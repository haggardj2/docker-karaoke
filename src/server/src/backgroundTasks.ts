import { getSetting, query, setSetting } from './db.js';
import { logger } from './logger.js';
import { isBreakMusicFile, processMissingDurations } from './scanner.js';
import {
  runLibraryScanRequests,
  LibraryScanAlreadyInProgressError,
  type LibraryScanRequest,
} from './libraryScanner.js';
import { runBreakMusicScan, BreakMusicScanAlreadyInProgressError } from './breakMusicScanner.js';
import { scanDownloadLocation, DownloadScanAlreadyInProgressError } from './ytdlp.js';
import {
  detectChangedDirectoryRoots,
  fingerprintsEqual,
  snapshotDirectoryFingerprint,
  snapshotDirectoryTree,
  type DirectoryFingerprint,
  type DirectoryTreeEntry,
} from './directoryFingerprints.js';
import { DEFAULT_LIBRARY_PARSE_MODE, type LibraryParseMode } from './parsing.js';

type TaskReason = 'startup' | 'settings' | 'scheduled';

export interface SyncBackgroundTaskStateOptions {
  runDurationImmediately?: boolean;
  runMediaLibraryScanImmediately?: boolean;
  runDownloadScanImmediately?: boolean;
  runBreakMusicScanImmediately?: boolean;
}

interface ScheduledTaskState {
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: Promise<void> | null;
  rerunRequested: boolean;
  enabled: boolean;
}

interface ScheduledTaskConfig {
  label: string;
  settingKey: string;
  defaultEnabled: boolean;
  intervalMs: number;
  run: (reason: TaskReason) => Promise<TaskRunResult>;
}

interface TaskRunResult {
  started: boolean;
  summary: string;
}

const DEFAULT_BACKGROUND_DURATION_INTERVAL_MS = 60_000;
const DEFAULT_BACKGROUND_MEDIA_SCAN_INTERVAL_MS = 15 * 60_000;
const DEFAULT_BACKGROUND_DOWNLOAD_SCAN_INTERVAL_MS = 5 * 60_000;
const DEFAULT_BACKGROUND_BREAK_MUSIC_SCAN_INTERVAL_MS = 10 * 60_000;

function parsePositiveIntegerEnv(name: string): number | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseBooleanSetting(value: any, defaultValue: boolean): boolean {
  if (value === null || value === undefined) return defaultValue;
  if (value === false || value === 0) return false;
  if (typeof value === 'string' && value.trim().toLowerCase() === 'false') return false;
  return true;
}

const BACKGROUND_DURATION_INTERVAL_MS =
  parsePositiveIntegerEnv('BACKGROUND_DURATION_INTERVAL_MS') ?? DEFAULT_BACKGROUND_DURATION_INTERVAL_MS;
const BACKGROUND_MEDIA_SCAN_INTERVAL_MS =
  parsePositiveIntegerEnv('BACKGROUND_MEDIA_SCAN_INTERVAL_MS') ?? DEFAULT_BACKGROUND_MEDIA_SCAN_INTERVAL_MS;
const BACKGROUND_DOWNLOAD_SCAN_INTERVAL_MS =
  parsePositiveIntegerEnv('BACKGROUND_DOWNLOAD_SCAN_INTERVAL_MS') ?? DEFAULT_BACKGROUND_DOWNLOAD_SCAN_INTERVAL_MS;
const BACKGROUND_BREAK_MUSIC_SCAN_INTERVAL_MS =
  parsePositiveIntegerEnv('BACKGROUND_BREAK_MUSIC_SCAN_INTERVAL_MS') ?? DEFAULT_BACKGROUND_BREAK_MUSIC_SCAN_INTERVAL_MS;

function createScheduledTask(config: ScheduledTaskConfig) {
  const state: ScheduledTaskState = {
    timer: null,
    inFlight: null,
    rerunRequested: false,
    enabled: config.defaultEnabled,
  };

  async function loadEnabled(): Promise<boolean> {
    const storedValue = await getSetting(config.settingKey);
    return parseBooleanSetting(storedValue, config.defaultEnabled);
  }

  function clearScheduledRun(): void {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  }

  function scheduleNextRun(delayMs: number = config.intervalMs): void {
    clearScheduledRun();
    state.timer = setTimeout(() => {
      void runCycle('scheduled');
    }, delayMs);
    state.timer.unref?.();
  }

  async function runCycle(reason: TaskReason): Promise<void> {
    if (!state.enabled) {
      return;
    }

    if (state.inFlight) {
      state.rerunRequested = true;
      logger.info(`[backgroundTasks] ${config.label} already running; queued another pass (${reason}).`);
      return state.inFlight;
    }

    const startedAt = Date.now();
    state.inFlight = (async () => {
      const result = await config.run(reason);
      const status = result.started ? 'pass complete' : 'pass skipped';
      logger.info(
        `[backgroundTasks] ${config.label} ${status} (${reason}) in ${Date.now() - startedAt}ms. ${result.summary}`
      );
    })();

    try {
      await state.inFlight;
    } catch (error) {
      logger.error(`[backgroundTasks] ${config.label} pass failed:`, error);
    } finally {
      state.inFlight = null;

      if (!state.enabled) {
        return;
      }

      if (state.rerunRequested) {
        state.rerunRequested = false;
        void runCycle('settings');
        return;
      }

      scheduleNextRun();
    }
  }

  async function sync(options: { runImmediately?: boolean } = {}): Promise<void> {
    state.enabled = await loadEnabled();

    if (!state.enabled) {
      clearScheduledRun();
      state.rerunRequested = false;
      logger.info(`[backgroundTasks] ${config.label} task disabled.`);
      return;
    }

    logger.info(
      `[backgroundTasks] ${config.label} task enabled; polling every ${config.intervalMs}ms.`
    );

    if (options.runImmediately) {
      await runCycle('settings');
      return;
    }

    if (!state.inFlight && !state.timer) {
      scheduleNextRun();
    }
  }

  return { sync };
}

const MEDIA_LIBRARY_SCAN_SNAPSHOT_KEY = 'background.media_library_scan_snapshot';
const DOWNLOAD_SCAN_SNAPSHOT_KEY = 'background.download_scan_snapshot';
const BREAK_MUSIC_SCAN_SNAPSHOT_KEY = 'background.break_music_scan_snapshot';

const MEDIA_LIBRARY_FILE_RE = /\.(mp4|zip|cdg|mp3)$/i;
const DOWNLOAD_MP4_RE = /\.mp4$/i;

interface MediaLibraryTreeSnapshot {
  libraryId: number;
  rootPath: string;
  parseMode: LibraryParseMode;
  entries: DirectoryTreeEntry[];
}

async function loadFingerprints(settingKey: string): Promise<DirectoryFingerprint[] | null> {
  const stored = await getSetting(settingKey);
  return Array.isArray(stored) ? stored as DirectoryFingerprint[] : null;
}

async function persistFingerprints(settingKey: string, fingerprints: DirectoryFingerprint[]): Promise<void> {
  await setSetting(settingKey, fingerprints);
}

async function loadMediaLibraryTreeSnapshots(): Promise<MediaLibraryTreeSnapshot[] | null> {
  const stored = await getSetting(MEDIA_LIBRARY_SCAN_SNAPSHOT_KEY);
  return Array.isArray(stored) ? (stored as MediaLibraryTreeSnapshot[]) : null;
}

async function persistMediaLibraryTreeSnapshots(snapshots: MediaLibraryTreeSnapshot[]): Promise<void> {
  await setSetting(MEDIA_LIBRARY_SCAN_SNAPSHOT_KEY, snapshots);
}

async function snapshotMediaLibraryTrees(): Promise<MediaLibraryTreeSnapshot[]> {
  const libraries = await query<{ id: number; path: string; parse_mode: LibraryParseMode | null }>(
    `SELECT id, path, parse_mode FROM libraries ORDER BY id`
  );
  return Promise.all(
    libraries.rows.map(async (library) => ({
      libraryId: library.id,
      rootPath: library.path,
      parseMode: library.parse_mode ?? DEFAULT_LIBRARY_PARSE_MODE,
      entries: await snapshotDirectoryTree(library.path, {
        recursive: true,
        includeFile: (filePath) => MEDIA_LIBRARY_FILE_RE.test(filePath),
      }),
    }))
  );
}

async function snapshotDownloadFingerprints(): Promise<DirectoryFingerprint[]> {
  const downloadLocation = (await getSetting('ytdlp.download_location')) || process.env.YTDLP_DOWNLOAD_LOCATION || '/media/downloads';
  return [
    await snapshotDirectoryFingerprint(downloadLocation, {
      recursive: false,
      includeFile: (filePath) => DOWNLOAD_MP4_RE.test(filePath),
    }),
  ];
}

async function snapshotBreakMusicFingerprints(): Promise<DirectoryFingerprint[]> {
  const folders = await query<{ id: number; path: string }>(
    `SELECT id, path FROM break_music_folders ORDER BY id`
  );
  const fingerprints = await Promise.all(
    folders.rows.map(async (folder) => ({
      folderId: folder.id,
      ...(await snapshotDirectoryFingerprint(folder.path, {
        recursive: true,
        includeFile: (filePath) => isBreakMusicFile(filePath),
      })),
    }))
  );

  return fingerprints;
}

async function runWhenFingerprintsChange(
  reason: TaskReason,
  options: {
    settingKey: string;
    takeSnapshot: () => Promise<DirectoryFingerprint[]>;
    runScan: () => Promise<TaskRunResult>;
    describeRoots: string;
  }
): Promise<TaskRunResult> {
  if (reason !== 'scheduled') {
    logger.info(`[backgroundTasks] Starting ${options.describeRoots} pass (${reason}).`);
    const result = await options.runScan();
    if (result.started) {
      const afterScan = await options.takeSnapshot();
      await persistFingerprints(options.settingKey, afterScan);
    }
    return result;
  }

  const [previous, current] = await Promise.all([
    loadFingerprints(options.settingKey),
    options.takeSnapshot(),
  ]);

  if (fingerprintsEqual(previous, current)) {
    return { started: false, summary: `No watched directory changes detected for ${options.describeRoots}.` };
  }

  logger.info(`[backgroundTasks] Starting ${options.describeRoots} pass (${reason}) after detecting directory changes.`);
  const result = await options.runScan();
  if (result.started) {
    const afterScan = await options.takeSnapshot();
    await persistFingerprints(options.settingKey, afterScan);
  }
  return result;
}

function getMediaLibraryScanRequests(
  previous: MediaLibraryTreeSnapshot[] | null,
  current: MediaLibraryTreeSnapshot[]
): LibraryScanRequest[] {
  if (!previous) {
    return [];
  }

  const previousByLibraryId = new Map(previous.map((snapshot) => [snapshot.libraryId, snapshot]));
  const scanRequests: LibraryScanRequest[] = [];

  for (const snapshot of current) {
    if (!previousByLibraryId.has(snapshot.libraryId)) {
      scanRequests.push({
        libraryId: snapshot.libraryId,
        libraryPath: snapshot.rootPath,
        parseMode: snapshot.parseMode,
        scanRoot: snapshot.rootPath,
        cleanupRoot: snapshot.rootPath,
      });
      continue;
    }

    const changedRoots = detectChangedDirectoryRoots(
      previousByLibraryId.get(snapshot.libraryId)?.entries ?? null,
      snapshot.entries,
      snapshot.rootPath
    );

    for (const scanRoot of changedRoots) {
      scanRequests.push({
        libraryId: snapshot.libraryId,
        libraryPath: snapshot.rootPath,
        parseMode: snapshot.parseMode,
        scanRoot,
        cleanupRoot: scanRoot,
      });
    }
  }

  return scanRequests;
}

async function runMediaLibraryScanForChanges(reason: TaskReason): Promise<TaskRunResult> {
  const [previous, current] = await Promise.all([
    loadMediaLibraryTreeSnapshots(),
    snapshotMediaLibraryTrees(),
  ]);

  if (!previous) {
    await persistMediaLibraryTreeSnapshots(current);
    return {
      started: false,
      summary: `Initialized watched directory snapshot for ${current.length} librar${current.length === 1 ? 'y' : 'ies'}.`,
    };
  }

  const scanRequests = getMediaLibraryScanRequests(previous, current);
  if (scanRequests.length === 0) {
    return { started: false, summary: 'No watched directory changes detected for Media library scan.' };
  }

  logger.info(
    `[backgroundTasks] Starting Media library scan pass (${reason}) for ${scanRequests.length} changed folder${scanRequests.length === 1 ? '' : 's'}.`
  );

  try {
    const result = await runLibraryScanRequests(scanRequests);
    await persistMediaLibraryTreeSnapshots(await snapshotMediaLibraryTrees());
    const libraryCount = Object.keys(result.stats || {}).length;
    return {
      started: true,
      summary: `Scanned ${scanRequests.length} changed folder${scanRequests.length === 1 ? '' : 's'} across ${libraryCount} librar${libraryCount === 1 ? 'y' : 'ies'}.`,
    };
  } catch (error) {
    if (error instanceof LibraryScanAlreadyInProgressError) {
      return {
        started: false,
        summary: 'Skipped because a media library scan is already running.',
      };
    }
    throw error;
  }
}

const durationProcessingTask = createScheduledTask({
  label: 'Duration processing',
  settingKey: 'admin.background_tasks_enabled',
  defaultEnabled: true,
  intervalMs: BACKGROUND_DURATION_INTERVAL_MS,
  run: async () => {
    logger.info('[backgroundTasks] Starting Duration processing pass.');
    let totalProcessed = 0;
    let passes = 0;

    while (true) {
      passes += 1;
      const processed = await processMissingDurations();
      totalProcessed += processed;

      if (processed === 0) {
        if (totalProcessed === 0) {
          return { started: true, summary: 'No tracks were missing duration metadata.' };
        }

        return {
          started: true,
          summary: `Updated ${totalProcessed} tracks across ${passes} batch${passes === 1 ? '' : 'es'}.`,
        };
      }
    }
  },
});

const mediaLibraryScanTask = createScheduledTask({
  label: 'Media library scan',
  settingKey: 'admin.background_media_scan_enabled',
  defaultEnabled: false,
  intervalMs: BACKGROUND_MEDIA_SCAN_INTERVAL_MS,
  run: async (reason) => {
    return runMediaLibraryScanForChanges(reason);
  },
});

const downloadScanTask = createScheduledTask({
  label: 'Download folder scan',
  settingKey: 'admin.background_download_scan_enabled',
  defaultEnabled: false,
  intervalMs: BACKGROUND_DOWNLOAD_SCAN_INTERVAL_MS,
  run: async (reason) => {
    return runWhenFingerprintsChange(reason, {
      settingKey: DOWNLOAD_SCAN_SNAPSHOT_KEY,
      takeSnapshot: snapshotDownloadFingerprints,
      describeRoots: 'Download folder scan',
      runScan: async () => {
        try {
          const result = await scanDownloadLocation();
          return {
            started: true,
            summary: result.message || `Added ${result.added}, removed ${result.removed}, skipped ${result.skipped}.`,
          };
        } catch (error) {
          if (error instanceof DownloadScanAlreadyInProgressError) {
            return {
              started: false,
              summary: 'Skipped because a download folder scan is already running.',
            };
          }
          throw error;
        }
      },
    });
  },
});

const breakMusicScanTask = createScheduledTask({
  label: 'Break music scan',
  settingKey: 'admin.background_break_music_scan_enabled',
  defaultEnabled: false,
  intervalMs: BACKGROUND_BREAK_MUSIC_SCAN_INTERVAL_MS,
  run: async (reason) => {
    return runWhenFingerprintsChange(reason, {
      settingKey: BREAK_MUSIC_SCAN_SNAPSHOT_KEY,
      takeSnapshot: snapshotBreakMusicFingerprints,
      describeRoots: 'Break music scan',
      runScan: async () => {
        try {
          const result = await runBreakMusicScan();
          return {
            started: true,
            summary: `Indexed ${result.indexed} tracks across ${result.foldersScanned} break music folder${result.foldersScanned === 1 ? '' : 's'}.`,
          };
        } catch (error) {
          if (error instanceof BreakMusicScanAlreadyInProgressError) {
            return {
              started: false,
              summary: 'Skipped because a break music scan is already running.',
            };
          }
          throw error;
        }
      },
    });
  },
});

export async function syncDurationProcessingTaskState(options: { runImmediately?: boolean } = {}): Promise<void> {
  await durationProcessingTask.sync(options);
}

export async function syncMediaLibraryScanTaskState(options: { runImmediately?: boolean } = {}): Promise<void> {
  await mediaLibraryScanTask.sync(options);
}

export async function syncDownloadScanTaskState(options: { runImmediately?: boolean } = {}): Promise<void> {
  await downloadScanTask.sync(options);
}

export async function syncBreakMusicScanTaskState(options: { runImmediately?: boolean } = {}): Promise<void> {
  await breakMusicScanTask.sync(options);
}

export async function syncBackgroundTaskState(
  options: SyncBackgroundTaskStateOptions = {}
): Promise<void> {
  await Promise.all([
    syncDurationProcessingTaskState({ runImmediately: options.runDurationImmediately }),
    syncMediaLibraryScanTaskState({ runImmediately: options.runMediaLibraryScanImmediately }),
    syncDownloadScanTaskState({ runImmediately: options.runDownloadScanImmediately }),
    syncBreakMusicScanTaskState({ runImmediately: options.runBreakMusicScanImmediately }),
  ]);
}

// server/src/scanner.ts
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { upsertArtist, upsertTrack } from './db';
import { DEFAULT_LIBRARY_PARSE_MODE, type LibraryParseMode, parseFromFilename } from './parsing';
import { createRequire } from 'module';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { promisify } from 'util';
import { logger } from './logger';
import { parseZipMediaRef } from './zipMediaRef.js';
const require = createRequire(import.meta.url);
const yauzl = require('yauzl');
const execFile = promisify(spawn);

type ProgressCb = (evt: { type: 'file' | 'summary'; data: any }) => void;
type ScanPathOptions = {
  scanRoot?: string;
  cleanupRoot?: string;
  parseMode?: LibraryParseMode;
};

const VIDEO_RE = /\.mp4$/i;
const ZIP_RE   = /\.zip$/i;
const CDG_RE   = /\.cdg$/i;
const MP3_RE   = /\.mp3$/i;
const BREAK_AUDIO_RE = /\.(mp3|flac|alac|wav|opus|aac|m4a|ogg|oga)$/i;
// .opus is intentionally excluded: its Vorbis Comments live in stream headers (not
// the container/format level), so ffmetadata writes an empty file for opus files.
// Opus is handled by the ffprobe path below which correctly reads stream-level tags.
const VORBIS_COMMENT_RE = /\.(flac|ogg|oga)$/i;

/**
 * Semaphore to limit concurrent ffprobe operations
 */
class Semaphore {
  private queue: Array<() => void> = [];
  private running = 0;

  constructor(private max: number) {}

  async acquire(): Promise<void> {
    if (this.running < this.max) {
      this.running++;
      return;
    }
    return new Promise(resolve => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) {
      this.running++;
      next();
    }
  }
}

function getDefaultMediaProbeConcurrency(): number {
  const availableParallelism =
    typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;

  return Math.max(10, Math.min(24, availableParallelism * 2));
}

const DEFAULT_MEDIA_PROBE_TIMEOUT_MS = 5 * 60 * 1000;

function parsePositiveIntegerEnv(name: string): number | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

const MEDIA_DURATION_PROBE_TIMEOUT_MS =
  parsePositiveIntegerEnv('MEDIA_DURATION_PROBE_TIMEOUT_MS') ?? DEFAULT_MEDIA_PROBE_TIMEOUT_MS;
const AUDIO_METADATA_PROBE_TIMEOUT_MS =
  parsePositiveIntegerEnv('AUDIO_METADATA_PROBE_TIMEOUT_MS') ?? DEFAULT_MEDIA_PROBE_TIMEOUT_MS;
const MEDIA_PROBE_CONCURRENCY =
  parsePositiveIntegerEnv('MEDIA_PROBE_CONCURRENCY') ?? getDefaultMediaProbeConcurrency();
const DEFAULT_MISSING_DURATION_BATCH_SIZE = Math.max(25, MEDIA_PROBE_CONCURRENCY * 2);

// Limit concurrent ffprobe processes to avoid EMFILE errors while still keeping the scanner busy.
const ffprobeSemaphore = new Semaphore(MEDIA_PROBE_CONCURRENCY);

function killTimedOutProcess(
  proc: ChildProcessWithoutNullStreams,
  label: string,
  timeoutMs: number
): void {
  logger.warn(`[scanner] ${label} exceeded ${timeoutMs}ms, terminating process`);

  try {
    proc.kill('SIGTERM');
  } catch {}

  const forceKillTimer = setTimeout(() => {
    if (!proc.killed) {
      try {
        proc.kill('SIGKILL');
      } catch {}
    }
  }, 5000);
  forceKillTimer.unref?.();
}

async function* walkFiles(dir: string): AsyncGenerator<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walkFiles(p);
    } else {
      yield p;
    }
  }
}

function isPathWithinRoot(candidatePath: string, rootPath: string): boolean {
  return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}${path.sep}`);
}

const MP3_BITRATES_KBPS: Record<string, number[]> = {
  V1L1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 0],
  V1L2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0],
  V1L3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
  V2L1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0],
  V2L2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
  V2L3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
};

function parseSynchsafeInt(buffer: Buffer, offset: number): number {
  return ((buffer[offset] & 0x7f) << 21) |
    ((buffer[offset + 1] & 0x7f) << 14) |
    ((buffer[offset + 2] & 0x7f) << 7) |
    (buffer[offset + 3] & 0x7f);
}

function getMp3StartOffset(buffer: Buffer): number {
  if (buffer.length < 10 || buffer.toString('ascii', 0, 3) !== 'ID3') return 0;
  const hasFooter = (buffer[5] & 0x10) !== 0;
  return 10 + parseSynchsafeInt(buffer, 6) + (hasFooter ? 10 : 0);
}

type Mp3FrameInfo = {
  offset: number;
  frameLength: number;
  sampleRate: number;
  samplesPerFrame: number;
  bitrateKbps: number;
  mpegVersion: 1 | 2 | 2.5;
  channelMode: number;
};

function readMp3FrameInfo(buffer: Buffer, offset: number): Mp3FrameInfo | null {
  if (offset + 4 > buffer.length) return null;
  const header = buffer.readUInt32BE(offset);
  if ((header & 0xffe00000) !== 0xffe00000) return null;

  const versionBits = (header >> 19) & 0x3;
  const layerBits = (header >> 17) & 0x3;
  const bitrateIndex = (header >> 12) & 0xf;
  const sampleRateIndex = (header >> 10) & 0x3;
  const padding = (header >> 9) & 0x1;
  const channelMode = (header >> 6) & 0x3;
  if (versionBits === 1 || layerBits === 0 || bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) {
    return null;
  }

  const mpegVersion = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5;
  const layer = 4 - layerBits;
  const baseSampleRates = [44100, 48000, 32000];
  const sampleRate = Math.round(baseSampleRates[sampleRateIndex] / (mpegVersion === 1 ? 1 : mpegVersion === 2 ? 2 : 4));
  const bitrateTableKey = `${mpegVersion === 1 ? 'V1' : 'V2'}L${layer}`;
  const bitrateKbps = MP3_BITRATES_KBPS[bitrateTableKey]?.[bitrateIndex] || 0;
  if (!bitrateKbps || !sampleRate) return null;

  const samplesPerFrame = layer === 1 ? 384 : layer === 3 && mpegVersion !== 1 ? 576 : 1152;
  const frameLength = layer === 1
    ? Math.floor(((12 * bitrateKbps * 1000) / sampleRate + padding) * 4)
    : Math.floor(((samplesPerFrame / 8) * bitrateKbps * 1000) / sampleRate + padding);
  if (frameLength <= 4) return null;

  return { offset, frameLength, sampleRate, samplesPerFrame, bitrateKbps, mpegVersion, channelMode };
}

function findFirstMp3Frame(buffer: Buffer): Mp3FrameInfo | null {
  const start = getMp3StartOffset(buffer);
  for (let offset = start; offset + 4 < buffer.length; offset++) {
    const frame = readMp3FrameInfo(buffer, offset);
    if (!frame) continue;
    const next = readMp3FrameInfo(buffer, offset + frame.frameLength);
    if (next || offset + frame.frameLength >= buffer.length) return frame;
  }
  return null;
}

function getVbrFrameCount(buffer: Buffer, frame: Mp3FrameInfo): number | null {
  const sideInfoLength = frame.mpegVersion === 1
    ? frame.channelMode === 3 ? 21 : 36
    : frame.channelMode === 3 ? 13 : 21;
  const xingOffset = frame.offset + sideInfoLength;
  const xingTag = buffer.toString('ascii', xingOffset, xingOffset + 4);
  if ((xingTag === 'Xing' || xingTag === 'Info') && xingOffset + 12 <= buffer.length) {
    const flags = buffer.readUInt32BE(xingOffset + 4);
    if ((flags & 0x1) !== 0) return buffer.readUInt32BE(xingOffset + 8);
  }

  const vbriOffset = frame.offset + 36;
  if (buffer.toString('ascii', vbriOffset, vbriOffset + 4) === 'VBRI' && vbriOffset + 18 <= buffer.length) {
    return buffer.readUInt32BE(vbriOffset + 14);
  }
  return null;
}

function parseMp3DurationMs(buffer: Buffer): number | null {
  const firstFrame = findFirstMp3Frame(buffer);
  if (!firstFrame) return null;

  const vbrFrames = getVbrFrameCount(buffer, firstFrame);
  if (vbrFrames && vbrFrames > 0) {
    return Math.round((vbrFrames * firstFrame.samplesPerFrame * 1000) / firstFrame.sampleRate);
  }

  let frameCount = 0;
  let offset = firstFrame.offset;
  while (offset + 4 < buffer.length) {
    const frame = readMp3FrameInfo(buffer, offset);
    if (!frame) {
      offset += 1;
      continue;
    }
    frameCount += 1;
    offset += frame.frameLength;
  }

  if (frameCount > 1) {
    return Math.round((frameCount * firstFrame.samplesPerFrame * 1000) / firstFrame.sampleRate);
  }

  const audioBytes = Math.max(0, buffer.length - firstFrame.offset);
  const cbrDurationMs = Math.round((audioBytes * 8 * 1000) / (firstFrame.bitrateKbps * 1000));
  return cbrDurationMs > 0 ? cbrDurationMs : null;
}

async function getMp3DurationFromFile(filePath: string): Promise<number | null> {
  try {
    return parseMp3DurationMs(await fs.readFile(filePath));
  } catch (error) {
    logger.warn(`[scanner] MP3 duration fallback failed for ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Get duration of a media file using ffprobe
 */
export async function getMediaDuration(filePath: string): Promise<number | null> {
  await ffprobeSemaphore.acquire();
  
  try {
    const ffprobeDuration = await new Promise<number | null>((resolve) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const finish = (value: number | null) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        resolve(value);
      };
      let ffprobe;
      try {
        ffprobe = spawn('ffprobe', [
          '-v', 'error',
          '-show_entries', 'format=duration',
          '-of', 'default=noprint_wrappers=1:nokey=1',
          filePath
        ]);
      } catch (err) {
        // Handle synchronous spawn errors (e.g., EMFILE)
        console.error(`Failed to spawn ffprobe for ${filePath}:`, err);
        finish(null);
        return;
      }

      // Handle spawn errors where process is returned but is invalid
      if (!ffprobe || !ffprobe.stdout) {
        console.error(`Invalid ffprobe process for ${filePath}`);
        finish(null);
        return;
      }

      ffprobe.stderr?.resume();

      timeout = setTimeout(() => {
        killTimedOutProcess(ffprobe, `Duration probe for ${filePath}`, MEDIA_DURATION_PROBE_TIMEOUT_MS);
        finish(null);
      }, MEDIA_DURATION_PROBE_TIMEOUT_MS);
      timeout.unref?.();

      let output = '';
      ffprobe.stdout.on('data', (data) => {
        output += data.toString();
      });

      ffprobe.on('close', (code) => {
        if (code === 0) {
          const duration = parseFloat(output.trim());
          if (!isNaN(duration)) {
            // Convert seconds to milliseconds
            finish(Math.round(duration * 1000));
          } else {
            finish(null);
          }
        } else {
          finish(null);
        }
      });

      ffprobe.on('error', (err) => {
        console.error(`ffprobe error for ${filePath}:`, err);
        finish(null);
      });
    });
    if (ffprobeDuration !== null) return ffprobeDuration;
  } catch (err) {
    console.error(`Exception in getMediaDuration for ${filePath}:`, err);
  } finally {
    ffprobeSemaphore.release();
  }

  if (MP3_RE.test(filePath)) {
    return getMp3DurationFromFile(filePath);
  }
  return null;
}

export function isBreakMusicFile(filePath: string): boolean {
  return BREAK_AUDIO_RE.test(filePath);
}

type AudioMetadata = {
  title: string | null;
  artist: string | null;
  genre: string | null;
  duration_ms: number | null;
};

function parseFfmetadataTag(content: string, key: string): string | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = content.match(new RegExp(`^${escapedKey}=(.*)$`, 'im'));
  return match ? match[1].trim() || null : null;
}

export async function extractAudioMetadata(filePath: string): Promise<AudioMetadata> {
  await ffprobeSemaphore.acquire();

  try {
    if (VORBIS_COMMENT_RE.test(filePath)) {
      // Write metadata to a temp file so ffmpeg can seek if needed (stdout is not seekable).
      // This is especially important for .opus files which fail with non-zero exit codes
      // when ffmetadata is directed to stdout.
      const tmpMetaFile = path.join(os.tmpdir(), `ffmeta_${Date.now()}_${Math.random().toString(36).slice(2)}.txt`);
      return await new Promise<AudioMetadata>((resolve) => {
        let settled = false;
        let timeout: ReturnType<typeof setTimeout> | null = null;
        const finish = (value: AudioMetadata) => {
          if (settled) return;
          settled = true;
          if (timeout) clearTimeout(timeout);
          resolve(value);
        };
        let proc;
        try {
          proc = spawn('ffmpeg', ['-y', '-i', filePath, '-f', 'ffmetadata', tmpMetaFile]);
        } catch {
          finish({ title: null, artist: null, genre: null, duration_ms: null });
          return;
        }

        if (!proc || !proc.stderr) {
          finish({ title: null, artist: null, genre: null, duration_ms: null });
          return;
        }

        // Drain stdout — ffmpeg may still emit some output to stdout even when the
        // primary output is a file, and not consuming it can cause the process to block.
        proc.stdout?.resume();

        timeout = setTimeout(() => {
          killTimedOutProcess(proc, `Audio metadata probe for ${filePath}`, AUDIO_METADATA_PROBE_TIMEOUT_MS);
          fs.unlink(tmpMetaFile).catch(() => {});
          finish({ title: null, artist: null, genre: null, duration_ms: null });
        }, AUDIO_METADATA_PROBE_TIMEOUT_MS);
        timeout.unref?.();

        let stderrData = '';
        proc.stderr.on('data', (data: Buffer) => { stderrData += data.toString(); });

        proc.on('close', async (_code) => {
          try {
            let metaContent = '';
            try {
              metaContent = await fs.readFile(tmpMetaFile, 'utf8');
            } catch {
              finish({ title: null, artist: null, genre: null, duration_ms: null });
              return;
            }

            const title = parseFfmetadataTag(metaContent, 'title');
            const artist = parseFfmetadataTag(metaContent, 'artist');
            const genre = parseFfmetadataTag(metaContent, 'genre');

            // Parse duration from ffmpeg stderr (e.g. "Duration: 00:03:45.12")
            const durationMatch = stderrData.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
            let duration_ms: number | null = null;
            if (durationMatch) {
              const h = parseInt(durationMatch[1], 10);
              const m = parseInt(durationMatch[2], 10);
              const s = parseFloat(durationMatch[3]);
              const total = h * 3600 + m * 60 + s;
              if (total > 0) duration_ms = Math.round(total * 1000);
            }

            finish({ title, artist, genre, duration_ms });
          } finally {
            fs.unlink(tmpMetaFile).catch(() => {});
          }
        });

        proc.on('error', () => {
          fs.unlink(tmpMetaFile).catch(() => {});
          finish({ title: null, artist: null, genre: null, duration_ms: null });
        });
      });
    }

    return await new Promise<AudioMetadata>((resolve) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const finish = (value: AudioMetadata) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        resolve(value);
      };
      let ffprobe;
      try {
        ffprobe = spawn('ffprobe', [
          '-v', 'error',
          '-show_entries', 'format=duration:format_tags=title,artist,genre:stream_tags=title,artist,genre',
          '-of', 'json',
          filePath
        ]);
      } catch {
        finish({ title: null, artist: null, genre: null, duration_ms: null });
        return;
      }

      if (!ffprobe || !ffprobe.stdout) {
        finish({ title: null, artist: null, genre: null, duration_ms: null });
        return;
      }

      ffprobe.stderr?.resume();

      timeout = setTimeout(() => {
        killTimedOutProcess(ffprobe, `Audio metadata probe for ${filePath}`, AUDIO_METADATA_PROBE_TIMEOUT_MS);
        finish({ title: null, artist: null, genre: null, duration_ms: null });
      }, AUDIO_METADATA_PROBE_TIMEOUT_MS);
      timeout.unref?.();

      let output = '';
      ffprobe.stdout.on('data', (data) => {
        output += data.toString();
      });

      ffprobe.on('close', (code) => {
        if (code !== 0) {
          finish({ title: null, artist: null, genre: null, duration_ms: null });
          return;
        }

        try {
          const parsed = JSON.parse(output || '{}');
          // format.tags covers MP3/AAC/etc; streams[0].tags covers opus/FLAC Vorbis Comments.
          // Normalize keys to lowercase: Vorbis Comment tags (opus, flac, ogg) are returned
          // by ffprobe in UPPERCASE (e.g. TITLE, ARTIST, GENRE), so a case-insensitive merge
          // ensures consistent access regardless of file format.
          const normKeys = (obj: Record<string, string>) =>
            Object.fromEntries(Object.entries(obj).map(([k, v]) => [k.toLowerCase(), v]));
          const formatTags = normKeys(parsed?.format?.tags || {});
          const streamTags = (Array.isArray(parsed?.streams) && parsed.streams.length > 0)
            ? normKeys(parsed.streams[0].tags || {})
            : {};
          const tags = { ...streamTags, ...formatTags };
          const duration = Number(parsed?.format?.duration);
          finish({
            title: typeof tags.title === 'string' ? tags.title.trim() || null : null,
            artist: typeof tags.artist === 'string' ? tags.artist.trim() || null : null,
            genre: typeof tags.genre === 'string' ? tags.genre.trim() || null : null,
            duration_ms: Number.isFinite(duration) && duration > 0 ? Math.round(duration * 1000) : null
          });
        } catch {
          finish({ title: null, artist: null, genre: null, duration_ms: null });
        }
      });

      ffprobe.on('error', () => {
        finish({ title: null, artist: null, genre: null, duration_ms: null });
      });
    });
  } finally {
    ffprobeSemaphore.release();
  }
}

/**
 * Utility function to extract duration from a track
 * Handles all track types: mp4, cdgmp3 (zip or loose)
 */
export async function extractTrackDuration(track: { 
  kind: string; 
  file_mp4: string | null; 
  file_mp3: string | null; 
}): Promise<number | null> {
  let extractedDuration: number | null = null;
  
  if (track.kind === 'cdgmp3' && track.file_mp3) {
    const isFromZip = track.file_mp3.startsWith('zip://');
    
    if (isFromZip) {
      // Extract duration from MP3 inside ZIP
      const parsed = parseZipMediaRef(track.file_mp3);
      const zipPath = parsed?.zipPath || '';
      const mp3Name = parsed?.entryName || '';
      
      if (zipPath && mp3Name) {
        extractedDuration = await getZipMp3Duration(zipPath, mp3Name);
      }
    } else {
      // Loose MP3 file
      extractedDuration = await getMediaDuration(track.file_mp3);
    }
  } else if (track.kind === 'mp4' && track.file_mp4) {
    extractedDuration = await getMediaDuration(track.file_mp4);
  }
  
  return extractedDuration;
}

/**
 * Get duration of MP3 inside a ZIP file
 */
export async function getZipMp3Duration(zipPath: string, mp3Name: string): Promise<number | null> {
  let tmpFile: string | null = null;
  let zipFile: any = null;
  
  try {
    return await new Promise((resolve) => {
      yauzl.open(zipPath, { lazyEntries: true }, (err: any, zf: any) => {
        if (err || !zf) {
          resolve(null);
          return;
        }

        zipFile = zf;
        zipFile.readEntry();
        
        zipFile.on('entry', (entry: any) => {
          if (entry.fileName === mp3Name) {
            // Extract MP3 to temp file to analyze duration
            tmpFile = path.join('/tmp', `temp_${Date.now()}_${Math.random().toString(36).substring(7)}.mp3`);
            const writeStream = require('fs').createWriteStream(tmpFile);
            
            zipFile.openReadStream(entry, (err2: any, readStream: any) => {
              if (err2 || !readStream) {
                writeStream.destroy();
                zipFile.close();
                resolve(null);
                return;
              }
              
              readStream.on('error', () => {
                writeStream.destroy();
                zipFile.close();
                resolve(null);
              });
              
              readStream.pipe(writeStream);
              
              writeStream.on('finish', async () => {
                try {
                  const duration = await getMediaDuration(tmpFile!);
                  resolve(duration);
                } catch (err) {
                  resolve(null);
                } finally {
                  // Close ZIP file handle
                  try {
                    zipFile.close();
                  } catch {}
                }
              });
              
              writeStream.on('error', () => {
                writeStream.destroy();
                try {
                  zipFile.close();
                } catch {}
                resolve(null);
              });
            });
          } else {
            zipFile.readEntry();
          }
        });

        zipFile.on('end', () => {
          resolve(null);
        });

        zipFile.on('error', () => {
          resolve(null);
        });
      });
    });
  } catch {
    return null;
  } finally {
    // Always clean up temp file and close ZIP file handle
    if (tmpFile) {
      try {
        await fs.unlink(tmpFile);
      } catch {}
    }
    if (zipFile) {
      try {
        zipFile.close();
      } catch {}
    }
  }
}

/**
 * Look inside ZIP files to find actual CDG/MP3 filenames
 */
async function getZipContents(zipPath: string): Promise<{ cdg: string | null; mp3: string | null }> {
  return new Promise((resolve) => {
    let cdgFile: string | null = null;
    let mp3File: string | null = null;

    yauzl.open(zipPath, { lazyEntries: true }, (err: any, zipFile: any) => {
      if (err || !zipFile) {
        resolve({ cdg: null, mp3: null });
        return;
      }

      zipFile.readEntry();
      
      zipFile.on('entry', (entry: any) => {
        const name = entry.fileName as string;
        if (CDG_RE.test(name)) cdgFile = name;
        if (MP3_RE.test(name)) mp3File = name;
        zipFile.readEntry();
      });

      zipFile.on('end', () => {
        resolve({ cdg: cdgFile, mp3: mp3File });
      });

      zipFile.on('error', () => {
        resolve({ cdg: null, mp3: null });
      });
    });
  });
}

export async function scanPath(
  libraryId: number,
  libPath: string,
  onProgress?: ProgressCb,
  options: ScanPathOptions = {}
) {
  let mp4Indexed = 0;
  let zipsSeen = 0;
  let zipPairsIndexed = 0;
  let loosePairsIndexed = 0;
  const libraryRoot = path.resolve(libPath);
  const scanRoot = path.resolve(options.scanRoot ?? libPath);
  const cleanupRoot = path.resolve(options.cleanupRoot ?? scanRoot);
  const parseMode = options.parseMode ?? DEFAULT_LIBRARY_PARSE_MODE;

  if (!isPathWithinRoot(scanRoot, libraryRoot) || !isPathWithinRoot(cleanupRoot, libraryRoot)) {
    throw new Error('scan root must stay within the library path');
  }

  // Track scanned files to remove orphaned tracks later
  const scannedKeys = new Set<string>();

  console.log(`Scanning library path: ${libPath} (scan root: ${scanRoot})`);

  for await (const abs of walkFiles(scanRoot)) {
    const basename = path.basename(abs);
    const dir = path.dirname(abs);

    if (VIDEO_RE.test(basename)) {
      const { artist, title, discId } = parseFromFilename(basename, parseMode);
      const artistId = artist ? await upsertArtist(artist) : null;
      
      // Skip duration extraction during scan for speed (lazy loading)
      // Duration will be extracted in background or when song is queued
      const duration_ms = null;

      await upsertTrack({
        artist_id: artistId,
        disc_id: discId,
        title: title,
        kind: 'mp4',
        duration_ms,
        file_mp4: abs,
        file_cdg: null,
        file_mp3: null,
        path: dir,
        basename,
        library_id: libraryId,
      });

      // Track this file as scanned (using kind + path + basename as key)
      scannedKeys.add(`mp4:${dir}:${basename}`);

      mp4Indexed++;
      console.log(`Indexed MP4: ${basename} (disc: ${discId}, duration: pending)`);
      onProgress?.({ type: 'file', data: { kind: 'mp4', file: abs } });
      continue;
    }

    if (ZIP_RE.test(basename)) {
      zipsSeen++;
      
      // Get actual contents of the ZIP
      const contents = await getZipContents(abs);
      
      if (contents.cdg && contents.mp3) {
        const { artist, title, discId } = parseFromFilename(basename, parseMode);
        const artistId = artist ? await upsertArtist(artist) : null;
        
        // Skip duration extraction during scan for speed (lazy loading)
        // Duration will be extracted in background or when song is queued
        const duration_ms = null;

        await upsertTrack({
          artist_id: artistId,
          disc_id: discId,
          title: title,
          kind: 'cdgmp3',
          duration_ms,
          file_mp4: null,
          file_cdg: `zip://${abs}#${contents.cdg}`,
          file_mp3: `zip://${abs}#${contents.mp3}`,
          path: dir,
          basename,
          library_id: libraryId,
        });

        // Track this file as scanned (using kind + path + basename as key)
        scannedKeys.add(`cdgmp3:${dir}:${basename}`);

        zipPairsIndexed++;
        console.log(`Indexed ZIP CDG+MP3: ${basename} (disc: ${discId}, duration: pending)`);
        onProgress?.({ type: 'file', data: { kind: 'zipPair', file: abs } });
      } else {
        console.warn(`ZIP file missing CDG or MP3: ${basename}`);
      }
      continue;
    }

    // Handle loose CDG+MP3 pairs
    if (CDG_RE.test(basename)) {
      const stem = basename.replace(/\.cdg$/i, '');
      const mp3 = path.join(dir, `${stem}.mp3`);
      try {
        await fs.stat(mp3);
        const { artist, title, discId } = parseFromFilename(basename, parseMode);
        const artistId = artist ? await upsertArtist(artist) : null;
        
        // Skip duration extraction during scan for speed (lazy loading)
        // Duration will be extracted in background or when song is queued
        const duration_ms = null;
        
        await upsertTrack({
          artist_id: artistId,
          disc_id: discId,
          title,
          kind: 'cdgmp3',
          duration_ms,
          file_mp4: null,
          file_cdg: abs,
          file_mp3: mp3,
          path: dir,
          basename,
          library_id: libraryId,
        });
        
        // Track this file as scanned (using kind + path + basename as key)
        scannedKeys.add(`cdgmp3:${dir}:${basename}`);
        
        loosePairsIndexed++;
        console.log(`Indexed loose CDG+MP3: ${basename} (disc: ${discId}, duration: pending)`);
        onProgress?.({ type: 'file', data: { kind: 'loosePair', file: abs } });
      } catch {
        console.warn(`CDG file missing matching MP3: ${basename}`);
      }
    }
  }

  // Remove tracks from this library that were not found during the scan
  const { query } = await import('./db');
  
  // Get all existing tracks for this library (excluding external tracks and tracks in queue)
  const existingTracks = await query<{ id: number; kind: string; path: string; basename: string }>(
    `SELECT t.id, t.kind, t.path, t.basename 
     FROM tracks t
     LEFT JOIN queue q ON t.id = q.track_id
     WHERE t.library_id = $1 
       AND t.external_url IS NULL
       AND q.track_id IS NULL
       AND (t.path = $2 OR t.path LIKE $3)`,
    [libraryId, cleanupRoot, `${cleanupRoot}${path.sep}%`]
  );
  
  const tracksToDelete: number[] = [];
  for (const track of existingTracks.rows) {
    const key = `${track.kind}:${track.path}:${track.basename}`;
    if (!scannedKeys.has(key)) {
      tracksToDelete.push(track.id);
    }
  }
  
  let tracksRemoved = 0;
  if (tracksToDelete.length > 0) {
    console.log(`Removing ${tracksToDelete.length} tracks that are no longer in the library...`);
    const deleteResult = await query(
      `DELETE FROM tracks WHERE id = ANY($1)`,
      [tracksToDelete]
    );
    tracksRemoved = deleteResult.rowCount || 0;
    console.log(`Removed ${tracksRemoved} orphaned tracks`);
  }

  const summary = { mp4Indexed, zipsSeen, zipPairsIndexed, loosePairsIndexed, tracksRemoved };
  console.log('Scan summary:', summary);
  onProgress?.({ type: 'summary', data: summary });
  return summary;
}

/**
 * Background task to process tracks with missing duration_ms
 * Processes a batch of tracks at a time to avoid overwhelming the system
 */
export async function processMissingDurations(
  batchSize: number = DEFAULT_MISSING_DURATION_BATCH_SIZE
): Promise<number> {
  const { query } = await import('./db');
  
  // Get tracks without duration
  const result = await query(
    `SELECT id, kind, file_mp4, file_mp3, file_cdg, title
     FROM tracks
     WHERE duration_ms IS NULL
     ORDER BY id
     LIMIT $1`,
    [batchSize]
  );
  
  if (result.rows.length === 0) {
    return 0;
  }
  
  logger.warn(
    `Processing ${result.rows.length} tracks with missing duration ` +
    `(batch=${batchSize}, concurrency=${MEDIA_PROBE_CONCURRENCY})...`
  );

  const settled = await Promise.allSettled(
    result.rows.map(async (track) => {
      try {
        const extractedDuration = await extractTrackDuration(track);

        if (extractedDuration === null) {
          console.warn(`Failed to extract duration for track ${track.id} (${track.title})`);
          return false;
        }

        await query('UPDATE tracks SET duration_ms = $1 WHERE id = $2', [extractedDuration, track.id]);
        logger.warn(`Updated duration for track ${track.id} (${track.title}): ${Math.round(extractedDuration / 1000)}s`);
        return true;
      } catch (err) {
        console.error(`Error processing track ${track.id}:`, err);
        return false;
      }
    })
  );

  return settled.reduce((processed, item) => {
    if (item.status === 'fulfilled' && item.value) return processed + 1;
    return processed;
  }, 0);
}

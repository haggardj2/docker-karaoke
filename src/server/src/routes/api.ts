// server/src/routes/api.ts
import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import {
  query,
  ensureHelpfulIndexes,
  getSetting,
  setSetting,
  createSession,
  validateSession,
  validateSessionInfo,
  deleteSession,
  cleanupExpiredSessions,
  hashPassword,
  verifyPassword,
  getUserByUsername,
  createUser,
  getUserByOidcSubject,
  listUsers,
  getUserById,
  type User,
  updateUser,
  deleteUser,
  countAdminUsers
} from '../db';
import {
  getMediaDuration,
  getZipMp3Duration,
  extractTrackDuration,
  extractAudioMetadata
} from '../scanner';
import { resolveExistingMediaPath } from './media';
import {
  DEFAULT_LIBRARY_PARSE_MODE,
  isLibraryParseMode,
  type LibraryParseMode,
} from '../parsing';
import QRCode from 'qrcode';
import { searchKaraokeNerds } from '../karaoke-nerds';
import crypto from 'crypto';
import * as oidc from 'openid-client';
import { authLimiter, searchLimiter, queueLimiter } from '../middleware/rateLimiters';
import { setLogLevel, logger, type LogLevel } from '../logger';
import {
  syncBackgroundTaskState,
  syncDurationProcessingTaskState,
  syncMediaLibraryScanTaskState,
  syncDownloadScanTaskState,
  syncBreakMusicScanTaskState,
} from '../backgroundTasks';
import { findOrCreateSinger, ensureSingerInActiveRotation, normalizeSingerName, normalizeSingerUuid, type SingerRow } from '../queueIdentity.js';
import { parseZipMediaRef } from '../zipMediaRef.js';
import { buildOidcGrantCallbackUrl } from '../oidcRedirect.js';
import {
  getQueueState,
  getSingerHistory,
  updateQueueItemStatus,
  reorderSingerQueue,
} from '../queueState.js';
import { recalculateSingerStats } from '../singerStats.js';
import {
  sortQueuedRotationItems,
  type QueueSortBasePolicy,
} from '../rotation/queueSort';
import {
  getLibraryScanStatus,
  LibraryScanAlreadyInProgressError,
  offLibraryScanEvent,
  onLibraryScanEvent,
  runLibraryScan,
} from '../libraryScanner.js';
import {
  BreakMusicScanAlreadyInProgressError,
  runBreakMusicScan,
} from '../breakMusicScanner.js';
import {
  DownloadScanAlreadyInProgressError,
  scanDownloadLocation,
} from '../ytdlp.js';

ensureHelpfulIndexes().catch(e => console.error('ensureHelpfulIndexes failed', e));

export const apiRouter = express.Router();

// Type for public settings that don't require authentication
interface PublicSettings {
  'libraries.local_enabled': boolean;
  'libraries.external_enabled': boolean;
  'requests.acceptance': 'local' | 'external' | 'disabled';
  'requests.local_browse_enabled': boolean;
  'requests.url': string;
}

const DEFAULT_BREAK_PLAYLISTS_FOLDER = process.env.BREAK_MUSIC_PLAYLISTS_FOLDER || '/media/playlists';

let postQueueUpdate: (type?: string, data?: any) => void = () => {};
export function setPostQueueUpdate(fn: (type?: string, data?: any) => void) {
  postQueueUpdate = typeof fn === 'function' ? fn : () => {};
}

const ah =
  (fn: express.RequestHandler): express.RequestHandler =>
  (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

const getAuthenticatedUser = async (req: express.Request): Promise<User | null> => {
  const userId = Number((req as any).user?.userId);
  if (!Number.isFinite(userId) || userId <= 0) return null;
  return getUserById(userId);
};

const getOptionalAuthenticatedUser = async (req: express.Request): Promise<User | null> => {
  const token = req.headers['x-session-token'];
  if (typeof token !== 'string' || !token.trim()) return null;

  const info = await validateSessionInfo(token);
  if (!info.valid || !info.userId) return null;
  return getUserById(info.userId);
};

// Session-based authentication guard (validates session, attaches user info)
const sessionGuard: express.RequestHandler = async (req, res, next) => {
  const token = req.headers['x-session-token'] as string;
  if (!token) {
    res.status(403).json({ error: 'Forbidden: No session token provided' });
    return;
  }
  
  try {
    const info = await validateSessionInfo(token);
    if (info.valid) {
      (req as any).user = { userId: info.userId, role: info.role };
      next();
      return;
    }
    
    res.status(403).json({ error: 'Forbidden: Invalid or expired session' });
  } catch (err) {
    console.error('sessionGuard error:', err);
    res.status(403).json({ error: 'Forbidden: Authentication error' });
  }
};

// Admin-only guard: requires a valid session AND admin role
const adminGuard: express.RequestHandler = async (req, res, next) => {
  const token = req.headers['x-session-token'] as string;
  if (!token) {
    res.status(403).json({ error: 'Forbidden: No session token provided' });
    return;
  }

  try {
    const info = await validateSessionInfo(token);
    if (!info.valid) {
      res.status(403).json({ error: 'Forbidden: Invalid or expired session' });
      return;
    }
    if (info.role !== 'admin') {
      res.status(403).json({ error: 'Forbidden: Admin role required' });
      return;
    }
    (req as any).user = { userId: info.userId, role: info.role };
    next();
  } catch (err) {
    console.error('adminGuard error:', err);
    res.status(403).json({ error: 'Forbidden: Authentication error' });
  }
};

const toInt = (v: any): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

const validateKeyAdjustment = (keyAdjustment: number | null): boolean => {
  if (keyAdjustment === null || keyAdjustment === undefined) return true; // null/undefined is valid (defaults to 0)
  return keyAdjustment >= -6 && keyAdjustment <= 6;
};

type SingerHistoryKdTrackRef =
  | { type: 'local'; trackId: number }
  | { type: 'external'; url: string; source?: string | null };

type SingerHistoryKdSong = {
  title: string | null;
  artist: string | null;
  status: string;
  keyAdjustment: number;
  requestedAt: string | null;
  completedAt: string | null;
  track: SingerHistoryKdTrackRef;
};

type SingerHistoryKdSinger = {
  singer?: {
    id?: string;
    uuid?: string;
    displayName: string;
    normalizedName?: string;
    totalSongsSung?: number;
    lastSangAt?: string | null;
  };
  songs: SingerHistoryKdSong[];
};

type SingerHistoryKdFile = {
  format: 'karaokedock.singer-history';
  version: 1;
  exportedAt: string;
  singers: SingerHistoryKdSinger[];
};

type RemoteGatewayConfig = {
  url: string;
  token: string;
};

type RemoteGatewayPendingRequest = {
  id: string;
  trackId: string | number;
  requestedBy: string;
  singerUuid?: string | null;
  keyAdjustment?: number | null;
  notes?: string | null;
  title?: string | null;
  artist?: string | null;
  discId?: string | null;
  brand?: string | null;
  externalUrl?: string | null;
  source?: string | null;
};

type RemoteGatewayQueueAction = {
  id: string;
  type: 'reorder' | 'remove';
  requestedBy?: string | null;
  singerUuid?: string | null;
  payload?: {
    queueIds?: Array<string | number>;
    queueId?: string | number;
  };
};

const DEFAULT_REMOTE_GATEWAY_POLL_SECONDS = 5;
const MIN_REMOTE_GATEWAY_POLL_SECONDS = 2;
const REMOTE_GATEWAY_CATALOG_REFRESH_MS = 10 * 60_000;
const REMOTE_GATEWAY_CATALOG_CHUNK_SIZE = 500;
let remoteGatewayTimer: ReturnType<typeof setTimeout> | null = null;
let remoteGatewayInFlight: Promise<void> | null = null;
let remoteGatewayLastCatalogSync = 0;

function toSafeFilename(value: string): string {
  return value.trim().replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'singer-history';
}

function normalizeRemoteGatewayBaseUrl(value: unknown): string {
  return String(value ?? '').trim().replace(/\/+$/, '');
}

async function getRemoteGatewayConfig(): Promise<RemoteGatewayConfig> {
  const enabled = await getSetting('remote_gateway.enabled');
  const url = normalizeRemoteGatewayBaseUrl(await getSetting('remote_gateway.url'));
  const token = String(await getSetting('remote_gateway.api_token') ?? '').trim();
  if (enabled !== true) {
    throw Object.assign(new Error('Remote Requests Gateway is not enabled'), { status: 400 });
  }
  if (!url) {
    throw Object.assign(new Error('Remote Requests Gateway URL is not configured'), { status: 400 });
  }
  if (!token) {
    throw Object.assign(new Error('Remote Requests Gateway API token is not configured'), { status: 400 });
  }
  return { url, token };
}

async function callRemoteGateway(config: RemoteGatewayConfig, pathName: string, init: RequestInit = {}) {
  const response = await fetch(`${config.url}${pathName}`, {
    ...init,
    headers: {
      'Accept': 'application/json',
      'Authorization': `Bearer ${config.token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  let body: any = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!response.ok) {
    const message = typeof body === 'object' && body?.error ? body.error : text || response.statusText;
    throw Object.assign(new Error(`Gateway ${response.status}: ${message}`), { status: response.status });
  }
  return body;
}

async function getRemoteGatewayStatus(config: RemoteGatewayConfig) {
  return callRemoteGateway(config, '/api/station/status');
}

async function getRemoteGatewaySettingsPayload() {
  return {
    'libraries.local_enabled': await getSetting('libraries.local_enabled') !== false,
    'libraries.external_enabled': await getSetting('libraries.external_enabled') !== false,
    'requests.acceptance': await getSetting('requests.acceptance') || 'local',
    'requests.local_browse_enabled': await getSetting('requests.local_browse_enabled') !== false,
  };
}

async function pushRemoteGatewaySettings(config: RemoteGatewayConfig) {
  return callRemoteGateway(config, '/api/station/settings', {
    method: 'PUT',
    body: JSON.stringify({ settings: await getRemoteGatewaySettingsPayload() }),
  });
}

async function pushRemoteGatewayCatalog(config: RemoteGatewayConfig) {
  const tracks = await query<{
    id: number;
    title: string;
    artist: string | null;
    disc_id: string | null;
    kind: string;
    duration_ms: number | null;
    source: string | null;
    external_url: string | null;
  }>(
    `SELECT t.id,
            t.title,
            a.name AS artist,
            t.disc_id,
            t.kind,
            t.duration_ms,
            COALESCE(t.source, 'local') AS source,
            t.external_url
       FROM tracks t
       LEFT JOIN artists a ON a.id = t.artist_id
      WHERE COALESCE(t.title, '') <> ''
      ORDER BY t.id`,
  );

  const syncId = `station-${Date.now()}-${crypto.randomUUID()}`;
  const chunkCount = Math.max(1, Math.ceil(tracks.rows.length / REMOTE_GATEWAY_CATALOG_CHUNK_SIZE));
  let accepted = 0;
  let received = 0;
  let response: any = null;

  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
    const chunkRows = tracks.rows.slice(
      chunkIndex * REMOTE_GATEWAY_CATALOG_CHUNK_SIZE,
      (chunkIndex + 1) * REMOTE_GATEWAY_CATALOG_CHUNK_SIZE,
    );
    response = await callRemoteGateway(config, '/api/station/catalog', {
      method: 'PUT',
      body: JSON.stringify({
        full: true,
        syncId,
        chunkIndex,
        chunkCount,
        complete: chunkIndex === chunkCount - 1,
        tracks: chunkRows.map((track) => ({
          id: track.id,
          title: track.title,
          artist: track.artist,
          discId: track.disc_id,
          kind: track.kind,
          durationMs: track.duration_ms,
          source: track.source || 'local',
          externalUrl: track.external_url,
        })),
      }),
    });
    accepted += Number(response?.accepted || 0);
    received += Number(response?.received || chunkRows.length);
  }

  return {
    ...(response || { ok: true }),
    received,
    accepted,
    chunks: chunkCount,
    syncId,
    stationTracks: tracks.rows.length,
  };
}

async function pushRemoteGatewayQueueSnapshot(config: RemoteGatewayConfig) {
  const queue = await query<{
    id: string;
    track_id: string;
    requested_by: string | null;
    singer_uuid: string | null;
    status: string;
    position: number;
    key_adjustment: number | null;
    title: string;
    artist: string | null;
  }>(
    `SELECT q.id,
            q.track_id,
            q.requested_by,
            s.public_uuid AS singer_uuid,
            q.status,
            q.position,
            q.key_adjustment,
            t.title,
            a.name AS artist
       FROM queue q
       JOIN tracks t ON t.id = q.track_id
       LEFT JOIN artists a ON a.id = t.artist_id
       LEFT JOIN singers s ON s.id = q.singer_id
      WHERE q.status <> 'removed'
      ORDER BY q.position, q.created_at`,
  );

  const response = await callRemoteGateway(config, '/api/station/queue/snapshot', {
    method: 'PUT',
    body: JSON.stringify({
      full: true,
      queue: queue.rows.map((item) => ({
        stationQueueId: item.id,
        stationTrackId: item.track_id,
        requestedBy: item.requested_by,
        singerUuid: item.singer_uuid,
        status: item.status,
        position: item.position,
        keyAdjustment: item.key_adjustment ?? 0,
        title: item.title,
        artist: item.artist,
      })),
    }),
  });

  return {
    ...response,
    stationQueueItems: queue.rows.length,
  };
}

async function queueRemoteGatewayRequest(request: RemoteGatewayPendingRequest): Promise<{ status: 'queued' | 'rejected'; stationQueueId?: string; error?: string }> {
  const requestedBy = String(request.requestedBy ?? '').trim();
  if (!requestedBy) {
    return { status: 'rejected', error: 'requestedBy is required' };
  }

  const keyAdjustment = toInt(request.keyAdjustment) ?? 0;
  if (!validateKeyAdjustment(keyAdjustment)) {
    return { status: 'rejected', error: 'keyAdjustment must be between -6 and 6' };
  }

  let trackId = Number(request.trackId);
  let trackInfo = Number.isFinite(trackId)
    ? await query<{ id: number; source: string | null }>('SELECT id, source FROM tracks WHERE id = $1 LIMIT 1', [trackId])
    : { rows: [] as { id: number; source: string | null }[] };

  if (trackInfo.rows.length === 0 && request.externalUrl) {
    const title = String(request.title || request.externalUrl).trim();
    const { upsertArtist, upsertExternalTrack } = await import('../db');
    const artistId = request.artist ? await upsertArtist(request.artist) : null;
    const track = await upsertExternalTrack({
      artist_id: artistId,
      disc_id: request.discId || request.brand || null,
      title,
      external_url: request.externalUrl,
      source: request.source || 'karaoke-nerds',
      duration_ms: null,
    });
    trackId = Number(track.id);
    trackInfo = await query<{ id: number; source: string | null }>('SELECT id, source FROM tracks WHERE id = $1 LIMIT 1', [trackId]);
  }

  if (!Number.isFinite(trackId) || trackInfo.rows.length === 0) {
    return { status: 'rejected', error: 'Track not found on Station' };
  }

  const isExternal = trackInfo.rows[0].source && trackInfo.rows[0].source !== 'local';
  if (isExternal && await getSetting('libraries.external_enabled') === false) {
    return { status: 'rejected', error: 'External library is disabled' };
  }
  if (!isExternal && await getSetting('libraries.local_enabled') === false) {
    return { status: 'rejected', error: 'Local library is disabled' };
  }

  let singerId: bigint | null = null;
  try {
    const singer = await findOrCreateSinger(requestedBy, normalizeSingerUuid(request.singerUuid));
    singerId = singer.id;
    await ensureSingerInActiveRotation(singerId);
  } catch (err) {
    console.error('Remote Gateway singer creation failed:', err);
  }

  if (singerId) {
    const dupCheck = await query<{ id: string }>(
      `SELECT id FROM queue WHERE singer_id = $1 AND track_id = $2 AND status IN ('queued', 'playing') LIMIT 1`,
      [singerId, trackId],
    );
    if (dupCheck.rows.length > 0) {
      return { status: 'rejected', error: 'Singer already has this song in the queue' };
    }
  }

  const posr = await query<{ p: number }>(`SELECT COALESCE(MAX(position),0)+1 AS p FROM queue`);
  const position = (posr.rows[0] as any).p;
  const inserted = await query<{ id: string }>(
    `INSERT INTO queue(track_id, requested_by, singer_id, status, position, key_adjustment, notes)
     VALUES ($1,$2,$3,'queued',$4,$5,$6)
     RETURNING id`,
    [trackId, requestedBy, singerId, position, keyAdjustment, request.notes || null],
  );
  await resortQueueByRotation();
  postQueueUpdate('queue.updated');
  return { status: 'queued', stationQueueId: String(inserted.rows[0].id) };
}

async function pullRemoteGatewayRequests(config: RemoteGatewayConfig) {
  const pending = await callRemoteGateway(config, '/api/station/requests/pending?limit=100') as RemoteGatewayPendingRequest[];
  const results = {
    received: Array.isArray(pending) ? pending.length : 0,
    queued: 0,
    rejected: 0,
  };
  if (!Array.isArray(pending)) return results;

  for (const request of pending) {
    const result = await queueRemoteGatewayRequest(request);
    if (result.status === 'queued') {
      results.queued += 1;
    } else {
      results.rejected += 1;
    }
    await callRemoteGateway(config, `/api/station/requests/${encodeURIComponent(request.id)}/ack`, {
      method: 'POST',
      body: JSON.stringify(result),
    });
  }
  return results;
}

async function applyRemoteGatewayQueueAction(action: RemoteGatewayQueueAction): Promise<{ status: 'applied' | 'rejected'; error?: string }> {
  const requesterName = String(action.requestedBy ?? '').trim();
  const singerUuid = normalizeSingerUuid(action.singerUuid);
  const normalizedRequester = normalizeSingerName(requesterName);

  async function ownsQueueItem(queueId: number): Promise<boolean> {
    const row = await query<{ requested_by: string | null; public_uuid: string | null; status: string }>(
      `SELECT q.requested_by, s.public_uuid, q.status
         FROM queue q
         LEFT JOIN singers s ON s.id = q.singer_id
        WHERE q.id = $1
        LIMIT 1`,
      [queueId],
    );
    if (row.rows.length === 0 || row.rows[0].status !== 'queued') return false;
    return Boolean(
      (normalizedRequester && normalizeSingerName(row.rows[0].requested_by ?? '') === normalizedRequester) ||
      (singerUuid && row.rows[0].public_uuid === singerUuid)
    );
  }

  if (action.type === 'remove') {
    const queueId = Number(action.payload?.queueId);
    if (!Number.isFinite(queueId)) return { status: 'rejected', error: 'Invalid queue id' };
    if (!(await ownsQueueItem(queueId))) return { status: 'rejected', error: 'Queue item is not removable by this singer' };
    await query(`UPDATE queue SET status = 'removed' WHERE id = $1 AND status = 'queued'`, [queueId]);
    await resortQueueByRotation();
    postQueueUpdate('queue.updated');
    return { status: 'applied' };
  }

  if (action.type === 'reorder') {
    const queueIds = Array.isArray(action.payload?.queueIds)
      ? action.payload!.queueIds!.map((id) => Number(id)).filter((id) => Number.isFinite(id))
      : [];
    if (queueIds.length === 0) return { status: 'rejected', error: 'No queue ids provided' };
    for (const queueId of queueIds) {
      if (!(await ownsQueueItem(queueId))) {
        return { status: 'rejected', error: `Queue item ${queueId} is not reorderable by this singer` };
      }
    }

    const curRes = await query<{ id: string; position: number }>(
      `SELECT q.id, q.position
         FROM queue q
         LEFT JOIN singers s ON s.id = q.singer_id
        WHERE q.status = 'queued'
          AND (
            ($1 <> '' AND LOWER(TRIM(q.requested_by)) = $1)
            OR ($2 <> '' AND s.public_uuid = $2)
          )
        ORDER BY q.position`,
      [normalizedRequester, singerUuid || ''],
    );
    const sortedPositions = curRes.rows.map((row) => row.position).sort((a, b) => a - b);
    const TEMP_OFFSET = 2_500_000;
    await query('BEGIN');
    try {
      for (let i = 0; i < queueIds.length && i < sortedPositions.length; i++) {
        await query(`UPDATE queue SET position = $1 WHERE id = $2`, [TEMP_OFFSET + i, queueIds[i]]);
      }
      for (let i = 0; i < queueIds.length && i < sortedPositions.length; i++) {
        await query(`UPDATE queue SET position = $1 WHERE id = $2`, [sortedPositions[i], queueIds[i]]);
      }
      await query('COMMIT');
    } catch (error) {
      await query('ROLLBACK');
      throw error;
    }
    await resortQueueByRotation();
    postQueueUpdate('queue.updated');
    return { status: 'applied' };
  }

  return { status: 'rejected', error: 'Unsupported queue action' };
}

async function pullRemoteGatewayQueueActions(config: RemoteGatewayConfig) {
  const pending = await callRemoteGateway(config, '/api/station/queue-actions/pending?limit=100') as RemoteGatewayQueueAction[];
  const results = {
    received: Array.isArray(pending) ? pending.length : 0,
    applied: 0,
    rejected: 0,
  };
  if (!Array.isArray(pending)) return results;

  for (const action of pending) {
    const result = await applyRemoteGatewayQueueAction(action);
    if (result.status === 'applied') {
      results.applied += 1;
    } else {
      results.rejected += 1;
    }
    await callRemoteGateway(config, `/api/station/queue-actions/${encodeURIComponent(action.id)}/ack`, {
      method: 'POST',
      body: JSON.stringify(result),
    });
  }
  return results;
}

async function runRemoteGatewaySync(options: { includeCatalog: boolean }) {
  const config = await getRemoteGatewayConfig();
  const settings = await pushRemoteGatewaySettings(config);
  const catalog = options.includeCatalog ? await pushRemoteGatewayCatalog(config) : null;
  if (catalog) {
    remoteGatewayLastCatalogSync = Date.now();
  }
  const pulledRequests = await pullRemoteGatewayRequests(config);
  const queueActions = await pullRemoteGatewayQueueActions(config);
  const queue = await pushRemoteGatewayQueueSnapshot(config);
  const status = await getRemoteGatewayStatus(config);
  return {
    ok: true,
    gatewayUrl: config.url,
    settings,
    catalog,
    pulledRequests,
    queueActions,
    queue,
    status,
  };
}

async function getRemoteGatewayPollIntervalMs(): Promise<number> {
  const raw = await getSetting('remote_gateway.poll_interval_seconds');
  const parsed = Number(raw ?? DEFAULT_REMOTE_GATEWAY_POLL_SECONDS);
  const seconds = Number.isFinite(parsed) ? Math.max(MIN_REMOTE_GATEWAY_POLL_SECONDS, parsed) : DEFAULT_REMOTE_GATEWAY_POLL_SECONDS;
  return Math.round(seconds * 1000);
}

function clearRemoteGatewayTimer() {
  if (remoteGatewayTimer) {
    clearTimeout(remoteGatewayTimer);
    remoteGatewayTimer = null;
  }
}

async function scheduleNextRemoteGatewayPoll(delayMs?: number) {
  clearRemoteGatewayTimer();
  const intervalMs = delayMs ?? await getRemoteGatewayPollIntervalMs();
  remoteGatewayTimer = setTimeout(() => {
    void runRemoteGatewayPollCycle();
  }, intervalMs);
  remoteGatewayTimer.unref?.();
}

async function runRemoteGatewayPollCycle() {
  if (process.env.STATION_MODE !== 'true') return;
  if (remoteGatewayInFlight) return remoteGatewayInFlight;

  remoteGatewayInFlight = (async () => {
    try {
      const config = await getRemoteGatewayConfig();
      const shouldRefreshCatalog = Date.now() - remoteGatewayLastCatalogSync > REMOTE_GATEWAY_CATALOG_REFRESH_MS;
      const result = await runRemoteGatewaySync({ includeCatalog: shouldRefreshCatalog });
      logger.info(
        `[remoteGateway] poll complete: queued ${result.pulledRequests.queued}, rejected ${result.pulledRequests.rejected}, gateway pending ${result.status?.pendingRequests ?? 0}.`
      );
    } catch (err: any) {
      if (!String(err?.message || '').includes('not configured')) {
        logger.warn('[remoteGateway] poll failed:', err);
      }
    } finally {
      remoteGatewayInFlight = null;
      await scheduleNextRemoteGatewayPoll();
    }
  })();

  return remoteGatewayInFlight;
}

export async function syncRemoteGatewayTaskState(options: { runImmediately?: boolean } = {}) {
  if (process.env.STATION_MODE !== 'true') {
    clearRemoteGatewayTimer();
    return;
  }

  if (options.runImmediately) {
    if (remoteGatewayInFlight) {
      await remoteGatewayInFlight;
    }
    await runRemoteGatewayPollCycle();
    return;
  }

  if (!remoteGatewayTimer && !remoteGatewayInFlight) {
    await scheduleNextRemoteGatewayPoll(1_000);
  }
}

function isSingerHistoryKdFile(value: any): value is SingerHistoryKdFile {
  return value?.format === 'karaokedock.singer-history' && value?.version === 1 && Array.isArray(value?.singers);
}

async function resolveSingerForRequester(name: string, singerUuid?: string | null): Promise<{ id: string; publicUuid: string; displayName: string; normalizedName: string } | null> {
  const publicUuid = normalizeSingerUuid(singerUuid);
  if (publicUuid) {
    const singerRes = await query<{ id: string; public_uuid: string; display_name: string; normalized_name: string }>(
      `SELECT id, public_uuid, display_name, normalized_name FROM singers WHERE public_uuid = $1 LIMIT 1`,
      [publicUuid],
    );
    if (singerRes.rows.length > 0) {
      return {
        id: String(singerRes.rows[0].id),
        publicUuid: singerRes.rows[0].public_uuid,
        displayName: singerRes.rows[0].display_name,
        normalizedName: singerRes.rows[0].normalized_name,
      };
    }
  }

  const norm = normalizeSingerName(name);
  if (!norm) return null;
  const singerRes = await query<{ id: string; public_uuid: string; display_name: string; normalized_name: string }>(
    `SELECT id, public_uuid, display_name, normalized_name FROM singers WHERE normalized_name = $1 LIMIT 1`,
    [norm],
  );
  if (singerRes.rows.length > 0) {
    return {
      id: String(singerRes.rows[0].id),
      publicUuid: singerRes.rows[0].public_uuid,
      displayName: singerRes.rows[0].display_name,
      normalizedName: singerRes.rows[0].normalized_name,
    };
  }
  return null;
}

function getUserRequesterName(user: User | null): string {
  return String(user?.display_name || user?.username || '').trim();
}

async function getAuthenticatedRequesterSinger(req: express.Request, requestedBy: string): Promise<SingerRow | null> {
  const user = await getOptionalAuthenticatedUser(req);
  const userName = getUserRequesterName(user);
  if (!userName) return null;
  return findOrCreateSinger(userName, null);
}

async function updateActiveQueueRequesterName(singerId: bigint, displayName: string): Promise<void> {
  await query(
    `UPDATE queue
        SET requested_by = $1
      WHERE singer_id = $2
        AND status IN ('queued', 'playing')`,
    [displayName, singerId],
  );
}

async function buildSingerHistoryKdFile(options: {
  singerIds?: string[];
  requesterName?: string;
  singerUuid?: string | null;
  includeSingerInfo: boolean;
}): Promise<SingerHistoryKdFile> {
  const params: any[] = [];
  let whereClause = `q.status IN ('queued', 'playing', 'done', 'skipped', 'removed', 'cancelled')`;

  if (options.singerIds && options.singerIds.length > 0) {
    params.push(options.singerIds);
    whereClause += ` AND q.singer_id = ANY($${params.length}::bigint[])`;
  } else if (options.requesterName) {
    const norm = normalizeSingerName(options.requesterName);
    const singer = await resolveSingerForRequester(options.requesterName, options.singerUuid);
    if (singer) {
      params.push(singer.id, norm);
      whereClause += ` AND (q.singer_id = $${params.length - 1} OR LOWER(TRIM(q.requested_by)) = $${params.length})`;
    } else {
      params.push(norm);
      whereClause += ` AND LOWER(TRIM(q.requested_by)) = $${params.length}`;
    }
  }

  const rows = await query<{
    queue_id: string;
    track_id: string;
    requested_by: string | null;
    singer_id: string | null;
    status: string;
    key_adjustment: number | null;
    created_at: Date | null;
    finished_at: Date | null;
    title: string | null;
    artist: string | null;
    external_url: string | null;
    source: string | null;
    display_name: string | null;
    public_uuid: string | null;
    normalized_name: string | null;
    total_songs_sung: string | number | null;
    last_sang_at: Date | null;
  }>(
    `SELECT q.id AS queue_id,
            q.track_id,
            q.requested_by,
            q.singer_id,
            q.status,
            q.key_adjustment,
            q.created_at,
            q.finished_at,
            t.title,
            t.external_url,
            t.source,
            a.name AS artist,
            s.display_name,
            s.public_uuid,
            s.normalized_name,
            s.total_songs_sung,
            s.last_sang_at
       FROM queue q
       JOIN tracks t ON t.id = q.track_id
       LEFT JOIN artists a ON a.id = t.artist_id
       LEFT JOIN singers s ON s.id = q.singer_id
      WHERE ${whereClause}
      ORDER BY COALESCE(s.display_name, q.requested_by),
               CASE q.status WHEN 'playing' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,
               q.position NULLS LAST,
               q.finished_at NULLS LAST,
               q.created_at`,
    params,
  );

  const singers = new Map<string, SingerHistoryKdSinger>();
  for (const row of rows.rows) {
    const displayName = row.display_name || row.requested_by || options.requesterName || 'Unknown Singer';
    const normalizedName = row.normalized_name || normalizeSingerName(displayName);
    const singerKey = row.singer_id ? `id:${row.singer_id}` : `name:${normalizedName}`;
    if (!singers.has(singerKey)) {
      singers.set(singerKey, {
        singer: options.includeSingerInfo
          ? {
              id: row.singer_id ? String(row.singer_id) : undefined,
              uuid: row.public_uuid ?? undefined,
              displayName,
              normalizedName,
              totalSongsSung: row.total_songs_sung != null ? Number(row.total_songs_sung) : undefined,
              lastSangAt: row.last_sang_at ? new Date(row.last_sang_at).toISOString() : null,
            }
          : undefined,
        songs: [],
      });
    }
    const trackRef: SingerHistoryKdTrackRef =
      row.external_url
        ? { type: 'external', url: row.external_url, source: row.source }
        : { type: 'local', trackId: Number(row.track_id) };
    singers.get(singerKey)!.songs.push({
      title: row.title,
      artist: row.artist,
      status: row.status,
      keyAdjustment: Number(row.key_adjustment ?? 0),
      requestedAt: row.created_at ? new Date(row.created_at).toISOString() : null,
      completedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
      track: trackRef,
    });
  }

  return {
    format: 'karaokedock.singer-history',
    version: 1,
    exportedAt: new Date().toISOString(),
    singers: Array.from(singers.values()),
  };
}

async function resolveKdTrack(song: SingerHistoryKdSong): Promise<number | null> {
  if (song.track?.type === 'local') {
    const trackId = Number(song.track.trackId);
    if (!Number.isFinite(trackId)) return null;
    const found = await query<{ id: number }>(`SELECT id FROM tracks WHERE id = $1 LIMIT 1`, [trackId]);
    return found.rows.length > 0 ? trackId : null;
  }

  if (song.track?.type === 'external' && song.track.url) {
    const existing = await query<{ id: number }>(
      `SELECT id FROM tracks WHERE external_url = $1 LIMIT 1`,
      [song.track.url],
    );
    if (existing.rows.length > 0) return Number(existing.rows[0].id);
    const { upsertArtist, upsertExternalTrack } = await import('../db');
    const artistId = song.artist ? await upsertArtist(song.artist) : null;
    const track = await upsertExternalTrack({
      artist_id: artistId,
      disc_id: null,
      title: song.title || song.track.url,
      external_url: song.track.url,
      source: song.track.source || 'karaoke-nerds',
      duration_ms: null,
    });
    return Number(track.id);
  }

  return null;
}

async function importSingerHistoryKdFile(file: SingerHistoryKdFile, options: { requesterName?: string; singerUuid?: string | null }): Promise<{
  imported: number;
  skipped: number;
}> {
  let imported = 0;
  let skipped = 0;

  for (const singerEntry of file.singers) {
    const displayName = options.requesterName || singerEntry.singer?.displayName?.trim();
    if (!displayName) {
      skipped += singerEntry.songs?.length ?? 0;
      continue;
    }
    const singerUuid = options.singerUuid || singerEntry.singer?.uuid || null;
    const singer = await findOrCreateSinger(displayName, singerUuid);
    await ensureSingerInActiveRotation(singer.id);
    for (const song of singerEntry.songs || []) {
      const trackId = await resolveKdTrack(song);
      if (!trackId) {
        skipped++;
        continue;
      }
      const status = ['queued', 'done', 'skipped', 'removed', 'cancelled'].includes(song.status)
        ? song.status
        : song.status === 'playing'
          ? 'queued'
          : 'done';
      const posr = await query<{ p: number }>(`SELECT COALESCE(MAX(position),0)+1 AS p FROM queue`);
      const position = (posr.rows[0] as any).p;
      await query(
        `INSERT INTO queue(track_id, requested_by, singer_id, status, position, key_adjustment, created_at, finished_at)
         VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz, NOW()), $8::timestamptz)`,
        [
          trackId,
          displayName,
          singer.id,
          status,
          position,
          Number(song.keyAdjustment ?? 0),
          song.requestedAt,
          song.completedAt,
        ],
      );
      imported++;
    }
    await recalculateSingerStats(String(singer.id)).catch((err) =>
      console.error('Failed to recalculate singer stats after history import for singer', singer.id, err),
    );
  }

  return { imported, skipped };
}

const MAX_OIDC_USERNAME_LENGTH = 120;
const MAX_OIDC_USERNAME_ATTEMPTS = 100;
const OIDC_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_INSECURE_BOOTSTRAP_PASSWORD = 'changeme-password';

const sanitizeOidcUsername = (value: string): string =>
  value.trim().toLowerCase().replace(/[^a-z0-9@._+-]/g, '_').slice(0, MAX_OIDC_USERNAME_LENGTH);

const normalizeOidcReturnTo = (value: unknown): '/admin' | '/host' =>
  value === '/host' ? '/host' : '/admin';

const getOidcDisplayName = (claims: Record<string, unknown>, fallback: string): string => {
  const displayName = typeof claims.display_name === 'string' ? claims.display_name.trim() : '';
  const name = typeof claims.name === 'string' ? claims.name.trim() : '';
  return displayName || name || fallback;
};

const getOidcPicture = (claims: Record<string, unknown>): string | null => {
  const picture = typeof claims.picture === 'string' ? claims.picture.trim() : '';
  return picture || null;
};

const getOidcErrorMessage = (err: any): string => {
  const description = err?.error_description || err?.cause?.error_description;
  if (typeof description === 'string' && description.trim()) return description.trim();
  const error = err?.error || err?.cause?.error;
  if (typeof error === 'string' && error.trim()) return error.trim();
  const message = err?.message;
  if (typeof message === 'string' && message.trim()) return message.trim();
  return 'OIDC error';
};

const findAvailableOidcUsername = async (baseUsername: string, currentUserId?: number): Promise<string | null> => {
  if (!baseUsername) return null;

  let candidate = baseUsername;
  let attempt = 0;

  while (true) {
    const existing = await getUserByUsername(candidate);
    if (!existing || existing.id === currentUserId) {
      return candidate;
    }

    attempt++;
    if (attempt > MAX_OIDC_USERNAME_ATTEMPTS) {
      return null;
    }

    candidate = `${baseUsername}_${attempt}`;
  }
};

type BreakMusicTrackRow = {
  id: number;
  title: string;
  artist: string | null;
  genre: string | null;
  duration_ms: number | null;
  file_path: string;
};

type BreakMusicState = {
  paused: boolean;
  autoPaused: boolean;
  currentTrackId: number | null;
  currentStartedAt: string | null;
  currentPositionSec: number;
  playlistTrackIds: number[];
  playlistIndex: number;
  activePlaylistId: number | null;
};

async function getBreakMusicState(): Promise<BreakMusicState> {
  const [
    paused,
    autoPaused,
    currentTrackId,
    currentStartedAt,
    currentPositionSec,
    playlistTrackIds,
    playlistIndex,
    activePlaylistId,
  ] = await Promise.all([
    getSetting('break_music.paused'),
    getSetting('break_music.auto_paused'),
    getSetting('break_music.current_track_id'),
    getSetting('break_music.current_started_at'),
    getSetting('break_music.current_position_sec'),
    getSetting('break_music.playlist_track_ids'),
    getSetting('break_music.playlist_index'),
    getSetting('break_music.active_playlist_id'),
  ]);

  return {
    paused: paused === true,
    autoPaused: autoPaused === true,
    currentTrackId: Number.isFinite(Number(currentTrackId)) ? Number(currentTrackId) : null,
    currentStartedAt: typeof currentStartedAt === 'string' ? currentStartedAt : null,
    currentPositionSec: Number.isFinite(Number(currentPositionSec)) ? Number(currentPositionSec) : 0,
    playlistTrackIds: Array.isArray(playlistTrackIds)
      ? playlistTrackIds.map((v: any) => Number(v)).filter((v: number) => Number.isFinite(v))
      : [],
    playlistIndex: Number.isFinite(Number(playlistIndex)) ? Number(playlistIndex) : 0,
    activePlaylistId: Number.isFinite(Number(activePlaylistId)) ? Number(activePlaylistId) : null,
  };
}

async function setBreakMusicState(partial: Partial<BreakMusicState>) {
  const writes: Promise<void>[] = [];
  if (partial.paused !== undefined) writes.push(setSetting('break_music.paused', partial.paused));
  if (partial.autoPaused !== undefined) writes.push(setSetting('break_music.auto_paused', partial.autoPaused));
  if (partial.currentTrackId !== undefined) writes.push(setSetting('break_music.current_track_id', partial.currentTrackId));
  if (partial.currentStartedAt !== undefined) writes.push(setSetting('break_music.current_started_at', partial.currentStartedAt));
  if (partial.currentPositionSec !== undefined) writes.push(setSetting('break_music.current_position_sec', partial.currentPositionSec));
  if (partial.playlistTrackIds !== undefined) writes.push(setSetting('break_music.playlist_track_ids', partial.playlistTrackIds));
  if (partial.playlistIndex !== undefined) writes.push(setSetting('break_music.playlist_index', partial.playlistIndex));
  if (partial.activePlaylistId !== undefined) writes.push(setSetting('break_music.active_playlist_id', partial.activePlaylistId));
  await Promise.all(writes);
}

// Pause break music automatically when a karaoke request starts playing.
// Saves the current playback position and marks it as auto-paused so we can
// resume correctly when karaoke ends, without overriding a deliberate user pause.
async function autoPauseBreakMusicForKaraoke() {
  const breakState = await getBreakMusicState();
  if (breakState.paused || !breakState.currentTrackId) return;
  let currentPositionSec = breakState.currentPositionSec || 0;
  if (breakState.currentStartedAt) {
    const startedMs = Date.parse(breakState.currentStartedAt);
    if (Number.isFinite(startedMs)) {
      currentPositionSec = Math.max(currentPositionSec, Math.floor((Date.now() - startedMs) / 1000));
    }
  }
  await setBreakMusicState({ paused: true, autoPaused: true, currentPositionSec, currentStartedAt: null });
  postQueueUpdate('break_music.updated');
}

// Resume break music after a karaoke request ends, but only if it was
// auto-paused by karaoke start (not paused by the user).
async function autoResumeBreakMusicForKaraoke() {
  const breakState = await getBreakMusicState();
  if (!breakState.autoPaused) return;
  await setBreakMusicState({
    paused: false,
    autoPaused: false,
    currentStartedAt: new Date(Date.now() - Math.max(0, breakState.currentPositionSec) * 1000).toISOString(),
  });
  postQueueUpdate('break_music.updated');
}

async function getBreakTrackById(id: number | null): Promise<BreakMusicTrackRow | null> {
  if (!id) return null;
  const r = await query<BreakMusicTrackRow>(
    `SELECT id, title, artist, genre, duration_ms, file_path
       FROM break_music_tracks
      WHERE id = $1`,
    [id]
  );
  return r.rows[0] || null;
}

function sanitizePlaylistFilename(name: string) {
  const reservedNames = new Set([
    'CON', 'PRN', 'AUX', 'NUL',
    'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
    'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
  ]);
  const cleaned = name
    .normalize('NFKD')
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/_+/g, '_')
    .trim()
    .replace(/^[.\s_]+|[.\s_]+$/g, '');
  const fallbackSafe = cleaned || 'break-playlist';
  return reservedNames.has(fallbackSafe.toUpperCase()) ? `${fallbackSafe}-playlist` : fallbackSafe;
}

async function writeBreakMusicPlaylistFile(name: string, trackIds: number[]) {
  const playlistsFolder = String(await getSetting('break_music.playlists_folder') || DEFAULT_BREAK_PLAYLISTS_FOLDER).trim() || DEFAULT_BREAK_PLAYLISTS_FOLDER;
  const resolvedFolder = path.resolve(playlistsFolder);
  await fs.mkdir(resolvedFolder, { recursive: true });

  const tracks = trackIds.length
    ? await query<Pick<BreakMusicTrackRow, 'title' | 'artist' | 'duration_ms' | 'file_path'>>(
      `SELECT title, artist, duration_ms, file_path
         FROM break_music_tracks
        WHERE id = ANY($1)
        ORDER BY array_position($1::int[], id)`,
      [trackIds]
    )
    : { rows: [] };

  const lines = ['#EXTM3U'];
  for (const track of tracks.rows) {
    const durationSeconds = track.duration_ms ? Math.max(0, Math.floor(track.duration_ms / 1000)) : 0;
    const displayName = [track.artist, track.title].filter(Boolean).join(' - ') || path.basename(track.file_path);
    lines.push(`#EXTINF:${durationSeconds},${displayName}`);
    lines.push(track.file_path);
  }

  const outputPath = path.join(resolvedFolder, `${sanitizePlaylistFilename(name)}.m3u`);
  await fs.writeFile(outputPath, `${lines.join('\r\n')}\r\n`, 'utf8');
  return outputPath;
}

async function resolveBreakMusicPlaybackState(step: -1 | 0 | 1 = 0) {
  let state = await getBreakMusicState();
  let track = await getBreakTrackById(state.currentTrackId);

  const emptyPlaylistRows = { rows: [] as { id: number }[] };
  const playlistRows = state.playlistTrackIds.length
    ? await query<{ id: number }>(
      `SELECT id FROM break_music_tracks WHERE id = ANY($1) ORDER BY array_position($1::int[], id)`,
      [state.playlistTrackIds]
    )
    : emptyPlaylistRows;
  const playlist = playlistRows.rows.map(r => r.id);

  if (step === 0 && track && !state.paused && track.duration_ms && track.duration_ms > 0) {
    let elapsedSec = Math.max(0, state.currentPositionSec || 0);
    if (state.currentStartedAt) {
      const startedMs = Date.parse(state.currentStartedAt);
      if (Number.isFinite(startedMs)) {
        elapsedSec = Math.max(elapsedSec, Math.floor((Date.now() - startedMs) / 1000));
      }
    }

    const durationSec = Math.max(1, Math.floor(track.duration_ms / 1000));
    if (elapsedSec >= durationSec && playlist.length > 0) {
      const activeIndex = playlist.indexOf(track.id);
      const nextIndex = (activeIndex >= 0 ? activeIndex + 1 : state.playlistIndex + 1) % playlist.length;
      track = await getBreakTrackById(playlist[nextIndex]);
      const currentStartedAt = track ? new Date().toISOString() : null;
      state = {
        ...state,
        currentTrackId: track?.id ?? null,
        currentPositionSec: 0,
        currentStartedAt,
        playlistTrackIds: playlist,
        playlistIndex: nextIndex,
      };
      await setBreakMusicState({
        currentTrackId: state.currentTrackId,
        currentStartedAt: state.currentStartedAt,
        currentPositionSec: state.currentPositionSec,
        playlistTrackIds: state.playlistTrackIds,
        playlistIndex: state.playlistIndex,
      });
      postQueueUpdate('break_music.updated');
      return { state, track };
    }
  }

  if (step !== 0 && playlist.length > 0) {
    const activeIndex = track ? playlist.indexOf(track.id) : -1;
    const baseIndex = activeIndex >= 0
      ? activeIndex
      : Math.min(Math.max(state.playlistIndex, 0), playlist.length - 1);
    const nextIndex = (baseIndex + step + playlist.length) % playlist.length;
    track = await getBreakTrackById(playlist[nextIndex]);
    const currentStartedAt = track ? new Date().toISOString() : null;
    await setBreakMusicState({
      currentTrackId: track?.id ?? null,
      currentStartedAt,
      currentPositionSec: 0,
      playlistTrackIds: playlist,
      playlistIndex: nextIndex
    });
    return {
      state: {
        ...state,
        currentTrackId: track?.id ?? null,
        currentPositionSec: 0,
        currentStartedAt,
        playlistTrackIds: playlist,
        playlistIndex: nextIndex
      },
      track
    };
  }

  if (!track && playlist.length > 0) {
    const nextIndex = Math.min(Math.max(state.playlistIndex, 0), playlist.length - 1);
    track = await getBreakTrackById(playlist[nextIndex]);
    const currentStartedAt = track ? new Date().toISOString() : null;
    await setBreakMusicState({
      currentTrackId: track?.id ?? null,
      currentStartedAt,
      currentPositionSec: 0,
      playlistTrackIds: playlist,
      playlistIndex: nextIndex
    });
    return {
      state: {
        ...state,
        currentTrackId: track?.id ?? null,
        currentPositionSec: 0,
        currentStartedAt,
        playlistTrackIds: playlist,
        playlistIndex: nextIndex
      },
      track
    };
  }

  if (!track) {
    await setBreakMusicState({
      currentTrackId: null,
      currentStartedAt: null,
      currentPositionSec: 0,
      playlistTrackIds: playlist,
      playlistIndex: 0
    });
  }

  return { state: { ...state, playlistTrackIds: playlist }, track };
}

apiRouter.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Clean up expired sessions periodically
setInterval(() => {
  cleanupExpiredSessions().catch(err => console.error('Failed to cleanup sessions:', err));
}, 60 * 60 * 1000); // Run every hour

// ===================== AUTHENTICATION =====================

// Admin/Host login endpoint - validates username/password and creates a session
apiRouter.post(
  '/auth/login',
  authLimiter, // Apply strict rate limiting to prevent brute force attacks
  ah(async (req, res) => {
    const passwordLoginEnabled = await getSetting('auth.password_login_enabled');
    if (passwordLoginEnabled === false) {
      return res.status(403).json({ ok: false, message: 'Username/password login is disabled. Please use SSO.' });
    }

    const { username, password } = req.body;

    // --- Primary path: check users table first ---
    // This ensures passwords changed via User Manager take effect immediately.
    const userRecord = await getUserByUsername(username);
    if (userRecord && userRecord.password_hash) {
      if (!userRecord.is_active) {
        return res.status(401).json({ ok: false, message: 'Account is disabled' });
      }
      const isPasswordValid = await verifyPassword(password, userRecord.password_hash);
      if (!isPasswordValid) {
        return res.status(401).json({ ok: false, message: 'Invalid credentials' });
      }
      const isDefaultPassword = await verifyPassword(DEFAULT_INSECURE_BOOTSTRAP_PASSWORD, userRecord.password_hash);
      const sessionToken = await createSession(30, userRecord.id, userRecord.role);
      return res.json({
        ok: true,
        sessionToken,
        isDefaultPassword,
        role: userRecord.role,
        username: userRecord.username,
        displayName: userRecord.display_name,
        picture: userRecord.picture,
      });
    }

    // --- Legacy fallback: check admin.username / admin.password settings ---
    // Used during initial setup before the users table has a password_hash stored.
    const storedUsername = await getSetting('admin.username');
    const adminUsername = storedUsername || process.env.ADMIN_USERNAME || 'admin';

    const storedPassword = await getSetting('admin.password');
    const adminPassword = storedPassword || process.env.ADMIN_PASSWORD;

    if (username !== adminUsername) {
      return res.status(401).json({ ok: false, message: 'Invalid credentials' });
    }

    if (!adminPassword) {
      return res.status(401).json({ ok: false, message: 'Invalid credentials' });
    }

    const isPasswordValid = await verifyPassword(password, adminPassword);
    if (!isPasswordValid) {
      return res.status(401).json({ ok: false, message: 'Invalid credentials' });
    }

    const isDefaultPassword = await verifyPassword(DEFAULT_INSECURE_BOOTSTRAP_PASSWORD, adminPassword);

    // Find or create user record for this legacy admin and sync the password hash
    let user = userRecord; // may be null (no password_hash) or undefined
    if (!user) {
      user = await createUser({ username, role: 'admin' });
    }
    // Sync password hash into users table so future logins use the primary path
    await updateUser(user.id, { password }); // updateUser hashes the plaintext password before storing
    const updatedUser = await getUserById(user.id) || user;

    if (!updatedUser.is_active) {
      return res.status(401).json({ ok: false, message: 'Account is disabled' });
    }

    const sessionToken = await createSession(30, updatedUser.id, updatedUser.role);
    return res.json({
      ok: true,
      sessionToken,
      isDefaultPassword,
      role: updatedUser.role,
      username: updatedUser.username,
      displayName: updatedUser.display_name,
      picture: updatedUser.picture,
    });
  })
);

// Validate session endpoint - check if a session is still valid
apiRouter.get(
  '/auth/validate',
  ah(async (req, res) => {
    const token = req.headers['x-session-token'] as string;
    if (!token) {
      return res.status(401).json({ valid: false, role: 'user' });
    }
    
    const info = await validateSessionInfo(token);
    if (!info.valid) {
      return res.json({ valid: false, role: 'user' });
    }

    const user = info.userId ? await getUserById(info.userId) : null;
    res.json({
      valid: true,
      role: info.role,
      username: user?.username || null,
      displayName: user?.display_name || null,
      picture: user?.picture || null,
    });
  })
);

// Logout endpoint - invalidate session
apiRouter.post(
  '/auth/logout',
  ah(async (req, res) => {
    const token = req.headers['x-session-token'] as string;
    if (token) {
      await deleteSession(token);
    }
    res.json({ ok: true });
  })
);

// Change password endpoint - requires valid session
apiRouter.post(
  '/auth/change-password',
  sessionGuard,
  ah(async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new passwords are required' });
    }
    
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long' });
    }
    
    const currentUser = await getAuthenticatedUser(req);
    const legacyPassword = await getSetting('admin.password') || process.env.ADMIN_PASSWORD;
    const passwordToVerify = currentUser?.password_hash || legacyPassword;

    if (!passwordToVerify) {
      return res.status(400).json({ error: 'No password is configured for this account' });
    }

    const isPasswordValid = await verifyPassword(currentPassword, passwordToVerify);
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const updatedUser = currentUser ? await updateUser(currentUser.id, { password: newPassword }) : null;
    const hashedPassword = updatedUser?.password_hash || await hashPassword(newPassword);

    if (currentUser?.role === 'admin' || !currentUser) {
      await setSetting('admin.password', hashedPassword);
    }

    res.json({ ok: true });
  })
);

// Change username endpoint - requires valid session
apiRouter.post(
  '/auth/change-username',
  sessionGuard,
  ah(async (req, res) => {
    const { currentPassword, newUsername } = req.body;
    
    if (!currentPassword || !newUsername) {
      return res.status(400).json({ error: 'Current password and new username are required' });
    }
    
    if (newUsername.length < 3) {
      return res.status(400).json({ error: 'Username must be at least 3 characters long' });
    }
    
    const currentUser = await getAuthenticatedUser(req);
    const legacyPassword = await getSetting('admin.password') || process.env.ADMIN_PASSWORD;
    const passwordToVerify = currentUser?.password_hash || legacyPassword;

    if (!passwordToVerify) {
      return res.status(400).json({ error: 'No password is configured for this account' });
    }

    const isPasswordValid = await verifyPassword(currentPassword, passwordToVerify);
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    if (currentUser) {
      const existing = await getUserByUsername(newUsername);
      if (existing && existing.id !== currentUser.id) {
        return res.status(409).json({ error: 'Username already exists' });
      }
      await updateUser(currentUser.id, { username: newUsername });
      if (currentUser.role === 'admin') {
        await setSetting('admin.username', newUsername);
      }
    } else {
      await setSetting('admin.username', newUsername);
    }

    res.json({ ok: true });
  })
);

// Username/password admin login endpoint (session-based)
apiRouter.post(
  '/admin/login',
  authLimiter, // Apply strict rate limiting to prevent brute force attacks
  ah(async (req, res) => {
    const { username, password } = req.body;
    
    const storedUsername = await getSetting('admin.username');
    const adminUsername = storedUsername || process.env.ADMIN_USERNAME || 'admin';
    
    const storedPassword = await getSetting('admin.password');
    const adminPassword = storedPassword || process.env.ADMIN_PASSWORD;

    if (!adminPassword) {
      res.status(503).json({ ok: false, message: 'Admin password is not configured' });
      return;
    }
    
    // Check username first
    if (username !== adminUsername) {
      res.status(401).json({ ok: false, message: 'Invalid credentials' });
      return;
    }
    
    // Verify password using bcrypt
    const isPasswordValid = await verifyPassword(password, adminPassword);
    
    if (isPasswordValid) {
      res.json({ ok: true });
    } else {
      res.status(401).json({ ok: false, message: 'Invalid credentials' });
    }
  })
);

// ===================== USER MANAGEMENT =====================

// List all users (admin only)
apiRouter.get(
  '/admin/users',
  adminGuard,
  ah(async (_req, res) => {
    const users = await listUsers();
    // Strip password hashes from the response
    const safeUsers = users.map(u => ({
      id: u.id,
      username: u.username,
      display_name: u.display_name,
      picture: u.picture,
      role: u.role,
      is_active: u.is_active,
      oidc_subject: u.oidc_subject,
      oidc_issuer: u.oidc_issuer,
      created_at: u.created_at,
      updated_at: u.updated_at,
    }));
    res.json(safeUsers);
  })
);

// Create a new user (admin only)
apiRouter.post(
  '/admin/users',
  adminGuard,
  ah(async (req, res) => {
    const { username, password, role } = req.body;
    if (!username || typeof username !== 'string' || username.trim().length < 3) {
      return res.status(400).json({ error: 'Username must be at least 3 characters' });
    }
    if (!password || typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    if (role && role !== 'admin' && role !== 'user') {
      return res.status(400).json({ error: 'Role must be admin or user' });
    }

    const existing = await getUserByUsername(username.trim());
    if (existing) {
      return res.status(409).json({ error: 'Username already exists' });
    }

    const user = await createUser({ username: username.trim(), password, role: role || 'user' });
    res.json({
      id: user.id,
      username: user.username,
      role: user.role,
      is_active: user.is_active,
      created_at: user.created_at,
    });
  })
);

// Update a user (admin only)
apiRouter.put(
  '/admin/users/:id',
  adminGuard,
  ah(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid user id' });

    const { role, is_active, password } = req.body;

    // Prevent removing the last admin
    if (role === 'user' || is_active === false) {
      const target = await getUserById(id);
      if (target?.role === 'admin') {
        const adminCount = await countAdminUsers();
        if (adminCount <= 1) {
          return res.status(400).json({ error: 'Cannot demote or deactivate the last admin user' });
        }
      }
    }

    const updates: Parameters<typeof updateUser>[1] = {};
    if (role === 'admin' || role === 'user') updates.role = role;
    if (typeof is_active === 'boolean') updates.is_active = is_active;
    if (password && typeof password === 'string') {
      if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
      updates.password = password;
    }

    const updated = await updateUser(id, updates);
    if (!updated) return res.status(404).json({ error: 'User not found' });

    res.json({
      id: updated.id,
      username: updated.username,
      role: updated.role,
      is_active: updated.is_active,
      updated_at: updated.updated_at,
    });
  })
);

// Delete a user (admin only)
apiRouter.delete(
  '/admin/users/:id',
  adminGuard,
  ah(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid user id' });

    const target = await getUserById(id);
    if (!target) return res.status(404).json({ error: 'User not found' });

    // Prevent deleting the last admin
    if (target.role === 'admin') {
      const adminCount = await countAdminUsers();
      if (adminCount <= 1) {
        return res.status(400).json({ error: 'Cannot delete the last admin user' });
      }
    }

    await deleteUser(id);
    res.json({ ok: true });
  })
);

// ===================== OIDC SETTINGS =====================

// Public endpoint: get OIDC button config (for login page)
apiRouter.get(
  '/auth/oidc/config',
  ah(async (_req, res) => {
    if (process.env.STATION_MODE === 'true') {
      return res.json({
        enabled: false,
        buttonText: 'Login with SSO',
        buttonColor: '#6366f1',
        passwordLoginEnabled: true,
      });
    }

    const enabled = await getSetting('oidc.enabled');
    const buttonText = await getSetting('oidc.button_text');
    const buttonColor = await getSetting('oidc.button_color');
    const passwordLoginEnabled = await getSetting('auth.password_login_enabled');
    res.json({
      enabled: enabled === true,
      buttonText: buttonText || 'Login with SSO',
      buttonColor: buttonColor || '#6366f1',
      passwordLoginEnabled: passwordLoginEnabled !== false,
    });
  })
);

// Admin: get full OIDC config
apiRouter.get(
  '/admin/settings/oidc',
  adminGuard,
  ah(async (_req, res) => {
    if (process.env.STATION_MODE === 'true') {
      return res.json({
        enabled: false,
        issuer: '',
        clientId: '',
        clientSecret: '',
        redirectUri: '',
        buttonText: 'Login with SSO',
        buttonColor: '#6366f1',
        autoCreateUsers: false,
        defaultRole: 'user',
        passwordLoginEnabled: true,
        stationMode: true,
      });
    }

    const [enabled, issuer, clientId, clientSecret, redirectUri, buttonText, buttonColor, autoCreate, defaultRole, passwordLoginEnabled] =
      await Promise.all([
        getSetting('oidc.enabled'),
        getSetting('oidc.issuer'),
        getSetting('oidc.client_id'),
        getSetting('oidc.client_secret'),
        getSetting('oidc.redirect_uri'),
        getSetting('oidc.button_text'),
        getSetting('oidc.button_color'),
        getSetting('oidc.auto_create_users'),
        getSetting('oidc.default_role'),
        getSetting('auth.password_login_enabled'),
      ]);
    res.json({
      enabled: enabled === true,
      issuer: issuer || '',
      clientId: clientId || '',
      clientSecret: clientSecret ? '***' : '', // mask the secret
      redirectUri: redirectUri || '',
      buttonText: buttonText || 'Login with SSO',
      buttonColor: buttonColor || '#6366f1',
      autoCreateUsers: autoCreate !== false,
      defaultRole: defaultRole || 'user',
      passwordLoginEnabled: passwordLoginEnabled !== false,
    });
  })
);

// Admin: update OIDC config
apiRouter.put(
  '/admin/settings/oidc',
  adminGuard,
  ah(async (req, res) => {
    if (process.env.STATION_MODE === 'true') {
      return res.status(403).json({ error: 'OIDC/SSO is not available in Station mode' });
    }

    const {
      enabled,
      issuer,
      clientId,
      clientSecret,
      redirectUri,
      buttonText,
      buttonColor,
      autoCreateUsers,
      defaultRole,
      passwordLoginEnabled
    } = req.body;

    const tasks: Promise<void>[] = [];
    if (typeof enabled === 'boolean') tasks.push(setSetting('oidc.enabled', enabled));
    if (typeof issuer === 'string') tasks.push(setSetting('oidc.issuer', issuer.trim()));
    if (typeof clientId === 'string') tasks.push(setSetting('oidc.client_id', clientId.trim()));
    if (typeof clientSecret === 'string' && clientSecret.length > 0) {
      tasks.push(setSetting('oidc.client_secret', clientSecret));
    }
    if (typeof redirectUri === 'string') tasks.push(setSetting('oidc.redirect_uri', redirectUri.trim()));
    if (typeof buttonText === 'string') tasks.push(setSetting('oidc.button_text', buttonText.trim() || 'Login with SSO'));
    if (typeof buttonColor === 'string') tasks.push(setSetting('oidc.button_color', buttonColor));
    if (typeof autoCreateUsers === 'boolean') tasks.push(setSetting('oidc.auto_create_users', autoCreateUsers));
    if (defaultRole === 'admin' || defaultRole === 'user') tasks.push(setSetting('oidc.default_role', defaultRole));
    if (typeof passwordLoginEnabled === 'boolean') tasks.push(setSetting('auth.password_login_enabled', passwordLoginEnabled));

    await Promise.all(tasks);
    res.json({ ok: true });
  })
);

// ===================== OIDC AUTH FLOW =====================

// In-memory store for OIDC state/PKCE (expires after 10 minutes)
const oidcStateStore = new Map<string, { codeVerifier: string; createdAt: number; returnTo: '/admin' | '/host' }>();
const oidcExchangeStore = new Map<string, {
  sessionToken: string;
  role: string;
  username: string;
  displayName: string | null;
  picture: string | null;
  createdAt: number;
}>();

// Clean up expired OIDC states periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of oidcStateStore) {
    if (now - val.createdAt > 10 * 60 * 1000) oidcStateStore.delete(key);
  }
  for (const [key, val] of oidcExchangeStore) {
    if (now - val.createdAt > 2 * 60 * 1000) oidcExchangeStore.delete(key);
  }
}, 5 * 60 * 1000);

// Initiate OIDC login
apiRouter.get(
  '/auth/oidc/login',
  ah(async (req, res) => {
    if (process.env.STATION_MODE === 'true') {
      return res.status(404).json({ error: 'OIDC/SSO is not available in Station mode' });
    }

    const oidcEnabled = await getSetting('oidc.enabled');
    if (!oidcEnabled) {
      return res.status(400).json({ error: 'OIDC is not enabled' });
    }

    const issuerUrl = await getSetting('oidc.issuer');
    const clientId = await getSetting('oidc.client_id');
    const clientSecret = await getSetting('oidc.client_secret');
    const redirectUri = String(await getSetting('oidc.redirect_uri') || '').trim();

    if (!issuerUrl || !clientId || !clientSecret || !redirectUri) {
      return res.status(400).json({ error: 'OIDC is not fully configured' });
    }

    try {
      const config = await oidc.discovery(
        new URL(issuerUrl),
        clientId,
        {
          client_secret: clientSecret,
          redirect_uris: [redirectUri],
          response_types: ['code'],
        },
        oidc.ClientSecretPost(clientSecret),
      );

      const state = oidc.randomState();
      const codeVerifier = oidc.randomPKCECodeVerifier();
      const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
      const returnTo = normalizeOidcReturnTo(req.query.returnTo);

      oidcStateStore.set(state, { codeVerifier, createdAt: Date.now(), returnTo });

      const authUrl = oidc.buildAuthorizationUrl(config, {
        redirect_uri: new URL(redirectUri).href,
        scope: 'openid email profile',
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      });

      res.redirect(authUrl.href);
    } catch (err: any) {
      console.error('OIDC login error:', err);
      res.status(500).json({ error: 'OIDC configuration error: ' + (err.message || 'Unknown error') });
    }
  })
);

// OIDC callback handler
apiRouter.get(
  '/auth/oidc/callback',
  ah(async (req, res) => {
    const oidcEnabled = await getSetting('oidc.enabled');
    if (!oidcEnabled) {
      return res.status(400).send('OIDC is not enabled');
    }

    const issuerUrl = await getSetting('oidc.issuer');
    const clientId = await getSetting('oidc.client_id');
    const clientSecret = await getSetting('oidc.client_secret');
    const redirectUri = String(await getSetting('oidc.redirect_uri') || '').trim();

    if (!issuerUrl || !clientId || !clientSecret || !redirectUri) {
      return res.status(400).send('OIDC is not fully configured');
    }

    try {
      const config = await oidc.discovery(
        new URL(issuerUrl),
        clientId,
        {
          client_secret: clientSecret,
          redirect_uris: [redirectUri],
          response_types: ['code'],
        },
        oidc.ClientSecretPost(clientSecret),
      );

      const currentUrl = buildOidcGrantCallbackUrl(redirectUri, req.originalUrl);

      const stateKey = currentUrl.searchParams.get('state') || '';

      const stored = stateKey ? oidcStateStore.get(stateKey) : undefined;
      if (!stored) {
        return res.status(400).send('Invalid or expired OIDC state');
      }
      oidcStateStore.delete(stateKey);

      const tokenSet = await oidc.authorizationCodeGrant(
        config,
        currentUrl,
        {
          expectedState: stateKey,
          pkceCodeVerifier: stored.codeVerifier,
        },
      );

      const claims = tokenSet.claims();
      if (!claims?.sub) {
        throw new Error('Missing subject claim from OIDC token');
      }
      const sub = claims.sub;
      const emailClaim = typeof claims.email === 'string' ? claims.email.trim() : '';
      const email = emailClaim.toLowerCase();
      if (!email || !OIDC_EMAIL_REGEX.test(email)) {
        const frontendUrl = await getOidcFrontendUrl(req);
        return res.redirect(`${frontendUrl}${stored.returnTo}?oidc_error=Missing+or+invalid+email+claim+from+SSO+provider`);
      }
      const displayName = getOidcDisplayName(claims, email || sub);
      const picture = getOidcPicture(claims);
      const baseUsername = sanitizeOidcUsername(email);
      if (!baseUsername) {
        const frontendUrl = await getOidcFrontendUrl(req);
        return res.redirect(`${frontendUrl}${stored.returnTo}?oidc_error=Could+not+derive+username+from+email`);
      }

      // Find or create user
      let user = await getUserByOidcSubject(sub, issuerUrl);
      if (!user) {
        const autoCreate = await getSetting('oidc.auto_create_users');
        if (autoCreate === false) {
          // Redirect back with error
          const frontendUrl = await getOidcFrontendUrl(req);
          return res.redirect(`${frontendUrl}${stored.returnTo}?oidc_error=User+not+found`);
        }
        const defaultRole = (await getSetting('oidc.default_role')) || 'user';
        const username = await findAvailableOidcUsername(baseUsername);
        if (!username) {
          const frontendUrl = await getOidcFrontendUrl(req);
          return res.redirect(`${frontendUrl}${stored.returnTo}?oidc_error=Could+not+assign+a+unique+username`);
        }
        user = await createUser({
          username,
          role: defaultRole as 'admin' | 'user',
          oidc_subject: sub,
          oidc_issuer: issuerUrl,
          display_name: displayName,
          picture,
        });
      } else {
        let nextUsername = user.username;
        if (baseUsername && baseUsername !== user.username) {
          nextUsername = await findAvailableOidcUsername(baseUsername, user.id) || user.username;
        }

        const updatedUser = await updateUser(user.id, {
          username: nextUsername,
          display_name: displayName,
          picture,
        });
        if (updatedUser) {
          user = updatedUser;
        }
      }

      if (!user.is_active) {
        const frontendUrl = await getOidcFrontendUrl(req);
        return res.redirect(`${frontendUrl}${stored.returnTo}?oidc_error=Account+disabled`);
      }

      const sessionToken = await createSession(30, user.id, user.role);
      const exchangeCode = crypto.randomBytes(24).toString('hex');
      oidcExchangeStore.set(exchangeCode, {
        sessionToken,
        role: user.role,
        username: user.username,
        displayName: user.display_name,
        picture: user.picture,
        createdAt: Date.now(),
      });
      const frontendUrl = await getOidcFrontendUrl(req);
      res.redirect(`${frontendUrl}${stored.returnTo}?oidc_code=${exchangeCode}`);
    } catch (err: any) {
      console.error('OIDC callback error:', err);
      const frontendUrl = await getOidcFrontendUrl(req).catch(() => '');
      res.redirect(`${frontendUrl}/admin?oidc_error=${encodeURIComponent(getOidcErrorMessage(err))}`);
    }
  })
);

apiRouter.post(
  '/auth/oidc/exchange',
  ah(async (req, res) => {
    const code = String(req.body?.code || '').trim();
    if (!code) {
      return res.status(400).json({ error: 'OIDC exchange code is required' });
    }

    const entry = oidcExchangeStore.get(code);
    if (!entry || Date.now() - entry.createdAt > 2 * 60 * 1000) {
      oidcExchangeStore.delete(code);
      return res.status(400).json({ error: 'Invalid or expired OIDC exchange code' });
    }

    oidcExchangeStore.delete(code);

    res.json({
      ok: true,
      sessionToken: entry.sessionToken,
      role: entry.role,
      username: entry.username,
      displayName: entry.displayName,
      picture: entry.picture,
    });
  })
);

async function getOidcFrontendUrl(req: express.Request): Promise<string> {
  const stored = await getSetting('oidc.frontend_url');
  if (stored) return stored.replace(/\/$/, '');
  const webAppUrl = process.env.WEB_APP_URL?.trim();
  if (webAppUrl) return webAppUrl.replace(/\/$/, '');
  // Derive from ORIGIN env variable (first one)
  const origins = process.env.ORIGIN?.split(',').map((o: string) => o.trim()).filter(Boolean);
  if (origins?.length) return origins[0].replace(/\/$/, '');
  // Fall back to request origin
  const host = req.headers.host || 'localhost:5173';
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${host}`;
}

function getPublicWebAppUrl(req: express.Request): string {
  const webAppUrl = process.env.WEB_APP_URL?.trim();
  if (webAppUrl) return webAppUrl.replace(/\/$/, '');

  const origins = process.env.ORIGIN?.split(',').map((o: string) => o.trim()).filter(Boolean);
  if (origins?.length) return origins[0].replace(/\/$/, '');

  const host = req.headers.host || 'localhost:5173';
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  return `${proto}://${host}`.replace(/\/$/, '');
}

async function getPublicRequestsUrl(req: express.Request): Promise<string> {
  const [gatewayEnabled, gatewayUrl] = await Promise.all([
    getSetting('remote_gateway.enabled'),
    getSetting('remote_gateway.url'),
  ]);
  const normalizedGatewayUrl = String(gatewayUrl ?? '').trim().replace(/\/+$/, '');
  if (gatewayEnabled === true && normalizedGatewayUrl) {
    return normalizedGatewayUrl;
  }
  return `${getPublicWebAppUrl(req)}/requests`;
}

function sseSend(res: express.Response, event: string, data: any) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

apiRouter.get('/scan/events', ah(async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  sseSend(res, 'hello', await getLibraryScanStatus());

  const onStart = () => sseSend(res, 'scan_start', { at: new Date().toISOString() });
  const onProgress = (payload: any) => sseSend(res, 'scan_progress', payload);
  const onDone = (payload: any) => sseSend(res, 'scan_done', payload);

  onLibraryScanEvent('start', onStart);
  onLibraryScanEvent('progress', onProgress);
  onLibraryScanEvent('done', onDone);

  req.on('close', () => {
    offLibraryScanEvent('start', onStart);
    offLibraryScanEvent('progress', onProgress);
    offLibraryScanEvent('done', onDone);
    res.end();
  });
}));

// ===================== LIBRARIES =====================

apiRouter.get(
  '/libraries',
  ah(async (_req, res) => {
    const r = await query<{ id: number; name: string; path: string; parse_mode: LibraryParseMode | null }>(
      `SELECT id, name, path, parse_mode FROM libraries ORDER BY id`
    );
    res.json(
      r.rows.map((row) => ({
        id: row.id,
        name: row.name,
        path: row.path,
        parseMode: row.parse_mode ?? DEFAULT_LIBRARY_PARSE_MODE,
      }))
    );
  })
);

apiRouter.post(
  '/libraries',
  adminGuard,
  ah(async (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    const libPath = String(req.body?.path ?? '').trim();
    const parseMode = req.body?.parseMode ?? DEFAULT_LIBRARY_PARSE_MODE;
    if (!name || !libPath) return res.status(400).send('name and path required');
    if (!isLibraryParseMode(parseMode)) return res.status(400).send('invalid parse mode');
    await query(`INSERT INTO libraries (name, path, parse_mode) VALUES ($1, $2, $3)`, [
      name,
      libPath,
      parseMode,
    ]);
    res.json({ ok: true });
  })
);

apiRouter.delete(
  '/libraries/:id',
  adminGuard,
  ah(async (req, res) => {
    const id = toInt(req.params.id);
    if (id == null) return res.status(400).send('id required');
    const result = await query<{ detached_tracks: string; deleted_libraries: string }>(
      `
      WITH detached AS (
        UPDATE tracks SET library_id = NULL WHERE library_id = $1
        RETURNING 1
      ),
      deleted AS (
        DELETE FROM libraries WHERE id = $1
        RETURNING 1
      )
      SELECT
        (SELECT COUNT(*) FROM detached) AS detached_tracks,
        (SELECT COUNT(*) FROM deleted) AS deleted_libraries
      `,
      [id]
    );
    const row = result.rows[0];
    if (!row || Number(row.deleted_libraries) === 0) {
      return res.status(404).json({ error: 'Library not found' });
    }
    res.json({ ok: true, detachedTracks: Number(row.detached_tracks) });
  })
);

// ===================== SCAN =====================

apiRouter.post(
  '/scan',
  adminGuard,
  ah(async (req, res) => {
    const libraryId = Number.isFinite(+req.body?.libraryId) ? +req.body.libraryId : null;
    try {
      const result = await runLibraryScan(libraryId);
      res.json({ ok: true, stats: result.stats });
    } catch (error) {
      if (error instanceof LibraryScanAlreadyInProgressError) {
        return res.status(409).json({ ok: false, message: error.message });
      }
      if (error instanceof Error && error.message === 'library not found') {
        return res.status(404).send('library not found');
      }
      throw error;
    }
  })
);

// ===================== ADMIN STATS =====================

apiRouter.get(
  '/admin/stats',
  adminGuard,
  ah(async (_req, res) => {
    const [{ lastScan }, artists, tracks, queued] = await Promise.all([
      getLibraryScanStatus(),
      query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM artists`),
      query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM tracks`),
      query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM queue`),
    ]);
    res.json({
      artists: Number(artists.rows[0].c),
      tracks: Number(tracks.rows[0].c),
      queued: Number(queued.rows[0].c),
      lastScan,
    });
  })
);

// ===================== SEARCH =====================

const ARTIST_BROWSE_LETTER_SQL = `
  CASE
    WHEN substring(BTRIM(COALESCE(a.name, '')) from 1 for 1) ~ '^[A-Za-z]$'
      THEN upper(substring(BTRIM(COALESCE(a.name, '')) from 1 for 1))
    ELSE '#'
  END
`;

const TITLE_BROWSE_LETTER_SQL = `
  CASE
    WHEN substring(BTRIM(COALESCE(t.title, '')) from 1 for 1) ~ '^[A-Za-z]$'
      THEN upper(substring(BTRIM(COALESCE(t.title, '')) from 1 for 1))
    ELSE '#'
  END
`;

function parseLocalKindFilter(value: unknown): 'mp4' | 'cdgmp3' | undefined {
  return value === 'mp4' || value === 'cdgmp3' ? value : undefined;
}

function parseLocalSearchField(value: unknown): 'all' | 'artist' | 'title' {
  return value === 'artist' || value === 'title' ? value : 'all';
}

function normalizeBrowseMode(value: unknown): 'artist' | 'title' | null {
  return value === 'artist' || value === 'title' ? value : null;
}

function normalizeBrowseLetter(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toUpperCase();
  if (trimmed === '#') return '#';
  return /^[A-Z]$/.test(trimmed) ? trimmed : null;
}

async function isLocalLibraryEnabled(): Promise<boolean> {
  return await getSetting('libraries.local_enabled') !== false;
}

async function isLocalBrowseEnabled(): Promise<boolean> {
  return await getSetting('requests.local_browse_enabled') !== false;
}

apiRouter.get(
  '/search',
  searchLimiter, // Apply rate limiting to prevent search abuse
  ah(async (req, res) => {
    // Check if local library is enabled
    if (!(await isLocalLibraryEnabled())) {
      return res.status(403).json({ error: 'Local library search is disabled' });
    }
    
    const q = String(req.query.q ?? '').trim();
    const kindFilter = req.query.kind as string | undefined;
    const fieldFilter = parseLocalSearchField(req.query.field);
    const libraryIdFilter = req.query.library_id ? Number(req.query.library_id) : undefined;
    
    if (!q) return res.json([]);

    // Build filter conditions
    let filterConditions = '';
    let rankedSearchConditions = `
      LOWER(t.title) LIKE '%' || LOWER($1) || '%'
      OR LOWER(a.name) LIKE '%' || LOWER($1) || '%'
      OR t.disc_id ILIKE '%' || $1 || '%'
      OR to_tsvector('english', COALESCE(t.title,'')) @@ plainto_tsquery('english', $1)
    `;
    let fallbackSearchConditions = `
      t.title ILIKE '%' || $1 || '%'
      OR a.name ILIKE '%' || $1 || '%'
      OR t.disc_id ILIKE '%' || $1 || '%'
    `;
    const queryParams: any[] = [q];
    let paramIndex = 2;

    if (fieldFilter === 'artist') {
      rankedSearchConditions = `LOWER(a.name) LIKE '%' || LOWER($1) || '%'`;
      fallbackSearchConditions = `a.name ILIKE '%' || $1 || '%'`;
    } else if (fieldFilter === 'title') {
      rankedSearchConditions = `
        LOWER(t.title) LIKE '%' || LOWER($1) || '%'
        OR to_tsvector('english', COALESCE(t.title,'')) @@ plainto_tsquery('english', $1)
      `;
      fallbackSearchConditions = `t.title ILIKE '%' || $1 || '%'`;
    }

    if (kindFilter && (kindFilter === 'mp4' || kindFilter === 'cdgmp3')) {
      filterConditions += ` AND t.kind = $${paramIndex}`;
      queryParams.push(kindFilter);
      paramIndex++;
    }

    if (libraryIdFilter !== undefined) {
      filterConditions += ` AND t.library_id = $${paramIndex}`;
      queryParams.push(libraryIdFilter);
      paramIndex++;
    }

    try {
      // Enhanced search with better ranking
      // Priority order:
      // 1. Exact title match (highest)
      // 2. Title starts with query
      // 3. Title contains query
      // 4. Full-text search match in title
      // 5. Exact artist match
      // 6. Artist starts with query
      // 7. Artist contains query
      // 8. Disc ID match
      const searchResults = await query(
        `
        WITH ranked_results AS (
          SELECT DISTINCT ON (t.id)
                 t.id,
                 t.title,
                 t.disc_id,
                 t.kind,
                 a.name AS artist,
                 CASE
                   -- Exact title match (case-insensitive)
                   WHEN LOWER(t.title) = LOWER($1) THEN 1
                   -- Title starts with query
                   WHEN LOWER(t.title) LIKE LOWER($1) || '%' THEN 2
                   -- Contains query in title
                   WHEN LOWER(t.title) LIKE '%' || LOWER($1) || '%' THEN 3
                   -- Full-text search in title
                   WHEN to_tsvector('english', COALESCE(t.title,'')) @@ plainto_tsquery('english', $1) THEN 4
                   -- Exact artist match
                   WHEN LOWER(a.name) = LOWER($1) THEN 5
                   -- Artist starts with query
                   WHEN LOWER(a.name) LIKE LOWER($1) || '%' THEN 6
                   -- Contains query in artist
                   WHEN LOWER(a.name) LIKE '%' || LOWER($1) || '%' THEN 7
                   -- Disc ID match
                   WHEN t.disc_id ILIKE '%' || $1 || '%' THEN 8
                   ELSE 9
                 END AS rank
            FROM tracks t
            LEFT JOIN artists a ON a.id = t.artist_id
           WHERE (t.source IS NULL OR t.source = 'local')
                 AND (${rankedSearchConditions})
                 ${filterConditions}
        )
        SELECT id, title, disc_id, kind, artist
          FROM ranked_results
         ORDER BY rank ASC, 
                  LOWER(artist) NULLS LAST, 
                  LOWER(title)
         LIMIT 1000
        `,
        queryParams
      );
      
      return res.json(searchResults.rows);
    } catch (err) {
      console.error('Search error:', err);
      
      // Fallback to simple ILIKE search
      const like = await query(
        `
        SELECT t.id,
               t.title,
               t.disc_id,
               t.kind,
               a.name AS artist
          FROM tracks t
          LEFT JOIN artists a ON a.id = t.artist_id
         WHERE (t.source IS NULL OR t.source = 'local')
           AND (${fallbackSearchConditions})
            ${filterConditions}
         ORDER BY a.name NULLS LAST, t.title
         LIMIT 1000
        `,
        queryParams
      );
      return res.json(like.rows);
    }
  })
);

// ---------------------------------------------------------------------------
// GET /api/search/suggestions — fuzzy "did you mean?" suggestions
// Returns up to 5 tracks that closely match the query using word-level search,
// intended for use when the main search returns few/no results.
// ---------------------------------------------------------------------------
apiRouter.get(
  '/search/suggestions',
  searchLimiter,
  ah(async (req, res) => {
    if (!(await isLocalLibraryEnabled())) return res.json([]);
    const q = String(req.query.q ?? '').trim();
    if (q.length < 2) return res.json([]);

    // Split query into words and search for each independently, rank by match count
    const words = q.toLowerCase().split(/\s+/).filter(w => w.length >= 2).slice(0, 5);
    if (words.length === 0) return res.json([]);

    // Build per-word LIKE conditions and a score expression
    const params: any[] = [];
    const wordConds: string[] = [];
    const scoreTerms: string[] = [];
    for (const word of words) {
      params.push(`%${word}%`);
      const p = `$${params.length}`;
      wordConds.push(`(LOWER(t.title) LIKE ${p} OR LOWER(COALESCE(a.name,'')) LIKE ${p})`);
      scoreTerms.push(`(CASE WHEN LOWER(t.title) LIKE ${p} OR LOWER(COALESCE(a.name,'')) LIKE ${p} THEN 1 ELSE 0 END)`);
    }

    try {
      const result = await query(
        `SELECT t.id, t.title, t.disc_id, t.kind, a.name AS artist,
                (${scoreTerms.join(' + ')}) AS score
           FROM tracks t
           LEFT JOIN artists a ON a.id = t.artist_id
          WHERE (t.source IS NULL OR t.source = 'local')
            AND (${wordConds.join(' OR ')})
          ORDER BY score DESC, LOWER(COALESCE(a.name,'')), LOWER(COALESCE(t.title,''))
          LIMIT 5`,
        params,
      );
      res.json(result.rows);
    } catch {
      res.json([]);
    }
  })
);

apiRouter.get(
  '/search/browse/letters',
  searchLimiter,
  ah(async (req, res) => {
    if (!(await isLocalLibraryEnabled())) {
      return res.status(403).json({ error: 'Local library browse is disabled' });
    }
    if (!(await isLocalBrowseEnabled())) {
      return res.status(403).json({ error: 'Local library browse is disabled' });
    }

    const mode = normalizeBrowseMode(req.query.mode);
    if (!mode) {
      return res.status(400).json({ error: 'Browse mode must be "artist" or "title"' });
    }

    const kindFilter = parseLocalKindFilter(req.query.kind);
    const letterSql = mode === 'artist' ? ARTIST_BROWSE_LETTER_SQL : TITLE_BROWSE_LETTER_SQL;
    const columnSql = mode === 'artist' ? 'a.name' : 't.title';
    const params: any[] = [];
    let kindClause = '';

    if (kindFilter) {
      params.push(kindFilter);
      kindClause = ` AND t.kind = $${params.length}`;
    }

    const result = await query<{ letter: string }>(
      `
      SELECT letter
        FROM (
          SELECT DISTINCT ${letterSql} AS letter,
                 CASE WHEN ${letterSql} = '#' THEN 1 ELSE 0 END AS sort_group
            FROM tracks t
            LEFT JOIN artists a ON a.id = t.artist_id
           WHERE (t.source IS NULL OR t.source = 'local')
             AND ${columnSql} IS NOT NULL
             AND BTRIM(${columnSql}) <> ''
             ${kindClause}
        ) letters
       ORDER BY sort_group, letter
      `,
      params
    );

    res.json({ letters: result.rows.map((row) => row.letter) });
  })
);

apiRouter.get(
  '/search/browse/artists',
  searchLimiter,
  ah(async (req, res) => {
    if (!(await isLocalLibraryEnabled())) {
      return res.status(403).json({ error: 'Local library browse is disabled' });
    }
    if (!(await isLocalBrowseEnabled())) {
      return res.status(403).json({ error: 'Local library browse is disabled' });
    }

    const letter = normalizeBrowseLetter(req.query.letter);
    if (!letter) {
      return res.status(400).json({ error: 'A browse letter is required' });
    }

    const kindFilter = parseLocalKindFilter(req.query.kind);
    const params: any[] = [letter];
    let kindClause = '';

    if (kindFilter) {
      params.push(kindFilter);
      kindClause = ` AND t.kind = $${params.length}`;
    }

    const result = await query<{ artist: string; songCount: string; versionCount: string }>(
      `
      SELECT artist,
             song_count AS "songCount",
             version_count AS "versionCount"
        FROM (
          SELECT a.name AS artist,
                 COUNT(DISTINCT LOWER(BTRIM(COALESCE(t.title, '')))) AS song_count,
                 COUNT(*) AS version_count,
                 LOWER(a.name) AS sort_artist
            FROM tracks t
            LEFT JOIN artists a ON a.id = t.artist_id
           WHERE (t.source IS NULL OR t.source = 'local')
             AND a.name IS NOT NULL
             AND BTRIM(a.name) <> ''
             AND ${ARTIST_BROWSE_LETTER_SQL} = $1
             ${kindClause}
           GROUP BY a.name
        ) artists
       ORDER BY sort_artist
      `,
      params
    );

    res.json({
      artists: result.rows.map((row) => ({
        artist: row.artist,
        songCount: Number(row.songCount),
        versionCount: Number(row.versionCount),
      })),
    });
  })
);

apiRouter.get(
  '/search/browse/titles',
  searchLimiter,
  ah(async (req, res) => {
    if (!(await isLocalLibraryEnabled())) {
      return res.status(403).json({ error: 'Local library browse is disabled' });
    }
    if (!(await isLocalBrowseEnabled())) {
      return res.status(403).json({ error: 'Local library browse is disabled' });
    }

    const letter = normalizeBrowseLetter(req.query.letter);
    if (!letter) {
      return res.status(400).json({ error: 'A browse letter is required' });
    }

    const kindFilter = parseLocalKindFilter(req.query.kind);
    const params: any[] = [letter];
    let kindClause = '';

    if (kindFilter) {
      params.push(kindFilter);
      kindClause = ` AND t.kind = $${params.length}`;
    }

    const result = await query(
      `
      SELECT t.id,
             t.title,
             t.disc_id,
             t.kind,
             a.name AS artist
        FROM tracks t
        LEFT JOIN artists a ON a.id = t.artist_id
       WHERE (t.source IS NULL OR t.source = 'local')
         AND t.title IS NOT NULL
         AND BTRIM(t.title) <> ''
         AND ${TITLE_BROWSE_LETTER_SQL} = $1
         ${kindClause}
       ORDER BY LOWER(t.title), LOWER(a.name) NULLS LAST, t.disc_id NULLS LAST
      `,
      params
    );

    res.json(result.rows);
  })
);

apiRouter.get(
  '/search/browse/artist-tracks',
  searchLimiter,
  ah(async (req, res) => {
    if (!(await isLocalLibraryEnabled())) {
      return res.status(403).json({ error: 'Local library browse is disabled' });
    }
    if (!(await isLocalBrowseEnabled())) {
      return res.status(403).json({ error: 'Local library browse is disabled' });
    }

    const artist = String(req.query.artist ?? '').trim();
    if (!artist) {
      return res.status(400).json({ error: 'An artist is required' });
    }

    const kindFilter = parseLocalKindFilter(req.query.kind);
    const params: any[] = [artist];
    let kindClause = '';

    if (kindFilter) {
      params.push(kindFilter);
      kindClause = ` AND t.kind = $${params.length}`;
    }

    const result = await query(
      `
      SELECT t.id,
             t.title,
             t.disc_id,
             t.kind,
             a.name AS artist
        FROM tracks t
        LEFT JOIN artists a ON a.id = t.artist_id
       WHERE (t.source IS NULL OR t.source = 'local')
         AND a.name IS NOT NULL
         AND LOWER(BTRIM(a.name)) = LOWER(BTRIM($1))
         ${kindClause}
       ORDER BY LOWER(t.title), t.disc_id NULLS LAST
      `,
      params
    );

    res.json(result.rows);
  })
);

// ===================== KARAOKE NERDS SEARCH =====================

apiRouter.get(
  '/karaoke-nerds/search',
  searchLimiter, // Apply rate limiting to prevent search abuse
  ah(async (req, res) => {
    // Check if external library is enabled
    const externalLibraryEnabled = await getSetting('libraries.external_enabled');
    if (externalLibraryEnabled === false) {
      return res.status(403).json({ error: 'External library search is disabled' });
    }
    
    const q = String(req.query.q ?? '').trim();
    if (!q) return res.json([]);

    const results = await searchKaraokeNerds(q);
    res.json(results);
  })
);

// Add Karaoke Nerds track to queue
apiRouter.post(
  '/karaoke-nerds/add',
  queueLimiter, // Apply rate limiting to prevent abuse
  ah(async (req, res) => {
    // Check if external library is enabled
    const externalLibraryEnabled = await getSetting('libraries.external_enabled');
    if (externalLibraryEnabled === false) {
      return res.status(403).json({ error: 'External library is disabled' });
    }
    
    const { title, artist, url, requestedBy, keyAdjustment, brand, discId } = req.body;
    const singerUuid = normalizeSingerUuid(req.body?.singerUuid);
    
    if (!title || !url) {
      return res.status(400).send('title and url required');
    }

    // Import upsertArtist and upsertExternalTrack
    const { upsertArtist, upsertExternalTrack } = await import('../db');
    const { getYouTubeDuration } = await import('../karaoke-nerds');
    
    // Insert artist if provided
    const artistId = artist ? await upsertArtist(artist) : null;
    
    // Try to get YouTube video duration (async, don't wait for it to fail)
    let duration_ms: number | null = null;
    try {
      const durationSeconds = await getYouTubeDuration(url);
      if (durationSeconds) {
        duration_ms = Math.round(durationSeconds * 1000);
        logger.verbose(`Got YouTube duration for "${title}": ${durationSeconds}s`);
      }
    } catch (err) {
      logger.warn('Failed to get YouTube duration:', err);
    }
    
    // Upsert the external track
    const track = await upsertExternalTrack({
      artist_id: artistId,
      disc_id: brand || discId || null,
      title,
      external_url: url,
      source: 'karaoke-nerds',
      duration_ms
    });
    
    // Add to queue
    const posr = await query<{ p: number }>(`SELECT COALESCE(MAX(position),0)+1 AS p FROM queue`);
    const position = (posr.rows[0] as any).p;

    const keyAdj = toInt(keyAdjustment) ?? 0;
    if (!validateKeyAdjustment(keyAdj)) {
      return res.status(400).send('keyAdjustment must be between -6 and 6');
    }

    // Find or create singer for this request
    let kn_singerId: bigint | null = null;
    let queueRequestedBy = requestedBy || null;
    if (requestedBy && requestedBy.trim()) {
      try {
        const singer = await getAuthenticatedRequesterSinger(req, requestedBy) ?? await findOrCreateSinger(requestedBy, singerUuid);
        kn_singerId = singer.id;
        queueRequestedBy = singer.display_name || requestedBy;
        await ensureSingerInActiveRotation(kn_singerId);
      } catch (err) {
        console.error('findOrCreateSinger / ensureSingerInActiveRotation failed:', err);
      }
    }

    // Try to insert with key_adjustment if the column exists
    try {
      const r = await query(
        `INSERT INTO queue(track_id, requested_by, singer_id, status, position, key_adjustment)
         VALUES ($1,$2,$3,'queued',$4,$5)
         RETURNING id, track_id, requested_by, singer_id, status, position, key_adjustment, created_at`,
        [track.id, queueRequestedBy, kn_singerId, position, keyAdj]
      );
      res.json(r.rows[0]);
      await resortQueueByRotation();
      postQueueUpdate('queue.updated');
      return;
    } catch (err: any) {
      // If key_adjustment column doesn't exist, fall back to insert without it
      // PostgreSQL error code 42703 = undefined_column
      const isColumnNotFound = 
        err?.code === '42703' || 
        (err?.message?.includes('key_adjustment') && err?.message?.includes('does not exist'));
      
      if (isColumnNotFound) {
        console.warn('key_adjustment column does not exist in queue table, inserting without it');
        const r = await query(
          `INSERT INTO queue(track_id, requested_by, singer_id, status, position)
           VALUES ($1,$2,$3,'queued',$4)
           RETURNING id, track_id, requested_by, singer_id, status, position, created_at`,
          [track.id, queueRequestedBy, kn_singerId, position]
        );
        res.json(r.rows[0]);
        await resortQueueByRotation();
        postQueueUpdate('queue.updated');
        return;
      }
      // Re-throw if it's a different error
      throw err;
    }
  })
);

// Get video metadata from URL (title, etc.)
apiRouter.get(
  '/video-metadata',
  ah(async (req, res) => {
    const url = String(req.query.url ?? '').trim();
    if (!url) {
      return res.status(400).json({ error: 'url parameter required' });
    }

    try {
      const { getYouTubeTitle } = await import('../karaoke-nerds');
      const title = await getYouTubeTitle(url);
      
      if (title) {
        res.json({ title });
      } else {
        // Fallback: extract from URL
        const fallbackTitle = url.split('/').pop()?.split('?')[0] || 'Video';
        res.json({ title: fallbackTitle });
      }
    } catch (err) {
      console.error('Error fetching video metadata:', err);
      // Fallback: extract from URL
      const fallbackTitle = url.split('/').pop()?.split('?')[0] || 'Video';
      res.json({ title: fallbackTitle });
    }
  })
);

// ===================== MEDIA =====================

apiRouter.get(
  '/media/info',
  ah(async (req, res) => {
    const id = toInt(req.query.id);
    if (id == null) return res.status(400).send('id required');
    const r = await query(
      `SELECT id, kind, file_mp4, file_cdg, file_mp3, path FROM tracks WHERE id=$1`,
      [id]
    );
    if (!r.rows.length) return res.status(404).send('not found');
    res.json(r.rows[0]);
  })
);

apiRouter.get(
  '/media/file',
  ah(async (req, res) => {
    try {
      const p = String(req.query.path || '');
      if (!p) return res.status(400).send('path required');
      if (p.startsWith('zip://')) {
        const parsed = parseZipMediaRef(p);
        const zipPath = parsed?.zipPath || '';
        const inner = parsed?.entryName || '';
        const safeZipPath = resolveExistingMediaPath(zipPath);
        if (!safeZipPath) return res.status(400).send('invalid path');
        res.redirect(`/media/zip?zip=${encodeURIComponent(safeZipPath)}&file=${encodeURIComponent(inner)}`);
        return;
      }
      const safePath = resolveExistingMediaPath(p);
      if (!safePath) return res.status(400).send('invalid path');
      const stat = await fs.stat(safePath);
      res.setHeader('Content-Length', String(stat.size));
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(safePath);
    } catch {
      res.status(404).send('file not found');
    }
  })
);

// Add to your browse endpoint - ensure it handles permissions correctly
apiRouter.get(
  '/browse',
  adminGuard,
  ah(async (req, res) => {
    const requestPath = String(req.query.path || '/media')
    
    try {
      // Try to access the directory
      const entries = await fs.readdir(requestPath, { withFileTypes: true })
      
      const items = entries
        .filter(entry => {
          // Filter out hidden and system directories
          return !entry.name.startsWith('.') && 
                 entry.name !== 'lost+found'
        })
        .map(entry => ({
          name: entry.name,
          path: path.join(requestPath, entry.name),
          isDirectory: entry.isDirectory()
        }))
        .sort((a, b) => {
          // Directories first, then alphabetical
          if (a.isDirectory && !b.isDirectory) return -1
          if (!a.isDirectory && b.isDirectory) return 1
          return a.name.localeCompare(b.name)
        })
      
      res.json(items)
    } catch (err: any) {
      console.error('Browse error:', err)
      
      // If permission denied, return empty list with error message
      if (err.code === 'EACCES' || err.code === 'EPERM') {
        res.json([{
          name: 'Permission denied - check volume mount permissions',
          path: requestPath,
          isDirectory: false
        }])
      } else if (err.code === 'ENOENT') {
        res.json([{
          name: 'Directory not found',
          path: requestPath,
          isDirectory: false
        }])
      } else {
        res.status(500).json({ error: 'Failed to browse directory' })
      }
    }
  })
);
// ===================== QUEUE =====================

/** Broadcast a queue update to all connected WebSocket clients. */
export function broadcastQueueUpdate(type = 'queue.updated', data?: any): void {
  postQueueUpdate(type, data);
}

// Re-sort queued items according to the active rotation policy.
// Called after new items are added or a song completes so the queue respects
// the configured rotation order.
//
// Algorithm:
//  1. Count how many songs each singer has already had played (done/playing) —
//     this tells us which "round" their next queued song belongs to.
//  2. Assign round numbers to all queued songs: round = doneSongs + 1 + songIndex.
//  3. Sort by (round ASC, tiebreaker) where the tiebreaker depends on policy:
//     - strict_round_robin / signup_order / hybrid: rotation position (rs.position)
//     - least_recently_sung: last_sang_at ASC (never sung first), then position
//  4. For singers who have queued songs but are not yet in rotation_singers,
//     derive their rotation slot from their first-appearance order in the queue.
export async function resortQueueByRotation(): Promise<void> {
  try {
    // Get the active rotation type
    const rotRes = await query<any>(
      `SELECT id, type, config, current_round FROM rotations WHERE status = 'active' ORDER BY created_at DESC LIMIT 1`
    );
    if (rotRes.rows.length === 0) return;

    const rotRow = rotRes.rows[0];
    const rotationType: string = (rotRow.config?.type) || rotRow.type || 'strict_round_robin';
    const currentRound = Number(rotRow.current_round) > 0 ? Number(rotRow.current_round) : 1;

    // For manual mode, never touch the order
    if (rotationType === 'manual') return;

    // song_queue_only: sort strictly by original request order (no singer fairness).
    // The queue is already in insertion order, so nothing needs to change.
    if (rotationType === 'song_queue_only') return;

    // Get all queued (not yet playing) items in their current order.
    // Prefer singer_id for grouping; fall back to requested_by for old rows.
    const queueRes = await query<{
      id: number;
      requested_by: string | null;
      singer_id: string | null;
      position: number;
    }>(
      `SELECT id, requested_by, singer_id, position FROM queue WHERE status = 'queued' ORDER BY position`
    );
    if (queueRes.rows.length <= 1) return;

    const playingRes = await query<{ singer_id: string | null; requested_by: string | null }>(
      `SELECT singer_id, requested_by FROM queue WHERE status = 'playing' ORDER BY started_at DESC NULLS LAST, id DESC LIMIT 1`
    );
    const currentlyPlayingSingerKey =
      playingRes.rows.length > 0
        ? (playingRes.rows[0].singer_id
            ? String(playingRes.rows[0].singer_id)
            : `name:${normalizeSingerName(playingRes.rows[0].requested_by ?? '')}`)
        : null;

    // Get singer positions from the rotation (used as tiebreaker within a round).
    // Join via singer_id for precision.
    const singerRes = await query<{
      singer_id: string;
      display_name: string;
      position: number;
      last_sang_at: Date | null;
      current_round_joined: number;
      last_round_sang: number | null;
    }>(
      `SELECT s.id AS singer_id, s.display_name, rs.position, rs.last_sang_at, rs.current_round_joined, rs.last_round_sang
        FROM rotation_singers rs
        JOIN singers s ON s.id = rs.singer_id
        WHERE rs.rotation_id = $1 AND rs.status = 'active'
        ORDER BY rs.position`,
      [rotRow.id]
    );

    // Build lookup: singer_id string → { position, lastSangAt }
    // Also keep a fallback lookup by lowercase display_name for old queue rows without singer_id
    const singerInfoById = new Map<string, { position: number; lastSangAt: Date | null; currentRoundJoined: number; lastRoundSang: number | null }>();
    const singerInfoByName = new Map<string, { position: number; lastSangAt: Date | null; currentRoundJoined: number; lastRoundSang: number | null }>();
    for (const row of singerRes.rows) {
      const info = {
        position: row.position,
        lastSangAt: row.last_sang_at,
        currentRoundJoined: Number(row.current_round_joined) > 0 ? Number(row.current_round_joined) : 1,
        lastRoundSang: row.last_round_sang === null ? null : Number(row.last_round_sang),
      };
      singerInfoById.set(String(row.singer_id), info);
      singerInfoByName.set(normalizeSingerName(row.display_name), info);
    }

    // For singers in the queue but not yet in rotation_singers, assign them
    // positions after the existing rotation singers, in first-appearance order.
    const maxRegisteredPos =
      singerInfoById.size > 0
        ? Math.max(...Array.from(singerInfoById.values()).map((v) => v.position))
        : -1;
    let nextPos = maxRegisteredPos + 1;

    // Helper: derive a stable singer key and info for a queue row
    const getSingerKey = (row: { id: number; requested_by: string | null; singer_id: string | null }) => {
      return row.singer_id ? row.singer_id : `name:${normalizeSingerName(row.requested_by ?? '')}`;
    };

    const resolvedInfo = new Map<string, { position: number; lastSangAt: Date | null; currentRoundJoined: number; lastRoundSang: number | null }>();
    for (const item of queueRes.rows) {
      const key = getSingerKey(item);
      if (resolvedInfo.has(key)) continue;

      if (item.singer_id && singerInfoById.has(item.singer_id)) {
        resolvedInfo.set(key, singerInfoById.get(item.singer_id)!);
      } else {
        const name = normalizeSingerName(item.requested_by ?? '');
        if (name && singerInfoByName.has(name)) {
          resolvedInfo.set(key, singerInfoByName.get(name)!);
        } else {
          resolvedInfo.set(key, {
            position: nextPos++,
            lastSangAt: null,
            currentRoundJoined: currentRound,
            lastRoundSang: null,
          });
        }
      }
    }

    if (resolvedInfo.size === 0) return;

    // Group queued items by singer key
    const bySinger = new Map<string, Array<{ id: number; requested_by: string | null; singer_id: string | null; position: number }>>();
    for (const item of queueRes.rows) {
      const key = getSingerKey(item);
      if (!bySinger.has(key)) bySinger.set(key, []);
      bySinger.get(key)!.push(item);
    }

    // Assign a (round, tiebreaker) to every queued item
    const sortableInputs: Array<{
      id: number;
      item: { id: number; requested_by: string | null; singer_id: string | null; position: number };
      origPos: number;
      rotPos: number;
      lastSangAt: Date | null;
      currentRoundJoined: number;
      lastRoundSang: number | null;
      isCurrentlyPlaying: boolean;
      songIndex: number;
    }> = [];

    for (const [key, items] of bySinger) {
      // Build the doneCounts key using the same logic as the SQL query:
      // singer_id::text when available, else LOWER(requested_by).
      const doneKey = items[0].singer_id
        ? items[0].singer_id
        : `name:${normalizeSingerName(items[0].requested_by ?? '')}`;
      const info = resolvedInfo.get(key) ?? {
        position: Number.MAX_SAFE_INTEGER,
        lastSangAt: null,
        currentRoundJoined: currentRound,
        lastRoundSang: null,
      };
      items.forEach((item, songIndex) => {
        sortableInputs.push({
          id: item.id,
          item,
          origPos: item.position,
          rotPos: info.position,
          lastSangAt: info.lastSangAt,
          currentRoundJoined: info.currentRoundJoined,
          lastRoundSang: info.lastRoundSang,
          isCurrentlyPlaying: currentlyPlayingSingerKey === doneKey,
          songIndex,
        });
      });
    }

    // Determine the effective base policy for sort tiebreaking
    const basePolicy: QueueSortBasePolicy =
      rotationType === 'hybrid'
        ? (rotRow.config?.basePolicy === 'least_recently_sung' || rotRow.config?.basePolicy === 'signup_order'
            ? rotRow.config.basePolicy
            : 'strict_round_robin')
        : (rotationType === 'least_recently_sung' || rotationType === 'signup_order'
            ? rotationType
            : 'strict_round_robin');

    const sortedOrder = sortQueuedRotationItems(
      sortableInputs.map((item) => ({
        id: item.id,
        origPos: item.origPos,
        rotPos: item.rotPos,
        lastSangAt: item.lastSangAt,
        currentRoundJoined: item.currentRoundJoined,
        lastRoundSang: item.lastRoundSang,
        isCurrentlyPlaying: item.isCurrentlyPlaying,
        songIndex: item.songIndex,
      })),
      { currentRound, basePolicy }
    );

    const itemById = new Map(sortableInputs.map((item) => [item.id, item.item]));
    const sorted = sortedOrder.map((s) => itemById.get(s.id)!).filter(Boolean);

    // Skip if already in the correct order
    const currentIds = queueRes.rows.map((r) => r.id);
    const sortedIds = sorted.map((r) => r.id);
    if (currentIds.every((id, i) => id === sortedIds[i])) return;

    const minPos = queueRes.rows[0].position;
    // Temporary offset used in the two-phase position update to avoid
    // intermediate unique-constraint conflicts when shuffling positions.
    const TEMP_OFFSET = 1_000_000;

    await query('BEGIN');
    try {
      // Phase 1: move to temp positions to avoid conflicts
      for (let i = 0; i < sorted.length; i++) {
        await query(`UPDATE queue SET position = $1 WHERE id = $2`, [TEMP_OFFSET + i, sorted[i].id]);
      }
      // Phase 2: move to final positions
      for (let i = 0; i < sorted.length; i++) {
        await query(`UPDATE queue SET position = $1 WHERE id = $2`, [minPos + i, sorted[i].id]);
      }
      await query('COMMIT');
    } catch (e) {
      await query('ROLLBACK');
      throw e;
    }
  } catch (err) {
    console.error('resortQueueByRotation failed:', err);
  }
}

export async function applyManualSingerQueueOrder(orderedSingerIds: string[]): Promise<void> {
  const normalizedOrder = orderedSingerIds
    .map((id) => String(id).trim())
    .filter((id) => /^\d+$/.test(id));
  if (normalizedOrder.length === 0) return;

  const queueRes = await query<{
    id: number;
    singer_id: string | null;
    position: number;
  }>(
    `SELECT id, singer_id, position
       FROM queue
      WHERE status = 'queued'
      ORDER BY position`
  );
  if (queueRes.rows.length <= 1) return;

  const bySinger = new Map<string, Array<{ id: number; position: number }>>();
  const unordered: Array<{ id: number; position: number }> = [];
  for (const row of queueRes.rows) {
    if (row.singer_id) {
      const key = String(row.singer_id);
      if (!bySinger.has(key)) bySinger.set(key, []);
      bySinger.get(key)!.push({ id: row.id, position: row.position });
    } else {
      unordered.push({ id: row.id, position: row.position });
    }
  }

  const remainingSingerIds = new Set(bySinger.keys());
  const singerOrder = normalizedOrder.filter((id) => {
    const hasSinger = bySinger.has(id);
    if (hasSinger) remainingSingerIds.delete(id);
    return hasSinger;
  });
  singerOrder.push(...Array.from(remainingSingerIds).sort((a, b) => {
    const aFirst = bySinger.get(a)?.[0]?.position ?? Number.MAX_SAFE_INTEGER;
    const bFirst = bySinger.get(b)?.[0]?.position ?? Number.MAX_SAFE_INTEGER;
    return aFirst - bFirst;
  }));

  const sorted: Array<{ id: number; position: number }> = [];
  let added = true;
  let songIndex = 0;
  while (added) {
    added = false;
    for (const singerId of singerOrder) {
      const item = bySinger.get(singerId)?.[songIndex];
      if (item) {
        sorted.push(item);
        added = true;
      }
    }
    songIndex++;
  }
  sorted.push(...unordered);

  const currentIds = queueRes.rows.map((row) => row.id);
  const sortedIds = sorted.map((row) => row.id);
  if (currentIds.length === sortedIds.length && currentIds.every((id, index) => id === sortedIds[index])) return;

  const positions = queueRes.rows.map((row) => row.position).sort((a, b) => a - b);
  const TEMP_OFFSET = 1_000_000;

  await query('BEGIN');
  try {
    for (let i = 0; i < sorted.length; i++) {
      await query(`UPDATE queue SET position = $1 WHERE id = $2`, [TEMP_OFFSET + i, sorted[i].id]);
    }
    for (let i = 0; i < sorted.length; i++) {
      await query(`UPDATE queue SET position = $1 WHERE id = $2`, [positions[i], sorted[i].id]);
    }
    await query('COMMIT');
  } catch (e) {
    await query('ROLLBACK');
    throw e;
  }
}

// ---------------------------------------------------------------------------
// GET /api/queue/state — nested singer-based queue state for Host page
// ---------------------------------------------------------------------------
// NOTE: This route MUST be declared before GET /api/queue so Express doesn't
// try to match "state" as an :id parameter.
apiRouter.get(
  '/queue/state',
  ah(async (_req, res) => {
    const state = await getQueueState();
    res.json(state);
  })
);

// ---------------------------------------------------------------------------
// GET /api/singers/:id/history — singer history including completed songs
// ---------------------------------------------------------------------------
apiRouter.get(
  '/singers/:id/history',
  ah(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid singer id' });
    const history = await getSingerHistory(BigInt(id));
    if (!history) return res.status(404).json({ error: 'Singer not found' });
    res.json(history);
  })
);

apiRouter.post(
  '/singers/self/name',
  queueLimiter,
  ah(async (req, res) => {
    const displayName = String(req.body?.name ?? '').trim();
    const singerUuid = normalizeSingerUuid(req.body?.singerUuid);
    if (!displayName) return res.status(400).json({ error: 'name is required' });
    if (!singerUuid) return res.status(400).json({ error: 'singerUuid is required' });

    const singer = await findOrCreateSinger(displayName, singerUuid);
    await ensureSingerInActiveRotation(singer.id);
    await updateActiveQueueRequesterName(singer.id, displayName);
    postQueueUpdate('queue.updated');
    res.json({
      ok: true,
      singer: {
        id: singer.id.toString(),
        uuid: singer.public_uuid,
        displayName: singer.display_name,
        normalizedName: singer.normalized_name,
      },
    });
  })
);

// ---------------------------------------------------------------------------
// Singer history .kd export/import
// ---------------------------------------------------------------------------
apiRouter.get(
  '/history/self/export',
  ah(async (req, res) => {
    const name = String(req.query.name ?? '').trim();
    const singerUuid = normalizeSingerUuid(req.query.singerUuid);
    if (!name) return res.status(400).json({ error: 'name is required' });
    const data = await buildSingerHistoryKdFile({
      requesterName: name,
      singerUuid,
      includeSingerInfo: true,
    });
    res.json(data);
  })
);

apiRouter.post(
  '/history/self/import',
  queueLimiter,
  ah(async (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    const singerUuid = normalizeSingerUuid(req.body?.singerUuid);
    const data = req.body?.data;
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (!isSingerHistoryKdFile(data)) return res.status(400).json({ error: 'Invalid .kd singer history file' });
    const result = await importSingerHistoryKdFile(data, { requesterName: name, singerUuid });
    await resortQueueByRotation();
    postQueueUpdate('queue.updated');
    res.json({ ok: true, ...result });
  })
);

apiRouter.get(
  '/history/singers/:id/export',
  adminGuard,
  ah(async (req, res) => {
    const singerId = String(req.params.id ?? '').trim();
    if (!/^\d+$/.test(singerId)) return res.status(400).json({ error: 'Invalid singer id' });
    const data = await buildSingerHistoryKdFile({
      singerIds: [singerId],
      includeSingerInfo: true,
    });
    res.json(data);
  })
);

apiRouter.get(
  '/history/export-all',
  adminGuard,
  ah(async (_req, res) => {
    const data = await buildSingerHistoryKdFile({ includeSingerInfo: true });
    res.json(data);
  })
);

apiRouter.post(
  '/history/export',
  adminGuard,
  ah(async (req, res) => {
    const singerIds = Array.isArray(req.body?.singerIds)
      ? req.body.singerIds.map((id: unknown) => String(id).trim()).filter((id: string) => /^\d+$/.test(id))
      : [];
    if (singerIds.length === 0) return res.status(400).json({ error: 'singerIds array is required' });
    const data = await buildSingerHistoryKdFile({ singerIds, includeSingerInfo: true });
    res.json(data);
  })
);

apiRouter.post(
  '/history/import',
  adminGuard,
  ah(async (req, res) => {
    const data = req.body?.data;
    if (!isSingerHistoryKdFile(data)) return res.status(400).json({ error: 'Invalid .kd singer history file' });
    const result = await importSingerHistoryKdFile(data, {});
    await resortQueueByRotation();
    postQueueUpdate('queue.updated');
    res.json({ ok: true, ...result });
  })
);

apiRouter.patch(
  '/singers/:id/rename',
  adminGuard,
  ah(async (req, res) => {
    const singerId = Number(req.params.id);
    const displayName = String(req.body?.displayName ?? '').trim();
    if (!Number.isFinite(singerId)) return res.status(400).send('Invalid singer id');
    if (!displayName) return res.status(400).send('displayName is required');

    const normalizedName = normalizeSingerName(displayName);
    if (!normalizedName) return res.status(400).send('displayName is required');

    const existingSinger = await query<{ id: string }>(
      `SELECT id FROM singers WHERE normalized_name = $1 AND id != $2 LIMIT 1`,
      [normalizedName, singerId],
    );
    if (existingSinger.rows.length > 0) {
      return res.status(400).send('Singer name is already in use');
    }

    await query('BEGIN');
    try {
      const updateSinger = await query<{ id: string; display_name: string; normalized_name: string }>(
        `UPDATE singers
            SET display_name = $1,
                normalized_name = $2
          WHERE id = $3
        RETURNING id, display_name, normalized_name`,
        [displayName, normalizedName, singerId],
      );
      if (updateSinger.rows.length === 0) {
        await query('ROLLBACK');
        return res.status(404).send('Singer not found');
      }

      await query(
        `UPDATE queue
            SET requested_by = $1
          WHERE singer_id = $2
            AND status IN ('queued', 'playing')`,
        [displayName, singerId],
      );

      await query('COMMIT');
      postQueueUpdate('queue.updated');
      res.json({
        ok: true,
        singer: {
          id: updateSinger.rows[0].id,
          displayName: updateSinger.rows[0].display_name,
          normalizedName: updateSinger.rows[0].normalized_name,
        },
      });
    } catch (error) {
      await query('ROLLBACK');
      throw error;
    }
  })
);

// ---------------------------------------------------------------------------
// DELETE /api/singers/:id/history — delete ALL of a singer's queue entries
// (pending queued songs, history, skipped, removed, cancelled) and reset stats.
// Used when removing a singer from the rotation.
// ---------------------------------------------------------------------------
apiRouter.delete(
  '/singers/:id/history',
  adminGuard,
  ah(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid singer id' });
    await query('BEGIN');
    try {
      await query(`DELETE FROM queue WHERE singer_id = $1`, [id]);
      await query(`UPDATE singers SET total_songs_sung = 0, last_sang_at = NULL WHERE id = $1`, [id]);
      await query('COMMIT');
    } catch (e) {
      await query('ROLLBACK');
      throw e;
    }
    postQueueUpdate('queue.updated');
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------------------
// PATCH /api/queue/:id/status — change status of a queue item
// ---------------------------------------------------------------------------
apiRouter.patch(
  '/queue/:id/status',
  adminGuard,
  ah(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid queue id' });
    const { status } = req.body as { status?: string };
    if (!status) return res.status(400).json({ error: 'status is required' });
    const allowed = ['queued', 'done', 'removed', 'skipped'] as const;
    if (!(allowed as readonly string[]).includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
    }
    const result = await updateQueueItemStatus(id, status as any);
    if (!result.ok) return res.status(404).json({ error: result.error });
    await resortQueueByRotation();
    postQueueUpdate('queue.updated');
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------------------
// PATCH /api/singers/:singerId/song-order — reorder a singer's queued songs
// ---------------------------------------------------------------------------
apiRouter.patch(
  '/singers/:singerId/song-order',
  adminGuard,
  ah(async (req, res) => {
    const singerId = Number(req.params.singerId);
    if (!Number.isFinite(singerId)) return res.status(400).json({ error: 'Invalid singer id' });
    const { queueIds } = req.body as { queueIds?: number[] };
    if (!Array.isArray(queueIds)) return res.status(400).json({ error: 'queueIds array is required' });
    const result = await reorderSingerQueue(BigInt(singerId), queueIds);
    if (!result.ok) return res.status(400).json({ error: result.error });
    await resortQueueByRotation();
    postQueueUpdate('queue.updated');
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------------------
// POST /api/singers/:id/merge — merge source singer into target singer (admin)
// ---------------------------------------------------------------------------
apiRouter.post(
  '/singers/:id/merge',
  adminGuard,
  ah(async (req, res) => {
    const targetId = Number(req.params.id);
    const sourceId = Number(req.body?.sourceId);
    if (!Number.isFinite(targetId) || !Number.isFinite(sourceId)) {
      return res.status(400).json({ error: 'Invalid singer ids' });
    }
    if (targetId === sourceId) {
      return res.status(400).json({ error: 'Cannot merge singer with itself' });
    }
    await query('BEGIN');
    try {
      const singerCheck = await query<{ id: string }>(
        `SELECT id FROM singers WHERE id = ANY($1::bigint[])`,
        [[targetId, sourceId]],
      );
      if (singerCheck.rows.length < 2) {
        await query('ROLLBACK');
        return res.status(404).json({ error: 'One or both singers not found' });
      }
      // Get target display name for updating queue rows
      const targetRes = await query<{ display_name: string }>(
        `SELECT display_name FROM singers WHERE id = $1`,
        [targetId],
      );
      const targetDisplayName = targetRes.rows[0]?.display_name ?? '';
      // Move all queue entries from source to target
      await query(
        `UPDATE queue SET singer_id = $1, requested_by = $2 WHERE singer_id = $3`,
        [targetId, targetDisplayName, sourceId],
      );
      // Remove source from rotations where target already exists, then reassign the rest
      await query(
        `DELETE FROM rotation_singers
          WHERE singer_id = $1
            AND rotation_id IN (
              SELECT rotation_id FROM rotation_singers WHERE singer_id = $2
            )`,
        [sourceId, targetId],
      );
      await query(
        `UPDATE rotation_singers SET singer_id = $1 WHERE singer_id = $2`,
        [targetId, sourceId],
      );
      // Recalculate stats for target
      await recalculateSingerStats(String(targetId));
      // Delete source singer
      await query(`DELETE FROM singers WHERE id = $1`, [sourceId]);
      await query('COMMIT');
      await resortQueueByRotation();
      postQueueUpdate('queue.updated');
      res.json({ ok: true });
    } catch (e) {
      await query('ROLLBACK');
      throw e;
    }
  })
);

// ---------------------------------------------------------------------------
// GET /api/queue/by-requester — public: requester views their own queued songs
// ---------------------------------------------------------------------------
apiRouter.get(
  '/queue/by-requester',
  ah(async (req, res) => {
    const name = String(req.query.name ?? '').trim();
    const singerUuid = normalizeSingerUuid(req.query.singerUuid);
    if (!name) return res.status(400).json({ error: 'name is required' });
    const norm = normalizeSingerName(name);
    const authenticatedSinger = await getAuthenticatedRequesterSinger(req, name);
    if (authenticatedSinger) {
      const qRes = await query(
        `SELECT q.id, q.track_id, q.status, q.position, q.created_at, q.started_at, q.finished_at,
                t.title, t.kind, a.name AS artist
           FROM queue q
           JOIN tracks t ON t.id = q.track_id
           LEFT JOIN artists a ON a.id = t.artist_id
          WHERE q.status != 'removed'
            AND q.singer_id = $1
          ORDER BY CASE q.status WHEN 'playing' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END, q.position`,
        [authenticatedSinger.id],
      );
      return res.json(qRes.rows);
    }

    // Prefer singer_id-based lookup
    const singer = await resolveSingerForRequester(name, singerUuid);
    let rows: any[];
    if (singer) {
      const singerId = singer.id;
      const qRes = await query(
        `SELECT q.id, q.track_id, q.status, q.position, q.created_at, q.started_at, q.finished_at,
                t.title, t.kind, a.name AS artist
           FROM queue q
           JOIN tracks t ON t.id = q.track_id
           LEFT JOIN artists a ON a.id = t.artist_id
          WHERE q.status != 'removed'
            AND (q.singer_id = $1 OR LOWER(TRIM(q.requested_by)) = $2)
          ORDER BY CASE q.status WHEN 'playing' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END, q.position`,
        [singerId, norm],
      );
      rows = qRes.rows;
    } else {
      const qRes = await query(
        `SELECT q.id, q.track_id, q.status, q.position, q.created_at, q.started_at, q.finished_at,
                t.title, t.kind, a.name AS artist
           FROM queue q
           JOIN tracks t ON t.id = q.track_id
           LEFT JOIN artists a ON a.id = t.artist_id
          WHERE LOWER(TRIM(q.requested_by)) = $1 AND q.status != 'removed'
          ORDER BY CASE q.status WHEN 'playing' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END, q.position`,
        [norm],
      );
      rows = qRes.rows;
    }
    res.json(rows);
  })
);

// ---------------------------------------------------------------------------
// POST /api/queue/:id/self-requeue — requester adds a completed song back
// ---------------------------------------------------------------------------
apiRouter.post(
  '/queue/:id/self-requeue',
  queueLimiter,
  ah(async (req, res) => {
    const queueId = Number(req.params.id);
    const requesterName = String(req.body?.name ?? '').trim();
    const singerUuid = normalizeSingerUuid(req.body?.singerUuid);
    if (!Number.isFinite(queueId)) return res.status(400).json({ error: 'Invalid queue id' });
    if (!requesterName) return res.status(400).json({ error: 'name is required' });

    const norm = normalizeSingerName(requesterName);
    const item = await query<{
      id: string;
      track_id: string;
      requested_by: string | null;
      singer_id: string | null;
      status: string;
      key_adjustment: number | null;
    }>(
      `SELECT id, track_id, requested_by, singer_id, status, key_adjustment
         FROM queue
        WHERE id = $1
          AND status IN ('done', 'skipped')
        LIMIT 1`,
      [queueId],
    );
    if (item.rows.length === 0) {
      return res.status(404).json({ error: 'Completed queue item not found' });
    }

    const row = item.rows[0];
    const authenticatedSinger = await getAuthenticatedRequesterSinger(req, requesterName);
    const singer = authenticatedSinger
      ? {
          id: String(authenticatedSinger.id),
          publicUuid: authenticatedSinger.public_uuid,
          displayName: authenticatedSinger.display_name,
          normalizedName: authenticatedSinger.normalized_name,
        }
      : await resolveSingerForRequester(requesterName, singerUuid);
    const requesterOwnsItem =
      (authenticatedSinger
        ? row.singer_id !== null && String(row.singer_id) === String(authenticatedSinger.id)
        : normalizeSingerName(row.requested_by ?? '') === norm ||
          (singer && row.singer_id !== null && String(row.singer_id) === String(singer.id)));
    if (!requesterOwnsItem) {
      return res.status(403).json({ error: 'You can only re-add your own songs' });
    }

    let singerId: bigint | null = row.singer_id !== null ? BigInt(row.singer_id) : null;
    try {
      const singer = authenticatedSinger ?? await findOrCreateSinger(requesterName, singerUuid);
      singerId = singer.id;
      await ensureSingerInActiveRotation(singerId);
    } catch (err) {
      console.error('findOrCreateSinger / ensureSingerInActiveRotation failed:', err);
    }

    const trackId = Number(row.track_id);
    if (singerId) {
      const dupCheck = await query<{ id: number }>(
        `SELECT id FROM queue WHERE singer_id = $1 AND track_id = $2 AND status IN ('queued', 'playing') LIMIT 1`,
        [singerId, trackId],
      );
      if (dupCheck.rows.length > 0) {
        return res.status(409).json({ error: 'You already have this song in the queue' });
      }
    }

    const posr = await query<{ p: number }>(`SELECT COALESCE(MAX(position),0)+1 AS p FROM queue`);
    const position = (posr.rows[0] as any).p;
    const keyAdjustment = row.key_adjustment ?? 0;

    const inserted = await query(
      `INSERT INTO queue(track_id, requested_by, singer_id, status, position, key_adjustment)
       VALUES ($1,$2,$3,'queued',$4,$5)
       RETURNING id, track_id, requested_by, singer_id, status, position, key_adjustment, created_at`,
      [trackId, (authenticatedSinger?.display_name || requesterName), singerId, position, keyAdjustment],
    );

    await resortQueueByRotation();
    postQueueUpdate('queue.updated');
    res.json(inserted.rows[0]);
  })
);

// ---------------------------------------------------------------------------
// DELETE /api/queue/:id/self-remove — requester removes their own queued or completed song
// ---------------------------------------------------------------------------
apiRouter.delete(
  '/queue/:id/self-remove',
  ah(async (req, res) => {
    const queueId = Number(req.params.id);
    const requesterName = String(req.query.name ?? '').trim();
    const singerUuid = normalizeSingerUuid(req.query.singerUuid);
    if (!Number.isFinite(queueId)) return res.status(400).json({ error: 'Invalid queue id' });
    if (!requesterName) return res.status(400).json({ error: 'name query param is required' });

    const item = await query<{ id: number; requested_by: string | null; singer_id: string | null; status: string }>(
      `SELECT id, requested_by, singer_id, status
         FROM queue
        WHERE id = $1
          AND status IN ('queued', 'done', 'skipped')`,
      [queueId],
    );
    if (item.rows.length === 0) {
      return res.status(404).json({ error: 'Queue item not found or not removable' });
    }
    const normalizedRequester = normalizeSingerName(requesterName);
    const normalizedOwner = normalizeSingerName(item.rows[0].requested_by ?? '');
    const authenticatedSinger = await getAuthenticatedRequesterSinger(req, requesterName);
    const singer = authenticatedSinger
      ? null
      : await resolveSingerForRequester(requesterName, singerUuid);
    const requesterOwnsItem =
      authenticatedSinger
        ? item.rows[0].singer_id !== null && String(item.rows[0].singer_id) === String(authenticatedSinger.id)
        : normalizedRequester === normalizedOwner ||
          (singer &&
            item.rows[0].singer_id !== null &&
            String(item.rows[0].singer_id) === String(singer.id));
    if (!requesterOwnsItem) {
      return res.status(403).json({ error: 'You can only remove your own songs' });
    }
    await query(`UPDATE queue SET status = 'removed' WHERE id = $1`, [queueId]);
    await resortQueueByRotation();
    postQueueUpdate('queue.updated');
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------------------
// PATCH /api/queue/self-reorder — public: requester reorders their own queued songs
// Body: { name: string, queueIds: number[] }
// ---------------------------------------------------------------------------
apiRouter.patch(
  '/queue/self-reorder',
  ah(async (req, res) => {
    const { name, queueIds, singerUuid: rawSingerUuid } = req.body as { name?: string; queueIds?: number[]; singerUuid?: string };
    const requesterName = String(name ?? '').trim();
    if (!requesterName) return res.status(400).json({ error: 'name is required' });
    if (!Array.isArray(queueIds) || queueIds.length === 0) return res.status(400).json({ error: 'queueIds array is required' });
    const orderedQueueIds = queueIds.map((id) => Number(id));
    if (orderedQueueIds.some((id) => !Number.isFinite(id))) return res.status(400).json({ error: 'queueIds must be numeric' });

    const norm = normalizeSingerName(requesterName);

    // Resolve singer_id for this requester
    const authenticatedSinger = await getAuthenticatedRequesterSinger(req, requesterName);
    const singer = authenticatedSinger
      ? {
          id: String(authenticatedSinger.id),
          publicUuid: authenticatedSinger.public_uuid,
          displayName: authenticatedSinger.display_name,
          normalizedName: authenticatedSinger.normalized_name,
        }
      : await resolveSingerForRequester(requesterName, rawSingerUuid);

    let ownedIds: Set<number>;
    if (singer) {
      const singerId = singer.id;
      const owned = authenticatedSinger
        ? await query<{ id: string }>(
            `SELECT id FROM queue
              WHERE status = 'queued'
                AND id = ANY($2::bigint[])
                AND singer_id = $1`,
            [singerId, orderedQueueIds],
          )
        : await query<{ id: string }>(
            `SELECT id FROM queue
              WHERE status = 'queued'
                AND id = ANY($2::bigint[])
                AND (singer_id = $1 OR LOWER(TRIM(requested_by)) = $3)`,
            [singerId, orderedQueueIds, norm],
          );
      ownedIds = new Set(owned.rows.map((r) => Number(r.id)));
    } else {
      const owned = await query<{ id: string }>(
        `SELECT id FROM queue WHERE LOWER(TRIM(requested_by)) = $1 AND status = 'queued' AND id = ANY($2::bigint[])`,
        [norm, orderedQueueIds],
      );
      ownedIds = new Set(owned.rows.map((r) => Number(r.id)));
    }

    for (const id of orderedQueueIds) {
      if (!ownedIds.has(id)) {
        return res.status(403).json({ error: `Queue item ${id} is not yours or not queued` });
      }
    }

    // Preserve relative positions: slot the new order into the existing position values
    let curRes: { rows: { id: string; position: number }[] };
    if (singer) {
      const singerId = singer.id;
      curRes = authenticatedSinger
        ? await query<{ id: string; position: number }>(
            `SELECT id, position FROM queue
              WHERE status = 'queued'
                AND singer_id = $1
              ORDER BY position`,
            [singerId],
          )
        : await query<{ id: string; position: number }>(
            `SELECT id, position FROM queue
              WHERE status = 'queued'
                AND (singer_id = $1 OR LOWER(TRIM(requested_by)) = $2)
              ORDER BY position`,
            [singerId, norm],
          );
    } else {
      curRes = await query<{ id: string; position: number }>(
        `SELECT id, position FROM queue WHERE LOWER(TRIM(requested_by)) = $1 AND status = 'queued' ORDER BY position`,
        [norm],
      );
    }
    const sorted = curRes.rows.map((r) => r.position).sort((a, b) => a - b);
    const TEMP_OFFSET = 2_000_000;
    await query('BEGIN');
    try {
      for (let i = 0; i < orderedQueueIds.length && i < sorted.length; i++) {
        await query(`UPDATE queue SET position = $1 WHERE id = $2`, [TEMP_OFFSET + i, orderedQueueIds[i]]);
      }
      for (let i = 0; i < orderedQueueIds.length && i < sorted.length; i++) {
        await query(`UPDATE queue SET position = $1 WHERE id = $2`, [sorted[i], orderedQueueIds[i]]);
      }
      await query('COMMIT');
    } catch (e) {
      await query('ROLLBACK');
      throw e;
    }
    await resortQueueByRotation();
    postQueueUpdate('queue.updated');
    res.json({ ok: true });
  })
);



apiRouter.get(
  '/queue',
  ah(async (_req, res) => {
    const result = await query(
      `
      SELECT q.id,
             q.track_id,
             q.requested_by,
             q.status,
             q.position,
             q.key_adjustment,
             t.title,
             t.disc_id,
             t.duration_ms,
             t.kind,
             t.file_mp4,
             t.file_mp3,
             t.file_cdg,
             t.path,
             t.external_url,
             t.source,
             a.name AS artist
        FROM queue q
        JOIN tracks t ON t.id = q.track_id
        LEFT JOIN artists a ON a.id = t.artist_id
       ORDER BY q.position
      `
    );
    res.json(result.rows);
  })
);

apiRouter.post(
  '/queue',
  queueLimiter, // Apply rate limiting to prevent queue spam
  ah(async (req, res) => {
    const trackId = toInt(req.body?.trackId);
    const requestedBy = (req.body?.requestedBy ?? null) as string | null;
    const singerUuid = normalizeSingerUuid(req.body?.singerUuid);
    const keyAdjustment = toInt(req.body?.keyAdjustment) ?? 0;
    if (trackId == null) return res.status(400).send('trackId required');
    if (!validateKeyAdjustment(keyAdjustment)) return res.status(400).send('keyAdjustment must be between -6 and 6');

    // Check if the track is from local library or external
    const trackInfo = await query<{ source: string | null }>(
      'SELECT source FROM tracks WHERE id = $1',
      [trackId]
    );
    
    if (trackInfo.rows.length === 0) {
      return res.status(404).send('Track not found');
    }
    
    const track = trackInfo.rows[0];
    const isExternal = track.source && track.source !== 'local';
    
    // Check library settings
    if (isExternal) {
      const externalLibraryEnabled = await getSetting('libraries.external_enabled');
      if (externalLibraryEnabled === false) {
        return res.status(403).json({ error: 'External library is disabled' });
      }
    } else {
      const localLibraryEnabled = await getSetting('libraries.local_enabled');
      if (localLibraryEnabled === false) {
        return res.status(403).json({ error: 'Local library is disabled' });
      }
    }

    const posr = await query<{ p: number }>(`SELECT COALESCE(MAX(position),0)+1 AS p FROM queue`);
    const position = (posr.rows[0] as any).p;

    // Find or create singer, then ensure they are in the active rotation.
    let singerId: bigint | null = null;
    let queueRequestedBy = requestedBy;
    if (requestedBy && requestedBy.trim()) {
      try {
        const singer = await getAuthenticatedRequesterSinger(req, requestedBy) ?? await findOrCreateSinger(requestedBy, singerUuid);
        singerId = singer.id;
        queueRequestedBy = singer.display_name || requestedBy;
        await ensureSingerInActiveRotation(singerId);
      } catch (err) {
        console.error('findOrCreateSinger / ensureSingerInActiveRotation failed:', err);
      }
    }

    // Check for duplicate request: same singer, same track, already queued/playing
    if (singerId && trackId) {
      const dupCheck = await query<{ id: number }>(
        `SELECT id FROM queue WHERE singer_id = $1 AND track_id = $2 AND status IN ('queued', 'playing') LIMIT 1`,
        [singerId, trackId],
      );
      if (dupCheck.rows.length > 0) {
        return res.status(409).json({ error: 'You have already requested this song' });
      }
    }

    // Try to insert with key_adjustment if the column exists
    try {
      const r = await query(
        `INSERT INTO queue(track_id, requested_by, singer_id, status, position, key_adjustment)
         VALUES ($1,$2,$3,'queued',$4,$5)
         RETURNING id, track_id, requested_by, singer_id, status, position, key_adjustment, created_at`,
        [trackId, queueRequestedBy, singerId, position, keyAdjustment]
      );
      logger.info(`Singer request queued: "${queueRequestedBy ?? 'anonymous'}" added track ${trackId} (queue id ${r.rows[0].id})`);
      res.json(r.rows[0]);
    } catch (err: any) {
      // If key_adjustment column doesn't exist, fall back to insert without it
      // PostgreSQL error code 42703 = undefined_column
      const isColumnNotFound = 
        err?.code === '42703' || 
        (err?.message?.includes('key_adjustment') && err?.message?.includes('does not exist'));
      
      if (isColumnNotFound) {
        console.warn('key_adjustment column does not exist in queue table, inserting without it');
        const r = await query(
          `INSERT INTO queue(track_id, requested_by, singer_id, status, position)
           VALUES ($1,$2,$3,'queued',$4)
           RETURNING id, track_id, requested_by, singer_id, status, position, created_at`,
          [trackId, queueRequestedBy, singerId, position]
        );
        logger.info(`Singer request queued: "${queueRequestedBy ?? 'anonymous'}" added track ${trackId} (queue id ${r.rows[0].id})`);
        res.json(r.rows[0]);
      } else {
        // Re-throw if it's a different error
        throw err;
      }
    }
    
    // Notify clients about the queue update
    await resortQueueByRotation();
    postQueueUpdate('queue.updated');
    
    // Get track details for pre-caching and duration extraction
    const trackDetails = await query(
      `SELECT t.id, t.title, t.kind, t.file_mp4, t.file_mp3, t.file_cdg, t.path, t.duration_ms, a.name AS artist
       FROM tracks t
       LEFT JOIN artists a ON a.id = t.artist_id
       WHERE t.id = $1`,
      [trackId]
    );
    
    if (trackDetails.rows.length) {
      const track = trackDetails.rows[0];
      
      // If duration_ms is missing, try to extract it
      if (track.duration_ms === null) {
        const extractedDuration = await extractTrackDuration(track);
        
        // Update the database with the extracted duration
        if (extractedDuration !== null) {
          logger.verbose(`Updating duration for track ${track.id}: ${extractedDuration}ms (${Math.round(extractedDuration / 1000)}s)`);
          await query('UPDATE tracks SET duration_ms = $1 WHERE id = $2', [extractedDuration, track.id]);
          
          // Notify clients about the updated track (so Host page gets new duration)
          postQueueUpdate('queue.updated');
        }
      }
      
      // Trigger pre-caching for CDG+MP3 from ZIP
      if (track.kind === 'cdgmp3') {
        const isFromZip = track.file_cdg?.startsWith('zip://');
        
        if (isFromZip) {
          const parsedCdg = track.file_cdg ? parseZipMediaRef(track.file_cdg) : null;
          const parsedMp3 = track.file_mp3 ? parseZipMediaRef(track.file_mp3) : null;
          const zipPath = parsedCdg?.zipPath || parsedMp3?.zipPath || '';
          const cdgEntry = parsedCdg?.entryName || '';
          const mp3Entry = parsedMp3?.entryName || '';
          
          fetch(`http://localhost:${process.env.PORT || 5174}/media/precache`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              file: zipPath,
              cdg: cdgEntry,
              mp3: mp3Entry,
              requestedBy,
              title: track.title,
              artist: track.artist
            })
          }).catch(err => console.error('Pre-cache request failed:', err));
        }
      }
    }
  })
);

apiRouter.post(
  '/queue/reorder',
  adminGuard,
  ah(async (req, res) => {
    const id = toInt(req.body?.id);
    const newPosition = toInt(req.body?.newPosition);
    if (id == null || newPosition == null) return res.status(400).send('id and newPosition (integers) required');

    await query('BEGIN');
    try {
      const cur = await query<{ position: number }>(`SELECT position FROM queue WHERE id=$1 FOR UPDATE`, [id]);
      if (!cur.rows.length) throw new Error('not found');

      const oldPos = cur.rows[0].position as number;
      if (newPosition < oldPos) {
        await query(`UPDATE queue SET position = position + 1 WHERE position >= $1 AND position < $2`, [newPosition, oldPos]);
      } else if (newPosition > oldPos) {
        await query(`UPDATE queue SET position = position - 1 WHERE position > $1 AND position <= $2`, [oldPos, newPosition]);
      }
      await query(`UPDATE queue SET position = $1 WHERE id = $2`, [newPosition, id]);
      await query('COMMIT');

      res.json({ ok: true });
      postQueueUpdate('queue.updated');
    } catch (e) {
      await query('ROLLBACK');
      throw e;
    }
  })
);

apiRouter.post(
  '/queue/rename',
  adminGuard,
  ah(async (req, res) => {
    const id = toInt(req.body?.id);
    const requestedBy = String(req.body?.requestedBy ?? '').trim();
    if (id == null) return res.status(400).send('id required');

    await query(`UPDATE queue SET requested_by = $1 WHERE id = $2`, [requestedBy, id]);
    res.json({ ok: true });
    postQueueUpdate('queue.updated');
  })
);

apiRouter.post(
  '/queue/update-key',
  adminGuard,
  ah(async (req, res) => {
    const id = toInt(req.body?.id);
    const keyAdjustment = toInt(req.body?.keyAdjustment);
    if (id == null) return res.status(400).send('id required');
    if (keyAdjustment == null) return res.status(400).send('keyAdjustment required');
    if (!validateKeyAdjustment(keyAdjustment)) return res.status(400).send('keyAdjustment must be between -6 and 6');

    await query(`UPDATE queue SET key_adjustment = $1 WHERE id = $2`, [keyAdjustment, id]);
    res.json({ ok: true });
    postQueueUpdate('queue.updated');
  })
);

apiRouter.post(
  '/queue/replace',
  adminGuard,
  ah(async (req, res) => {
    const id = toInt(req.body?.id);
    const requestedTrackId = toInt(req.body?.trackId);
    const external = req.body?.external;
    if (id == null) return res.status(400).send('id required');

    let trackId: number | null = null;
    if (requestedTrackId != null) {
      const found = await query<{ id: number }>(`SELECT id FROM tracks WHERE id = $1 LIMIT 1`, [requestedTrackId]);
      if (found.rows.length === 0) return res.status(404).send('Track not found');
      trackId = requestedTrackId;
    } else if (external && typeof external === 'object') {
      const title = String(external.title ?? '').trim();
      const artist = String(external.artist ?? '').trim();
      const url = String(external.url ?? '').trim();
      const source = String(external.source ?? 'karaoke-nerds').trim() || 'karaoke-nerds';
      const discId = String(external.discId ?? external.brand ?? '').trim();
      if (!title || !url) return res.status(400).send('external.title and external.url are required');
      const { upsertArtist, upsertExternalTrack } = await import('../db');
      const artistId = artist ? await upsertArtist(artist) : null;
      const track = await upsertExternalTrack({
        artist_id: artistId,
        disc_id: discId || null,
        title,
        external_url: url,
        source,
        duration_ms: null,
      });
      trackId = Number(track.id);
    } else {
      return res.status(400).send('trackId or external track is required');
    }

    const current = await query<{ id: number; status: string }>(
      `SELECT id, status FROM queue WHERE id = $1 LIMIT 1`,
      [id]
    );
    if (current.rows.length === 0) return res.status(404).send('Queue item not found');
    const wasPlaying = current.rows[0].status === 'playing';

    await query(
      `UPDATE queue
          SET track_id = $1,
              started_at = CASE WHEN status = 'playing' THEN NOW() ELSE started_at END
        WHERE id = $2`,
      [trackId, id]
    );

    if (wasPlaying) {
      postQueueUpdate('player.play');
      await autoPauseBreakMusicForKaraoke();
    } else {
      postQueueUpdate('queue.updated');
    }
    res.json({ ok: true, trackId, wasPlaying });
  })
);

apiRouter.post(
  '/queue/delete',
  adminGuard,
  ah(async (req, res) => {
    const id = toInt(req.body?.id);
    if (id == null) return res.status(400).send('id required');

    await query('BEGIN');
    try {
      const cur = await query(`SELECT position FROM queue WHERE id=$1 FOR UPDATE`, [id]);
      if (!cur.rows.length) throw new Error('not found');
      const pos = (cur.rows[0] as any).position as number;

      await query(`DELETE FROM queue WHERE id=$1`, [id]);
      await query(`UPDATE queue SET position = position - 1 WHERE position > $1`, [pos]);

      await query('COMMIT');
      res.json({ ok: true });
      postQueueUpdate('queue.updated');
    } catch (e) {
      await query('ROLLBACK');
      throw e;
    }
  })
);

apiRouter.post(
  '/queue/clear',
  adminGuard,
  ah(async (_req, res) => {
    await query('BEGIN');
    try {
      // Reset stats for all singers who have queue entries before clearing
      await query(`
        UPDATE singers SET total_songs_sung = 0, last_sang_at = NULL
        WHERE id IN (SELECT DISTINCT singer_id FROM queue WHERE singer_id IS NOT NULL)
      `);
      await query(`DELETE FROM queue`);
      await query('COMMIT');
    } catch (e) {
      await query('ROLLBACK');
      throw e;
    }
    res.json({ ok: true });
    postQueueUpdate('queue.updated');
  })
);

// ===================== PLAYER (Host controls) =====================
// These are minimal and keep logic server-side so Player can react via your postQueueUpdate hook.

apiRouter.get(
  '/player/now',
  ah(async (_req, res) => {
    const r = await query(
      `
      SELECT q.id, q.track_id, q.position, q.requested_by, q.status,
             t.title, t.kind, t.file_mp4, t.file_mp3, t.file_cdg, t.path,
             t.duration_ms,
             t.external_url, t.source,
             a.name AS artist
        FROM queue q
        JOIN tracks t ON t.id = q.track_id
        LEFT JOIN artists a ON a.id = t.artist_id
       WHERE q.status = 'playing'
       ORDER BY q.position
       LIMIT 1
      `
    );
    res.json(r.rows[0] || null);
  })
);

apiRouter.post(
  '/player/play',
  adminGuard,
  ah(async (req, res) => {
    const id = toInt(req.body?.id ?? null);
    
    // Clear manual stop so autoplay can resume after this play action
    manualStopActive = false;
    await setSetting('player.manual_stop', 'false');

    // First, determine which track will be played and ensure duration_ms is populated
    let trackToPlay: any = null;
    if (id != null) {
      const result = await query(`
        SELECT q.id, q.track_id, q.key_adjustment, q.requested_by, t.duration_ms, t.kind, t.file_mp4, t.file_mp3, t.file_cdg,
               t.title, a.name AS artist
        FROM queue q
        JOIN tracks t ON t.id = q.track_id
        LEFT JOIN artists a ON a.id = t.artist_id
        WHERE q.id = $1
      `, [id]);
      if (result.rows.length > 0) {
        trackToPlay = result.rows[0];
      }
    } else {
      // Get the top queued song
      const result = await query(`
        SELECT q.id, q.track_id, q.key_adjustment, q.requested_by, t.duration_ms, t.kind, t.file_mp4, t.file_mp3, t.file_cdg,
               t.title, a.name AS artist
        FROM queue q
        JOIN tracks t ON t.id = q.track_id
        LEFT JOIN artists a ON a.id = t.artist_id
        WHERE q.status = 'queued'
        ORDER BY q.position
        LIMIT 1
      `);
      if (result.rows.length > 0) {
        trackToPlay = result.rows[0];
      }
    }
    
    // If we have a track to play with pitch adjustment or missing duration, ensure duration is cached
    if (trackToPlay) {
      const hasPitchAdjustment = trackToPlay.key_adjustment && trackToPlay.key_adjustment !== 0;
      const needsDuration = trackToPlay.duration_ms === null;
      
      // Extract duration if:
      // 1. Duration is missing (null), OR
      // 2. Pitch adjustment is applied (to ensure accurate duration is cached before re-encoding)
      if (needsDuration || hasPitchAdjustment) {
        logger.verbose(`Track ${trackToPlay.track_id}: Ensuring duration is cached (hasPitch=${hasPitchAdjustment}, needsDuration=${needsDuration})`);
        
        const extractedDuration = await extractTrackDuration({
          kind: trackToPlay.kind,
          file_mp4: trackToPlay.file_mp4,
          file_mp3: trackToPlay.file_mp3
        });
        
        if (extractedDuration !== null && needsDuration) {
          logger.verbose(`Caching duration for track ${trackToPlay.track_id}: ${extractedDuration}ms (${Math.round(extractedDuration / 1000)}s)`);
          await query('UPDATE tracks SET duration_ms = $1 WHERE id = $2', [extractedDuration, trackToPlay.track_id]);
        } else if (extractedDuration !== null) {
          logger.verbose(`Duration already cached for track ${trackToPlay.track_id}: ${trackToPlay.duration_ms}ms (will be used for pitch-shifted playback)`);
        }
      }
    }
    
    let songStarted = false;
    let startedQueueId: number | null = null;
    if (trackToPlay) {
      const singerLabel = trackToPlay.requested_by ? ` (requested by ${trackToPlay.requested_by})` : '';
      const artistLabel = trackToPlay.artist ? ` by ${trackToPlay.artist}` : '';
      logger.info(`Now playing: "${trackToPlay.title}"${artistLabel}${singerLabel}`);
    }
    await query('BEGIN');
    try {
      // Only reset the currently playing song back to queued; leave done/removed/skipped rows untouched
      await query(`UPDATE queue SET status = 'queued', started_at = NULL WHERE status = 'playing'`);
      if (id != null) {
        const updateResult = await query<{ id: number }>(`UPDATE queue SET status = 'playing', started_at = NOW() WHERE id = $1 RETURNING id`, [id]);
        songStarted = updateResult.rows.length > 0;
        startedQueueId = updateResult.rows[0]?.id ?? null;
      } else {
        // play top
        const updateResult = await query<{ id: number }>(`
          UPDATE queue SET status = 'playing', started_at = NOW()
           WHERE id = (SELECT id FROM queue WHERE status = 'queued' ORDER BY position LIMIT 1)
           RETURNING id
        `);
        songStarted = updateResult.rows.length > 0;
        startedQueueId = updateResult.rows[0]?.id ?? null;
      }
      await query('COMMIT');
    } catch (e) {
      await query('ROLLBACK'); throw e;
    }
    if (startedQueueId != null) {
      await ensureQueueTrackDurationBeforePlayback(startedQueueId);
    }
    postQueueUpdate('player.play');
    if (songStarted) {
      await autoPauseBreakMusicForKaraoke();
    }
    res.json({ ok: true });
  })
);

apiRouter.post(
  '/player/next',
  adminGuard,
  ah(async (_req, res) => {
    // Re-sort the remaining queued items now that a song is about to complete.
    // The currently-playing song is counted in doneCounts (status = 'playing')
    // so the rotation correctly treats it as used up before picking the next song.
    await resortQueueByRotation();

    // Capture the currently-playing row so we can update singer stats after completion.
    const playingRow = await query<{ id: number; singer_id: string | null }>(
      `SELECT id, singer_id FROM queue WHERE status = 'playing' LIMIT 1`
    );

    // Atomically mark current song done and start the next one.
    await query('BEGIN');
    try {
      await query(`UPDATE queue SET status = 'done', finished_at = NOW() WHERE status = 'playing'`);
      await query(`
        UPDATE queue SET status = 'playing', started_at = NOW()
         WHERE id IN (
           SELECT id FROM queue
           WHERE status = 'queued'
           ORDER BY position
           LIMIT 1
         )
      `);
      await query('COMMIT');
    } catch (e) {
      await query('ROLLBACK'); throw e;
    }

    // Update singer stats for the completed song using authoritative COUNT to avoid double-counting
    if (playingRow.rows.length > 0 && playingRow.rows[0].singer_id) {
      const singerId = playingRow.rows[0].singer_id;
      try {
        await recalculateSingerStats(singerId);
      } catch (err) {
        console.error('Failed to update singer stats after completion:', err);
      }
    }

    // Resume break music only when there is no next karaoke song to play
    const stillPlaying = await query<{ id: number }>(`SELECT id FROM queue WHERE status = 'playing' LIMIT 1`);
    if (stillPlaying.rows.length) {
      await ensureQueueTrackDurationBeforePlayback(stillPlaying.rows[0].id);
    } else {
      await autoResumeBreakMusicForKaraoke();
    }
    postQueueUpdate('player.next');
    res.json({ ok: true });
  })
);

apiRouter.post(
  '/player/stop',
  adminGuard,
  ah(async (_req, res) => {
    manualStopActive = true;
    await setSetting('player.manual_stop', 'true');
    await query(`UPDATE queue SET status = 'queued' WHERE status = 'playing'`);
    postQueueUpdate('player.stop');
    await autoResumeBreakMusicForKaraoke();
    res.json({ ok: true });
  })
);

apiRouter.post(
  '/player/youtube-fallback',
  ah(async (req, res) => {
    const id = toInt(req.body?.id);
    const errorCode = req.body?.errorCode != null ? String(req.body.errorCode) : null;
    if (id == null) return res.status(400).json({ error: 'id required' });

    const current = await query<{
      id: number;
      external_url: string | null;
      title: string | null;
      artist: string | null;
      disc_id: string | null;
    }>(
      `SELECT q.id,
              t.external_url,
              t.title,
              t.disc_id,
              a.name AS artist
         FROM queue q
         JOIN tracks t ON t.id = q.track_id
         LEFT JOIN artists a ON a.id = t.artist_id
        WHERE q.id = $1
          AND q.status = 'playing'
        LIMIT 1`,
      [id]
    );
    const row = current.rows[0];
    if (!row) return res.status(404).json({ error: 'Current playing song not found' });
    if (!row.external_url) return res.status(400).json({ error: 'Current song is not an external video' });

    const postFallbackStatus = (status: 'downloading' | 'ready' | 'error', message: string) => {
      postQueueUpdate('player.youtube_fallback', {
        status,
        message,
        queueId: id,
        title: row.title,
        artist: row.artist,
      });
    };

    const allowDownloads = await getSetting('ytdlp.allow_downloads');
    if (allowDownloads === false) {
      postFallbackStatus('error', '⚠️ YouTube fallback download is disabled.');
      return res.status(403).json({ error: 'Downloads are disabled' });
    }

    postFallbackStatus('downloading', 'YouTube playback failed. Downloading a local fallback...');
    logger.warn(
      `[player] YouTube playback failed${errorCode ? ` (error ${errorCode})` : ''}; downloading fallback for queue ${id}.`
    );
    try {
      const { downloadVideo, addDownloadedFileToDatabase } = await import('../ytdlp');
      const result = await downloadVideo(row.external_url, {
        title: row.title || undefined,
        artist: row.artist || undefined,
        discId: row.disc_id || undefined,
      });

      if (!result.success || !result.filePath) {
        const message = result.message || 'Download failed';
        postFallbackStatus('error', `⚠️ YouTube fallback failed: ${message}`);
        return res.status(500).json({ error: message });
      }

      const dbResult = await addDownloadedFileToDatabase(result.filePath);
      if (!dbResult.success || !dbResult.trackId) {
        const message = dbResult.message || 'Downloaded file could not be added to database';
        postFallbackStatus('error', `⚠️ YouTube fallback failed: ${message}`);
        return res.status(500).json({ error: message });
      }

      await query(
        `UPDATE queue
            SET track_id = $1,
                started_at = NOW()
          WHERE id = $2
            AND status = 'playing'`,
        [dbResult.trackId, id]
      );
      postFallbackStatus('ready', '✔ Local fallback ready. Restarting playback...');
      postQueueUpdate('player.play');
      res.json({
        ok: true,
        trackId: dbResult.trackId,
        filePath: result.filePath,
        message: 'Downloaded fallback and replaced current song',
      });
    } catch (err) {
      postFallbackStatus('error', '⚠️ YouTube fallback failed.');
      throw err;
    }
  })
);

// Get current player state (readable by all clients, not admin-only)
apiRouter.get(
  '/player/state',
  ah(async (_req, res) => {
    res.json({ manualStop: manualStopActive });
  })
);

// Track song state for autoplay logic
const songState = new Map<number | string, {
  hasFinished: boolean;
  autoplayScheduled: boolean;
}>();

// Track initial autoplay state to prevent duplicate triggers
let initialAutoplayScheduled = false;
let lastQueueCheck = 0;
// Prevents autoplay from restarting after a manual stop; cleared on manual play
let manualStopActive = false;

// Restore manualStopActive from DB on startup (so server restarts preserve the stopped state)
(async () => {
  try {
    const storedVal = await getSetting('player.manual_stop');
    if (storedVal === 'true') {
      manualStopActive = true;
    }
  } catch {
    // ignore — default is false
  }
})();

// Constants for initial autoplay timing
const INITIAL_AUTOPLAY_CHECK_INTERVAL_MS = 2000; // Check every 2 seconds
const INITIAL_AUTOPLAY_DEBOUNCE_MS = 3000; // Minimum time between scheduling attempts

// Helper function to check if initial autoplay conditions are met
async function checkInitialAutoplayConditions(): Promise<{ 
  shouldAutoplay: boolean; 
  autoplayEnabled: boolean;
  hasPlayingSong: boolean;
  hasQueuedSongs: boolean;
}> {
  const autoplayEnabled = await getSetting('autoplay.enabled');
  const isEnabled = autoplayEnabled === 'true';
  
  const currentlyPlaying = await query<{ id: number }>(`
    SELECT id FROM queue WHERE status = 'playing' LIMIT 1
  `);
  const hasPlayingSong = currentlyPlaying.rows.length > 0;
  
  const queuedSongs = await query<{ id: number }>(`
    SELECT id FROM queue WHERE status = 'queued' ORDER BY position LIMIT 1
  `);
  const hasQueuedSongs = queuedSongs.rows.length > 0;
  
  return {
    shouldAutoplay: isEnabled && !hasPlayingSong && hasQueuedSongs,
    autoplayEnabled: isEnabled,
    hasPlayingSong,
    hasQueuedSongs
  };
}

type QueueTrackDurationRow = {
  id: number;
  track_id: number;
  key_adjustment?: number | null;
  duration_ms: number | null;
  kind: string;
  file_mp4: string | null;
  file_mp3: string | null;
  file_cdg: string | null;
  title: string | null;
};

async function ensureQueueTrackDurationBeforePlayback(queueId: number | string | null | undefined): Promise<number | null> {
  if (queueId == null) return null;
  const id = normalizeQueueId(queueId);
  if (id == null) return null;

  const result = await query<QueueTrackDurationRow>(
    `SELECT q.id,
            q.track_id,
            q.key_adjustment,
            t.duration_ms,
            t.kind,
            t.file_mp4,
            t.file_mp3,
            t.file_cdg,
            t.title
       FROM queue q
       JOIN tracks t ON t.id = q.track_id
      WHERE q.id = $1`,
    [id],
  );
  if (result.rows.length === 0) return null;

  const track = result.rows[0];
  if (track.duration_ms != null && track.duration_ms > 0) {
    return Number(track.duration_ms);
  }

  logger.info(`Track ${track.track_id}: duration missing before playback; extracting now (${track.title ?? 'untitled'})`);
  const extractedDuration = await extractTrackDuration({
    kind: track.kind,
    file_mp4: track.file_mp4,
    file_mp3: track.file_mp3,
  });

  if (extractedDuration != null && extractedDuration > 0) {
    await query('UPDATE tracks SET duration_ms = $1 WHERE id = $2', [extractedDuration, track.track_id]);
    logger.info(`Track ${track.track_id}: cached duration before playback: ${extractedDuration}ms (${Math.round(extractedDuration / 1000)}s)`);
    return extractedDuration;
  }

  logger.warn(`Track ${track.track_id}: unable to extract duration before playback`);
  return null;
}

// Periodic check for initial autoplay - starts first song if:
// 1. No song is playing
// 2. Autoplay is enabled  
// 3. There are songs in queue
// 4. Enough time has passed since last check
setInterval(async () => {
  try {
    const now = Date.now();
    
    // Skip check if autoplay was recently scheduled to avoid unnecessary queries
    if (initialAutoplayScheduled && (now - lastQueueCheck) < INITIAL_AUTOPLAY_DEBOUNCE_MS) {
      return;
    }
    
    const conditions = await checkInitialAutoplayConditions();
    
    // Reset flag if conditions no longer met, or if a manual stop is active
    if (!conditions.autoplayEnabled || conditions.hasPlayingSong || !conditions.hasQueuedSongs || manualStopActive) {
      initialAutoplayScheduled = false;
      return;
    }
    
    // Schedule initial autoplay if not already scheduled
    if (!initialAutoplayScheduled && conditions.shouldAutoplay) {
      initialAutoplayScheduled = true;
      lastQueueCheck = now;
      
      const delayStr = await getSetting('autoplay.delay');
      const delay = delayStr ? parseInt(delayStr, 10) : 5;
      
      logger.info(`Initial autoplay: Waiting ${delay}s before starting first song...`);
      
      setTimeout(async () => {
        try {
          // Double-check conditions before starting song
          const stillValid = await checkInitialAutoplayConditions();
          
          if (!stillValid.shouldAutoplay) {
            logger.verbose('Initial autoplay: Conditions changed, skipping');
            initialAutoplayScheduled = false;
            return;
          }
          
          // Start playing the first queued song with proper transaction handling
          try {
            await query('BEGIN');
            const result = await query<{ id: number; title: string | null; artist: string | null }>(`
              WITH next_song AS (
                SELECT id FROM queue
                WHERE status = 'queued'
                ORDER BY position
                LIMIT 1
              ), updated AS (
                UPDATE queue SET status = 'playing'
                WHERE id = (SELECT id FROM next_song)
                RETURNING id, track_id
              )
              SELECT u.id, t.title, a.name AS artist
                FROM updated u
                JOIN tracks t ON t.id = u.track_id
                LEFT JOIN artists a ON a.id = t.artist_id
            `);
            await query('COMMIT');
            
            if (result.rows.length > 0) {
              const { id, title, artist } = result.rows[0];
              const songLabel = [artist, title].filter(Boolean).join(' - ') || `ID: ${id}`;
              await ensureQueueTrackDurationBeforePlayback(id);
              logger.info(`Initial autoplay: Started first song — ${songLabel}`);
              postQueueUpdate('player.play');
              await autoPauseBreakMusicForKaraoke();
            }
          } catch (dbErr) {
            await query('ROLLBACK');
            throw dbErr;
          }
          
          initialAutoplayScheduled = false;
        } catch (err) {
          console.error('Initial autoplay error:', err);
          initialAutoplayScheduled = false;
        }
      }, delay * 1000);
    }
  } catch (err) {
    console.error('Initial autoplay check error:', err);
    initialAutoplayScheduled = false;
  }
}, INITIAL_AUTOPLAY_CHECK_INTERVAL_MS);

// Helper function to normalize queue ID to a number
function normalizeQueueId(queueId: number | string): number | null {
  if (typeof queueId === 'number') {
    return queueId;
  }
  
  // Use stricter validation for string inputs
  const parsed = parseInt(queueId, 10);
  
  // Ensure the parsed value is valid and the string representation matches
  // This prevents cases like '123abc' being parsed as 123
  if (isNaN(parsed) || String(parsed) !== String(queueId).trim()) {
    return null;
  }
  
  return parsed;
}

// Mark a finished song as 'done' and keep it in the queue for history.
// Returns true if the song was found (whether it needed updating or was already
// done), false if the song does not exist in the queue at all.
async function markSongDone(queueId: number | string): Promise<boolean> {
  try {
    const id = normalizeQueueId(queueId);
    if (id === null) {
      console.warn(`Invalid queueId for completion: ${queueId}`);
      return false;
    }

    const checkResult = await query<{ id: number; singer_id: string | null; status: string }>(`
      SELECT id, singer_id, status FROM queue WHERE id = $1
    `, [id]);

    if (checkResult.rows.length === 0) {
      logger.verbose(`Song ${id} not found in queue`);
      return false;
    }

    const row = checkResult.rows[0];
    if (row.status === 'done') {
      // Already marked done (e.g. manual /player/next was called first)
      logger.verbose(`Song ${id} already marked done`);
      return true;
    }

    // Mark song done and record completion time
    await query(
      `UPDATE queue SET status = 'done', finished_at = NOW() WHERE id = $1`,
      [id],
    );
    logger.verbose(`Marked finished song ${id} as done`);

    // Recalculate singer stats from actual done-count
    if (row.singer_id) {
      await recalculateSingerStats(row.singer_id).catch((err) =>
        console.error(`Failed to recalculate singer stats after completion for singer ${row.singer_id}:`, err),
      );
    }

    return true;
  } catch (err) {
    console.error('Error marking finished song as done:', queueId, err);
    throw err;
  }
}

// Report playback timing from Player
apiRouter.post(
  '/player/timing',
  ah(async (req, res) => {
    const { currentTime, duration, queueId } = req.body;
    
    // Validate inputs
    if (typeof currentTime !== 'number' || typeof duration !== 'number') {
      return res.status(400).json({ error: 'currentTime and duration must be numbers' });
    }
    
    // Validate ranges
    if (currentTime < 0 || !isFinite(currentTime) || 
        duration <= 0 || !isFinite(duration)) {
      return res.status(400).json({ error: 'Invalid timing values: must be finite, non-negative, and duration must be positive' });
    }
    
    // Broadcast timing update to all connected clients via WebSocket
    postQueueUpdate('player.timing', {
      currentTime,
      duration,
      queueId
    });
    
    // Server-side autoplay logic: detect when song is finished
    const SONG_END_TOLERANCE = 1; // Same as Host page
    const songFinished = currentTime >= duration - SONG_END_TOLERANCE;
    
    if (songFinished && queueId != null) {
      // Normalize queueId to a consistent type for Map lookups
      const normalizedQueueId = normalizeQueueId(queueId);
      
      // Skip if the ID is invalid
      if (normalizedQueueId === null) {
        console.warn(`Invalid queueId received: ${queueId}`);
        return res.json({ ok: true });
      }
      
      // Get or initialize state for this song
      const state = songState.get(normalizedQueueId) || { hasFinished: false, autoplayScheduled: false };
      
      // Only trigger autoplay once per song
      if (!state.hasFinished && !state.autoplayScheduled) {
        state.hasFinished = true;
        state.autoplayScheduled = true;
        songState.set(normalizedQueueId, state);
        
        // Check if autoplay is enabled (default: enabled when setting is not explicitly set)
        const autoplayEnabled = await getSetting('autoplay.enabled');
        const isEnabled = autoplayEnabled !== 'false';
        
        if (isEnabled) {
          const delayStr = await getSetting('autoplay.delay');
          const delay = delayStr ? parseInt(delayStr, 10) : 5;
          const breakResumeDelayRaw = await getSetting('break_music.resume_delay');
          const breakResumeDelay = breakResumeDelayRaw !== null ? Math.max(0, parseInt(breakResumeDelayRaw, 10)) : 2;
          
          // Mark the finished song as done so Player page shows countdown
          try {
            const songStillExisted = await markSongDone(normalizedQueueId);
            
            if (!songStillExisted) {
              // Song was already removed, don't schedule autoplay
              songState.delete(normalizedQueueId);
              logger.verbose(`Autoplay: Song ${normalizedQueueId} was already removed, skipping autoplay`);
              postQueueUpdate('queue.updated');
              return res.json({ ok: true });
            }
            
            // Notify clients that queue has updated (finished song marked done)
            postQueueUpdate('queue.updated');
            
            // Determine whether there is a queued song waiting.
            // Use a shorter break-music resume delay when the queue is empty so that
            // break music resumes faster than the karaoke-to-karaoke transition delay.
            const nextQueued = await query<{ id: number }>(
              `SELECT id FROM queue WHERE status = 'queued' ORDER BY position LIMIT 1`
            );
            const timerDelay = nextQueued.rows.length > 0 ? delay : breakResumeDelay;

            if (nextQueued.rows.length > 0) {
              logger.info(`Song ${normalizedQueueId} finished. Autoplay enabled, waiting ${timerDelay}s before next song...`);
              // Resume break music immediately so it plays during the inter-song countdown
              await autoResumeBreakMusicForKaraoke();
            } else {
              logger.info(`Song ${normalizedQueueId} finished. Queue empty, resuming break music in ${timerDelay}s...`);
            }

            // Wait for the appropriate delay, then advance to next song or resume break music
            setTimeout(async () => {
              try {
                await query('BEGIN');
                
                // Check if there's already a song playing (could happen if user manually advanced)
                const currentlyPlaying = await query<{ id: number }>(`
                  SELECT id FROM queue WHERE status = 'playing' LIMIT 1
                `);
                
                if (currentlyPlaying.rows.length > 0) {
                  // Another song is already playing, don't start a new one
                  await query('COMMIT');
                  songState.delete(normalizedQueueId);
                  logger.verbose(`Autoplay: Another song is already playing (ID: ${currentlyPlaying.rows[0].id}), skipping autoplay`);
                  return;
                }
                
                // Check if manual stop is active — host pressed stop during the autoplay delay
                if (manualStopActive) {
                  await query('COMMIT');
                  songState.delete(normalizedQueueId);
                  logger.verbose(`Autoplay: Manual stop is active, skipping autoplay for song ${normalizedQueueId}`);
                  return;
                }
                
                // Play the next queued song
                const result = await query<{ id: number; title: string | null; artist: string | null }>(`
                  WITH next_song AS (
                    SELECT id FROM queue
                    WHERE status = 'queued'
                    ORDER BY position
                    LIMIT 1
                  ), updated AS (
                    UPDATE queue SET status = 'playing'
                    WHERE id = (SELECT id FROM next_song)
                    RETURNING id, track_id
                  )
                  SELECT u.id, t.title, a.name AS artist
                    FROM updated u
                    JOIN tracks t ON t.id = u.track_id
                    LEFT JOIN artists a ON a.id = t.artist_id
                `);
                
                await query('COMMIT');
                
                // Clean up state for the finished song
                songState.delete(normalizedQueueId);
                
                if (result.rows.length > 0) {
                  const { id, title, artist } = result.rows[0];
                  const songLabel = [artist, title].filter(Boolean).join(' - ') || `ID: ${id}`;
                  await ensureQueueTrackDurationBeforePlayback(id);
                  logger.info(`Autoplay: Started next song — ${songLabel}`);
                  // Pause break music now that the next karaoke song is starting
                  await autoPauseBreakMusicForKaraoke();
                  postQueueUpdate('player.next');
                } else {
                  logger.info('Autoplay: No more songs in queue');
                  postQueueUpdate('queue.updated');
                  await autoResumeBreakMusicForKaraoke();
                }
              } catch (err) {
                await query('ROLLBACK');
                console.error('Autoplay error:', err);
                songState.delete(normalizedQueueId);
              }
            }, timerDelay * 1000);
          } catch (err) {
            logger.error('Error marking finished song as done for autoplay:', err);
          }
        } else {
          logger.verbose(`Song ${normalizedQueueId} finished but autoplay is disabled`);
          // Still mark the finished song as done even if autoplay is disabled
          try {
            const marked = await markSongDone(normalizedQueueId);
            songState.delete(normalizedQueueId);
            if (marked) {
              postQueueUpdate('queue.updated');
              await autoResumeBreakMusicForKaraoke();
            }
          } catch (err) {
            console.error('Error in autoplay-disabled song completion:', err);
            // If marking fails, still clean up state and notify clients
            // The song may have been manually removed already
            songState.delete(normalizedQueueId);
            postQueueUpdate('queue.updated');
          }
        }
      }
    }
    
    res.json({ ok: true });
  })
);

// ==================== QR CODE GENERATION =====================
// QR endpoint is now handled by routes/qr.ts

// ===================== OVERLAY SETTINGS =====================

// Get overlay settings
apiRouter.get(
  '/overlay/settings',
  ah(async (_req, res) => {
    const visible = await getSetting('overlay.visible');
    const height = await getSetting('overlay.height');
    const qrSize = await getSetting('overlay.qrSize');
    const customMessage = await getSetting('overlay.customMessage');
    const showRoller = await getSetting('overlay.showRoller');
    const showQrCode = await getSetting('overlay.showQrCode');
    const hideSingerQueue = await getSetting('overlay.hideSingerQueue');
    const keepRotationScrollerSingers = await getSetting('overlay.keepRotationScrollerSingers');
    const showRequestsUrl = await getSetting('overlay.showRequestsUrl');
    res.json({
      visible: visible === null ? true : visible === 'true',
      height: height === null ? 90 : parseInt(height, 10),
      qrSize: qrSize === null ? 60 : parseInt(qrSize, 10),
      customMessage: customMessage || '',
      showRoller: showRoller === null ? true : showRoller === 'true',
      showQrCode: showQrCode === null ? true : showQrCode === 'true',
      hideSingerQueue: hideSingerQueue === null ? false : hideSingerQueue === 'true',
      keepRotationScrollerSingers:
        keepRotationScrollerSingers === null ? false : keepRotationScrollerSingers === 'true',
      showRequestsUrl: showRequestsUrl === null ? true : showRequestsUrl === 'true',
    });
  })
);

// Update overlay settings (requires admin)
apiRouter.post(
  '/overlay/settings',
  adminGuard,
  ah(async (req, res) => {
    const {
      visible,
      height,
      qrSize,
      customMessage,
      showRoller,
      showQrCode,
      hideSingerQueue,
      keepRotationScrollerSingers,
      showRequestsUrl,
    } = req.body;
    
    if (typeof visible === 'boolean') {
      await setSetting('overlay.visible', String(visible));
    }
    if (typeof height === 'number' && height >= 40 && height <= 150) {
      await setSetting('overlay.height', String(height));
    }
    if (typeof qrSize === 'number' && qrSize >= 40 && qrSize <= 150) {
      await setSetting('overlay.qrSize', String(qrSize));
    }
    if (typeof customMessage === 'string') {
      // Limit custom message length to 500 characters
      const truncatedMessage = customMessage.slice(0, 500);
      await setSetting('overlay.customMessage', truncatedMessage);
    }
    if (typeof showRoller === 'boolean') {
      await setSetting('overlay.showRoller', String(showRoller));
    }
    if (typeof showQrCode === 'boolean') {
      await setSetting('overlay.showQrCode', String(showQrCode));
    }
    if (typeof hideSingerQueue === 'boolean') {
      await setSetting('overlay.hideSingerQueue', String(hideSingerQueue));
    }
    if (typeof keepRotationScrollerSingers === 'boolean') {
      await setSetting('overlay.keepRotationScrollerSingers', String(keepRotationScrollerSingers));
    }
    if (typeof showRequestsUrl === 'boolean') {
      await setSetting('overlay.showRequestsUrl', String(showRequestsUrl));
    }
    
    // Broadcast settings update to all clients
    const currentVisible = await getSetting('overlay.visible');
    const currentHeight = await getSetting('overlay.height');
    const currentQrSize = await getSetting('overlay.qrSize');
    const currentCustomMessage = await getSetting('overlay.customMessage');
    const currentShowRoller = await getSetting('overlay.showRoller');
    const currentShowQrCode = await getSetting('overlay.showQrCode');
    const currentHideSingerQueue = await getSetting('overlay.hideSingerQueue');
    const currentKeepRotationScrollerSingers = await getSetting('overlay.keepRotationScrollerSingers');
    const currentShowRequestsUrl = await getSetting('overlay.showRequestsUrl');
    
    postQueueUpdate('overlay.settings', {
      visible: currentVisible === null ? true : currentVisible === 'true',
      height: currentHeight === null ? 90 : parseInt(currentHeight, 10),
      qrSize: currentQrSize === null ? 60 : parseInt(currentQrSize, 10),
      customMessage: currentCustomMessage || '',
      showRoller: currentShowRoller === null ? true : currentShowRoller === 'true',
      showQrCode: currentShowQrCode === null ? true : currentShowQrCode === 'true',
      hideSingerQueue: currentHideSingerQueue === null ? false : currentHideSingerQueue === 'true',
      keepRotationScrollerSingers:
        currentKeepRotationScrollerSingers === null ? false : currentKeepRotationScrollerSingers === 'true',
      showRequestsUrl: currentShowRequestsUrl === null ? true : currentShowRequestsUrl === 'true',
    });
    
    res.json({ ok: true });
  })
);

apiRouter.get(
  '/overlay/rotation-singers',
  ah(async (_req, res) => {
    const activeRotation = await query<{ id: string }>(
      `SELECT id FROM rotations WHERE status = 'active' ORDER BY created_at DESC LIMIT 1`
    );

    if (activeRotation.rows.length === 0) {
      res.json([]);
      return;
    }

    const result = await query<{
      display_name: string;
      position: number;
      has_queue: boolean;
    }>(
      `SELECT
         s.display_name,
         rs.position,
         EXISTS (
           SELECT 1
             FROM queue q
            WHERE q.status IN ('queued', 'playing')
              AND (
                q.singer_id = rs.singer_id
                OR (
                  q.singer_id IS NULL
                  AND LOWER(REGEXP_REPLACE(TRIM(COALESCE(q.requested_by, '')), '\s+', ' ', 'g')) = s.normalized_name
                )
              )
         ) AS has_queue
         FROM rotation_singers rs
         JOIN singers s ON s.id = rs.singer_id
        WHERE rs.rotation_id = $1
          AND rs.status = 'active'
        ORDER BY rs.position`,
      [activeRotation.rows[0].id]
    );

    res.json(
      result.rows.map((row) => ({
        displayName: row.display_name,
        position: row.position,
        hasQueuedSong: row.has_queue,
      }))
    );
  })
);

// ===================== AUTOPLAY SETTINGS =====================

// Get autoplay settings
apiRouter.get(
  '/autoplay/settings',
  ah(async (_req, res) => {
    const enabled = await getSetting('autoplay.enabled');
    const delay = await getSetting('autoplay.delay');
    res.json({
      enabled: enabled === null ? false : enabled === 'true',
      delay: delay === null ? 5 : parseInt(delay, 10)
    });
  })
);

// Update autoplay settings (requires admin)
apiRouter.post(
  '/autoplay/settings',
  adminGuard,
  ah(async (req, res) => {
    const { enabled, delay } = req.body;
    
    if (typeof enabled === 'boolean') {
      await setSetting('autoplay.enabled', String(enabled));
    }
    if (typeof delay === 'number' && delay >= 0 && delay <= 60) {
      await setSetting('autoplay.delay', String(delay));
    }
    
    // Broadcast settings update to all clients
    const currentEnabled = await getSetting('autoplay.enabled');
    const currentDelay = await getSetting('autoplay.delay');
    
    postQueueUpdate('autoplay.settings', {
      enabled: currentEnabled === null ? false : currentEnabled === 'true',
      delay: currentDelay === null ? 5 : parseInt(currentDelay, 10)
    });
    
    res.json({ ok: true });
  })
);

// ===================== CLEAR DATABASE (FK-safe, verifiable) =====================

apiRouter.post(
  '/admin/clear-db',
  adminGuard,
  ah(async (_req, res) => {
    const [a1, t1, q1] = await Promise.all([
      query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM artists`),
      query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM tracks`),
      query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM queue`),
    ]);

    await query(`
      TRUNCATE TABLE queue, tracks, artists
      RESTART IDENTITY
      CASCADE
    `);

    const [a2, t2, q2] = await Promise.all([
      query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM artists`),
      query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM tracks`),
      query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM queue`),
    ]);

    res.json({
      ok: true,
      before: { artists: Number(a1.rows[0].c), tracks: Number(t1.rows[0].c), queue: Number(q1.rows[0].c) },
      after:  { artists: Number(a2.rows[0].c), tracks: Number(t2.rows[0].c), queue: Number(q2.rows[0].c) }
    });

    postQueueUpdate('queue.updated');
  })
);

// ===================== YT-DLP OPERATIONS =====================

// Get yt-dlp version
apiRouter.get(
  '/admin/ytdlp/version',
  adminGuard,
  ah(async (req, res) => {
    const { getYtDlpVersion } = await import('../ytdlp');
    const version = await getYtDlpVersion();
    res.json({ version });
  })
);

// Update yt-dlp
apiRouter.post(
  '/admin/ytdlp/update',
  adminGuard,
  ah(async (req, res) => {
    const { updateYtDlp } = await import('../ytdlp');
    const result = await updateYtDlp();
    res.json(result);
  })
);

// Download video using yt-dlp
apiRouter.post(
  '/admin/ytdlp/download',
  adminGuard,
  ah(async (req, res) => {
    const { url, format, title, artist, brand, discId } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }
    
    // Check if downloads are allowed
    const allowDownloads = await getSetting('ytdlp.allow_downloads');
    if (allowDownloads === false) {
      return res.status(403).json({ error: 'Downloads are disabled' });
    }
    
    const { downloadVideo, addDownloadedFileToDatabase } = await import('../ytdlp');
    
    // Download the video
    const result = await downloadVideo(url, { format, title, artist, brand, discId });
    
    if (result.success && result.filePath) {
      // Add the downloaded file to the database
      const dbResult = await addDownloadedFileToDatabase(result.filePath);
      
      res.json({ 
        ok: true, 
        filePath: result.filePath,
        parsed: result.parsed,
        trackId: dbResult.trackId,
        message: result.message,
        dbMessage: dbResult.message
      });
    } else {
      res.status(500).json({ error: result.message });
    }
  })
);

// Scan download location
apiRouter.post(
  '/admin/ytdlp/scan',
  adminGuard,
  ah(async (req, res) => {
    try {
      const result = await scanDownloadLocation();
      res.json(result);
    } catch (error) {
      if (error instanceof DownloadScanAlreadyInProgressError) {
        return res.status(409).json({ ok: false, message: error.message });
      }
      throw error;
    }
  })
);

// Get video info
apiRouter.post(
  '/admin/ytdlp/info',
  adminGuard,
  ah(async (req, res) => {
    const { url } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }
    
    const { getVideoInfo } = await import('../ytdlp');
    try {
      const info = await getVideoInfo(url);
      res.json({ ok: true, info });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  })
);

// ===================== SETTINGS MANAGEMENT =====================

// Get public settings (no authentication required - for guest features like Requests page)
apiRouter.get(
  '/settings/public',
  ah(async (req, res) => {
    // Only return settings that are safe for public access
    const publicKeys: Array<keyof PublicSettings> = [
      'libraries.local_enabled',
      'libraries.external_enabled',
      'requests.acceptance',
      'requests.local_browse_enabled'
    ];
    
    const result = await query('SELECT key, value FROM settings WHERE key = ANY($1)', [publicKeys]);
    const settings: Partial<PublicSettings> = {};
    for (const row of result.rows) {
      settings[row.key as keyof PublicSettings] = row.value;
    }
    
    // Set defaults for missing settings
    const completeSettings: PublicSettings = {
      'libraries.local_enabled': settings['libraries.local_enabled'] ?? true,
      'libraries.external_enabled': settings['libraries.external_enabled'] ?? true,
      'requests.acceptance': settings['requests.acceptance'] ?? 'local',
      'requests.local_browse_enabled': settings['requests.local_browse_enabled'] ?? true,
      'requests.url': await getPublicRequestsUrl(req),
    };
    
    res.json(completeSettings);
  })
);

// Get all settings (admin only)
apiRouter.get(
  '/admin/settings',
  adminGuard,
  ah(async (req, res) => {
    const result = await query('SELECT key, value FROM settings ORDER BY key');
    const settings: Record<string, any> = {};
    for (const row of result.rows) {
      settings[row.key] = row.value;
    }
    settings['station.mode'] = process.env.STATION_MODE === 'true';
    res.json(settings);
  })
);

apiRouter.post(
  '/admin/remote-gateway/test',
  adminGuard,
  ah(async (_req, res) => {
    const config = await getRemoteGatewayConfig();
    await pushRemoteGatewaySettings(config);
    const status = await getRemoteGatewayStatus(config);
    res.json({
      ok: true,
      gatewayUrl: config.url,
      status,
    });
  })
);

apiRouter.post(
  '/admin/remote-gateway/sync',
  adminGuard,
  ah(async (_req, res) => {
    res.json(await runRemoteGatewaySync({ includeCatalog: true }));
  })
);

// Update a setting (admin only)
apiRouter.put(
  '/admin/settings/:key',
  adminGuard,
  ah(async (req, res) => {
    const { key } = req.params;
    const { value } = req.body;
    
    if (!key) {
      return res.status(400).json({ error: 'Setting key is required' });
    }
    
    await setSetting(key, value);

    // Apply log level change immediately without requiring a server restart
    if (key === 'admin.log_level' && value) {
      setLogLevel(value as LogLevel);
    }

    if (key === 'admin.background_tasks_enabled') {
      await syncDurationProcessingTaskState({ runImmediately: value !== false });
    }

    if (key === 'admin.background_media_scan_enabled') {
      await syncMediaLibraryScanTaskState({ runImmediately: value !== false });
    }

    if (key === 'admin.background_download_scan_enabled') {
      await syncDownloadScanTaskState({ runImmediately: value !== false });
    }

    if (key === 'admin.background_break_music_scan_enabled') {
      await syncBreakMusicScanTaskState({ runImmediately: value !== false });
    }

    if (
      key === 'remote_gateway.url' ||
      key === 'remote_gateway.enabled' ||
      key === 'remote_gateway.api_token' ||
      key === 'remote_gateway.poll_interval_seconds' ||
      key === 'libraries.local_enabled' ||
      key === 'libraries.external_enabled' ||
      key === 'requests.acceptance' ||
      key === 'requests.local_browse_enabled'
    ) {
      await syncRemoteGatewayTaskState({ runImmediately: true });
    }

    res.json({ ok: true });
  })
);

// ===================== BREAK MUSIC =====================

apiRouter.get(
  '/break-music/folders',
  adminGuard,
  ah(async (_req, res) => {
    const r = await query<{ id: number; name: string; path: string }>(
      `SELECT id, name, path FROM break_music_folders ORDER BY id`
    );
    res.json(r.rows);
  })
);

apiRouter.post(
  '/break-music/folders',
  adminGuard,
  ah(async (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    const folderPath = String(req.body?.path ?? '').trim();
    if (!name || !folderPath) return res.status(400).json({ error: 'name and path required' });
    await query(`INSERT INTO break_music_folders(name, path) VALUES ($1, $2)`, [name, folderPath]);
    res.json({ ok: true });
  })
);

apiRouter.delete(
  '/break-music/folders/:id',
  adminGuard,
  ah(async (req, res) => {
    const id = toInt(req.params.id);
    if (id == null) return res.status(400).json({ error: 'invalid id' });
    await query('BEGIN');
    try {
      await query(`DELETE FROM break_music_tracks WHERE folder_id = $1`, [id]);
      await query(`DELETE FROM break_music_folders WHERE id = $1`, [id]);
      await query('COMMIT');
    } catch (err) {
      await query('ROLLBACK');
      throw err;
    }

    const resolved = await resolveBreakMusicPlaybackState(0);
    postQueueUpdate('break_music.updated');
    res.json({ ok: true, currentTrackId: resolved.track?.id ?? null });
  })
);

apiRouter.post(
  '/break-music/clear-library',
  adminGuard,
  ah(async (_req, res) => {
    const beforeResult = await query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM break_music_tracks`);
    const before = Number(beforeResult.rows[0]?.count || '0');

    await query(`DELETE FROM break_music_tracks`);
    await setBreakMusicState({
      currentTrackId: null,
      currentStartedAt: null,
      currentPositionSec: 0,
      playlistTrackIds: [],
      playlistIndex: 0,
      activePlaylistId: null,
    });

    const afterResult = await query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM break_music_tracks`);
    const after = Number(afterResult.rows[0]?.count || '0');

    postQueueUpdate('break_music.updated');
    res.json({ ok: true, before, after });
  })
);

apiRouter.post(
  '/break-music/scan',
  adminGuard,
  ah(async (req, res) => {
    const folderId = toInt(req.body?.folderId);
    let indexed = 0;
    try {
      ({ indexed } = await runBreakMusicScan(folderId));
    } catch (error) {
      if (error instanceof BreakMusicScanAlreadyInProgressError) {
        return res.status(409).json({ ok: false, message: error.message });
      }
      throw error;
    }

    const resolved = await resolveBreakMusicPlaybackState(0);
    postQueueUpdate('break_music.updated');
    res.json({ ok: true, indexed, currentTrackId: resolved.track?.id ?? null });
  })
);

apiRouter.get(
  '/break-music/search',
  sessionGuard,
  searchLimiter,
  ah(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const r = q
      ? await query(
        `SELECT id, title, artist, genre, duration_ms, file_path
           FROM break_music_tracks
          WHERE title ILIKE '%' || $1 || '%'
             OR artist ILIKE '%' || $1 || '%'
             OR genre ILIKE '%' || $1 || '%'
          ORDER BY artist NULLS LAST, title`,
        [q]
      )
      : await query(
        `SELECT id, title, artist, genre, duration_ms, file_path
           FROM break_music_tracks
          ORDER BY artist NULLS LAST, title`
      );
    res.json(r.rows);
  })
);

apiRouter.get(
  '/break-music/state',
  ah(async (_req, res) => {
    const crossfadeSeconds = Number(await getSetting('break_music.crossfade_seconds') ?? 3);
    const volumePercent = Number(await getSetting('break_music.volume_percent') ?? 100);
    const resumeDelayRaw = await getSetting('break_music.resume_delay');
    const resumeDelaySec = resumeDelayRaw !== null ? Number(resumeDelayRaw) : 2;
    const resolved = await resolveBreakMusicPlaybackState(0);
    const playlistNames = await query<{ id: number; name: string }>(
      `SELECT id, name FROM break_music_playlists ORDER BY updated_at DESC, id DESC`
    );

    let elapsed = resolved.state.currentPositionSec || 0;
    if (!resolved.state.paused && resolved.state.currentStartedAt) {
      const startedMs = Date.parse(resolved.state.currentStartedAt);
      if (Number.isFinite(startedMs)) {
        elapsed = Math.max(elapsed, Math.floor((Date.now() - startedMs) / 1000));
      }
    }

    const durationSec = resolved.track?.duration_ms ? Math.max(0, Math.floor(resolved.track.duration_ms / 1000)) : null;
    const remainingSec = durationSec != null ? Math.max(0, durationSec - elapsed) : null;

    res.json({
      paused: resolved.state.paused,
      crossfadeSeconds: Number.isFinite(crossfadeSeconds) ? crossfadeSeconds : 3,
      volumePercent: Number.isFinite(volumePercent) ? Math.max(0, Math.min(100, Math.round(volumePercent))) : 100,
      resumeDelaySec: Number.isFinite(resumeDelaySec) ? Math.max(0, Math.min(30, Math.round(resumeDelaySec))) : 2,
      currentTrack: resolved.track,
      elapsedSec: elapsed,
      remainingSec,
      playlistTrackIds: resolved.state.playlistTrackIds,
      playlistIndex: resolved.state.playlistIndex,
      activePlaylistId: resolved.state.activePlaylistId,
      playlists: playlistNames.rows
    });
  })
);

apiRouter.post(
  '/break-music/settings',
  adminGuard,
  ah(async (req, res) => {
    const hasCrossfadeSeconds = req.body?.crossfadeSeconds !== undefined;
    const hasVolumePercent = req.body?.volumePercent !== undefined;
    const hasResumeDelaySec = req.body?.resumeDelaySec !== undefined;
    if (!hasCrossfadeSeconds && !hasVolumePercent && !hasResumeDelaySec) {
      return res.status(400).json({ error: 'At least one of crossfadeSeconds, volumePercent, or resumeDelaySec is required' });
    }

    if (hasCrossfadeSeconds) {
      const crossfadeSeconds = Number(req.body?.crossfadeSeconds);
      if (!Number.isFinite(crossfadeSeconds) || crossfadeSeconds < 0 || crossfadeSeconds > 15) {
        return res.status(400).json({ error: 'crossfadeSeconds must be between 0 and 15' });
      }
      await setSetting('break_music.crossfade_seconds', crossfadeSeconds);
    }

    if (hasVolumePercent) {
      const volumePercent = Number(req.body?.volumePercent);
      if (!Number.isFinite(volumePercent) || volumePercent < 0 || volumePercent > 100) {
        return res.status(400).json({ error: 'volumePercent must be between 0 and 100' });
      }
      await setSetting('break_music.volume_percent', Math.round(volumePercent));
    }

    if (hasResumeDelaySec) {
      const resumeDelaySec = Number(req.body?.resumeDelaySec);
      if (!Number.isFinite(resumeDelaySec) || resumeDelaySec < 0 || resumeDelaySec > 30) {
        return res.status(400).json({ error: 'resumeDelaySec must be between 0 and 30' });
      }
      await setSetting('break_music.resume_delay', Math.round(resumeDelaySec));
    }

    postQueueUpdate('break_music.updated');
    res.json({ ok: true });
  })
);

apiRouter.post(
  '/break-music/control',
  adminGuard,
  ah(async (req, res) => {
    const action = String(req.body?.action || '').trim();
    if (action === 'pause') {
      const resolved = await resolveBreakMusicPlaybackState(0);
      let currentPositionSec = resolved.state.currentPositionSec || 0;
      if (!resolved.state.paused && resolved.state.currentStartedAt) {
        const startedMs = Date.parse(resolved.state.currentStartedAt);
        if (Number.isFinite(startedMs)) {
          currentPositionSec = Math.max(currentPositionSec, Math.floor((Date.now() - startedMs) / 1000));
        }
      }
      // User explicitly paused — clear autoPaused so karaoke end won't override this
      await setBreakMusicState({ paused: true, autoPaused: false, currentPositionSec, currentStartedAt: null });
    } else if (action === 'resume') {
      const state = await getBreakMusicState();
      // User explicitly resumed — clear autoPaused so karaoke start will auto-pause again if needed
      await setBreakMusicState({
        paused: false,
        autoPaused: false,
        currentStartedAt: new Date(Date.now() - Math.max(0, state.currentPositionSec) * 1000).toISOString()
      });
    } else if (action === 'skip') {
      await resolveBreakMusicPlaybackState(1);
    } else if (action === 'previous') {
      await resolveBreakMusicPlaybackState(-1);
    } else if (action === 'select') {
      const trackId = toInt(req.body?.trackId);
      if (trackId == null) return res.status(400).json({ error: 'trackId required for select' });
      await setBreakMusicState({
        currentTrackId: trackId,
        currentStartedAt: new Date().toISOString(),
        currentPositionSec: 0,
        paused: false
      });
    } else {
      return res.status(400).json({ error: 'Invalid action' });
    }

    const resolved = await resolveBreakMusicPlaybackState(0);
    postQueueUpdate('break_music.updated');
    res.json({ ok: true, currentTrack: resolved.track });
  })
);

apiRouter.post(
  '/break-music/auto-next',
  adminGuard,
  ah(async (_req, res) => {
    await resolveBreakMusicPlaybackState(1);
    postQueueUpdate('break_music.updated');
    res.json({ ok: true });
  })
);

apiRouter.post(
  '/break-music/timing',
  adminGuard,
  ah(async (req, res) => {
    const trackId = toInt(req.body?.trackId);
    const currentTime = Number(req.body?.currentTime);
    if (trackId == null || !Number.isFinite(currentTime) || currentTime < 0) {
      return res.status(400).json({ error: 'trackId and currentTime are required' });
    }
    await setBreakMusicState({
      currentTrackId: trackId,
      currentPositionSec: Math.floor(currentTime),
      currentStartedAt: new Date(Date.now() - Math.floor(currentTime * 1000)).toISOString()
    });
    res.json({ ok: true });
  })
);

apiRouter.get(
  '/break-music/playlists',
  sessionGuard,
  ah(async (_req, res) => {
    const r = await query<{ id: number; name: string; created_at: string; updated_at: string }>(
      `SELECT id, name, created_at, updated_at
         FROM break_music_playlists
        ORDER BY updated_at DESC, id DESC`
    );
    res.json(r.rows);
  })
);

apiRouter.post(
  '/break-music/playlists',
  sessionGuard,
  ah(async (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    const trackIds = Array.isArray(req.body?.trackIds)
      ? req.body.trackIds.map((v: any) => Number(v)).filter((v: number) => Number.isFinite(v))
      : [];

    if (!name) return res.status(400).json({ error: 'name required' });
    if (trackIds.length === 0) return res.status(400).json({ error: 'trackIds required' });

    await query('BEGIN');
    try {
      const playlist = await query<{ id: number }>(
        `INSERT INTO break_music_playlists(name)
         VALUES($1)
         ON CONFLICT (name) DO UPDATE SET updated_at = now()
         RETURNING id`,
        [name]
      );
      const playlistId = playlist.rows[0].id;
      await query(`DELETE FROM break_music_playlist_tracks WHERE playlist_id = $1`, [playlistId]);
      for (let i = 0; i < trackIds.length; i++) {
        await query(
          `INSERT INTO break_music_playlist_tracks(playlist_id, track_id, position)
           VALUES ($1, $2, $3)`,
          [playlistId, trackIds[i], i]
        );
      }
      const m3uPath = await writeBreakMusicPlaylistFile(name, trackIds);
      await query('COMMIT');
      res.json({ ok: true, playlistId, m3uPath });
    } catch (err) {
      await query('ROLLBACK');
      throw err;
    }
  })
);

apiRouter.post(
  '/break-music/playlists/load',
  sessionGuard,
  ah(async (req, res) => {
    const playlistId = toInt(req.body?.playlistId);
    if (playlistId == null) return res.status(400).json({ error: 'playlistId required' });
    const tracks = await query<{ track_id: number }>(
      `SELECT track_id FROM break_music_playlist_tracks
        WHERE playlist_id = $1
        ORDER BY position`,
      [playlistId]
    );
    const trackIds = tracks.rows.map(r => r.track_id);
    await setBreakMusicState({
      playlistTrackIds: trackIds,
      playlistIndex: 0,
      currentTrackId: null,
      currentPositionSec: 0,
      currentStartedAt: null,
      paused: false,
      activePlaylistId: playlistId,
    });
    const resolved = await resolveBreakMusicPlaybackState(0);
    postQueueUpdate('break_music.updated');
    res.json({ ok: true, trackIds, currentTrack: resolved.track });
  })
);

apiRouter.post(
  '/break-music/playlist/active',
  sessionGuard,
  ah(async (req, res) => {
    const requestedTrackIds = Array.isArray(req.body?.trackIds)
      ? req.body.trackIds.map((v: any) => Number(v)).filter((v: number) => Number.isFinite(v))
      : [];

    const existing = requestedTrackIds.length
      ? await query<{ id: number }>(
        `SELECT id
           FROM break_music_tracks
          WHERE id = ANY($1)
          ORDER BY array_position($1::int[], id)`,
        [requestedTrackIds]
      )
      : { rows: [] as { id: number }[] };
    const trackIds = existing.rows.map((r) => r.id);

    const state = await getBreakMusicState();
    let currentTrackId = state.currentTrackId;
    let playlistIndex = 0;
    let currentStartedAt = state.currentStartedAt;
    let currentPositionSec = state.currentPositionSec;

    if (trackIds.length === 0) {
      currentTrackId = null;
      playlistIndex = 0;
      currentStartedAt = null;
      currentPositionSec = 0;
    } else if (currentTrackId != null && trackIds.includes(currentTrackId)) {
      playlistIndex = trackIds.indexOf(currentTrackId);
    } else {
      const maxIndex = Math.max(0, trackIds.length - 1);
      const nextIndex = Math.min(Math.max(state.playlistIndex, 0), maxIndex);
      currentTrackId = trackIds[nextIndex] ?? null;
      playlistIndex = nextIndex;
      currentStartedAt = currentTrackId != null ? new Date().toISOString() : null;
      currentPositionSec = 0;
    }

    await setBreakMusicState({
      playlistTrackIds: trackIds,
      playlistIndex,
      currentTrackId,
      currentStartedAt,
      currentPositionSec,
      activePlaylistId: null,
    });

    const resolved = await resolveBreakMusicPlaybackState(0);
    postQueueUpdate('break_music.updated');
    res.json({
      ok: true,
      trackIds: resolved.state.playlistTrackIds,
      playlistIndex: resolved.state.playlistIndex,
      currentTrack: resolved.track
    });
  })
);

// JSON error handler
apiRouter.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('API error:', err);
  res.status(500).json({ error: String(err?.message || err) });
});

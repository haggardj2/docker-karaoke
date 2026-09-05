import crypto from 'crypto';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { fileURLToPath } from 'url';
import { config, validateConfig } from './config.js';
import { openDatabase, setMeta } from './db.js';
import { searchKaraokeNerds } from './karaokeNerds.js';

type TrackInput = {
  id?: string | number;
  stationTrackId?: string | number;
  title?: string;
  artist?: string | null;
  discId?: string | null;
  kind?: string;
  durationMs?: number | null;
  source?: string | null;
  externalUrl?: string | null;
};

type QueueInput = {
  stationQueueId?: string | number;
  id?: string | number;
  stationTrackId?: string | number | null;
  trackId?: string | number | null;
  requestedBy?: string | null;
  singerUuid?: string | null;
  status?: string;
  position?: number;
  keyAdjustment?: number;
  title?: string;
  artist?: string | null;
};

type GatewaySettings = {
  localEnabled: boolean;
  externalEnabled: boolean;
  requestAcceptance: 'local' | 'external' | 'disabled';
  localBrowseEnabled: boolean;
  stationConnected: boolean;
};

validateConfig();

const db = openDatabase();
const app = express();
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: config.corsOrigins === '*' ? true : config.corsOrigins,
  credentials: false,
}));
app.use(express.json({ limit: config.jsonBodyLimit }));
app.use(express.static(publicDir, {
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache');
  },
}));

function asyncHandler(fn: express.RequestHandler): express.RequestHandler {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function requireStationToken(req: express.Request, res: express.Response, next: express.NextFunction) {
  const auth = String(req.header('authorization') || '');
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  const provided = bearer || String(req.header('x-station-token') || '').trim();
  if (!provided || !safeEqual(provided, config.stationApiToken)) {
    res.status(401).json({ error: 'Invalid Station API token' });
    return;
  }
  next();
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function normalizeStationTrackId(input: TrackInput): string {
  return String(input.stationTrackId ?? input.id ?? '').trim();
}

function normalizeStationQueueId(input: QueueInput): string {
  return String(input.stationQueueId ?? input.id ?? '').trim();
}

function normalizeString(value: unknown, maxLength: number): string {
  return String(value ?? '').trim().slice(0, maxLength);
}

function normalizeNullableString(value: unknown, maxLength: number): string | null {
  const normalized = normalizeString(value, maxLength);
  return normalized || null;
}

function normalizeKeyAdjustment(value: unknown): number {
  const parsed = Number(value ?? 0);
  if (!Number.isInteger(parsed) || parsed < -6 || parsed > 6) {
    throw Object.assign(new Error('keyAdjustment must be an integer between -6 and 6'), { status: 400 });
  }
  return parsed;
}

function externalTrackId(url: string): string {
  return `external:knerds:${crypto.createHash('sha256').update(url).digest('hex').slice(0, 24)}`;
}

function getStationConnected() {
  const row = db.prepare(`
    SELECT value
      FROM gateway_meta
     WHERE key IN ('last_settings_sync_at', 'last_queue_sync_at')
     ORDER BY value DESC
     LIMIT 1
  `).get() as { value: string } | undefined;
  const lastSync = row ? Date.parse(row.value) : NaN;
  return Number.isFinite(lastSync) && Date.now() - lastSync < 30_000;
}

function getGatewaySettings(): GatewaySettings {
  const rows = db.prepare('SELECT key, value FROM gateway_meta WHERE key IN (?, ?, ?, ?)')
    .all('libraries.local_enabled', 'libraries.external_enabled', 'requests.acceptance', 'requests.local_browse_enabled') as { key: string; value: string }[];
  const values = new Map(rows.map((row) => [row.key, row.value]));
  const boolValue = (key: string, fallback: boolean) => {
    const raw = values.get(key);
    if (raw == null) return fallback;
    return raw !== 'false';
  };
  const requestAcceptance = values.get('requests.acceptance');
  return {
    localEnabled: boolValue('libraries.local_enabled', true),
    externalEnabled: boolValue('libraries.external_enabled', true),
    requestAcceptance: requestAcceptance === 'external' || requestAcceptance === 'disabled' ? requestAcceptance : 'local',
    localBrowseEnabled: boolValue('requests.local_browse_enabled', true),
    stationConnected: getStationConnected(),
  };
}

function requestsAreClosed(settings: GatewaySettings) {
  return settings.requestAcceptance === 'disabled' || (!settings.localEnabled && !settings.externalEnabled);
}

function trackIsExternal(track: { source?: string | null; external_url?: string | null; station_track_id?: string | null }) {
  return Boolean(track.external_url) || (track.source != null && track.source !== 'local') || String(track.station_track_id || '').startsWith('external:');
}

function trackSelectSql() {
  return `
    t.station_track_id AS id,
    t.title,
    t.artist,
    t.disc_id AS discId,
    t.kind,
    t.duration_ms AS durationMs,
    t.source,
    t.external_url AS externalUrl
  `;
}

function catalogAvailabilityClause(settings: GatewaySettings, alias = 't', browse = false) {
  const externalExpr = `(COALESCE(${alias}.external_url, '') <> '' OR COALESCE(${alias}.source, 'local') <> 'local')`;
  const localExpr = `(COALESCE(${alias}.external_url, '') = '' AND COALESCE(${alias}.source, 'local') = 'local')`;
  const localEnabled = settings.localEnabled && (!browse || settings.localBrowseEnabled);

  if (localEnabled && settings.externalEnabled) return '';
  if (localEnabled) return `AND ${localExpr}`;
  if (settings.externalEnabled) return `AND ${externalExpr}`;
  return 'AND 1 = 0';
}

function initialFilterClause(expression: string, prefix: string) {
  const normalized = prefix.trim().toUpperCase();
  if (normalized === '#') {
    return {
      clause: `AND (UPPER(SUBSTR(TRIM(${expression}), 1, 1)) < 'A' OR UPPER(SUBSTR(TRIM(${expression}), 1, 1)) > 'Z')`,
      params: [] as unknown[],
    };
  }
  if (/^[A-Z]$/.test(normalized)) {
    return {
      clause: `AND UPPER(SUBSTR(TRIM(${expression}), 1, 1)) = ?`,
      params: [normalized] as unknown[],
    };
  }
  return { clause: '', params: [] as unknown[] };
}

function dedupeSearchRows(rows: any[]) {
  const seen = new Set<string>();
  const unique: any[] = [];
  for (const row of rows) {
    const isExternal = Boolean(row.externalUrl) || row.source === 'karaoke-nerds' || String(row.id || '').startsWith('external:');
    const key = isExternal
      ? `external:${String(row.externalUrl || row.id || '').trim().toLowerCase().replace(/\/+$/, '')}`
      : `local:${row.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(row);
  }
  return unique;
}

function requesterWhere(name: string, singerUuid: string | null) {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (name) {
    clauses.push('LOWER(requested_by) = LOWER(?)');
    params.push(name);
  }
  if (singerUuid) {
    clauses.push('singer_uuid = ?');
    params.push(singerUuid);
  }
  return { clause: clauses.join(' OR '), params };
}

function parseHistorySourceTrack(sourceData: unknown) {
  if (!sourceData) return null;
  try {
    const parsed = JSON.parse(String(sourceData));
    return parsed?.track && typeof parsed.track === 'object' ? parsed.track : null;
  } catch {
    return null;
  }
}

function singerHistoryRows(name: string, singerUuid: string | null) {
  const where = requesterWhere(name, singerUuid);

  const requestRows = db.prepare(`
    SELECT t.title,
           t.artist,
           r.status,
           r.key_adjustment AS keyAdjustment,
           r.created_at AS requestedAt,
           r.completed_at AS completedAt,
           t.station_track_id AS trackId,
           t.external_url AS externalUrl,
           t.source
      FROM requests r
      LEFT JOIN tracks t ON t.id = r.track_id
     WHERE ${where.clause}
  `).all(...where.params) as any[];

  const queueRows = db.prepare(`
    SELECT title,
           artist,
           status,
           key_adjustment AS keyAdjustment,
           updated_at AS requestedAt,
           NULL AS completedAt,
           station_track_id AS trackId,
           NULL AS externalUrl,
           NULL AS source
      FROM queue_items
     WHERE ${where.clause}
  `).all(...where.params) as any[];

  const importedRows = db.prepare(`
    SELECT title,
           artist,
           status,
           key_adjustment AS keyAdjustment,
           requested_at AS requestedAt,
           completed_at AS completedAt,
           NULL AS trackId,
           NULL AS externalUrl,
           NULL AS source,
           source_data AS sourceData
      FROM history_items
     WHERE ${where.clause}
  `).all(...where.params) as any[];

  const seen = new Set<string>();
  return [...requestRows, ...queueRows, ...importedRows]
    .filter((row) => row.title)
    .filter((row) => {
      const track = parseHistorySourceTrack(row.sourceData);
      const trackId = row.trackId || track?.trackId || null;
      const externalUrl = row.externalUrl || track?.url || null;
      const key = `${row.title}|${row.artist}|${row.status}|${trackId}|${externalUrl}|${row.requestedAt}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((row) => {
      const importedTrack = parseHistorySourceTrack(row.sourceData);
      const externalUrl = row.externalUrl || importedTrack?.url || null;
      const trackId = row.trackId || importedTrack?.trackId || null;
      return {
        title: row.title,
        artist: row.artist,
        status: row.status || 'imported',
        keyAdjustment: Number(row.keyAdjustment ?? 0),
        requestedAt: row.requestedAt || null,
        completedAt: row.completedAt || null,
        track: externalUrl
          ? { type: 'external', url: externalUrl, source: row.source || importedTrack?.source || 'karaoke-nerds' }
          : { type: 'local', trackId: trackId || null },
      };
    })
    .sort((a, b) => String(b.completedAt || b.requestedAt || '').localeCompare(String(a.completedAt || a.requestedAt || '')));
}

function ensureRequestsAllowed(settings: GatewaySettings, external: boolean) {
  if (requestsAreClosed(settings)) {
    throw Object.assign(new Error('Requests are currently disabled'), { status: 403 });
  }
  if (!external && (!settings.localEnabled || settings.requestAcceptance === 'external')) {
    throw Object.assign(new Error('Local library requests are currently disabled'), { status: 403 });
  }
  if (external && !settings.externalEnabled) {
    throw Object.assign(new Error('External library requests are currently disabled'), { status: 403 });
  }
}

function tokenizeFtsQuery(q: string): string {
  return q
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2)
    .slice(0, 8)
    .map((part) => `${part.replace(/"/g, '')}*`)
    .join(' ');
}

app.get('/api/health', (_req, res) => {
  const trackCount = db.prepare('SELECT COUNT(*) AS count FROM tracks').get() as { count: number };
  const pendingCount = db.prepare("SELECT COUNT(*) AS count FROM requests WHERE status = 'pending'").get() as { count: number };
  res.json({
    ok: true,
    tracks: trackCount.count,
    pendingRequests: pendingCount.count,
    publicBaseUrl: config.publicBaseUrl || null,
  });
});

app.get('/api/public/config', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ publicBaseUrl: config.publicBaseUrl || '', settings: getGatewaySettings() });
});

function respondRequestsDisabled(res: express.Response, settings: GatewaySettings) {
  res.status(403).json({
    code: 'REQUESTS_DISABLED',
    error: 'Requests are currently disabled',
    settings,
  });
}

function respondStationUnavailable(res: express.Response, settings: GatewaySettings) {
  res.status(503).json({
    code: 'STATION_UNAVAILABLE',
    error: 'Station is not connected',
    settings,
  });
}

app.get('/api/search', asyncHandler(async (req, res) => {
  const q = normalizeString(req.query.q, 200);
  const kind = normalizeNullableString(req.query.kind, 50);
  const field = normalizeString(req.query.field || 'all', 20);
  const limit = Math.min(Math.max(Number(req.query.limit || 2000), 1), 2000);
  const settings = getGatewaySettings();

  if (!settings.stationConnected) {
    respondStationUnavailable(res, settings);
    return;
  }

  if (requestsAreClosed(settings)) {
    respondRequestsDisabled(res, settings);
    return;
  }

  if (!q) {
    res.json([]);
    return;
  }

  const combinedRows: any[] = [];

  if (settings.localEnabled || settings.externalEnabled) {
    const params: unknown[] = [];
    let kindClause = '';
    if (kind) {
      params.push(kind);
      kindClause = 'AND t.kind = ?';
    }
    const availabilityClause = catalogAvailabilityClause(settings);

    let localRows: any[] | null = null;
    const ftsQuery = tokenizeFtsQuery(q);
    if (ftsQuery && field === 'all') {
      try {
        localRows = db.prepare(`
          SELECT ${trackSelectSql()}
            FROM track_fts f
            JOIN tracks t ON t.id = f.rowid
           WHERE track_fts MATCH ?
             ${availabilityClause}
             ${kindClause}
           ORDER BY bm25(track_fts), LOWER(COALESCE(t.artist, '')), LOWER(t.title)
           LIMIT ?
        `).all(ftsQuery, ...params, limit) as any[];
      } catch {
        localRows = null;
      }
    }

    if (!localRows) {
      const like = `%${q.toLowerCase()}%`;
      const searchClause = field === 'artist'
        ? 'LOWER(COALESCE(t.artist, \'\')) LIKE ?'
        : field === 'title'
          ? 'LOWER(t.title) LIKE ?'
          : '(LOWER(t.title) LIKE ? OR LOWER(COALESCE(t.artist, \'\')) LIKE ? OR LOWER(COALESCE(t.disc_id, \'\')) LIKE ?)';
      const searchParams = field === 'all' ? [like, like, like] : [like];

      localRows = db.prepare(`
        SELECT ${trackSelectSql()}
          FROM tracks t
         WHERE ${searchClause}
           ${availabilityClause}
           ${kindClause}
         ORDER BY LOWER(COALESCE(t.artist, '')), LOWER(t.title)
         LIMIT ?
      `).all(...searchParams, ...params, limit) as any[];
    }

    combinedRows.push(...localRows);
  }

  if (settings.externalEnabled && field !== 'artist' && !kind) {
    const externalRows = (await searchKaraokeNerds(q)).map((track) => ({
      id: externalTrackId(track.url),
      title: track.title,
      artist: track.artist,
      discId: track.brand || 'KaraokeNerds',
      kind: 'mp4',
      durationMs: null,
      source: track.source,
      externalUrl: track.url,
      brand: track.brand || null,
    }));
    combinedRows.push(...externalRows);
  }

  res.json(dedupeSearchRows(combinedRows).slice(0, limit));
}));

app.get('/api/browse/artists', (req, res) => {
  const prefix = normalizeString(req.query.prefix || 'A', 10);
  const settings = getGatewaySettings();
  if (!settings.stationConnected) {
    respondStationUnavailable(res, settings);
    return;
  }
  if (requestsAreClosed(settings)) {
    respondRequestsDisabled(res, settings);
    return;
  }
  if (!settings.localEnabled || !settings.localBrowseEnabled) {
    res.json([]);
    return;
  }
  const initial = initialFilterClause("COALESCE(t.artist, '')", prefix);
  const rows = db.prepare(`
    SELECT COALESCE(NULLIF(TRIM(t.artist), ''), 'Unknown Artist') AS artist,
           COUNT(*) AS versionCount,
           COUNT(DISTINCT LOWER(t.title)) AS songCount
      FROM tracks t
     WHERE COALESCE(t.title, '') <> ''
       ${catalogAvailabilityClause(settings, 't', true)}
       ${initial.clause}
     GROUP BY LOWER(COALESCE(NULLIF(TRIM(t.artist), ''), 'Unknown Artist')),
              COALESCE(NULLIF(TRIM(t.artist), ''), 'Unknown Artist')
     ORDER BY LOWER(COALESCE(NULLIF(TRIM(t.artist), ''), 'Unknown Artist'))
  `).all(...initial.params);
  res.json(rows);
});

app.get('/api/browse/artist-songs', (req, res) => {
  const artist = normalizeString(req.query.artist, 300);
  if (!artist) {
    res.status(400).json({ error: 'artist is required' });
    return;
  }
  const settings = getGatewaySettings();
  if (!settings.stationConnected) {
    respondStationUnavailable(res, settings);
    return;
  }
  if (requestsAreClosed(settings)) {
    respondRequestsDisabled(res, settings);
    return;
  }
  if (!settings.localEnabled || !settings.localBrowseEnabled) {
    res.json([]);
    return;
  }
  const rows = db.prepare(`
    SELECT ${trackSelectSql()}
      FROM tracks t
     WHERE COALESCE(t.title, '') <> ''
       AND LOWER(COALESCE(NULLIF(TRIM(t.artist), ''), 'Unknown Artist')) = LOWER(?)
       ${catalogAvailabilityClause(settings, 't', true)}
     ORDER BY LOWER(t.title), LOWER(COALESCE(t.artist, '')), LOWER(COALESCE(t.disc_id, '')), t.station_track_id
  `).all(artist);
  res.json(dedupeSearchRows(rows));
});

app.get('/api/browse/songs', (req, res) => {
  const prefix = normalizeString(req.query.prefix || 'A', 10);
  const settings = getGatewaySettings();
  if (!settings.stationConnected) {
    respondStationUnavailable(res, settings);
    return;
  }
  if (requestsAreClosed(settings)) {
    respondRequestsDisabled(res, settings);
    return;
  }
  if (!settings.localEnabled || !settings.localBrowseEnabled) {
    res.json([]);
    return;
  }
  const initial = initialFilterClause('t.title', prefix);
  const rows = db.prepare(`
    SELECT ${trackSelectSql()}
      FROM tracks t
     WHERE COALESCE(t.title, '') <> ''
       ${catalogAvailabilityClause(settings, 't', true)}
       ${initial.clause}
     ORDER BY LOWER(t.title), LOWER(COALESCE(t.artist, '')), LOWER(COALESCE(t.disc_id, '')), t.station_track_id
  `).all(...initial.params);
  res.json(dedupeSearchRows(rows));
});

app.post('/api/requests', asyncHandler((req, res) => {
  const stationTrackId = normalizeString(req.body?.trackId ?? req.body?.stationTrackId, 80);
  const requestedBy = normalizeString(req.body?.requestedBy, 120);
  const singerUuid = normalizeNullableString(req.body?.singerUuid, 120);
  const notes = normalizeNullableString(req.body?.notes, 500);
  const keyAdjustment = normalizeKeyAdjustment(req.body?.keyAdjustment);
  const external = req.body?.external && typeof req.body.external === 'object' ? req.body.external : null;
  const settings = getGatewaySettings();

  if (!settings.stationConnected) {
    respondStationUnavailable(res, settings);
    return;
  }

  if (requestsAreClosed(settings)) {
    respondRequestsDisabled(res, settings);
    return;
  }

  if (!stationTrackId) {
    res.status(400).json({ error: 'trackId is required' });
    return;
  }
  if (!requestedBy) {
    res.status(400).json({ error: 'requestedBy is required' });
    return;
  }

  let track = db.prepare('SELECT id, station_track_id, title, artist, source, external_url FROM tracks WHERE station_track_id = ?').get(stationTrackId) as
    | { id: number; station_track_id: string; title: string; artist: string | null; source: string | null; external_url: string | null }
    | undefined;

  if (!track && external) {
    const title = normalizeString(external.title, 300);
    const artist = normalizeNullableString(external.artist, 300);
    const url = normalizeString(external.url || external.externalUrl, 1000);
    if (!title || !url) {
      res.status(400).json({ error: 'External request requires title and url' });
      return;
    }
    const externalId = externalTrackId(url);
    if (externalId !== stationTrackId) {
      res.status(400).json({ error: 'External track id does not match url' });
      return;
    }
    db.prepare(`
      INSERT INTO tracks(station_track_id, title, artist, disc_id, kind, duration_ms, source, external_url, updated_at)
      VALUES (?, ?, ?, ?, 'mp4', NULL, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(station_track_id) DO UPDATE SET
        title = excluded.title,
        artist = excluded.artist,
        disc_id = excluded.disc_id,
        source = excluded.source,
        external_url = excluded.external_url,
        updated_at = CURRENT_TIMESTAMP
    `).run(externalId, title, artist, normalizeNullableString(external.brand, 120), 'karaoke-nerds', url);
    track = db.prepare('SELECT id, station_track_id, title, artist, source, external_url FROM tracks WHERE station_track_id = ?').get(externalId) as any;
  }

  if (!track) {
    res.status(404).json({ error: 'Track not found' });
    return;
  }

  ensureRequestsAllowed(settings, trackIsExternal(track));

  const duplicate = db.prepare(`
    SELECT id FROM requests
     WHERE station_track_id = ?
       AND LOWER(requested_by) = LOWER(?)
       AND status IN ('pending', 'delivered', 'queued')
     LIMIT 1
  `).get(stationTrackId, requestedBy);
  if (duplicate) {
    res.status(409).json({ error: 'You already have this song requested or queued' });
    return;
  }

  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO requests(id, track_id, station_track_id, requested_by, singer_uuid, key_adjustment, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, track.id, stationTrackId, requestedBy, singerUuid, keyAdjustment, notes);

  res.status(201).json({
    id,
    status: 'pending',
    track: {
      id: track.station_track_id,
      title: track.title,
      artist: track.artist,
    },
  });
}));

app.get('/api/requests/:id', (req, res) => {
  const row = db.prepare(`
    SELECT r.id,
           r.station_track_id AS trackId,
           r.requested_by AS requestedBy,
           r.singer_uuid AS singerUuid,
           r.key_adjustment AS keyAdjustment,
           r.status,
           r.station_queue_id AS stationQueueId,
           r.error,
           r.created_at AS createdAt,
           r.completed_at AS completedAt,
           t.title,
           t.artist
      FROM requests r
      LEFT JOIN tracks t ON t.id = r.track_id
     WHERE r.id = ?
  `).get(req.params.id);
  if (!row) {
    res.status(404).json({ error: 'Request not found' });
    return;
  }
  res.json(row);
});

app.get('/api/history/self/export', (req, res) => {
  const name = normalizeString(req.query.name, 120);
  const singerUuid = normalizeNullableString(req.query.singerUuid, 120);
  if (!name && !singerUuid) {
    res.status(400).json({ error: 'name or singerUuid is required' });
    return;
  }
  const songs = singerHistoryRows(name, singerUuid);

  res.json({
    format: 'karaokedock.singer-history',
    version: 1,
    exportedAt: new Date().toISOString(),
    singers: [{
      singer: {
        uuid: singerUuid || undefined,
        displayName: name || 'Gateway Singer',
      },
      songs,
    }],
  });
});

app.get('/api/history/self', (req, res) => {
  const name = normalizeString(req.query.name, 120);
  const singerUuid = normalizeNullableString(req.query.singerUuid, 120);
  if (!name && !singerUuid) {
    res.status(400).json({ error: 'name or singerUuid is required' });
    return;
  }
  res.json({ songs: singerHistoryRows(name, singerUuid) });
});

app.post('/api/history/self/import', asyncHandler((req, res) => {
  const name = normalizeString(req.body?.name, 120);
  const singerUuid = normalizeNullableString(req.body?.singerUuid, 120);
  const data = req.body?.data;
  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  if (data?.format !== 'karaokedock.singer-history' || !Array.isArray(data?.singers)) {
    res.status(400).json({ error: 'Invalid KaraokeDock history file' });
    return;
  }

  const insert = db.prepare(`
    INSERT INTO history_items(
      id, requested_by, singer_uuid, title, artist, status, key_adjustment, requested_at, completed_at, source_data
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let imported = 0;
  db.transaction(() => {
    for (const singer of data.singers) {
      const songs = Array.isArray(singer?.songs) ? singer.songs : [];
      for (const song of songs) {
        const title = normalizeString(song?.title, 300);
        if (!title) continue;
        insert.run(
          crypto.randomUUID(),
          name,
          singerUuid,
          title,
          normalizeNullableString(song?.artist, 300),
          normalizeString(song?.status || 'imported', 40),
          normalizeKeyAdjustment(song?.keyAdjustment),
          normalizeNullableString(song?.requestedAt, 80),
          normalizeNullableString(song?.completedAt, 80),
          JSON.stringify(song),
        );
        imported++;
      }
    }
  })();

  res.json({ ok: true, imported });
}));

app.get('/api/my-queue', (req, res) => {
  const name = normalizeString(req.query.name, 120);
  const singerUuid = normalizeNullableString(req.query.singerUuid, 120);
  if (!name && !singerUuid) {
    res.status(400).json({ error: 'name or singerUuid is required' });
    return;
  }

  const clauses: string[] = [];
  const params: unknown[] = [];
  if (name) {
    clauses.push('LOWER(requested_by) = LOWER(?)');
    params.push(name);
  }
  if (singerUuid) {
    clauses.push('singer_uuid = ?');
    params.push(singerUuid);
  }

  const rows = db.prepare(`
    SELECT station_queue_id AS id,
           station_track_id AS trackId,
           requested_by AS requestedBy,
           singer_uuid AS singerUuid,
           status,
           position,
           key_adjustment AS keyAdjustment,
           title,
           artist,
           updated_at AS updatedAt
      FROM queue_items
     WHERE (${clauses.join(' OR ')})
       AND status IN ('playing', 'queued')
     ORDER BY CASE status WHEN 'playing' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END, position, updated_at DESC
  `).all(...params);
  res.json(rows);
});

app.patch('/api/my-queue/reorder', asyncHandler((req, res) => {
  const requestedBy = normalizeString(req.body?.name, 120);
  const singerUuid = normalizeNullableString(req.body?.singerUuid, 120);
  const queueIds: string[] = Array.isArray(req.body?.queueIds) ? req.body.queueIds.map((id: unknown) => normalizeString(id, 80)).filter(Boolean) : [];
  if (!requestedBy && !singerUuid) {
    res.status(400).json({ error: 'name or singerUuid is required' });
    return;
  }
  if (queueIds.length === 0) {
    res.status(400).json({ error: 'queueIds is required' });
    return;
  }

  const clauses: string[] = [];
  const params: unknown[] = [];
  if (requestedBy) {
    clauses.push('LOWER(requested_by) = LOWER(?)');
    params.push(requestedBy);
  }
  if (singerUuid) {
    clauses.push('singer_uuid = ?');
    params.push(singerUuid);
  }

  const owned = db.prepare(`
    SELECT station_queue_id FROM queue_items
     WHERE status = 'queued'
       AND (${clauses.join(' OR ')})
  `).all(...params) as { station_queue_id: string }[];
  const ownedIds = new Set(owned.map((item) => item.station_queue_id));
  for (const id of queueIds) {
    if (!ownedIds.has(id)) {
      res.status(403).json({ error: `Queue item ${id} is not yours or not queued` });
      return;
    }
  }

  const update = db.prepare('UPDATE queue_items SET position = ?, updated_at = CURRENT_TIMESTAMP WHERE station_queue_id = ?');
  db.transaction(() => {
    queueIds.forEach((id: string, index: number) => update.run(index + 1, id));
    db.prepare(`
      INSERT INTO queue_actions(id, type, requested_by, singer_uuid, payload)
      VALUES (?, 'reorder', ?, ?, ?)
    `).run(crypto.randomUUID(), requestedBy || null, singerUuid, JSON.stringify({ queueIds }));
  })();
  res.json({ ok: true });
}));

app.delete('/api/my-queue/:id', asyncHandler((req, res) => {
  const requestedBy = normalizeString(req.query.name, 120);
  const singerUuid = normalizeNullableString(req.query.singerUuid, 120);
  if (!requestedBy && !singerUuid) {
    res.status(400).json({ error: 'name or singerUuid is required' });
    return;
  }

  const clauses: string[] = [];
  const params: unknown[] = [];
  if (requestedBy) {
    clauses.push('LOWER(requested_by) = LOWER(?)');
    params.push(requestedBy);
  }
  if (singerUuid) {
    clauses.push('singer_uuid = ?');
    params.push(singerUuid);
  }

  const result = db.prepare(`
    UPDATE queue_items
       SET status = 'removed', updated_at = CURRENT_TIMESTAMP
     WHERE station_queue_id = ?
       AND status = 'queued'
       AND (${clauses.join(' OR ')})
  `).run(req.params.id, ...params);

  if (result.changes === 0) {
    res.status(404).json({ error: 'Queue item not found or not removable' });
    return;
  }
  db.prepare(`
    INSERT INTO queue_actions(id, type, requested_by, singer_uuid, payload)
    VALUES (?, 'remove', ?, ?, ?)
  `).run(crypto.randomUUID(), requestedBy || null, singerUuid, JSON.stringify({ queueId: req.params.id }));
  res.json({ ok: true });
}));

app.put('/api/station/settings', requireStationToken, (req, res) => {
  const settings = req.body?.settings && typeof req.body.settings === 'object' ? req.body.settings as Record<string, unknown> : {};
  const allowedKeys = new Set([
    'libraries.local_enabled',
    'libraries.external_enabled',
    'requests.acceptance',
    'requests.local_browse_enabled',
  ]);
  const upsert = db.prepare(`
    INSERT INTO gateway_meta(key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  let accepted = 0;
  for (const [key, value] of Object.entries(settings)) {
    if (!allowedKeys.has(key)) continue;
    upsert.run(key, String(value));
    accepted++;
  }
  setMeta(db, 'last_settings_sync_at', new Date().toISOString());
  res.json({ ok: true, accepted, settings: getGatewaySettings() });
});

app.put('/api/station/catalog', requireStationToken, asyncHandler((req, res) => {
  const tracks = Array.isArray(req.body?.tracks) ? req.body.tracks as TrackInput[] : null;
  if (!tracks) {
    res.status(400).json({ error: 'tracks array is required' });
    return;
  }
  const syncId = normalizeNullableString(req.body?.syncId, 120);
  const complete = req.body?.complete === true ||
    (Number.isInteger(req.body?.chunkIndex) &&
      Number.isInteger(req.body?.chunkCount) &&
      Number(req.body.chunkIndex) >= Number(req.body.chunkCount) - 1);

  const seen = new Set<string>();
  const upsert = db.prepare(`
    INSERT INTO tracks(station_track_id, title, artist, disc_id, kind, duration_ms, source, external_url, last_sync_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(station_track_id) DO UPDATE SET
      title = excluded.title,
      artist = excluded.artist,
      disc_id = excluded.disc_id,
      kind = excluded.kind,
      duration_ms = excluded.duration_ms,
      source = excluded.source,
      external_url = excluded.external_url,
      last_sync_id = excluded.last_sync_id,
      updated_at = CURRENT_TIMESTAMP
  `);
  const deleteMissing = db.prepare(`DELETE FROM tracks WHERE station_track_id NOT LIKE 'external:%' AND station_track_id NOT IN (SELECT value FROM json_each(?))`);
  const deleteMissingForSync = db.prepare(`DELETE FROM tracks WHERE station_track_id NOT LIKE 'external:%' AND COALESCE(last_sync_id, '') <> ?`);

  const result = db.transaction(() => {
    let accepted = 0;
    for (const input of tracks) {
      const stationTrackId = normalizeStationTrackId(input);
      const title = normalizeString(input.title, 300);
      const kind = normalizeString(input.kind || 'local', 50);
      if (!stationTrackId || !title) continue;
      seen.add(stationTrackId);
      upsert.run(
        stationTrackId,
        title,
        normalizeNullableString(input.artist, 300),
        normalizeNullableString(input.discId, 120),
        kind,
        input.durationMs == null ? null : Number(input.durationMs),
        normalizeString(input.source || 'local', 80),
        normalizeNullableString(input.externalUrl, 1000),
        syncId,
      );
      accepted++;
    }
    if (req.body?.full === true && syncId && complete) {
      deleteMissingForSync.run(syncId);
    } else if (req.body?.full === true && !syncId && seen.size > 0) {
      deleteMissing.run(JSON.stringify([...seen]));
    }
    setMeta(db, 'last_catalog_sync_at', new Date().toISOString());
    return accepted;
  })();

  res.json({ ok: true, received: tracks.length, accepted: result, syncId, complete });
}));

app.get('/api/station/requests/pending', requireStationToken, (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 200);
  const rows = db.prepare(`
    SELECT r.id,
           r.station_track_id AS trackId,
           r.requested_by AS requestedBy,
           r.singer_uuid AS singerUuid,
           r.key_adjustment AS keyAdjustment,
           r.notes,
           r.created_at AS createdAt,
           t.title,
           t.artist,
           t.disc_id AS discId,
           t.kind,
           t.external_url AS externalUrl,
           t.source
      FROM requests r
      LEFT JOIN tracks t ON t.id = r.track_id
     WHERE r.status = 'pending'
     ORDER BY r.created_at
     LIMIT ?
  `).all(limit);
  res.json(rows);
});

app.get('/api/station/queue-actions/pending', requireStationToken, (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 200);
  const rows = db.prepare(`
    SELECT id,
           type,
           requested_by AS requestedBy,
           singer_uuid AS singerUuid,
           payload,
           created_at AS createdAt
      FROM queue_actions
     WHERE status = 'pending'
     ORDER BY created_at
     LIMIT ?
  `).all(limit) as { id: string; type: string; requestedBy: string | null; singerUuid: string | null; payload: string; createdAt: string }[];
  res.json(rows.map((row) => ({
    ...row,
    payload: JSON.parse(row.payload),
  })));
});

app.post('/api/station/queue-actions/:id/ack', requireStationToken, (req, res) => {
  const status = normalizeString(req.body?.status, 40);
  if (!['applied', 'rejected'].includes(status)) {
    res.status(400).json({ error: 'status must be applied or rejected' });
    return;
  }
  const result = db.prepare(`
    UPDATE queue_actions
       SET status = ?,
           error = ?,
           completed_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `).run(status, normalizeNullableString(req.body?.error, 500), req.params.id);
  if (result.changes === 0) {
    res.status(404).json({ error: 'Queue action not found' });
    return;
  }
  res.json({ ok: true });
});

app.post('/api/station/requests/:id/ack', requireStationToken, asyncHandler((req, res) => {
  const status = normalizeString(req.body?.status, 40);
  if (!['queued', 'rejected', 'delivered'].includes(status)) {
    res.status(400).json({ error: 'status must be queued, rejected, or delivered' });
    return;
  }

  const completedAt = status === 'queued' || status === 'rejected' ? new Date().toISOString() : null;
  const result = db.prepare(`
    UPDATE requests
       SET status = ?,
           station_queue_id = COALESCE(?, station_queue_id),
           error = ?,
           delivered_at = COALESCE(delivered_at, CURRENT_TIMESTAMP),
           completed_at = COALESCE(?, completed_at)
     WHERE id = ?
  `).run(
    status,
    normalizeNullableString(req.body?.stationQueueId, 80),
    normalizeNullableString(req.body?.error, 500),
    completedAt,
    req.params.id,
  );

  if (result.changes === 0) {
    res.status(404).json({ error: 'Request not found' });
    return;
  }
  res.json({ ok: true });
}));

app.put('/api/station/queue/snapshot', requireStationToken, asyncHandler((req, res) => {
  const queue = Array.isArray(req.body?.queue) ? req.body.queue as QueueInput[] : null;
  if (!queue) {
    res.status(400).json({ error: 'queue array is required' });
    return;
  }

  const seen = new Set<string>();
  const upsert = db.prepare(`
    INSERT INTO queue_items(
      station_queue_id,
      station_track_id,
      requested_by,
      singer_uuid,
      status,
      position,
      key_adjustment,
      title,
      artist,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(station_queue_id) DO UPDATE SET
      station_track_id = excluded.station_track_id,
      requested_by = excluded.requested_by,
      singer_uuid = excluded.singer_uuid,
      status = excluded.status,
      position = excluded.position,
      key_adjustment = excluded.key_adjustment,
      title = excluded.title,
      artist = excluded.artist,
      updated_at = CURRENT_TIMESTAMP
  `);
  const deleteMissing = db.prepare(`DELETE FROM queue_items WHERE station_queue_id NOT IN (SELECT value FROM json_each(?))`);

  const accepted = db.transaction(() => {
    let count = 0;
    for (const item of queue) {
      const stationQueueId = normalizeStationQueueId(item);
      const title = normalizeString(item.title, 300);
      const status = normalizeString(item.status || 'queued', 40);
      if (!stationQueueId || !title) continue;
      seen.add(stationQueueId);
      upsert.run(
        stationQueueId,
        normalizeNullableString(item.stationTrackId ?? item.trackId, 80),
        normalizeNullableString(item.requestedBy, 120),
        normalizeNullableString(item.singerUuid, 120),
        status,
        Number.isFinite(Number(item.position)) ? Number(item.position) : 0,
        normalizeKeyAdjustment(item.keyAdjustment),
        title,
        normalizeNullableString(item.artist, 300),
      );
      count++;
    }
    if (req.body?.full === true) {
      if (seen.size > 0) {
        deleteMissing.run(JSON.stringify([...seen]));
      } else {
        db.prepare('DELETE FROM queue_items').run();
      }
    }
    setMeta(db, 'last_queue_sync_at', new Date().toISOString());
    return count;
  })();

  res.json({ ok: true, received: queue.length, accepted });
}));

app.get('/api/station/status', requireStationToken, (_req, res) => {
  const metaRows = db.prepare('SELECT key, value FROM gateway_meta').all() as { key: string; value: string }[];
  const meta = Object.fromEntries(metaRows.map((row) => [row.key, row.value]));
  const counts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM tracks) AS tracks,
      (SELECT COUNT(*) FROM requests WHERE status = 'pending') AS pendingRequests,
      (SELECT COUNT(*) FROM queue_items) AS queueItems
  `).get() as { tracks: number; pendingRequests: number; queueItems: number };
  res.json({ ...counts, ...meta });
});

app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = Number(err?.status) || 500;
  if (status >= 500) {
    console.error(err);
  }
  res.status(status).json({ error: err?.message || 'Internal server error' });
});

app.listen(config.port, config.host, () => {
  console.log(`KaraokeDock Remote Requests Gateway listening on http://${config.host}:${config.port}`);
});

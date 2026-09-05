// server/src/db.ts
import { Pool, type QueryResultRow } from 'pg';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { logger } from './logger';
import { resolveDatabaseUrl } from './databaseUrl.js';

let pool: Pool | undefined;

function getPool() {
  if (!pool) {
    pool = new Pool({ connectionString: resolveDatabaseUrl() });
  }
  return pool;
}

export async function query<T extends QueryResultRow = any>(text: string, params?: any[]) {
  const client = await getPool().connect();
  const start = Date.now();
  try {
    const res = await client.query<T>(text, params);
    const duration = Date.now() - start;
    const tag = text.trim().split(/\s+/).slice(0, 2).join(' ') || 'query';
    logger.verbose(`[db] duration: ${duration} ms  ${tag}`);
    return res;
  } finally {
    client.release();
  }
}

/** Normalize artist names for case/diacritic-insensitive matching */
function nameNorm(s: string) {
  return (s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/[^a-z0-9]+/g, '');     // keep a-z0-9 only
}

/**
 * Optional: create helpful indexes if they're missing.
 * Safe to call at startup; IF NOT EXISTS guards prevent errors.
 */
export async function ensureHelpfulIndexes() {
  await query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'tracks_path_basename_idx') THEN
        CREATE INDEX tracks_path_basename_idx ON tracks(path, basename);
      END IF;

      IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'tracks_kind_title_idx') THEN
        CREATE INDEX tracks_kind_title_idx ON tracks(kind, title);
      END IF;

      IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'artists_name_norm_uq') THEN
        CREATE UNIQUE INDEX artists_name_norm_uq ON artists(name_norm);
      END IF;
    END$$;
  `);
}

/**
 * Upsert artist by normalized name (populates name_norm which is NOT NULL).
 * Returns artist id.
 */
export async function upsertArtist(name: string): Promise<number> {
  let clean = (name || '').trim();
  if (!clean) clean = 'Unknown';
  const norm = nameNorm(clean);
  if (!norm) {
    // Fallback if the name reduced to nothing
    clean = 'Unknown';
  }
  const finalNorm = nameNorm(clean);

  const r = await query<{ id: number }>(`
    WITH existing AS (
      SELECT id FROM artists WHERE name_norm = $2 LIMIT 1
    ), ins AS (
      INSERT INTO artists(name, name_norm)
      SELECT $1, $2
      WHERE NOT EXISTS (SELECT 1 FROM existing)
      RETURNING id
    )
    SELECT id FROM ins
    UNION ALL
    SELECT id FROM existing
    LIMIT 1;
  `, [clean, finalNorm]);

  return r.rows[0].id;
}

/**
 * Upsert track identified by natural key (kind + path + basename) WITHOUT ON CONFLICT.
 * Null-ish "new" values won't overwrite existing non-nulls.
 */
export type UpsertTrackArgs = {
  artist_id: number | null;
  disc_id: string | null;
  title: string | null;
  kind: 'mp4' | 'cdgmp3';  // Match database enum
  duration_ms: number | null;
  file_mp4: string | null;
  file_cdg: string | null;
  file_mp3: string | null;
  path: string;       // absolute directory
  basename: string;   // file name only
  library_id: number | null;
};

export async function upsertTrack(a: UpsertTrackArgs) {
  const params = [
    a.artist_id,
    a.disc_id,
    a.title,
    a.kind,
    a.duration_ms,
    a.file_mp4,
    a.file_cdg,
    a.file_mp3,
    a.path,
    a.basename,
    a.library_id
  ];

  const sql = `
    WITH existing AS (
      SELECT id FROM tracks
      WHERE kind = $4 AND path = $9 AND basename = $10
      LIMIT 1
    ),
    updated AS (
      UPDATE tracks t
         SET artist_id   = COALESCE($1, t.artist_id),
             disc_id     = COALESCE($2, t.disc_id),
             title       = COALESCE($3, t.title),
             duration_ms = COALESCE($5, t.duration_ms),
             file_mp4    = COALESCE($6, t.file_mp4),
             file_cdg    = COALESCE($7, t.file_cdg),
             file_mp3    = COALESCE($8, t.file_mp3),
             library_id  = COALESCE($11, t.library_id)
      FROM existing e
      WHERE t.id = e.id
      RETURNING t.*
    ),
    inserted AS (
      INSERT INTO tracks (artist_id, disc_id, title, kind, duration_ms, file_mp4, file_cdg, file_mp3, path, basename, library_id)
      SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11
      WHERE NOT EXISTS (SELECT 1 FROM existing)
      RETURNING *
    )
    SELECT * FROM updated
    UNION ALL
    SELECT * FROM inserted
    LIMIT 1;
  `;

  const res = await query(sql, params);
  return res.rows[0];
}

/**
 * Insert external track (e.g., from Karaoke Nerds)
 * External tracks have a unique constraint on (source, external_url)
 */
export type InsertExternalTrackArgs = {
  artist_id: number | null;
  disc_id?: string | null;
  title: string;
  external_url: string;
  source: string;
  duration_ms?: number | null;
};

export async function upsertExternalTrack(a: InsertExternalTrackArgs) {
  const sql = `
    WITH existing AS (
      SELECT id FROM tracks
      WHERE source = $5 AND external_url = $4
      LIMIT 1
    ),
    updated AS (
      UPDATE tracks t
      SET artist_id = COALESCE($1, t.artist_id),
          disc_id = COALESCE($2, t.disc_id),
          title = COALESCE($3, t.title),
          duration_ms = COALESCE($6, t.duration_ms)
      FROM existing e
      WHERE t.id = e.id
      RETURNING t.*
    ),
    inserted AS (
      INSERT INTO tracks (artist_id, disc_id, title, kind, external_url, source, path, basename, duration_ms)
      SELECT $1, $2, $3, 'mp4', $4, $5, '', '', $6
      WHERE NOT EXISTS (SELECT 1 FROM existing)
      RETURNING *
    )
    SELECT * FROM updated
    UNION ALL
    SELECT * FROM inserted
    LIMIT 1;
  `;
  
  const res = await query(sql, [a.artist_id, a.disc_id || null, a.title, a.external_url, a.source, a.duration_ms || null]);
  return res.rows[0];
}

/**
 * Get a setting value from the settings table
 */
export async function getSetting(key: string): Promise<any> {
  const res = await query<{ value: any }>('SELECT value FROM settings WHERE key = $1', [key]);
  if (res.rows.length === 0) return null;
  // JSONB columns are automatically parsed by PostgreSQL, return the value directly
  return res.rows[0].value;
}

/**
 * Set a setting value in the settings table
 */
export async function setSetting(key: string, value: any): Promise<void> {
  await query(
    'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
    [key, JSON.stringify(value)]
  );
}

/**
 * User management functions
 */

export interface User {
  id: number;
  username: string;
  display_name: string | null;
  picture: string | null;
  password_hash: string | null;
  role: 'admin' | 'user';
  is_active: boolean;
  oidc_subject: string | null;
  oidc_issuer: string | null;
  created_at: Date;
  updated_at: Date;
}

export async function createUser(params: {
  username: string;
  password?: string;
  role?: 'admin' | 'user';
  oidc_subject?: string;
  oidc_issuer?: string;
  display_name?: string | null;
  picture?: string | null;
}): Promise<User> {
  const passwordHash = params.password ? await hashPassword(params.password) : null;
  const role = params.role || 'user';
  const res = await query<User>(
    `INSERT INTO users (username, password_hash, role, oidc_subject, oidc_issuer, display_name, picture)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      params.username,
      passwordHash,
      role,
      params.oidc_subject || null,
      params.oidc_issuer || null,
      params.display_name || null,
      params.picture || null,
    ]
  );
  return res.rows[0];
}

export async function getUserByUsername(username: string): Promise<User | null> {
  const res = await query<User>('SELECT * FROM users WHERE username = $1 LIMIT 1', [username]);
  return res.rows[0] || null;
}

export async function getUserByOidcSubject(subject: string, issuer: string): Promise<User | null> {
  const res = await query<User>(
    'SELECT * FROM users WHERE oidc_subject = $1 AND oidc_issuer = $2 LIMIT 1',
    [subject, issuer]
  );
  return res.rows[0] || null;
}

export async function getUserById(id: number): Promise<User | null> {
  const res = await query<User>('SELECT * FROM users WHERE id = $1 LIMIT 1', [id]);
  return res.rows[0] || null;
}

export async function listUsers(): Promise<User[]> {
  const res = await query<User>('SELECT * FROM users ORDER BY created_at ASC');
  return res.rows;
}

export async function updateUser(id: number, updates: {
  username?: string;
  password?: string;
  role?: 'admin' | 'user';
  is_active?: boolean;
  oidc_subject?: string | null;
  oidc_issuer?: string | null;
  display_name?: string | null;
  picture?: string | null;
}): Promise<User | null> {
  const fields: string[] = ['updated_at = NOW()'];
  const values: any[] = [];
  let idx = 1;

  if (updates.username !== undefined) {
    fields.push(`username = $${idx++}`);
    values.push(updates.username);
  }
  if (updates.password !== undefined) {
    const hash = await hashPassword(updates.password);
    fields.push(`password_hash = $${idx++}`);
    values.push(hash);
  }
  if (updates.role !== undefined) {
    fields.push(`role = $${idx++}`);
    values.push(updates.role);
  }
  if (updates.is_active !== undefined) {
    fields.push(`is_active = $${idx++}`);
    values.push(updates.is_active);
  }
  if (updates.oidc_subject !== undefined) {
    fields.push(`oidc_subject = $${idx++}`);
    values.push(updates.oidc_subject);
  }
  if (updates.oidc_issuer !== undefined) {
    fields.push(`oidc_issuer = $${idx++}`);
    values.push(updates.oidc_issuer);
  }
  if (updates.display_name !== undefined) {
    fields.push(`display_name = $${idx++}`);
    values.push(updates.display_name);
  }
  if (updates.picture !== undefined) {
    fields.push(`picture = $${idx++}`);
    values.push(updates.picture);
  }

  if (fields.length === 1) return getUserById(id); // nothing to update

  values.push(id);
  const res = await query<User>(
    `UPDATE users SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  return res.rows[0] || null;
}

export async function deleteUser(id: number): Promise<void> {
  await query('DELETE FROM users WHERE id = $1', [id]);
}

export async function countAdminUsers(): Promise<number> {
  const res = await query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM users WHERE role = 'admin' AND is_active = true`
  );
  return Number(res.rows[0].c);
}

export interface BootstrapAdminCredentials {
  username: string;
  password: string;
}

/**
 * Ensure the legacy admin user from settings is migrated to the users table.
 * Called at application startup - safe to call multiple times.
 */
export async function ensureAdminUser(): Promise<BootstrapAdminCredentials | null> {
  try {
    const count = await query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM users`);
    if (Number(count.rows[0].c) > 0) return null; // already have users

    const storedUsername = await getSetting('admin.username');
    const storedPassword = await getSetting('admin.password');
    const username = storedUsername || process.env.ADMIN_USERNAME || 'admin';
    // storedPassword may be a bcrypt hash (from migration) or plaintext value
    let rawPassword = storedPassword || process.env.ADMIN_PASSWORD;
    let generatedBootstrapPassword: string | null = null;
    if (!rawPassword) {
      generatedBootstrapPassword = crypto.randomBytes(18).toString('base64url');
      rawPassword = generatedBootstrapPassword;
    }
    // Use a regex matching the full bcrypt format ($2a$, $2b$, $2y$ + cost + hash)
    const bcryptPattern = /^\$2[aby]\$\d{2}\$.{53}$/;
    const isAlreadyHashed = typeof rawPassword === 'string' && bcryptPattern.test(rawPassword);
    const passwordHash = isAlreadyHashed ? rawPassword : await hashPassword(rawPassword);

    await query(
      `INSERT INTO users (username, password_hash, role, is_active)
       VALUES ($1, $2, 'admin', true)
       ON CONFLICT (username) DO NOTHING`,
      [username, passwordHash]
    );
    console.log('[db] Migrated legacy admin user to users table');
    if (generatedBootstrapPassword) {
      return { username, password: generatedBootstrapPassword };
    }
    return null;
  } catch (err) {
    console.error('[db] ensureAdminUser failed:', err);
    return null;
  }
}

/**
 * Session management functions
 */

export interface Session {
  id: number;
  token: string;
  user_id: number | null;
  role: string | null;
  created_at: Date;
  expires_at: Date;
  last_accessed: Date;
}

export interface SessionInfo {
  valid: boolean;
  userId?: number;
  role: string;
}

/**
 * Create a new session with a random token
 * Sessions expire after 30 days by default.
 * When no userId is provided this creates a legacy-style session treated as admin for backward compat.
 */
export async function createSession(expiresInDays: number = 30, userId?: number, role: string = 'user'): Promise<string> {
  const token = generateToken();
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + expiresInDays);
  const storedToken = hashSessionToken(token);

  await query(
    'INSERT INTO sessions (token, expires_at, user_id, role) VALUES ($1, $2, $3, $4)',
    [storedToken, expiresAt, userId ?? null, role]
  );

  return token;
}

/**
 * Validate a session token and update last accessed time
 */
export async function validateSession(token: string): Promise<boolean> {
  const info = await validateSessionInfo(token);
  return info.valid;
}

/**
 * Validate a session and return user info (role, userId)
 */
export async function validateSessionInfo(token: string): Promise<SessionInfo> {
  const hashedToken = hashSessionToken(token);
  const res = await query<Session>(
    'SELECT * FROM sessions WHERE token = ANY($1::text[]) AND expires_at > NOW() LIMIT 1',
    [[hashedToken, token]]
  );

  if (res.rows.length === 0) {
    return { valid: false, role: 'user' };
  }

  const session = res.rows[0];

  // Update last accessed time
  if (session.token === token) {
    await query('UPDATE sessions SET token = $2, last_accessed = NOW() WHERE token = $1', [token, hashedToken]);
  } else {
    await query('UPDATE sessions SET last_accessed = NOW() WHERE token = $1', [hashedToken]);
  }

  // Backward compat: sessions without user_id are legacy admin sessions
  const role = session.role || 'admin';

  return {
    valid: true,
    userId: session.user_id ?? undefined,
    role,
  };
}

/**
 * Delete a session (logout)
 */
export async function deleteSession(token: string): Promise<void> {
  await query('DELETE FROM sessions WHERE token = ANY($1::text[])', [[hashSessionToken(token), token]]);
}

/**
 * Clean up expired sessions (can be called periodically)
 */
export async function cleanupExpiredSessions(): Promise<void> {
  await query('DELETE FROM sessions WHERE expires_at <= NOW()');
}

/**
 * Generate a secure random token
 */
function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function hashSessionToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Password hashing and verification functions
 */

// Number of salt rounds for bcrypt (10 is a good balance of security and performance)
const SALT_ROUNDS = 10;

// Regex to detect bcrypt hashes (starts with $2a$, $2b$, or $2y$ followed by cost factor)
const BCRYPT_HASH_REGEX = /^\$2[aby]\$\d{2}\$/;

/**
 * Hash a password using bcrypt
 */
export async function hashPassword(password: string): Promise<string> {
  return await bcrypt.hash(password, SALT_ROUNDS);
}

/**
 * Verify a password against a hashed password
 * This function handles both bcrypt hashes and plaintext passwords for backward compatibility
 * during the migration period. Once all passwords are hashed, only bcrypt comparison will be used.
 */
export async function verifyPassword(password: string, hashedPassword: string): Promise<boolean> {
  // Check if the stored password is a bcrypt hash
  // Bcrypt hashes always start with $2a$, $2b$, or $2y$ followed by the cost factor
  const isBcryptHash = BCRYPT_HASH_REGEX.test(hashedPassword);
  
  if (isBcryptHash) {
    // Password is hashed, use bcrypt to verify
    return await bcrypt.compare(password, hashedPassword);
  } else {
    // Password is in plaintext (legacy/migration state), do direct comparison
    // This should only occur during migration or when using environment variables
    console.warn('WARNING: Plaintext password detected. Please run "npm run migrate-passwords" to encrypt passwords.');
    return password === hashedPassword;
  }
}

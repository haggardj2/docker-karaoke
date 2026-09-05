// server/src/queueIdentity.ts
// Canonical singer identity helpers.
// All singer lookups should go through these functions so that name variants
// like "Jared", " jared ", "JARED" and "Jared  " all map to the same singer.

import { randomUUID } from 'crypto';
import { query } from './db.js';

// ---------------------------------------------------------------------------
// Name normalisation
// ---------------------------------------------------------------------------

/**
 * Normalise a singer's display name to a canonical search key:
 *  - Trim leading/trailing whitespace.
 *  - Collapse runs of internal whitespace to a single space.
 *  - Lower-case everything.
 */
export function normalizeSingerName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

// ---------------------------------------------------------------------------
// Find-or-create singer
// ---------------------------------------------------------------------------

export interface SingerRow {
  id: bigint;
  public_uuid: string;
  display_name: string;
  normalized_name: string;
  status: string;
}

export function normalizeSingerUuid(value: unknown): string | null {
  const uuid = String(value ?? '').trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid)
    ? uuid
    : null;
}

async function updateSingerNameIfPossible(singerId: bigint, displayName: string, normalizedName: string): Promise<void> {
  const conflict = await query<{ id: string }>(
    `SELECT id FROM singers WHERE normalized_name = $1 AND id != $2 LIMIT 1`,
    [normalizedName, singerId],
  );
  if (conflict.rows.length > 0) {
    await query(
      `UPDATE singers SET display_name = $1 WHERE id = $2`,
      [displayName, singerId],
    );
    return;
  }

  await query(
    `UPDATE singers SET display_name = $1, normalized_name = $2 WHERE id = $3`,
    [displayName, normalizedName, singerId],
  );
}

/**
 * Look up a singer by normalised name.  If none exists, insert a new one.
 * The display_name stored is the first canonical version supplied (later
 * calls with the same normalised name just return the existing row).
 *
 * Thread-safe: uses INSERT … ON CONFLICT DO NOTHING + SELECT fallback.
 */
export async function findOrCreateSinger(displayName: string, singerUuid?: string | null): Promise<SingerRow> {
  const trimmed = displayName.trim().replace(/\s+/g, ' ') || displayName;
  const norm = normalizeSingerName(trimmed);
  const publicUuid = normalizeSingerUuid(singerUuid) ?? randomUUID();

  if (singerUuid) {
    const existingByUuid = await query<SingerRow>(
      `SELECT id, public_uuid, display_name, normalized_name, status
         FROM singers
        WHERE public_uuid = $1
        LIMIT 1`,
      [publicUuid],
    );
    if (existingByUuid.rows.length > 0) {
      const singerId = BigInt(existingByUuid.rows[0].id as unknown as string);
      await updateSingerNameIfPossible(singerId, trimmed, norm);
      const updated = await query<SingerRow>(
        `SELECT id, public_uuid, display_name, normalized_name, status
           FROM singers
          WHERE id = $1
          LIMIT 1`,
        [singerId],
      );
      return { ...updated.rows[0], id: BigInt(updated.rows[0].id as unknown as string) };
    }
  }

  // Fast path: already exists
  const existing = await query<SingerRow>(
    `SELECT id, public_uuid, display_name, normalized_name, status
       FROM singers
      WHERE public_uuid = $1 OR normalized_name = $2
      ORDER BY CASE WHEN public_uuid = $1 THEN 0 ELSE 1 END
      LIMIT 1`,
    [publicUuid, norm],
  );
  if (existing.rows.length > 0) {
    if (singerUuid && existing.rows[0].public_uuid !== publicUuid) {
      await query(
        `UPDATE singers
            SET public_uuid = $1
          WHERE id = $2
            AND NOT EXISTS (SELECT 1 FROM singers WHERE public_uuid = $1 AND id != $2)`,
        [publicUuid, existing.rows[0].id],
      );
      const updated = await query<SingerRow>(
        `SELECT id, public_uuid, display_name, normalized_name, status
           FROM singers
          WHERE id = $1
          LIMIT 1`,
        [existing.rows[0].id],
      );
      return { ...updated.rows[0], id: BigInt(updated.rows[0].id as unknown as string) };
    }
    return { ...existing.rows[0], id: BigInt(existing.rows[0].id as unknown as string) };
  }

  // Upsert: insert if not exists, then select
  await query(
    `INSERT INTO singers (public_uuid, display_name, normalized_name, status)
     VALUES ($1, $2, $3, 'active')
     ON CONFLICT (normalized_name) DO NOTHING`,
    [publicUuid, trimmed, norm],
  );

  const created = await query<SingerRow>(
    `SELECT id, public_uuid, display_name, normalized_name, status
       FROM singers
      WHERE public_uuid = $1 OR normalized_name = $2
      ORDER BY CASE WHEN public_uuid = $1 THEN 0 ELSE 1 END
      LIMIT 1`,
    [publicUuid, norm],
  );
  return { ...created.rows[0], id: BigInt(created.rows[0].id as unknown as string) };
}

// ---------------------------------------------------------------------------
// Ensure singer is in the active rotation
// ---------------------------------------------------------------------------

/**
 * Add a singer to the active rotation if they are not already there.
 * If no active rotation exists, a default one is created automatically.
 * Idempotent — calling multiple times for the same singer does nothing.
 */
export async function ensureSingerInActiveRotation(singerId: bigint): Promise<void> {
  // Find the most-recent active rotation, creating a default if none exists
  let rotRes = await query<{ id: string }>(
    `SELECT id FROM rotations WHERE status = 'active' ORDER BY created_at DESC LIMIT 1`,
  );

  let rotationId: bigint;
  if (rotRes.rows.length === 0) {
    // No active rotation — auto-create a default one
    const defaultConfig = {
      type: 'strict_round_robin',
      basePolicy: 'strict_round_robin',
      newSingerPlacement: 'end_of_current_round',
      duetPolicy: 'primary_only',
      skipPolicy: 'move_to_end',
      priorityPolicy: 'none',
      allowSingerMultipleSongsInQueue: true,
      emptySingerPolicy: 'keep_active_without_song',
      songSelectionPolicy: 'oldest_request_first',
    };
    const created = await query<{ id: string }>(
      `INSERT INTO rotations (name, type, base_policy, status, current_round, config)
       VALUES ('Default Rotation', 'strict_round_robin', 'strict_round_robin', 'active', 1, $1)
       RETURNING id`,
      [JSON.stringify(defaultConfig)],
    );
    rotationId = BigInt(created.rows[0].id);
  } else {
    rotationId = BigInt(rotRes.rows[0].id);
  }

  await query(
    `DELETE FROM rotation_singers rs
      WHERE rs.rotation_id = $1
        AND rs.singer_id = $2
        AND rs.id <> (
          SELECT MIN(id)
            FROM rotation_singers
           WHERE rotation_id = $1
             AND singer_id = $2
        )`,
    [rotationId, singerId],
  );

  const existing = await query<{ id: string }>(
    `UPDATE rotation_singers
        SET status = 'active'
      WHERE rotation_id = $1
        AND singer_id = $2
      RETURNING id`,
    [rotationId, singerId],
  );
  if (existing.rows.length > 0) {
    return;
  }

  // Determine the next available position
  const posRes = await query<{ max_pos: number | null }>(
    `SELECT MAX(position) AS max_pos FROM rotation_singers WHERE rotation_id = $1`,
    [rotationId],
  );
  const nextPos = (posRes.rows[0].max_pos ?? -1) + 1;

  // Get current rotation round so new singers join appropriately
  const roundRes = await query<{ current_round: number }>(
    `SELECT current_round FROM rotations WHERE id = $1`,
    [rotationId],
  );
  const currentRound = roundRes.rows[0]?.current_round ?? 1;

  // Insert singer if not already in this rotation
  await query(
    `INSERT INTO rotation_singers
       (rotation_id, singer_id, status, position, current_round_joined)
     VALUES ($1, $2, 'active', $3, $4)
     ON CONFLICT (rotation_id, singer_id) DO NOTHING`,
    [rotationId, singerId, nextPos, currentRound],
  );
}

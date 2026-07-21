// RFC-213 — backup manifest + migration-identity.
//
// Every backup tarball (createBackup's VACUUM-INTO snapshot AND rawCopyDb's raw
// byte copy) carries a manifest.json. The RESTORE version gate keys on MIGRATION
// IDENTITY — the backup DB's newest `__drizzle_migrations.created_at` (which is
// drizzle's folderMillis / the `_journal.json` `when`) — NOT a .sql file count.
//
// WHY NOT COUNT (design gate): the single-binary bakes `import.meta.dirname` to
// `/`, so `readdirSync(Paths.migrationsDir)` returns 0 there; and drizzle applies
// a migration purely on `lastDbMigration.created_at < migration.folderMillis`,
// never on count. Two divergent binaries with equal counts (104==104) would be
// judged "same" and restored with no forward migration → schema/type mismatch.

import { Database } from 'bun:sqlite'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { appVersion } from '@/util/version'

export const MANIFEST_FILENAME = 'manifest.json'

export type BackupKind = 'manual' | 'scheduled' | 'auto' | 'pre-restore' | 'pre-migration'

export interface MigrationIdentity {
  /** hash of the newest applied migration (drizzle sha256 of the .sql), or null. */
  lastHash: string | null
  /** newest `__drizzle_migrations.created_at` == folderMillis == `_journal.json` `when`. */
  lastCreatedAt: number | null
}

export interface BackupManifest {
  manifestVersion: 1
  kind: BackupKind
  createdAt: number
  /** Binary that produced the backup. `pre-migration` restore refuses forward-roll
   *  onto a DIFFERENT binary (design gate: else it re-runs the migration that broke). */
  appVersion: string
  includesWorktrees: boolean
  migration: MigrationIdentity
}

/** The running binary's identity for the pre-migration gate. Impl-gate P1-3
 *  (2026-07-22): was `env ?? '0.0.0'` with nothing setting the env — every two
 *  binaries compared equal and the gate never fired. Now delegates to
 *  util/version (build-time `--define` from git describe; dev = '0.0.0-dev'). */
export function currentAppVersion(): string {
  return appVersion()
}

/**
 * Read the newest `__drizzle_migrations` entry of a sqlite file WITHOUT going
 * through openDb (no migrations, no integrity gate). Best-effort + corruption
 * tolerant: returns null when the file is unreadable / not-a-database / the
 * table is missing, so it never blocks a raw snapshot of a corrupt DB.
 */
export function readDbMigrationIdentity(dbPath: string): MigrationIdentity | null {
  let db: Database | null = null
  try {
    db = new Database(dbPath, { readonly: true })
    const row = db
      .query('SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1')
      .get() as { hash: string; created_at: number | bigint } | null | undefined
    if (row == null) return { lastHash: null, lastCreatedAt: null }
    return { lastHash: row.hash, lastCreatedAt: Number(row.created_at) }
  } catch {
    // corrupt / SQLITE_NOTADB / no __drizzle_migrations table / permission
    return null
  } finally {
    db?.close()
  }
}

export interface MigrationAxis {
  /** max `when` across `_journal.json` entries (== newest folderMillis). */
  maxWhen: number
  /** number of journal entries (informational; NOT the version gate). */
  count: number
}

/**
 * The running binary's migration axis, read from `meta/_journal.json` in the
 * resolved migrations folder (dev: db/migrations; embedded: the runtime dir the
 * caller extracted to). The version gate compares a backup's lastCreatedAt to
 * this maxWhen.
 */
export function readMigrationAxisFromJournal(migrationsFolder: string): MigrationAxis {
  const journalPath = join(migrationsFolder, 'meta', '_journal.json')
  const journal = JSON.parse(readFileSync(journalPath, 'utf-8')) as {
    entries?: { idx: number; when: number; tag: string }[]
  }
  const whens = (journal.entries ?? []).map((e) => e.when)
  return { maxWhen: whens.length > 0 ? Math.max(...whens) : 0, count: whens.length }
}

export function writeManifest(dir: string, manifest: BackupManifest): void {
  writeFileSync(join(dir, MANIFEST_FILENAME), JSON.stringify(manifest, null, 2), 'utf-8')
}

/** Read + shallow-validate a manifest from an extracted backup dir. Null if
 *  absent (a legacy pre-RFC-213 backup) or malformed. */
export function readManifest(dir: string): BackupManifest | null {
  const path = join(dir, MANIFEST_FILENAME)
  if (!existsSync(path)) return null
  try {
    const m = JSON.parse(readFileSync(path, 'utf-8')) as BackupManifest
    if (m.manifestVersion !== 1 || typeof m.kind !== 'string' || m.migration == null) return null
    return m
  } catch {
    return null
  }
}

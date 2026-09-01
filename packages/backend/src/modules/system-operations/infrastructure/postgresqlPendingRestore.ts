// RFC-349 — durable PostgreSQL restore staging.
//
// Unlike SQLite recovery, this marker never authorizes an in-place swap. The
// configured PostgreSQL profile must point at an empty schema (or the same
// resumable logical operation) when the marker is created and consumed.

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { canonicalSchemaJson } from '@/platform/persistence/schemaContract'
import { DomainError } from '@/util/errors'

const MarkerSchema = z
  .object({
    version: z.literal(1),
    provider: z.literal('postgresql'),
    operationId: z.string().regex(/^dbm_[A-Za-z0-9_-]{8,128}$/),
    generationId: z.string().regex(/^dbg_[A-Za-z0-9_-]{8,128}$/),
    stagedTarball: z.string().min(1),
    noSafetyBackup: z.boolean(),
    noMigrate: z.boolean(),
    skipIntegrityCheck: z.boolean(),
    requestedAt: z.number().int().nonnegative(),
  })
  .strict()

export type PostgresqlPendingRestoreMarker = z.infer<typeof MarkerSchema>

const pendingDirectory = (appHome: string): string => join(appHome, '.restore-pending-postgresql')
const markerPath = (appHome: string): string =>
  join(pendingDirectory(appHome), 'restore-pending.json')
const stagedPath = (appHome: string): string => join(pendingDirectory(appHome), 'staged.tar.gz')

function parseMarker(appHome: string): PostgresqlPendingRestoreMarker | null {
  const path = markerPath(appHome)
  if (!existsSync(path)) return null
  try {
    return MarkerSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return null
  }
}

export function readPendingPostgresqlRestore(
  appHome: string,
): PostgresqlPendingRestoreMarker | null {
  return parseMarker(appHome)
}

export function projectPendingPostgresqlRestore(appHome: string): Readonly<{
  requestedAt: number
  stagedBytes: number | null
  noMigrate: boolean
  skipIntegrityCheck: boolean
}> | null {
  const marker = parseMarker(appHome)
  if (marker === null) return null
  let stagedBytes: number | null = null
  try {
    stagedBytes = statSync(marker.stagedTarball).size
  } catch {
    // A consumed/missing tarball is projected explicitly; boot cleanup owns it.
  }
  return Object.freeze({
    requestedAt: marker.requestedAt,
    stagedBytes,
    noMigrate: marker.noMigrate,
    skipIntegrityCheck: marker.skipIntegrityCheck,
  })
}

export function stagePendingPostgresqlRestore(input: {
  readonly appHome: string
  readonly tarballPath: string
  readonly operationId: string
  readonly generationId: string
  readonly noSafetyBackup: boolean
  readonly noMigrate: boolean
  readonly skipIntegrityCheck: boolean
  readonly requestedAt: number
}): PostgresqlPendingRestoreMarker {
  const directory = pendingDirectory(input.appHome)
  mkdirSync(input.appHome, { recursive: true })
  try {
    mkdirSync(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new DomainError(
        'restore-already-pending',
        'a PostgreSQL restore is already staged; cancel it before staging another',
        409,
        undefined,
      )
    }
    throw error
  }

  const destination = stagedPath(input.appHome)
  try {
    cpSync(input.tarballPath, destination)
    const marker = MarkerSchema.parse({
      version: 1,
      provider: 'postgresql',
      operationId: input.operationId,
      generationId: input.generationId,
      stagedTarball: destination,
      noSafetyBackup: input.noSafetyBackup,
      noMigrate: input.noMigrate,
      skipIntegrityCheck: input.skipIntegrityCheck,
      requestedAt: input.requestedAt,
    })
    writeFileSync(markerPath(input.appHome), canonicalSchemaJson(marker), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    })
    return marker
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
}

export function clearPendingPostgresqlRestore(appHome: string): boolean {
  if (!existsSync(markerPath(appHome))) return false
  rmSync(pendingDirectory(appHome), { recursive: true, force: true })
  return true
}

export function completePendingPostgresqlRestore(appHome: string): void {
  const marker = parseMarker(appHome)
  if (marker !== null) rmSync(marker.stagedTarball, { force: true })
  rmSync(pendingDirectory(appHome), { recursive: true, force: true })
}

export function quarantinePendingPostgresqlRestore(
  appHome: string,
  error: unknown,
  failedAt: number,
): string | null {
  const directory = pendingDirectory(appHome)
  if (!existsSync(directory)) return null
  const quarantine = `${directory}.failed-${failedAt}`
  try {
    renameSync(directory, quarantine)
    writeFileSync(
      join(quarantine, 'error.txt'),
      `${error instanceof Error ? error.message : String(error)}\n`,
      'utf8',
    )
    return quarantine
  } catch {
    rmSync(directory, { recursive: true, force: true })
    return null
  }
}

export function listFailedPostgresqlRestores(appHome: string): ReadonlyArray<{
  readonly dir: string
  readonly failedAt: number | null
  readonly error: string | null
}> {
  let entries: string[]
  try {
    entries = readdirSync(appHome)
  } catch {
    return []
  }
  const prefix = '.restore-pending-postgresql.failed-'
  return entries
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => {
      const dir = join(appHome, entry)
      let detail: string | null = null
      try {
        detail = readFileSync(join(dir, 'error.txt'), 'utf8').trim()
      } catch {
        // Preserve the failed directory even if its diagnostic was lost.
      }
      const timestamp = Number(entry.slice(prefix.length))
      return Object.freeze({
        dir,
        failedAt: Number.isFinite(timestamp) ? timestamp : null,
        error: detail,
      })
    })
    .sort((left, right) => (right.failedAt ?? 0) - (left.failedAt ?? 0))
}

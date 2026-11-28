import type { Database } from 'bun:sqlite'
import { existsSync, lstatSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { openSqliteForRead } from '../../sqlite/openForRead'
import type { EpochSourceLocation } from '../run/types'
import { availableDiskBytes } from './diskBudget'

/** Logical file bytes deliberately budget the copy fallback, even on reflink filesystems. */
export function migrationDirectoryBytes(root: string): number {
  if (!existsSync(root)) return 0
  const info = lstatSync(root)
  if (info.isFile()) return info.size
  if (!info.isDirectory()) return 0
  return readdirSync(root).reduce(
    (bytes, name) => bytes + migrationDirectoryBytes(join(root, name)),
    0,
  )
}

/**
 * RFC-626 §3.5: the bytes a SQLite database holds in pages that are in use. Every copy the
 * upgrade makes is a `VACUUM INTO`, which leaves the free pages behind, so this — not the size of
 * the file — is what each copy costs. A database that once was large and had most of its rows
 * deleted keeps its file size; budgeting by it refuses upgrades that would fit many times over.
 */
export function sqliteLiveBytes(database: Database): number {
  const pragma = (name: string): number => {
    const row = database.query(`PRAGMA ${name}`).get() as Record<string, unknown> | null
    const value = Number(row?.[name])
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error(`sqlite-live-bytes-unavailable: ${name}`)
    return value
  }
  return Math.max(0, pragma('page_count') - pragma('freelist_count')) * pragma('page_size')
}

function sqliteSourceBytes(path: string): number | null {
  if (!existsSync(path)) return null
  try {
    const database = openSqliteForRead(path)
    try {
      return sqliteLiveBytes(database)
    } finally {
      database.close()
    }
  } catch {
    // A file that cannot be read as a database still occupies its size; opening it for the
    // upgrade reports the actual problem.
    return statSync(path).size
  }
}

export interface MigrationCapacityMeasurement {
  readonly sourceBytes: number | null
  readonly availableBytes: number | null
  readonly operationBytes?: number
}

/** Both local and hosted composition measure the operation filesystem here. */
export async function measureMigrationCapacity(
  source: EpochSourceLocation,
  operationRoot: string,
  postgresqlBytes?: () => Promise<number>,
): Promise<MigrationCapacityMeasurement> {
  const sourceBytes =
    source.kind === 'sqlite-file'
      ? sqliteSourceBytes(source.path)
      : source.kind === 'backup'
        ? migrationDirectoryBytes(source.root)
        : ((await postgresqlBytes?.()) ?? null)
  return {
    sourceBytes,
    operationBytes: migrationDirectoryBytes(operationRoot),
    availableBytes: availableDiskBytes(operationRoot),
  }
}

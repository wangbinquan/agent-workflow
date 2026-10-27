import { existsSync, lstatSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
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
      ? existsSync(source.path)
        ? statSync(source.path).size
        : null
      : source.kind === 'backup'
        ? migrationDirectoryBytes(source.root)
        : ((await postgresqlBytes?.()) ?? null)
  return {
    sourceBytes,
    operationBytes: migrationDirectoryBytes(operationRoot),
    availableBytes: availableDiskBytes(operationRoot),
  }
}

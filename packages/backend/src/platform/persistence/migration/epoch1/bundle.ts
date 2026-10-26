// RFC-395 II-b V1: immutable epoch-1 bytes resolved in source and embedded builds.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { resolveMigrationsFolder, resolvePostgresqlMigrationsFolder } from '@/util/migrationsFolder'
import { sha256Hex } from '@/util/hash'
import { readPostgresqlMigrationHistoryPrefix } from '../legacy/postgresqlMigrationHistory'
import type { PostgresqlMigrationHistory } from '../legacy/postgresqlMigrationSequence'
import { digestSchemaContract } from '../../schema/canonical'
import { SourceBlockedError } from '../sourceTypes'
import provenance from './provenance.json'
import { frozenEpoch1Contract } from './contract'

export const epoch1MaintenanceInstruction =
  'Update the frozen epoch-1 copy, target contribution and supported-source manifest together (migration §3).'

export function verifyFrozenEpoch1Files(folders: { sqlite: string; postgresql: string }): void {
  const expected = provenance.migrationFiles as Readonly<Record<string, string>>
  const actual: string[] = []
  for (const [provider, folder] of Object.entries(folders)) {
    for (const path of readdirSync(folder, { recursive: true }).map(String)) {
      const relative = path.replaceAll('\\', '/')
      if (!/\.(?:sql|json)$/.test(relative) || /_snapshot\.json$/.test(relative)) continue
      const key = `${provider}/${relative}`
      actual.push(key)
      if (sha256Hex(readFileSync(join(folder, path))) !== expected[key])
        throw new SourceBlockedError(
          `Frozen migration bytes differ: ${key}. ${epoch1MaintenanceInstruction}`,
        )
    }
  }
  if (JSON.stringify(actual.sort()) !== JSON.stringify(Object.keys(expected).sort()))
    throw new SourceBlockedError(
      `Frozen migration file set differs. ${epoch1MaintenanceInstruction}`,
    )
}
export async function resolveFrozenEpoch1Folders(): Promise<{
  sqlite: string
  postgresql: string
}> {
  const resolve = async (force: boolean) => ({
    sqlite: await resolveMigrationsFolder({ force }),
    postgresql: await resolvePostgresqlMigrationsFolder({ force }),
  })
  let folders = await resolve(false)
  try {
    verifyFrozenEpoch1Files(folders)
  } catch {
    folders = await resolve(true)
    verifyFrozenEpoch1Files(folders)
  }
  return folders
}
/** Fixture/authoring convenience; no second bundled copy of SQL. */
export async function extractFrozenEpoch1Migrations(directory: string): Promise<void> {
  const folders = await resolveFrozenEpoch1Folders()
  for (const key of Object.keys(provenance.migrationFiles)) {
    const slash = key.indexOf('/')
    const folder = folders[key.slice(0, slash) as keyof typeof folders]
    const destination = join(directory, key)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, readFileSync(join(folder, key.slice(slash + 1))))
  }
}
export interface FrozenEpoch1History {
  readonly chainDigest: string
  readonly sqlite: ReturnType<typeof readMigrationFiles>
  readonly sqliteTags: readonly string[]
  readonly postgresql: PostgresqlMigrationHistory
}
const histories = new Map<string, Promise<FrozenEpoch1History>>()
export async function loadFrozenEpoch1History(): Promise<FrozenEpoch1History> {
  // Verify on every admission, including after activation and cache hits.
  const folders = await resolveFrozenEpoch1Folders()
  const chainDigest = digestSchemaContract(provenance.migrationFiles)
  let pending = histories.get(chainDigest)
  if (!pending) {
    pending = (async () => {
      const postgresql = await readPostgresqlMigrationHistoryPrefix({
        migrationsFolder: folders.postgresql,
      })
      if (postgresql.head.contract.digest !== frozenEpoch1Contract.digest)
        throw new SourceBlockedError(`Frozen history head differs. ${epoch1MaintenanceInstruction}`)
      const journal = JSON.parse(
        readFileSync(join(folders.sqlite, 'meta/_journal.json'), 'utf8'),
      ) as {
        entries: { tag: string }[]
      }
      return {
        chainDigest,
        sqlite: readMigrationFiles({ migrationsFolder: folders.sqlite }),
        sqliteTags: journal.entries.map((entry) => entry.tag),
        postgresql,
      }
    })().catch((error: unknown) => {
      histories.delete(chainDigest)
      throw error
    })
    histories.set(chainDigest, pending)
  }
  return pending
}

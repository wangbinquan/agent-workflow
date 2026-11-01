/** SQL-only fixture installation from immutable history artifacts, never runtime code. */
import type { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT, sha256 } from './io'
import type { ReleaseEntry } from './model'

function historyJson(value: unknown): string {
  const sort = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(sort)
      : item !== null && typeof item === 'object'
        ? Object.fromEntries(
            Object.entries(item)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, entry]) => [key, sort(entry)]),
          )
        : item
  return `${JSON.stringify(sort(value), null, 2)}\n`
}

export function installEpoch2Fixture(db: Database, release: ReleaseEntry, seeds: string): void {
  const epoch = release.epoch2
  if (!epoch) throw new Error('Expected epoch-2 release')
  const base = join(REPO_ROOT, 'packages/backend/db/schema-history/epoch2', epoch.history)
  const artifact = <T extends { digest: string }>(suffix: string, expected?: string): T => {
    const value = JSON.parse(readFileSync(`${base}.${suffix}.json`, 'utf8')) as T
    const { digest, ...payload } = value
    if (`sha256:${sha256(historyJson(payload))}` !== digest || (expected && expected !== digest))
      throw new Error(`History artifact digest mismatch: ${suffix}`)
    return value
  }
  const contract = artifact<{
    digest: string
    schemaEpoch: number
    version: number
    contract: { digest: string }
  }>('contract', epoch.contractDigest)
  const sqlite = artifact<{
    digest: string
    statements: string[]
    version: number
    schemaEpoch: number
  }>('sqlite-plan', epoch.sqlitePlanDigest)
  const postgresql = artifact('postgresql-plan', epoch.postgresqlPlanDigest)
  const postgresqlCatalog = artifact('postgresql-17-catalog')
  if (
    contract.schemaEpoch !== 2 ||
    contract.version !== epoch.version ||
    sqlite.schemaEpoch !== 2 ||
    sqlite.version !== epoch.version
  )
    throw new Error('History epoch/version mismatch')
  for (const statement of sqlite.statements) db.exec(statement)
  const metadata = JSON.parse(
    readFileSync(
      join(seeds, 'epoch2', `metadata-${String(epoch.version).padStart(4, '0')}.json`),
      'utf8',
    ),
  ) as {
    source: string
    sourceSha256: string
    statements: string[]
  }
  if (sha256(readFileSync(join(REPO_ROOT, metadata.source))) !== metadata.sourceSha256)
    throw new Error('Frozen metadata source hash mismatch')
  for (const statement of metadata.statements) db.exec(statement)
  const now = 1778459500000
  const generation = 'rfc398-epoch2-native-installation'
  db.query(
    "INSERT INTO aw_meta_generations (generation_id,schema_epoch,role,state,provider,contract_digest,plan_digest,created_at,activated_at) VALUES (?,2,'installed','active','sqlite',?,?,?,?)",
  ).run(generation, contract.contract.digest, sqlite.digest, now, now)
  // The fixture has business history; its first-write marker is already committed.
  db.query('INSERT INTO aw_meta_first_write (generation_id,first_live_write_at) VALUES (?,?)').run(
    generation,
    now,
  )
  db.exec(
    'CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at INTEGER)',
  )
  db.query('INSERT INTO __drizzle_migrations VALUES (-395,?,-395)').run(
    'RFC395_SCHEMA_EPOCH_2_REQUIRES_TARGET_BINARY',
  )
  db.query(
    'INSERT INTO aw_meta_schema_history (version,contract_digest,sqlite_plan_digest,postgresql_plan_digest,applied_at,artifact_json) VALUES (?,?,?,?,?,?)',
  ).run(
    epoch.version,
    contract.contract.digest,
    sqlite.digest,
    postgresql.digest,
    now,
    historyJson({ contract, sqlite, postgresql, postgresqlCatalog }),
  )
}

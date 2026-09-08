#!/usr/bin/env bun

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { format, resolveConfig } from 'prettier'
import { readExpectedMigrationChain, type ExpectedMigration } from '../src/db/schemaAdmission'
import { buildPostgresqlSchemaPlan } from '../src/platform/persistence/postgresqlSchema'
import {
  buildLogicalSchemaContract,
  canonicalSchemaJson,
  type LogicalSchemaContract,
} from '../src/platform/persistence/schemaContract'
import {
  POSTGRESQL_MIGRATION_ROOT_FILE,
  readPostgresqlMigrationHistoryPrefix,
} from '../src/platform/persistence/postgresqlMigrationHistory'
import {
  assertPostgresqlMigrationHead,
  createPostgresqlIndexUpgrade,
  createPostgresqlMigrationRoot,
  postgresqlMigrationDigest,
  postgresqlSqliteMigrationIdentity,
  renderPostgresqlUpgradeSql,
  type PostgresqlMigrationHistory,
} from '../src/platform/persistence/postgresqlMigrationSequence'

async function writeImmutable(path: string, bytes: string): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true })
  try {
    await writeFile(path, bytes, { flag: 'wx' })
    return true
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
    if ((await readFile(path, 'utf8')) !== bytes)
      throw new Error(`immutable PostgreSQL migration artifact differs: ${path}`)
    return false
  }
}

async function artifactJson(path: string, value: unknown): Promise<string> {
  const configurationPath = resolve(
    import.meta.dir,
    '..',
    'db',
    'postgresql-migrations',
    'meta',
    'artifact.json',
  )
  return await format(canonicalSchemaJson(value), {
    ...(await resolveConfig(configurationPath)),
    filepath: path,
  })
}

function assertSqliteMigrationHead(
  history: PostgresqlMigrationHistory,
  sqliteMigrations: readonly Readonly<ExpectedMigration>[],
): void {
  if (
    canonicalSchemaJson(history.head.sqliteMigrations) !== canonicalSchemaJson(sqliteMigrations)
  ) {
    throw new Error(
      'PostgreSQL history head differs from the complete current SQLite migration prefix',
    )
  }
}

/** No baseline rewrite. SQL is created first; the immutable journal commits its append. */
export async function generatePostgresqlMigrationHistory(
  input: {
    readonly migrationsFolder?: string
    readonly sqliteMigrations?: readonly Readonly<ExpectedMigration>[]
    readonly contract?: LogicalSchemaContract
    readonly appendId?: string
  } = {},
): Promise<{ readonly created: readonly string[]; readonly planDigest: string }> {
  const folder =
    input.migrationsFolder ?? resolve(import.meta.dir, '..', 'db', 'postgresql-migrations')
  const contract = input.contract ?? buildLogicalSchemaContract()
  const plan = buildPostgresqlSchemaPlan(contract)
  const sqliteMigrations =
    input.sqliteMigrations ??
    readExpectedMigrationChain(resolve(import.meta.dir, '..', 'db', 'migrations'))
  const target = {
    contract,
    plan,
    sqliteMigrations,
    sqliteMigration: postgresqlSqliteMigrationIdentity(sqliteMigrations),
  }
  const created: string[] = []
  const rootFile = resolve(folder, 'meta', POSTGRESQL_MIGRATION_ROOT_FILE)
  if (!existsSync(rootFile)) {
    const root = createPostgresqlMigrationRoot({
      contract,
      plan,
      sqliteMigrations,
      baselineSql: await readFile(resolve(folder, '0000_rfc349_baseline.sql'), 'utf8'),
      legacyJournal: await readFile(resolve(folder, 'meta', '_journal.json'), 'utf8'),
    })
    if (await writeImmutable(rootFile, await artifactJson(rootFile, root))) created.push(rootFile)
  }
  if (input.appendId !== undefined && !/^\d{4,}_[a-z0-9_]+$/u.test(input.appendId))
    throw new Error('append ID must have an ordered numeric prefix and lowercase description')
  const history = await readPostgresqlMigrationHistoryPrefix({
    migrationsFolder: folder,
    pendingSqlFile: input.appendId === undefined ? undefined : `${input.appendId}.sql`,
  })
  if (input.appendId === undefined) {
    assertPostgresqlMigrationHead(history, contract, plan)
    assertSqliteMigrationHead(history, sqliteMigrations)
    return { created, planDigest: plan.digest }
  }
  const existingAt = history.steps.findIndex((step) => step.id === input.appendId)
  const at = existingAt < 0 ? history.steps.length : existingAt
  const step = createPostgresqlIndexUpgrade({
    from: history.versions[at]!,
    to: target,
    id: input.appendId,
    sequence: at + 1,
    previousEntryDigest:
      at === 0 ? postgresqlMigrationDigest(history.root) : history.steps[at - 1]!.digest,
  })
  const sqlFile = resolve(folder, step.sqlFile)
  const journalFile = resolve(folder, 'meta', `${step.id}.upgrade.json`)
  if (await writeImmutable(sqlFile, renderPostgresqlUpgradeSql(step))) created.push(sqlFile)
  if (await writeImmutable(journalFile, await artifactJson(journalFile, step)))
    created.push(journalFile)
  const appended = await readPostgresqlMigrationHistoryPrefix({ migrationsFolder: folder })
  assertPostgresqlMigrationHead(appended, contract, plan)
  assertSqliteMigrationHead(appended, sqliteMigrations)
  return { created, planDigest: plan.digest }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--append' || args[1] === undefined))
    throw new Error('usage: bun run db:rfc349-postgresql-schema [--append 0001_description]')
  const result = await generatePostgresqlMigrationHistory({ appendId: args[1] })
  console.log(
    `PostgreSQL history verified (${result.created.length} new immutable files, ${result.planDigest})`,
  )
}

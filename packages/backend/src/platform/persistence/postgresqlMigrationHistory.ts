// RFC-349 T4/T10, RFC-359 T19h — frozen baseline plus append-only upgrades.
// Every runtime history must reach the current complete projection. A resumed
// historical copy may then select an exact verified node from that same history.

import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { resolvePostgresqlMigrationsFolder } from '@/util/migrationsFolder'
import {
  buildPostgresqlSchemaPlan,
  POSTGRESQL_BASELINE_ID,
  renderPostgresqlBaselineSql,
  type PostgresqlSchemaPlan,
} from './postgresqlSchema'
import {
  buildLogicalSchemaContract,
  canonicalSchemaJson,
  type LogicalSchemaContract,
} from './schemaContract'
import {
  assertPostgresqlMigrationHead,
  postgresqlMigrationJournal as expectedJournal,
  PostgresqlMigrationSequenceError,
  renderPostgresqlUpgradeSql,
  replayPostgresqlMigrationHistory,
  validatePostgresqlMigrationRoot,
  type PostgresqlIndexUpgrade,
  type PostgresqlMigrationHistory,
  type PostgresqlMigrationRoot,
} from './postgresqlMigrationSequence'

export const POSTGRESQL_MIGRATION_ROOT_FILE = '0000_rfc349_baseline.plan.json'

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u)
const OwnerSchema = z.enum([
  'collaboration',
  'development-automation',
  'digital-employee',
  'event-center',
  'identity-access',
  'integration',
  'intent',
  'knowledge-evolution',
  'platform-events',
  'resource-catalog',
  'source-control',
  'system-operations',
  'task-execution',
])
const IndexSchema = z
  .object({
    name: z.string(),
    unique: z.boolean(),
    columns: z.array(z.string()),
    where: z.string().nullable(),
  })
  .strict()
const ConstraintSchema = z
  .object({ name: z.string(), columns: z.array(z.string()), expression: z.string().nullable() })
  .strict()
const ColumnSchema = z
  .object({
    name: z.string(),
    logicalCodec: z.enum([
      'boolean',
      'epoch-milliseconds',
      'integer',
      'json-text',
      'opaque-bytes',
      'real',
      'text',
      'text-identity',
    ]),
    nullable: z.boolean(),
    primary: z.boolean(),
    hasDefault: z.boolean(),
    defaultKind: z.enum([
      'none',
      'literal',
      'database-expression',
      'runtime',
      'identity',
      'implicit-primary',
    ]),
    defaultValue: z.string().nullable(),
    providerDefault: z
      .object({ sqlite: z.string().nullable(), postgresql: z.string().nullable() })
      .strict(),
    identity: z.boolean(),
    uniqueName: z.string().nullable(),
    enumValues: z.array(z.string()),
    providerType: z.object({ sqlite: z.string(), postgresql: z.string() }).strict(),
  })
  .strict()
const ContractSchema: z.ZodType<LogicalSchemaContract> = z
  .object({
    contractVersion: z.number().int(),
    sourceProjection: z.literal('sqlite'),
    sourceTableCount: z.number().int().nonnegative(),
    activeTableCount: z.number().int().nonnegative(),
    archiveOnlyTableCount: z.number().int().nonnegative(),
    digest: DigestSchema,
    tables: z.array(
      z
        .object({
          id: z.string(),
          schemaSymbol: z.string(),
          ownerContext: OwnerSchema,
          disposition: z.enum(['KEEP', 'ARCHIVE_THEN_OMIT', 'DEFER']),
          sourceTable: z.string(),
          providerTables: z
            .object({ sqlite: z.string(), postgresql: z.string().optional() })
            .strict(),
          migrationKey: z.array(z.string()),
          columns: z.array(ColumnSchema),
          primaryKey: z.array(z.string()),
          unique: z.array(ConstraintSchema),
          checks: z.array(ConstraintSchema),
          indexes: z.array(IndexSchema),
          foreignKeys: z.array(
            z
              .object({
                name: z.string(),
                columns: z.array(z.string()),
                foreignTable: z.string(),
                foreignColumns: z.array(z.string()),
                onDelete: z.string(),
                onUpdate: z.string(),
              })
              .strict(),
          ),
          retention: z
            .object({
              class: z.enum([
                'archive-only',
                'owner-managed-business',
                'owner-managed-operational',
              ]),
              owner: OwnerSchema,
              rule: z.string(),
            })
            .strict(),
          consumers: z
            .object({
              productionReader: z.enum(['zero-proved', 'owner-required']),
              productionWriter: z.enum(['zero-proved', 'owner-required-or-immutable']),
              backgroundRecoveryDiagnostic: z.enum(['zero-proved', 'owner-reviewed']),
              evidence: z.string(),
            })
            .strict(),
          archive: z
            .object({
              format: z.literal('agent-workflow-logical-table-v1'),
              stableOrder: z.array(z.string()),
              verifies: z.tuple([
                z.literal('row-count'),
                z.literal('key-bounds'),
                z.literal('chunk-digest'),
                z.literal('root-digest'),
              ]),
              restoreIntoActiveSchema: z.literal(false),
              approval: z.literal('RFC-349-D9'),
            })
            .strict()
            .optional(),
          rationale: z.string(),
        })
        .strict(),
    ),
  })
  .strict()
const StatementSchema = z
  .object({
    kind: z.enum(['bootstrap', 'table', 'constraint', 'index', 'metadata']),
    logicalId: z.string(),
    sql: z.string(),
  })
  .strict()
const PlanSchema = z
  .object({
    version: z.literal(1),
    baselineId: z.literal(POSTGRESQL_BASELINE_ID),
    contractDigest: DigestSchema,
    activeTableCount: z.number().int().nonnegative(),
    archiveOnlyTableCount: z.number().int().nonnegative(),
    statements: z.array(StatementSchema),
    digest: DigestSchema,
  })
  .strict()
const MigrationSchema = z
  .object({
    index: z.number().int().nonnegative(),
    folderMillis: z.number().int(),
    hash: z.string().regex(/^[a-f0-9]{64}$/u),
    tag: z.string().min(1),
  })
  .strict()
const SqliteIdentitySchema = z
  .object({ count: z.number().int().positive(), last: MigrationSchema, chainDigest: DigestSchema })
  .strict()
const IdentitySchema = z
  .object({ baselineId: z.string(), contractDigest: DigestSchema, planDigest: DigestSchema })
  .strict()
const RootSchema: z.ZodType<PostgresqlMigrationRoot> = z
  .object({
    version: z.literal(1),
    contract: ContractSchema,
    plan: PlanSchema,
    sqliteMigrations: z.array(MigrationSchema),
    sqliteMigration: SqliteIdentitySchema,
    baselineSqlDigest: DigestSchema,
    legacyJournalDigest: DigestSchema,
  })
  .strict()
const UpgradeSchema: z.ZodType<PostgresqlIndexUpgrade> = z
  .object({
    version: z.literal(1),
    id: z.string().regex(/^\d{4,}_[a-z0-9_]+$/u),
    sequence: z.number().int().positive(),
    digest: DigestSchema,
    previousEntryDigest: DigestSchema,
    from: IdentitySchema,
    to: IdentitySchema,
    logicalIndexes: z.array(
      z
        .object({
          tableId: z.string(),
          position: z.number().int().nonnegative(),
          index: IndexSchema,
        })
        .strict(),
    ),
    indexAdditions: z.array(
      z.object({ position: z.number().int().nonnegative(), statement: StatementSchema }).strict(),
    ),
    contractRow: z.object({ beforeDigest: DigestSchema, after: StatementSchema }).strict(),
    sqliteMigration: z
      .object({
        from: SqliteIdentitySchema,
        to: SqliteIdentitySchema,
        appended: z.array(MigrationSchema),
      })
      .strict(),
    executableStatements: z.array(StatementSchema),
    sqlFile: z.string().regex(/^\d{4,}_[a-z0-9_]+\.sql$/u),
    sqlDigest: DigestSchema,
  })
  .strict()

export class PostgresqlMigrationHistoryError extends Error {
  constructor(
    public readonly code:
      | 'postgresql-migration-history-missing'
      | 'postgresql-migration-history-invalid'
      | 'postgresql-migration-history-drift',
    message: string,
  ) {
    super(message)
    this.name = 'PostgresqlMigrationHistoryError'
  }
}

interface PostgresqlMigrationJournal {
  readonly version: number
  readonly baselineId: string
  readonly contractDigest: string
  readonly planDigest: string
  readonly activeTableCount: number
  readonly archiveOnlyTableCount: number
  readonly statements: readonly {
    readonly kind: string
    readonly logicalId: string
    readonly digest: string
  }[]
}

export interface PostgresqlMigrationHistoryReceipt {
  readonly migrationsFolder: string
  readonly baselineId: string
  readonly contractDigest: string
  readonly planDigest: string
  readonly statementCount: number
}

function normalizeJournal(value: unknown): PostgresqlMigrationJournal | null {
  if (value === null || typeof value !== 'object') return null
  const candidate = value as Record<string, unknown>
  if (
    typeof candidate.version !== 'number' ||
    typeof candidate.baselineId !== 'string' ||
    typeof candidate.contractDigest !== 'string' ||
    typeof candidate.planDigest !== 'string' ||
    typeof candidate.activeTableCount !== 'number' ||
    typeof candidate.archiveOnlyTableCount !== 'number' ||
    !Array.isArray(candidate.statements)
  ) {
    return null
  }
  const statements: Array<{ kind: string; logicalId: string; digest: string }> = []
  for (const value of candidate.statements) {
    if (value === null || typeof value !== 'object') return null
    const statement = value as Record<string, unknown>
    if (
      typeof statement.kind !== 'string' ||
      typeof statement.logicalId !== 'string' ||
      typeof statement.digest !== 'string'
    ) {
      return null
    }
    statements.push({
      kind: statement.kind,
      logicalId: statement.logicalId,
      digest: statement.digest,
    })
  }
  return {
    version: candidate.version,
    baselineId: candidate.baselineId,
    contractDigest: candidate.contractDigest,
    planDigest: candidate.planDigest,
    activeTableCount: candidate.activeTableCount,
    archiveOnlyTableCount: candidate.archiveOnlyTableCount,
    statements,
  }
}

async function verifyFlatPostgresqlMigrationHistory(input: {
  readonly plan: PostgresqlSchemaPlan
  readonly migrationsFolder?: string
}): Promise<PostgresqlMigrationHistoryReceipt> {
  const migrationsFolder = input.migrationsFolder ?? (await resolvePostgresqlMigrationsFolder())
  let baseline: string
  let rawJournal: string
  try {
    ;[baseline, rawJournal] = await Promise.all([
      readFile(join(migrationsFolder, '0000_rfc349_baseline.sql'), 'utf8'),
      readFile(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
    ])
  } catch {
    throw new PostgresqlMigrationHistoryError(
      'postgresql-migration-history-missing',
      'PostgreSQL migration baseline or journal is missing from this runtime',
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawJournal)
  } catch {
    throw new PostgresqlMigrationHistoryError(
      'postgresql-migration-history-invalid',
      'PostgreSQL migration journal is not valid JSON',
    )
  }
  const actual = normalizeJournal(parsed)
  if (actual === null) {
    throw new PostgresqlMigrationHistoryError(
      'postgresql-migration-history-invalid',
      'PostgreSQL migration journal has an invalid contract',
    )
  }
  const expected = expectedJournal(input.plan)
  const baselineDrifted = baseline !== renderPostgresqlBaselineSql(input.plan)
  const journalDrifted = JSON.stringify(actual) !== JSON.stringify(expected)
  if (baselineDrifted || journalDrifted) {
    // 这条错误几乎只有一个成因：改了 `db/schema.ts`（drizzle 声明是 PostgreSQL DDL 的唯一
    // 来源）却没重生成盘上的基线。它在测试的 `beforeAll` 里抛，于是**全仓每个
    // `describeEachProvider` 用例的 PG 分支一起死**——2026-09-07 实撞：多个并发作业各自
    // 排查了很久，因为消息只说「不匹配」，既没说是哪一半漂了，也没说该跑什么。
    // 所以这里把「哪半边」与「怎么修」直接写进消息；`rfc349-postgresql-migration-history`
    // 里有断言锁住这两点，别把它改回一句笼统的话。
    const drifted = [baselineDrifted ? 'baseline SQL' : null, journalDrifted ? 'journal' : null]
      .filter((part): part is string => part !== null)
      .join(' + ')
    throw new PostgresqlMigrationHistoryError(
      'postgresql-migration-history-drift',
      `PostgreSQL migration history does not match this binary schema plan (${drifted} drifted). ` +
        'If you just changed db/schema.ts, regenerate the on-disk history with ' +
        '`bun run db:rfc349-postgresql-schema` — that script is registered in ' +
        'packages/backend/package.json, so run it FROM packages/backend ' +
        '(from the repository root it is not a known script).',
    )
  }
  return Object.freeze({
    migrationsFolder,
    baselineId: actual.baselineId,
    contractDigest: actual.contractDigest,
    planDigest: actual.planDigest,
    statementCount: actual.statements.length,
  })
}

function decodeArtifact<T>(raw: string, schema: z.ZodType<T>, name: string): T {
  try {
    const value: unknown = JSON.parse(raw)
    return schema.parse(value)
  } catch {
    throw new PostgresqlMigrationHistoryError(
      'postgresql-migration-history-invalid',
      `PostgreSQL migration ${name} has an invalid contract or JSON`,
    )
  }
}

function historyDrift(error: unknown): never {
  const reason = error instanceof Error ? error.message : String(error)
  throw new PostgresqlMigrationHistoryError(
    'postgresql-migration-history-drift',
    `PostgreSQL migration history does not match this binary schema plan (${reason}). ` +
      'Use `bun run db:rfc349-postgresql-schema` from packages/backend; schema changes require an explicit --append ID and must preserve existing history.',
  )
}

/** Authoring reads a verified prefix; runtime callers use load below to require current head. */
export async function readPostgresqlMigrationHistoryPrefix(input: {
  readonly migrationsFolder: string
  /** Authoring may finish this one SQL-first append; the runtime never supplies it. */
  readonly pendingSqlFile?: string
}): Promise<PostgresqlMigrationHistory> {
  const folder = input.migrationsFolder
  let baseline: string
  let journal: string
  let rawRoot: string
  let entries: string[]
  try {
    ;[baseline, journal, rawRoot, entries] = await Promise.all([
      readFile(join(folder, '0000_rfc349_baseline.sql'), 'utf8'),
      readFile(join(folder, 'meta', '_journal.json'), 'utf8'),
      readFile(join(folder, 'meta', POSTGRESQL_MIGRATION_ROOT_FILE), 'utf8'),
      readdir(join(folder, 'meta')),
    ])
  } catch {
    throw new PostgresqlMigrationHistoryError(
      'postgresql-migration-history-missing',
      'PostgreSQL migration baseline, journal or frozen root is missing from this runtime',
    )
  }
  let parsedJournal: unknown
  try {
    parsedJournal = JSON.parse(journal)
  } catch {
    throw new PostgresqlMigrationHistoryError(
      'postgresql-migration-history-invalid',
      'PostgreSQL migration journal is not valid JSON',
    )
  }
  if (normalizeJournal(parsedJournal) === null)
    throw new PostgresqlMigrationHistoryError(
      'postgresql-migration-history-invalid',
      'PostgreSQL migration journal has an invalid contract',
    )
  const root = decodeArtifact(rawRoot, RootSchema, 'frozen root')
  const steps = await Promise.all(
    entries
      .filter((entry) => entry.endsWith('.upgrade.json'))
      .map(async (entry) => {
        const step = decodeArtifact(
          await readFile(join(folder, 'meta', entry), 'utf8'),
          UpgradeSchema,
          entry,
        )
        if (entry !== `${step.id}.upgrade.json`)
          historyDrift(new Error('upgrade journal filename differs from its ID'))
        return step
      }),
  )
  steps.sort((left, right) => left.sequence - right.sequence)
  try {
    validatePostgresqlMigrationRoot(root, baseline, journal)
    const history = replayPostgresqlMigrationHistory(root, steps)
    const expectedSql = ['0000_rfc349_baseline.sql', ...steps.map((step) => step.sqlFile)].sort()
    const actualSql = (await readdir(folder))
      .filter(
        (entry) =>
          entry.endsWith('.sql') &&
          !(entry === input.pendingSqlFile && !expectedSql.includes(entry)),
      )
      .sort()
    if (canonicalSchemaJson(actualSql) !== canonicalSchemaJson(expectedSql))
      historyDrift(new Error('upgrade SQL files are missing or have no matching journal'))
    for (const step of steps) {
      if ((await readFile(join(folder, step.sqlFile), 'utf8')) !== renderPostgresqlUpgradeSql(step))
        historyDrift(new Error(`upgrade SQL drifted for ${step.id}`))
    }
    return history
  } catch (error) {
    if (error instanceof PostgresqlMigrationHistoryError) throw error
    if (error instanceof PostgresqlMigrationSequenceError) historyDrift(error)
    throw error
  }
}

export async function loadPostgresqlMigrationHistory(
  input: {
    readonly plan?: PostgresqlSchemaPlan
    readonly contract?: LogicalSchemaContract
    readonly migrationsFolder?: string
  } = {},
): Promise<PostgresqlMigrationHistory> {
  const contract = input.contract ?? buildLogicalSchemaContract()
  const plan = input.plan ?? buildPostgresqlSchemaPlan(contract)
  const history = await readPostgresqlMigrationHistoryPrefix({
    migrationsFolder: input.migrationsFolder ?? (await resolvePostgresqlMigrationsFolder()),
  })
  try {
    assertPostgresqlMigrationHead(history, contract, plan)
  } catch (error) {
    historyDrift(error)
  }
  return history
}

export async function verifyPostgresqlMigrationHistory(input: {
  readonly plan: PostgresqlSchemaPlan
  readonly migrationsFolder?: string
}): Promise<PostgresqlMigrationHistoryReceipt> {
  const migrationsFolder = input.migrationsFolder ?? (await resolvePostgresqlMigrationsFolder())
  // Existing explicit, self-contained custom baselines remain an exact contract.
  if (
    input.migrationsFolder !== undefined &&
    !existsSync(join(migrationsFolder, 'meta', POSTGRESQL_MIGRATION_ROOT_FILE))
  ) {
    return await verifyFlatPostgresqlMigrationHistory({ ...input, migrationsFolder })
  }
  const history = await loadPostgresqlMigrationHistory({ migrationsFolder })
  const node = history.versions.find(
    (version) => canonicalSchemaJson(version.plan) === canonicalSchemaJson(input.plan),
  )
  if (node === undefined)
    historyDrift(new Error('requested schema plan is not an exact supported history node'))
  return Object.freeze({
    migrationsFolder,
    baselineId: node.plan.baselineId,
    contractDigest: node.contract.digest,
    planDigest: node.plan.digest,
    statementCount: node.plan.statements.length,
  })
}

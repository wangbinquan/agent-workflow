// RFC-349 T4/T10 — runtime admission for the independent PostgreSQL
// migration history. The projector remains the executable source of DDL, but
// production refuses to prepare a target unless the committed (or embedded)
// baseline and journal are byte/digest-equivalent to that projector.

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolvePostgresqlMigrationsFolder } from '@/util/migrationsFolder'
import { renderPostgresqlBaselineSql, type PostgresqlSchemaPlan } from './postgresqlSchema'

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

function statementDigest(sql: string): string {
  return `sha256:${createHash('sha256').update(sql).digest('hex')}`
}

function expectedJournal(plan: PostgresqlSchemaPlan): PostgresqlMigrationJournal {
  return {
    version: 1,
    baselineId: plan.baselineId,
    contractDigest: plan.contractDigest,
    planDigest: plan.digest,
    activeTableCount: plan.activeTableCount,
    archiveOnlyTableCount: plan.archiveOnlyTableCount,
    statements: plan.statements.map((statement) => ({
      kind: statement.kind,
      logicalId: statement.logicalId,
      digest: statementDigest(statement.sql),
    })),
  }
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

export async function verifyPostgresqlMigrationHistory(input: {
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
  if (
    baseline !== renderPostgresqlBaselineSql(input.plan) ||
    JSON.stringify(actual) !== JSON.stringify(expected)
  ) {
    throw new PostgresqlMigrationHistoryError(
      'postgresql-migration-history-drift',
      'PostgreSQL migration history does not match this binary schema plan',
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

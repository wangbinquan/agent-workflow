// RFC-349 T4 — fail-closed baseline admission for an external PostgreSQL
// target. It holds the advisory lock and DDL transaction on the same reserved
// connection, so poolMax=1 remains valid during boot/migration.

import type { PostgresqlDatabaseRuntime, PostgresqlReservedConnection } from './postgresqlRuntime'
import {
  buildPostgresqlSchemaPlan,
  POSTGRESQL_APPLICATION_SCHEMA,
  POSTGRESQL_BASELINE_ID,
  POSTGRESQL_METADATA_SCHEMA,
  type PostgresqlSchemaPlan,
} from './postgresqlSchema'

export class PostgresqlMigrationError extends Error {
  constructor(
    public readonly code:
      | 'postgresql-schema-lock-held'
      | 'postgresql-schema-partial'
      | 'postgresql-schema-drift'
      | 'postgresql-schema-prepare-failed',
    message: string,
  ) {
    super(message)
    this.name = 'PostgresqlMigrationError'
  }
}

export interface PostgresqlMigrationReceipt {
  readonly baselineId: typeof POSTGRESQL_BASELINE_ID
  readonly contractDigest: string
  readonly planDigest: string
  readonly applied: boolean
  readonly activeTableCount: number
}

interface TargetSnapshot {
  readonly applicationTables: readonly string[]
  readonly hasMigrationTable: boolean
  readonly baseline: { readonly contractDigest: string; readonly planDigest: string } | null
}

async function targetSnapshot(connection: PostgresqlReservedConnection): Promise<TargetSnapshot> {
  const tableRows = await connection.unsafe(
    'SELECT table_schema, table_name FROM information_schema.tables ' +
      'WHERE table_schema IN ($1, $2) AND table_type = $3 ORDER BY table_schema, table_name',
    [POSTGRESQL_APPLICATION_SCHEMA, POSTGRESQL_METADATA_SCHEMA, 'BASE TABLE'],
  )
  const applicationTables: string[] = []
  let hasMigrationTable = false
  for (const row of tableRows) {
    if (row.table_schema === POSTGRESQL_APPLICATION_SCHEMA) {
      applicationTables.push(String(row.table_name))
    }
    if (row.table_schema === POSTGRESQL_METADATA_SCHEMA && row.table_name === 'schema_migrations') {
      hasMigrationTable = true
    }
  }
  let baseline: TargetSnapshot['baseline'] = null
  if (hasMigrationTable) {
    const rows = await connection.unsafe(
      `SELECT contract_digest, plan_digest FROM "${POSTGRESQL_METADATA_SCHEMA}"."schema_migrations" WHERE baseline_id = $1`,
      [POSTGRESQL_BASELINE_ID],
    )
    const row = rows[0]
    if (row !== undefined) {
      baseline = {
        contractDigest: String(row.contract_digest),
        planDigest: String(row.plan_digest),
      }
    }
  }
  return { applicationTables, hasMigrationTable, baseline }
}

function assertSnapshot(snapshot: TargetSnapshot, plan: PostgresqlSchemaPlan): 'empty' | 'ready' {
  const expected = plan.statements
    .filter((statement) => statement.kind === 'table')
    .map((statement) => statement.logicalId)
    .sort()
  const actual = [...snapshot.applicationTables].sort()
  if (actual.length === 0 && !snapshot.hasMigrationTable && snapshot.baseline === null)
    return 'empty'
  if (
    snapshot.baseline?.contractDigest === plan.contractDigest &&
    snapshot.baseline.planDigest === plan.digest &&
    JSON.stringify(actual) === JSON.stringify(expected)
  ) {
    return 'ready'
  }
  if (snapshot.baseline === null) {
    throw new PostgresqlMigrationError(
      'postgresql-schema-partial',
      'PostgreSQL target contains a partial or unmanaged agent-workflow schema',
    )
  }
  throw new PostgresqlMigrationError(
    'postgresql-schema-drift',
    'PostgreSQL schema metadata or active table roster does not match this binary',
  )
}

function receipt(plan: PostgresqlSchemaPlan, applied: boolean): PostgresqlMigrationReceipt {
  return {
    baselineId: POSTGRESQL_BASELINE_ID,
    contractDigest: plan.contractDigest,
    planDigest: plan.digest,
    applied,
    activeTableCount: plan.activeTableCount,
  }
}

export async function migratePostgresqlSchema(input: {
  readonly runtime: PostgresqlDatabaseRuntime
  readonly plan?: PostgresqlSchemaPlan
  readonly now?: () => number
}): Promise<PostgresqlMigrationReceipt> {
  const plan = input.plan ?? buildPostgresqlSchemaPlan()
  const connection = await input.runtime.providerPool().reserve()
  const lockKey = `rfc349-schema:${plan.contractDigest}`
  let locked = false
  let transaction = false
  try {
    const lockRows = await connection.unsafe(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
      [lockKey],
    )
    locked = lockRows[0]?.acquired === true
    if (!locked) {
      throw new PostgresqlMigrationError(
        'postgresql-schema-lock-held',
        'another process is preparing the PostgreSQL schema',
      )
    }

    const state = assertSnapshot(await targetSnapshot(connection), plan)
    if (state === 'ready') return receipt(plan, false)

    await connection.unsafe('BEGIN')
    transaction = true
    for (const statement of plan.statements) {
      try {
        await connection.unsafe(statement.sql)
      } catch {
        throw new PostgresqlMigrationError(
          'postgresql-schema-prepare-failed',
          `PostgreSQL schema preparation failed at ${statement.kind}:${statement.logicalId}`,
        )
      }
    }
    await connection.unsafe(
      `INSERT INTO "${POSTGRESQL_METADATA_SCHEMA}"."schema_migrations" (baseline_id, contract_digest, plan_digest, applied_at) VALUES ($1, $2, $3, $4)`,
      [
        POSTGRESQL_BASELINE_ID,
        plan.contractDigest,
        plan.digest,
        Math.trunc((input.now ?? Date.now)()),
      ],
    )
    await connection.unsafe('COMMIT')
    transaction = false
    assertSnapshot(await targetSnapshot(connection), plan)
    return receipt(plan, true)
  } catch (error) {
    if (transaction) {
      try {
        await connection.unsafe('ROLLBACK')
      } catch {
        // The original deterministic failure category wins.
      }
    }
    if (error instanceof PostgresqlMigrationError) throw error
    throw new PostgresqlMigrationError(
      'postgresql-schema-prepare-failed',
      'PostgreSQL schema preparation failed',
    )
  } finally {
    if (locked) {
      try {
        await connection.unsafe('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey])
      } catch {
        // Releasing the reserved session below is the final lock release.
      }
    }
    connection.release()
  }
}

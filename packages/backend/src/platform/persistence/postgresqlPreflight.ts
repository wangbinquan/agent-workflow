// RFC-349 — read-mostly target preflight. The only capability probe runs in a
// transaction that is always rolled back, so an accepted or rejected probe
// leaves no schema object behind and never exposes the connection URL.

import type { PostgresqlDatabaseRuntime, PostgresqlReservedConnection } from './postgresqlRuntime'
import { POSTGRESQL_APPLICATION_SCHEMA, POSTGRESQL_METADATA_SCHEMA } from './postgresqlSchema'

export interface PostgresqlPreflightReceipt {
  readonly ok: true
  readonly databaseFingerprint: string
  readonly serverMajor: number
  readonly serverVersionNum: number
  readonly serverEncoding: 'UTF8'
  readonly timezone: 'UTC'
  readonly databaseBytes: number
  readonly targetState: 'empty' | 'resumable'
  readonly applicationTableCount: number
  readonly metadataTableCount: number
}

export class PostgresqlPreflightError extends Error {
  constructor(
    public readonly code:
      | 'postgresql-version-unsupported'
      | 'postgresql-encoding-unsupported'
      | 'postgresql-timezone-unsupported'
      | 'postgresql-collation-unavailable'
      | 'postgresql-target-not-empty'
      | 'postgresql-permission-probe-failed'
      | 'postgresql-advisory-lock-held',
    message: string,
  ) {
    super(message)
    this.name = 'PostgresqlPreflightError'
  }
}

async function rollback(connection: PostgresqlReservedConnection): Promise<void> {
  try {
    await connection.unsafe('ROLLBACK')
  } catch {
    // The deterministic preflight category below remains authoritative.
  }
}

export async function preflightPostgresqlTarget(input: {
  readonly runtime: PostgresqlDatabaseRuntime
  readonly operationId: string
}): Promise<PostgresqlPreflightReceipt> {
  const health = await input.runtime.readiness()
  const connection = await input.runtime.providerPool().reserve()
  const lockKey = `rfc349-preflight:${input.operationId}`
  let locked = false
  try {
    const environmentRows = await connection.unsafe(
      "SELECT current_setting('server_version_num') AS server_version_num, " +
        "current_setting('server_encoding') AS server_encoding, " +
        "current_setting('TimeZone') AS timezone, " +
        'pg_database_size(current_database()) AS database_bytes, ' +
        "EXISTS (SELECT 1 FROM pg_collation WHERE collname = 'C') AS has_c_collation",
    )
    const environment = environmentRows[0]
    const serverVersionNum = Number(environment?.server_version_num)
    const serverMajor = Math.floor(serverVersionNum / 10_000)
    if (!Number.isSafeInteger(serverVersionNum) || serverMajor < 15 || serverMajor > 18) {
      throw new PostgresqlPreflightError(
        'postgresql-version-unsupported',
        'PostgreSQL target must run a supported major version (15 through 18)',
      )
    }
    if (environment?.server_encoding !== 'UTF8') {
      throw new PostgresqlPreflightError(
        'postgresql-encoding-unsupported',
        'PostgreSQL target database encoding must be UTF8',
      )
    }
    if (environment?.timezone !== 'UTC') {
      throw new PostgresqlPreflightError(
        'postgresql-timezone-unsupported',
        'PostgreSQL migration session timezone must be UTC',
      )
    }
    if (environment?.has_c_collation !== true) {
      throw new PostgresqlPreflightError(
        'postgresql-collation-unavailable',
        'PostgreSQL target must provide the C collation for SQLite BINARY parity',
      )
    }

    const tableRows = await connection.unsafe(
      'SELECT table_schema, table_name FROM information_schema.tables ' +
        'WHERE table_schema IN ($1, $2) AND table_type = $3 ORDER BY table_schema, table_name',
      [POSTGRESQL_APPLICATION_SCHEMA, POSTGRESQL_METADATA_SCHEMA, 'BASE TABLE'],
    )
    const applicationTableCount = tableRows.filter(
      (row) => row.table_schema === POSTGRESQL_APPLICATION_SCHEMA,
    ).length
    const metadataTableCount = tableRows.filter(
      (row) => row.table_schema === POSTGRESQL_METADATA_SCHEMA,
    ).length
    let targetState: PostgresqlPreflightReceipt['targetState'] = 'empty'
    if (applicationTableCount > 0 || metadataTableCount > 0) {
      const hasOperationTable = tableRows.some(
        (row) =>
          row.table_schema === POSTGRESQL_METADATA_SCHEMA &&
          row.table_name === 'logical_copy_operations',
      )
      if (!hasOperationTable) {
        throw new PostgresqlPreflightError(
          'postgresql-target-not-empty',
          'PostgreSQL target is non-empty and is not owned by an RFC-349 migration',
        )
      }
      const operationRows = await connection.unsafe(
        `SELECT operation_id FROM "${POSTGRESQL_METADATA_SCHEMA}"."logical_copy_operations" WHERE operation_id = $1`,
        [input.operationId],
      )
      if (operationRows.length !== 1) {
        throw new PostgresqlPreflightError(
          'postgresql-target-not-empty',
          'PostgreSQL target belongs to another migration operation',
        )
      }
      targetState = 'resumable'
    }

    const lockRows = await connection.unsafe(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
      [lockKey],
    )
    locked = lockRows[0]?.acquired === true
    if (!locked) {
      throw new PostgresqlPreflightError(
        'postgresql-advisory-lock-held',
        'another process is probing the PostgreSQL migration target',
      )
    }

    const probeSchema = `rfc349_probe_${input.operationId.slice(4).replaceAll(/[^A-Za-z0-9_]/g, '_')}`
    await connection.unsafe('BEGIN')
    try {
      await connection.unsafe(`CREATE SCHEMA "${probeSchema}"`)
      await connection.unsafe(
        `CREATE TABLE "${probeSchema}"."capability" (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, value TEXT COLLATE "C" NOT NULL)`,
      )
      await connection.unsafe(`INSERT INTO "${probeSchema}"."capability" (value) VALUES ('ok')`)
      await rollback(connection)
    } catch {
      await rollback(connection)
      throw new PostgresqlPreflightError(
        'postgresql-permission-probe-failed',
        'PostgreSQL target lacks schema, table, identity or DML capability',
      )
    }

    return {
      ok: true,
      databaseFingerprint: health.databaseFingerprint,
      serverMajor,
      serverVersionNum,
      serverEncoding: 'UTF8',
      timezone: 'UTC',
      databaseBytes: Number(environment.database_bytes),
      targetState,
      applicationTableCount,
      metadataTableCount,
    }
  } finally {
    if (locked) {
      try {
        await connection.unsafe('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey])
      } catch {
        // Releasing the reserved connection below is the final lock release.
      }
    }
    connection.release()
  }
}

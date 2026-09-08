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
import { loadPostgresqlMigrationHistory } from './postgresqlMigrationHistory'
import {
  planPostgresqlUpgrade,
  postgresqlUpgradeReceipt,
  type PostgresqlCompletedUpgrade,
  type PostgresqlMigrationHistory,
} from './postgresqlMigrationSequence'

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
  readonly metadataTables: readonly string[]
  readonly hasMigrationTable: boolean
  readonly baseline: { readonly contractDigest: string; readonly planDigest: string } | null
  readonly migrations: readonly PostgresqlCompletedUpgrade[]
  readonly contract: {
    readonly digest: string
    readonly activeTableCount: number
    readonly archiveOnlyTableCount: number
  } | null
  readonly activeGenerations: readonly {
    readonly generationId: string
    readonly operationId: string
    readonly contractDigest: string
  }[]
}

export interface PostgresqlActiveGeneration {
  readonly generationId: string
  readonly operationId: string
  readonly expectedContractDigest: string
}

async function targetSnapshot(
  connection: PostgresqlReservedConnection,
  withHistory = false,
): Promise<TargetSnapshot> {
  const tableRows = await connection.unsafe(
    'SELECT table_schema, table_name FROM information_schema.tables ' +
      'WHERE table_schema IN ($1, $2) AND table_type = $3 ORDER BY table_schema, table_name',
    [POSTGRESQL_APPLICATION_SCHEMA, POSTGRESQL_METADATA_SCHEMA, 'BASE TABLE'],
  )
  const applicationTables: string[] = []
  const metadataTables: string[] = []
  let hasMigrationTable = false
  for (const row of tableRows) {
    if (row.table_schema === POSTGRESQL_APPLICATION_SCHEMA) {
      applicationTables.push(String(row.table_name))
    }
    if (row.table_schema === POSTGRESQL_METADATA_SCHEMA && row.table_name === 'schema_migrations') {
      hasMigrationTable = true
    }
    if (row.table_schema === POSTGRESQL_METADATA_SCHEMA) metadataTables.push(String(row.table_name))
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
  let migrations: TargetSnapshot['migrations'] = []
  let contract: TargetSnapshot['contract'] = null
  let activeGenerations: TargetSnapshot['activeGenerations'] = []
  if (withHistory && hasMigrationTable) {
    const rows = await connection.unsafe(
      `SELECT baseline_id, contract_digest, plan_digest FROM "${POSTGRESQL_METADATA_SCHEMA}"."schema_migrations"`,
    )
    migrations = rows.map((row) => ({
      baselineId: String(row.baseline_id),
      contractDigest: String(row.contract_digest),
      planDigest: String(row.plan_digest),
    }))
  }
  if (withHistory && metadataTables.includes('schema_contract')) {
    const rows = await connection.unsafe(
      `SELECT contract_digest, active_table_count, archive_only_table_count FROM "${POSTGRESQL_METADATA_SCHEMA}"."schema_contract" WHERE singleton = TRUE`,
    )
    if (rows.length === 1) {
      contract = {
        digest: String(rows[0]!.contract_digest),
        activeTableCount: Number(rows[0]!.active_table_count),
        archiveOnlyTableCount: Number(rows[0]!.archive_only_table_count),
      }
    }
  }
  if (withHistory && metadataTables.includes('database_generations')) {
    const rows = await connection.unsafe(
      `SELECT generation_id, operation_id, contract_digest FROM "${POSTGRESQL_METADATA_SCHEMA}"."database_generations" WHERE state = 'active' ORDER BY generation_id`,
    )
    activeGenerations = rows.map((row) => ({
      generationId: String(row.generation_id),
      operationId: String(row.operation_id),
      contractDigest: String(row.contract_digest),
    }))
  }
  return {
    applicationTables,
    metadataTables,
    hasMigrationTable,
    baseline,
    migrations,
    contract,
    activeGenerations,
  }
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

function schemaDrift(): never {
  throw new PostgresqlMigrationError(
    'postgresql-schema-drift',
    'PostgreSQL schema metadata or active generation does not match its migration history',
  )
}

function historyState(
  snapshot: TargetSnapshot,
  history: PostgresqlMigrationHistory,
  selectedGeneration: PostgresqlActiveGeneration | undefined,
): 'empty' | PostgresqlMigrationHistory['steps'] {
  if (snapshot.applicationTables.length === 0 && snapshot.metadataTables.length === 0) {
    if (selectedGeneration !== undefined) schemaDrift()
    return 'empty'
  }
  if (snapshot.baseline === null) {
    throw new PostgresqlMigrationError(
      'postgresql-schema-partial',
      'PostgreSQL target contains a partial or unmanaged agent-workflow schema',
    )
  }
  const expectedTables = history.head.plan.statements
    .filter((statement) => statement.kind === 'table')
    .map((statement) => statement.logicalId)
    .sort()
  if (
    snapshot.contract === null ||
    !snapshot.metadataTables.includes('database_generations') ||
    snapshot.contract.activeTableCount !== history.head.plan.activeTableCount ||
    snapshot.contract.archiveOnlyTableCount !== history.head.plan.archiveOnlyTableCount ||
    JSON.stringify([...snapshot.applicationTables].sort()) !== JSON.stringify(expectedTables)
  ) {
    schemaDrift()
  }
  const baseline = snapshot.migrations.filter((row) => row.baselineId === POSTGRESQL_BASELINE_ID)
  const current = snapshot.migrations.filter(
    (row) => row.contractDigest === snapshot.contract!.digest,
  )
  if (baseline.length !== 1 || current.length !== 1) schemaDrift()
  const baselineIdentity = {
    baselineId: POSTGRESQL_BASELINE_ID,
    contractDigest: baseline[0]!.contractDigest,
    planDigest: baseline[0]!.planDigest,
  }
  const currentIdentity = {
    baselineId: POSTGRESQL_BASELINE_ID,
    contractDigest: current[0]!.contractDigest,
    planDigest: current[0]!.planDigest,
  }
  let steps: PostgresqlMigrationHistory['steps']
  try {
    steps = planPostgresqlUpgrade(history, {
      baseline: baselineIdentity,
      current: currentIdentity,
      completed: snapshot.migrations.filter((row) => row.baselineId !== POSTGRESQL_BASELINE_ID),
    })
  } catch {
    schemaDrift()
  }
  if (
    snapshot.activeGenerations.some(
      (generation) => generation.contractDigest !== currentIdentity.contractDigest,
    )
  ) {
    schemaDrift()
  }
  if (selectedGeneration !== undefined) {
    const actual = snapshot.activeGenerations.find(
      (generation) => generation.generationId === selectedGeneration.generationId,
    )
    const expectedVersion = history.versions.findIndex(
      (version) => version.contract.digest === selectedGeneration.expectedContractDigest,
    )
    const currentVersion = history.versions.findIndex(
      (version) => version.contract.digest === currentIdentity.contractDigest,
    )
    if (
      actual?.operationId !== selectedGeneration.operationId ||
      expectedVersion < 0 ||
      expectedVersion > currentVersion
    ) {
      schemaDrift()
    }
  }
  return steps
}

async function advanceActiveGenerations(
  connection: PostgresqlReservedConnection,
  generations: TargetSnapshot['activeGenerations'],
  fromDigest: string,
  toDigest: string,
): Promise<TargetSnapshot['activeGenerations']> {
  if (generations.length === 0) return generations
  const rows = await connection.unsafe(
    `UPDATE "${POSTGRESQL_METADATA_SCHEMA}"."database_generations" SET contract_digest = $1 WHERE state = 'active' AND contract_digest = $2 RETURNING generation_id, operation_id, contract_digest`,
    [toDigest, fromDigest],
  )
  const actual = rows
    .map((row) => ({
      generationId: String(row.generation_id),
      operationId: String(row.operation_id),
      contractDigest: String(row.contract_digest),
    }))
    .sort((left, right) => left.generationId.localeCompare(right.generationId))
  const expected = generations
    .map((generation) => ({ ...generation, contractDigest: toDigest }))
    .sort((left, right) => left.generationId.localeCompare(right.generationId))
  if (JSON.stringify(actual) !== JSON.stringify(expected)) schemaDrift()
  return actual
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
  readonly history?: PostgresqlMigrationHistory
  readonly activeGeneration?: PostgresqlActiveGeneration
  /** Runs after durable schema verification, while the same schema lock is held. */
  readonly afterCommitted?: (receipt: PostgresqlMigrationReceipt) => void | Promise<void>
  readonly now?: () => number
}): Promise<PostgresqlMigrationReceipt> {
  const history =
    input.history ?? (input.plan === undefined ? await loadPostgresqlMigrationHistory() : undefined)
  const plan = input.plan ?? history?.head.plan ?? buildPostgresqlSchemaPlan()
  if (history !== undefined && JSON.stringify(plan) !== JSON.stringify(history.head.plan)) {
    schemaDrift()
  }
  const connection = await input.runtime.providerPool().reserve()
  const lockKeys = [
    'rfc359-schema-upgrade',
    ...new Set(
      (history?.versions.map((version) => version.contract.digest) ?? [plan.contractDigest]).map(
        (digest) => `rfc349-schema:${digest}`,
      ),
    ),
  ]
  const heldLocks: string[] = []
  let transaction = false
  let afterCommitStarted = false
  const finish = async (
    result: PostgresqlMigrationReceipt,
  ): Promise<PostgresqlMigrationReceipt> => {
    afterCommitStarted = true
    await input.afterCommitted?.(result)
    return result
  }
  try {
    // Same ruler problem as `openPostgresqlLogicalTarget`: this session holds ONE
    // transaction across the entire baseline plan, while the pool's server-side
    // budgets (`urlWithServerTimeouts`) are sized for one online request.
    //
    // Both fresh schema preparation and an existing-table index build belong
    // to this boot DDL session. Keep its original statement/idle settings: a
    // plan with hundreds of round-trips can otherwise lose the transaction
    // while the server waits for a paused client.
    //
    // `lock_timeout` deliberately stays at the configured budget: contention on
    // a target that should be exclusively ours is a real fault, worth failing
    // fast on.
    await connection.unsafe(
      "SELECT set_config('statement_timeout', '0', false), " +
        "set_config('idle_in_transaction_session_timeout', '0', false)",
    )
    // New versions share one stable key. Also hold every supported version's
    // published key so a still-running older migrator cannot overlap this DDL.
    for (const lockKey of lockKeys) {
      const lockRows = await connection.unsafe(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
        [lockKey],
      )
      if (lockRows[0]?.acquired !== true) {
        throw new PostgresqlMigrationError(
          'postgresql-schema-lock-held',
          'another process is preparing the PostgreSQL schema',
        )
      }
      heldLocks.push(lockKey)
    }

    const snapshot = await targetSnapshot(connection, history !== undefined)
    const state =
      history === undefined
        ? assertSnapshot(snapshot, plan)
        : historyState(snapshot, history, input.activeGeneration)
    if (state === 'ready' || (Array.isArray(state) && state.length === 0)) {
      return await finish(receipt(plan, false))
    }

    await connection.unsafe('BEGIN')
    transaction = true
    if (state === 'empty') {
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
    } else {
      let generations = snapshot.activeGenerations
      for (const step of state) {
        for (const statement of step.executableStatements) {
          let rows: readonly Record<string, unknown>[]
          try {
            rows = await connection.unsafe(statement.sql)
          } catch {
            throw new PostgresqlMigrationError(
              'postgresql-schema-prepare-failed',
              `PostgreSQL schema preparation failed at ${statement.kind}:${statement.logicalId}`,
            )
          }
          if (
            statement.logicalId === 'advance-contract-row' &&
            (rows.length !== 1 || rows[0]?.contract_digest !== step.to.contractDigest)
          ) {
            schemaDrift()
          }
        }
        const completed = postgresqlUpgradeReceipt(step)
        await connection.unsafe(
          `INSERT INTO "${POSTGRESQL_METADATA_SCHEMA}"."schema_migrations" (baseline_id, contract_digest, plan_digest, applied_at) VALUES ($1, $2, $3, $4)`,
          [
            completed.baselineId,
            completed.contractDigest,
            completed.planDigest,
            Math.trunc((input.now ?? Date.now)()),
          ],
        )
        generations = await advanceActiveGenerations(
          connection,
          generations,
          step.from.contractDigest,
          step.to.contractDigest,
        )
      }
    }
    await connection.unsafe('COMMIT')
    transaction = false
    const committed = await targetSnapshot(connection, history !== undefined)
    if (history === undefined) {
      assertSnapshot(committed, plan)
    } else {
      const pending = historyState(committed, history, input.activeGeneration)
      if (pending === 'empty' || pending.length !== 0) schemaDrift()
    }
    return await finish(receipt(plan, true))
  } catch (error) {
    // A pointer write can fail after a successful COMMIT. Preserve that exact
    // failure; the next call verifies the receipts and repeats only the callback.
    if (afterCommitStarted) throw error
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
    for (const lockKey of heldLocks.reverse()) {
      try {
        await connection.unsafe('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey])
      } catch {
        // Releasing the reserved session below is the final lock release.
      }
    }
    connection.release()
  }
}

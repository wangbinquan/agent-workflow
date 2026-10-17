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
  postgresqlUpgradeStatementSql,
  type PostgresqlCompletedUpgrade,
  type PostgresqlMigrationHistory,
} from './postgresqlMigrationSequence'

export class PostgresqlMigrationError extends Error {
  constructor(
    public readonly code:
      | 'postgresql-schema-lock-held'
      | 'postgresql-schema-partial'
      | 'postgresql-schema-drift'
      | 'postgresql-schema-prepare-failed'
      | 'postgresql-schema-not-current'
      | 'postgresql-generation-conflict',
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
  /** Hosted verify only: the newer, expand-only contract the database already carries. */
  readonly successorContractDigest?: string
}

export type PostgresqlSchemaSnapshot = TargetSnapshot

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
  // The installed schema may precede additive-table edges. Validate its exact
  // historical roster before executing DDL, then validate the head after commit.
  const installed = history.versions.find(
    (version) => version.contract.digest === snapshot.contract?.digest,
  )
  if (installed === undefined) schemaDrift()
  const expectedTables = installed.plan.statements
    .filter((statement) => statement.kind === 'table')
    .map((statement) => statement.logicalId)
    .sort()
  if (
    snapshot.contract === null ||
    !snapshot.metadataTables.includes('database_generations') ||
    snapshot.contract.activeTableCount !== installed.plan.activeTableCount ||
    snapshot.contract.archiveOnlyTableCount !== installed.plan.archiveOnlyTableCount ||
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

/**
 * RFC-370 v3 V7 — a hosted database may already carry a newer release's
 * schema: the release pipeline migrates before the new release takes traffic,
 * while the previous release keeps serving (and may restart) until the switch,
 * or is switched back to. Hosted migrations are expand-only, so that schema
 * still serves this binary when its recorded history extends this binary's own:
 * every upgrade this binary knows after the installed baseline is recorded,
 * further upgrades it does not know follow, the installed contract is one of
 * those, every table this binary uses still exists, and the active generations
 * follow the installed contract.
 *
 * Returns null when the installed contract is one this binary knows (the
 * ordinary history check decides); anything else that is not such a successor
 * is drift.
 */
export function expandOnlySuccessorOf(
  snapshot: PostgresqlSchemaSnapshot,
  history: PostgresqlMigrationHistory,
): { readonly contractDigest: string } | null {
  const installed = snapshot.contract
  const baseline = snapshot.baseline
  if (installed === null || baseline === null) return null
  if (history.versions.some((version) => version.contract.digest === installed.digest)) return null
  const baselineAt = history.versions.findIndex(
    (version) =>
      version.plan.contractDigest === baseline.contractDigest &&
      version.plan.digest === baseline.planDigest,
  )
  if (baselineAt < 0) schemaDrift()
  const upgrades = snapshot.migrations.filter((row) => row.baselineId !== POSTGRESQL_BASELINE_ID)
  if (snapshot.migrations.length - upgrades.length !== 1) schemaDrift()
  const unknown = new Map(upgrades.map((row) => [row.baselineId, row]))
  if (unknown.size !== upgrades.length) schemaDrift()
  for (const step of history.steps.slice(baselineAt)) {
    const expected = postgresqlUpgradeReceipt(step)
    const recorded = unknown.get(expected.baselineId)
    if (
      recorded === undefined ||
      recorded.contractDigest !== expected.contractDigest ||
      recorded.planDigest !== expected.planDigest
    ) {
      schemaDrift()
    }
    unknown.delete(expected.baselineId)
  }
  const knownIds = new Set(history.steps.map((step) => postgresqlUpgradeReceipt(step).baselineId))
  const successor = [...unknown.values()]
  if (
    successor.some((row) => knownIds.has(row.baselineId) || !row.baselineId.startsWith('upgrade:'))
  ) {
    schemaDrift()
  }
  if (!successor.some((row) => row.contractDigest === installed.digest)) schemaDrift()
  const tables = new Set(snapshot.applicationTables)
  if (
    history.head.plan.statements.some(
      (statement) => statement.kind === 'table' && !tables.has(statement.logicalId),
    )
  ) {
    schemaDrift()
  }
  if (
    !snapshot.metadataTables.includes('database_generations') ||
    snapshot.activeGenerations.some((generation) => generation.contractDigest !== installed.digest)
  ) {
    schemaDrift()
  }
  return { contractDigest: installed.digest }
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
    // RFC-370 v3 V7: a newer expand-only schema already serves this binary
    // (a switch back to the previous release); there is nothing to apply.
    const successor = history === undefined ? null : expandOnlySuccessorOf(snapshot, history)
    if (successor !== null)
      return await finish({
        ...receipt(plan, false),
        successorContractDigest: successor.contractDigest,
      })
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
            rows = await connection.unsafe(
              postgresqlUpgradeStatementSql(history!.versions[step.sequence - 1]!, statement),
            )
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

/**
 * RFC-370 M0 — verify without changing the schema. A hosted service never
 * migrates: the release pipeline's migration Job is the single writer of DDL,
 * and a service that finds an empty or older schema refuses to start until it
 * has run. RFC-370 v3 V7: a newer schema that extends this binary's history
 * (`expandOnlySuccessorOf`) serves it too.
 */
export async function verifyPostgresqlSchema(input: {
  readonly runtime: PostgresqlDatabaseRuntime
  readonly history: PostgresqlMigrationHistory
  /** The generation this service writes as; it must be the database's active one. */
  readonly activeGeneration?: Pick<PostgresqlActiveGeneration, 'generationId' | 'operationId'>
}): Promise<PostgresqlMigrationReceipt> {
  const plan = input.history.head.plan
  const connection = await input.runtime.providerPool().reserve()
  try {
    const snapshot = await targetSnapshot(connection, true)
    const successor = expandOnlySuccessorOf(snapshot, input.history)
    const state = successor === null ? historyState(snapshot, input.history, undefined) : []
    if (state === 'empty') {
      throw new PostgresqlMigrationError(
        'postgresql-schema-not-current',
        'the PostgreSQL schema is not installed; run the migration job first',
      )
    }
    if (state.length !== 0) {
      throw new PostgresqlMigrationError(
        'postgresql-schema-not-current',
        `the PostgreSQL schema is ${state.length} migration(s) behind this binary; run the migration job first`,
      )
    }
    const expected = input.activeGeneration
    if (
      expected !== undefined &&
      !snapshot.activeGenerations.some(
        (generation) =>
          generation.generationId === expected.generationId &&
          generation.operationId === expected.operationId,
      )
    ) {
      throw new PostgresqlMigrationError(
        'postgresql-schema-not-current',
        `the PostgreSQL database does not serve generation ${expected.generationId}; run the migration job first`,
      )
    }
    return successor === null
      ? receipt(plan, false)
      : { ...receipt(plan, false), successorContractDigest: successor.contractDigest }
  } finally {
    connection.release()
  }
}

/** The logical source of a hosted installation's copy: a freshly migrated SQLite, not a database. */
const HOSTED_INSTALLATION_SOURCE = 'hosted-installation'

/**
 * RFC-370 M0 — a hosted installation has no SQLite database to cut over from:
 * the release migration Job copies the initial rows itself. Register that copy
 * as the database's logical-copy operation and its generation as the active
 * one, so the generation fence admits the copy and every later business write.
 * Idempotent across Job retries; a database that serves another active
 * generation (another service, or a standalone migration) is refused.
 */
export async function activateHostedPostgresqlGeneration(input: {
  readonly runtime: PostgresqlDatabaseRuntime
  readonly generation: Pick<PostgresqlActiveGeneration, 'generationId' | 'operationId'>
  readonly contractDigest: string
  readonly planDigest: string
  readonly now: number
}): Promise<void> {
  const connection = await input.runtime.providerPool().reserve()
  let transaction = false
  try {
    await connection.unsafe('BEGIN')
    transaction = true
    await connection.unsafe(
      `INSERT INTO "${POSTGRESQL_METADATA_SCHEMA}"."logical_copy_operations" (operation_id, source_generation_id, contract_digest, plan_digest, stage, created_at, updated_at) VALUES ($1, $2, $3, $4, 'activated', $5, $5) ON CONFLICT (operation_id) DO NOTHING`,
      [
        input.generation.operationId,
        HOSTED_INSTALLATION_SOURCE,
        input.contractDigest,
        input.planDigest,
        input.now,
      ],
    )
    await connection.unsafe(
      `INSERT INTO "${POSTGRESQL_METADATA_SCHEMA}"."database_generations" (generation_id, operation_id, source_generation_id, contract_digest, state, activated_at, first_live_write_at) VALUES ($1, $2, $3, $4, 'active', $5, NULL) ON CONFLICT (generation_id) DO NOTHING`,
      [
        input.generation.generationId,
        input.generation.operationId,
        HOSTED_INSTALLATION_SOURCE,
        input.contractDigest,
        input.now,
      ],
    )
    const active = await connection.unsafe(
      `SELECT generation_id, operation_id FROM "${POSTGRESQL_METADATA_SCHEMA}"."database_generations" WHERE state = 'active'`,
    )
    if (
      active.length !== 1 ||
      active[0]?.generation_id !== input.generation.generationId ||
      active[0]?.operation_id !== input.generation.operationId
    ) {
      throw new PostgresqlMigrationError(
        'postgresql-generation-conflict',
        `the PostgreSQL database serves another generation than ${input.generation.generationId}`,
      )
    }
    await connection.unsafe('COMMIT')
    transaction = false
  } catch (error) {
    if (transaction) {
      try {
        await connection.unsafe('ROLLBACK')
      } catch {
        // The original failure wins.
      }
    }
    throw error
  } finally {
    connection.release()
  }
}

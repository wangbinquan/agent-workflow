// RFC-370 v3 V7 (design/RFC-370-crewstation-hosted-deployment/redesign-v2-20261014.md §9):
// a hosted serving instance verifies a newer schema whose recorded history
// extends this binary's own. Regression intent: the release pipeline migrates
// before the new release takes traffic, so the previous release kept serving
// on a schema its verify treated as drift — any restart (or a switch-back) was
// refused. Hosted migrations are expand-only, so that schema serves it; genuine
// drift (a broken history, a missing table, a contract nothing explains) is
// still refused. These cases drive the pure classification with the real
// on-disk history; the real-PostgreSQL cycle is in
// `rfc370-v3-hosted-write-window.integration.test.ts`.
import { buildFrozenEpoch1LogicalSchemaContract as buildLogicalSchemaContract } from '@/platform/persistence/migration/epoch1/contract'
import { describe, expect, test } from 'bun:test'
import { loadPostgresqlMigrationHistory } from '@/platform/persistence/migration/legacy/postgresqlMigrationHistory'
import {
  expandOnlySuccessorOf,
  type PostgresqlSchemaSnapshot,
} from '@/platform/persistence/migration/legacy/postgresqlMigrator'
import { postgresqlUpgradeReceipt } from '@/platform/persistence/migration/legacy/postgresqlMigrationSequence'
import { POSTGRESQL_BASELINE_ID } from '@/platform/persistence/migration/legacy/postgresqlSchema'

const history = await loadPostgresqlMigrationHistory({ headContract: buildLogicalSchemaContract() })
const head = history.head
const headTables = head.plan.statements
  .filter((statement) => statement.kind === 'table')
  .map((statement) => statement.logicalId)
const SUCCESSOR = 'sha256:' + 'e'.repeat(64)
const SUCCESSOR_RECEIPT = {
  baselineId: `upgrade:9999_rfc370_successor:sha256:${'f'.repeat(64)}`,
  contractDigest: SUCCESSOR,
  planDigest: 'sha256:' + '9'.repeat(64),
}

/** A database installed at version `at`, upgraded through this binary's head, then by a successor. */
function successorSnapshot(
  at: number,
  overrides: Partial<PostgresqlSchemaSnapshot> = {},
): PostgresqlSchemaSnapshot {
  const installed = history.versions[at]!
  return {
    applicationTables: [...headTables, 'rfc370_successor_only'],
    metadataTables: ['schema_contract', 'schema_migrations', 'database_generations'],
    hasMigrationTable: true,
    baseline: { contractDigest: installed.plan.contractDigest, planDigest: installed.plan.digest },
    migrations: [
      {
        baselineId: POSTGRESQL_BASELINE_ID,
        contractDigest: installed.plan.contractDigest,
        planDigest: installed.plan.digest,
      },
      ...history.steps.slice(at).map(postgresqlUpgradeReceipt),
      SUCCESSOR_RECEIPT,
    ],
    contract: {
      digest: SUCCESSOR,
      activeTableCount: headTables.length + 1,
      archiveOnlyTableCount: 0,
    },
    activeGenerations: [
      { generationId: 'dbg_cs_test', operationId: 'dbm_cs_test', contractDigest: SUCCESSOR },
    ],
    ...overrides,
  }
}
const atHead = history.versions.length - 1
const drift = (snapshot: PostgresqlSchemaSnapshot) => {
  let error: unknown
  try {
    expandOnlySuccessorOf(snapshot, history)
  } catch (failure) {
    error = failure
  }
  expect(error).toMatchObject({ code: 'postgresql-schema-drift' })
}

describe('RFC-370 v3 hosted verify: expand-only successor schemas', () => {
  test('a successor installed after this binary head serves it', () => {
    expect(expandOnlySuccessorOf(successorSnapshot(atHead), history)).toEqual({
      contractDigest: SUCCESSOR,
    })
  })

  test('a database installed at an older version accepts when every known upgrade is recorded', () => {
    expect(expandOnlySuccessorOf(successorSnapshot(0), history)).toEqual({
      contractDigest: SUCCESSOR,
    })
    // One known upgrade missing: the history does not extend this binary's.
    const snapshot = successorSnapshot(0)
    drift({
      ...snapshot,
      migrations: snapshot.migrations.filter(
        (row) => row.baselineId !== postgresqlUpgradeReceipt(history.steps[0]!).baselineId,
      ),
    })
    // A known upgrade recorded with other digests is drift too.
    drift({
      ...snapshot,
      migrations: snapshot.migrations.map((row) =>
        row.baselineId === postgresqlUpgradeReceipt(history.steps[0]!).baselineId
          ? { ...row, planDigest: 'sha256:' + '0'.repeat(64) }
          : row,
      ),
    })
  })

  test('a contract this binary knows is left to the ordinary history check', () => {
    expect(
      expandOnlySuccessorOf(
        successorSnapshot(atHead, {
          contract: { digest: head.contract.digest, activeTableCount: 0, archiveOnlyTableCount: 0 },
        }),
        history,
      ),
    ).toBeNull()
    expect(expandOnlySuccessorOf(successorSnapshot(atHead, { contract: null }), history)).toBeNull()
    expect(expandOnlySuccessorOf(successorSnapshot(atHead, { baseline: null }), history)).toBeNull()
  })

  test('an unknown baseline, or a second one, is drift', () => {
    drift(
      successorSnapshot(atHead, {
        baseline: { contractDigest: SUCCESSOR, planDigest: 'sha256:' + '1'.repeat(64) },
      }),
    )
    const snapshot = successorSnapshot(atHead)
    drift({ ...snapshot, migrations: [snapshot.migrations[0]!, ...snapshot.migrations] })
  })

  test('an unknown contract that no recorded successor upgrade explains is drift', () => {
    const snapshot = successorSnapshot(atHead)
    drift({
      ...snapshot,
      migrations: snapshot.migrations.filter((row) => row !== SUCCESSOR_RECEIPT),
    })
    drift({ ...snapshot, contract: { ...snapshot.contract!, digest: 'sha256:' + '2'.repeat(64) } })
    drift({
      ...snapshot,
      migrations: snapshot.migrations.map((row) =>
        row === SUCCESSOR_RECEIPT ? { ...row, baselineId: 'baseline-2' } : row,
      ),
    })
  })

  test('a successor upgrade that reuses one of this binary receipts is drift', () => {
    const known = postgresqlUpgradeReceipt(history.steps[0]!)
    const snapshot = successorSnapshot(atHead)
    drift({ ...snapshot, migrations: [...snapshot.migrations, known] })
  })

  test('a missing table of this binary is not expand-only', () => {
    drift(
      successorSnapshot(atHead, {
        applicationTables: headTables.filter((table) => table !== 'hosted_execution_control'),
      }),
    )
  })

  test('active generations must follow the installed successor contract', () => {
    drift(
      successorSnapshot(atHead, {
        activeGenerations: [
          {
            generationId: 'dbg_cs_test',
            operationId: 'dbm_cs_test',
            contractDigest: head.contract.digest,
          },
        ],
      }),
    )
    drift(successorSnapshot(atHead, { metadataTables: ['schema_contract', 'schema_migrations'] }))
  })
})

describe('RFC-370 v3 V7 — the migration Job of the previous release', () => {
  test('a switch back to the previous release applies nothing over an expand-only successor', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(
      new URL(
        '../src/platform/persistence/migration/legacy/postgresqlMigrator.ts',
        import.meta.url,
      ),
      'utf8',
    )
    const migrate = source.slice(source.indexOf('export async function migratePostgresqlSchema('))
    // The successor classification precedes the history state machine, and
    // its outcome is an un-applied receipt naming the newer contract.
    const successorAt = migrate.indexOf('expandOnlySuccessorOf(snapshot, history)')
    expect(successorAt).toBeGreaterThan(0)
    expect(successorAt).toBeLessThan(migrate.indexOf('historyState(snapshot, history'))
    expect(migrate).toContain('successorContractDigest: successor.contractDigest')
  })
})

// RFC-395 I-a: historical copy/restore contracts must not replace the binary head used to check migration history.
import { beforeAll, describe, expect, test } from 'bun:test'
import { buildLogicalSchemaContract } from '@/bootstrap/persistenceSchema'
import {
  loadPostgresqlMigrationHistory,
  verifyPostgresqlMigrationHistory,
} from '@/platform/persistence/postgresqlMigrationHistory'
import type { PostgresqlMigrationHistory } from '@/platform/persistence/postgresqlMigrationSequence'
import { openPostgresqlLogicalTarget } from '@/platform/persistence/postgresqlLogicalTarget'
import {
  resolveLogicalDatabaseRestoreSourceContract,
  LogicalDatabaseRestoreError,
} from '@/platform/persistence/logicalDatabaseRestore'
import {
  createPostgresqlDatabaseRuntime,
  type PostgresqlReservedConnection,
  type SqlRows,
} from '@/platform/persistence/postgresqlRuntime'

const headContract = buildLogicalSchemaContract()
let history: PostgresqlMigrationHistory
beforeAll(async () => {
  history = await loadPostgresqlMigrationHistory({ headContract })
}, 60_000)

function targetRuntime() {
  const queries: string[] = []
  let releases = 0
  const connection: PostgresqlReservedConnection = {
    unsafe(query): SqlRows {
      queries.push(query)
      const rows = query.includes('pg_try_advisory_lock') ? [{ acquired: true }] : []
      return Object.assign(Promise.resolve(rows), {
        async values() {
          return rows.map(Object.values)
        },
      })
    },
    release() {
      releases += 1
    },
  }
  const runtime = createPostgresqlDatabaseRuntime({
    generationId: 'dbg_rfc395_historical_target',
    config: {
      provider: 'postgresql',
      urlEnv: 'RFC395_DATABASE_URL',
      poolMax: 1,
      connectTimeoutMs: 10_000,
      statementTimeoutMs: 60_000,
      idleTimeoutMs: 30_000,
    },
    env: { RFC395_DATABASE_URL: 'postgresql://fixture:fixture@localhost/fixture' },
    poolFactory: () => ({
      async reserve() {
        return connection
      },
      unsafe: connection.unsafe,
      async close() {},
    }),
  })
  return { runtime, queries, releases: () => releases }
}

describe('RFC-395 I-a binary head and historical operation contracts', () => {
  test('opens an exact historical target after checking the complete binary history', async () => {
    expect(history.root.contract.digest).not.toBe(headContract.digest)
    const fixture = targetRuntime()
    try {
      const receipt = await verifyPostgresqlMigrationHistory({
        headContract,
        plan: history.root.plan,
      })
      expect(receipt.contractDigest).toBe(history.root.contract.digest)
      const target = await openPostgresqlLogicalTarget({
        headContract,
        contract: history.root.contract,
        plan: history.root.plan,
        runtime: fixture.runtime,
        operationId: 'dbm_rfc395_historical',
        sourceGenerationId: 'dbg_rfc395_source',
      })
      await target.close()
      expect(fixture.queries.some((query) => query.includes('pg_try_advisory_lock'))).toBe(true)
      expect(fixture.releases()).toBe(1)
    } finally {
      await fixture.runtime.close()
    }
  })

  test('resolves the published historical source against the complete binary head', async () => {
    expect(
      await resolveLogicalDatabaseRestoreSourceContract({
        headContract,
        sourceSchemaDigest: history.root.contract.digest,
        targetContract: headContract,
      }),
    ).toEqual(history.root.contract)
  })

  test('preserves the explicit non-head restore target error and the same-contract fixture path', async () => {
    const result = resolveLogicalDatabaseRestoreSourceContract({
      headContract,
      sourceSchemaDigest: headContract.digest,
      targetContract: history.root.contract,
    })
    await expect(result).rejects.toBeInstanceOf(LogicalDatabaseRestoreError)
    await expect(result).rejects.toMatchObject({
      code: 'logical-restore-artifact-corrupt',
      message:
        'logical database restore artifact is corrupt: restore target differs from the complete current schema head',
    })
    expect(
      await resolveLogicalDatabaseRestoreSourceContract({
        headContract,
        sourceSchemaDigest: history.root.contract.digest,
        targetContract: history.root.contract,
      }),
    ).toBe(history.root.contract)
  })

  test('keeps target contract/plan mismatches separate from migration history verification', async () => {
    const fixture = targetRuntime()
    try {
      await expect(
        openPostgresqlLogicalTarget({
          headContract,
          contract: history.root.contract,
          plan: history.head.plan,
          runtime: fixture.runtime,
          operationId: 'dbm_rfc395_mismatch',
          sourceGenerationId: 'dbg_rfc395_source',
        }),
      ).rejects.toMatchObject({
        code: 'postgresql-target-operation-mismatch',
        message: 'PostgreSQL target plan and logical contract differ',
      })
      expect(fixture.queries).toEqual([])
    } finally {
      await fixture.runtime.close()
    }
  })

  test('default historical verification reuses the runtime history without projecting the head again', async () => {
    let projections = 0
    const observedHead = new Proxy(headContract, {
      get(target, property, receiver) {
        if (property === 'tables') projections += 1
        return Reflect.get(target, property, receiver)
      },
    })
    const cached = await loadPostgresqlMigrationHistory({ headContract: observedHead })
    expect(projections).toBeGreaterThan(0)
    const before = projections
    const receipt = await verifyPostgresqlMigrationHistory({
      headContract: observedHead,
      plan: cached.root.plan,
    })
    expect(receipt.contractDigest).toBe(cached.root.contract.digest)
    expect(projections).toBe(before)
    expect(await loadPostgresqlMigrationHistory({ headContract: observedHead })).toBe(cached)
  }, 60_000)
})

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
import { createPostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'

const headContract = buildLogicalSchemaContract()
let history: PostgresqlMigrationHistory
beforeAll(async () => {
  history = await loadPostgresqlMigrationHistory({ headContract })
}, 60_000)

// A real runtime: Bun.SQL connects lazily, and nothing listens on this port, so any
// attempt to reach the database would surface as a connection error instead of the
// contract error asserted below. Opening a historical target over a real database is
// covered by the RFC-359 T19h old-copy upgrade and old-backup restore cases.
function unreachableRuntime() {
  return createPostgresqlDatabaseRuntime({
    generationId: 'dbg_rfc395_unreachable',
    config: {
      provider: 'postgresql',
      urlEnv: 'RFC395_DATABASE_URL',
      poolMax: 1,
      connectTimeoutMs: 1_000,
      statementTimeoutMs: 60_000,
      idleTimeoutMs: 30_000,
    },
    env: { RFC395_DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1:1/fixture' },
  })
}

describe('RFC-395 I-a binary head and historical operation contracts', () => {
  test('verifies an exact historical plan against the complete binary history', async () => {
    expect(history.root.contract.digest).not.toBe(headContract.digest)
    const receipt = await verifyPostgresqlMigrationHistory({
      headContract,
      plan: history.root.plan,
    })
    expect(receipt.contractDigest).toBe(history.root.contract.digest)
    expect(receipt.planDigest).toBe(history.root.plan.digest)
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
    const runtime = unreachableRuntime()
    try {
      await expect(
        openPostgresqlLogicalTarget({
          headContract,
          contract: history.root.contract,
          plan: history.head.plan,
          runtime,
          operationId: 'dbm_rfc395_mismatch',
          sourceGenerationId: 'dbg_rfc395_source',
        }),
      ).rejects.toMatchObject({
        code: 'postgresql-target-operation-mismatch',
        message: 'PostgreSQL target plan and logical contract differ',
      })
    } finally {
      await runtime.close()
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

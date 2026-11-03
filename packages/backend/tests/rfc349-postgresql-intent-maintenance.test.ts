import { intentApplyArtifactCodecs } from '@/modules/intent/infrastructure/intentApplyArtifactCodec'
import { reencodeIntentApplyArtifacts } from '@/modules/intent/infrastructure/migration/applyJournalRule'
import { createEpoch2PostgresqlMetadata } from './helpers/epoch2PostgresqlMetadata'
import { createAtomicApplyRecovery } from '@/platform/atomic-apply/convergence'
import { createIntentApplyRecoveryScene } from '@/modules/intent/infrastructure/intentApplyRecovery'
import { withNativeTransactions } from './helpers/nativeTransactions'
import { describe, expect, test } from 'bun:test'

import { decodeIntentApplyRecoveryArtifacts } from '@/modules/intent/infrastructure/intentApplyArtifactLifecycle'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
  PostgresqlReservedConnection,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'

function rows(
  input: {
    readonly objects?: readonly Record<string, unknown>[]
    readonly values?: readonly (readonly unknown[])[]
    readonly count?: number
  } = {},
): SqlRows {
  const objects = [...(input.objects ?? [])] as Array<Record<string, unknown>> & {
    count?: number
  }
  objects.count = input.count ?? objects.length
  return Object.assign(Promise.resolve(objects), {
    async values() {
      return input.values ?? []
    },
  })
}

/**
 * RFC-401 T4：恢复先接管持久 claim 再动手。`claim` 缺省表示这条 journal 没有 claim 行（旧版本留下的记录，可直接接管）；
 * 给出时是另一个进程仍持有的未过期 claim（`claim_expires_at` 在 now 之后），接管的条件更新得到 0 行。
 */
function fixture(updatedAt: number, claim?: { readonly expiresAt: number }) {
  const statements: string[] = []
  const epoch2Metadata = createEpoch2PostgresqlMetadata()
  const execute = (sql: string): SqlRows => {
    statements.push(sql)
    const metadata = epoch2Metadata(sql)
    if (metadata) return metadata
    const normalized = sql.trim().toLowerCase()
    if (/^(begin|commit|rollback)$/.test(normalized)) return rows()
    if (sql.includes('generations')) {
      return rows({
        objects: [{ generation_id: 'dbg_intent_maintenance_pg' }],
        values: [['dbg_intent_maintenance_pg']],
        count: 1,
      })
    }
    if (normalized.startsWith('select') && normalized.includes('intent_apply_journal')) {
      return rows({
        values: [
          [
            'journal-1',
            'session-1',
            'mutation-1',
            'draft-1',
            'hash-1',
            'prepared',
            intentApplyArtifactCodecs.encode([]),
            null,
            null,
            100,
            updatedAt,
          ],
        ],
      })
    }
    if (normalized.startsWith('update') && normalized.includes('intent_apply_journal')) {
      return rows({ values: [['journal-1']], count: 1 })
    }
    if (normalized.includes('atomic_apply_claims')) {
      if (normalized.startsWith('select'))
        return rows({
          values:
            claim === undefined
              ? []
              : [['intent', 'journal-1', 'other-daemon', 1, claim.expiresAt, 'none', 100, 100]],
        })
      // 没有 claim 行时 insert 落下；有未过期 claim 时 insert 冲突、条件更新 0 行。写回的续租以接管令牌为条件。
      if (claim !== undefined) return rows({ values: [], count: 0 })
      return rows({ values: [['journal-1']], count: 1 })
    }
    throw new Error(`unexpected PostgreSQL intent maintenance query: ${sql}`)
  }
  const connection: PostgresqlReservedConnection = withNativeTransactions({
    unsafe: execute,
    release() {},
  })
  const pool: PostgresqlPool = {
    async reserve() {
      return connection
    },
    unsafe: execute,
    async close() {},
  }
  const runtime: PostgresqlDatabaseRuntime = {
    provider: 'postgresql',
    generationId: 'dbg_intent_maintenance_pg',
    async health() {
      throw new Error('not used')
    },
    async readiness() {
      throw new Error('not used')
    },
    async acquireMigrationAdvisoryLock() {
      throw new Error('not used')
    },
    providerPool: () => pool,
    async close() {},
  }
  return { db: createPostgresqlDatabaseClient(runtime), statements }
}

const log = Object.freeze({ info() {}, warn() {}, error() {}, debug() {} }) as never

describe('RFC-349 PostgreSQL Intent apply maintenance', () => {
  test('recovery decoder accepts native PostgreSQL and versioned migrated artifacts', () => {
    expect(
      decodeIntentApplyRecoveryArtifacts(
        intentApplyArtifactCodecs.encode([
          {
            kind: 'skill-version-stage',
            skillId: 'skill-1',
            operationId: 'operation-1',
            version: 2,
            stagingDirectory: '/app/skills/skill-1/files.op-operation-1.staged',
            versionDirectory: '/app/skills/skill-1/versions/2',
          },
        ]),
      ),
    ).toEqual([
      {
        kind: 'skill-version-stage',
        skillId: 'skill-1',
        operationId: 'operation-1',
        version: 2,
        stagingDirectory: '/app/skills/skill-1/files.op-operation-1.staged',
        versionDirectory: '/app/skills/skill-1/versions/2',
      },
    ])
    expect(
      decodeIntentApplyRecoveryArtifacts(
        reencodeIntentApplyArtifacts(JSON.stringify({ version: 1, artifacts: [] })),
      ),
    ).toEqual([])
  })

  test('stale prepared journals compensate and settle through PostgreSQL CAS', async () => {
    const fake = fixture(100)
    let compensations = 0
    const convergence = createAtomicApplyRecovery([
      createIntentApplyRecoveryScene({
        db: fake.db,
        artifacts: {
          async compensate() {
            compensations += 1
          },
          async rollForward() {
            throw new Error('prepared journal must not roll forward')
          },
        },
        now: () => 1_000_000,
        log,
      }),
    ])

    const result = await convergence.converge({ intent: [] })
    expect(result).toEqual({ failed: 1, rolledForward: 0 })
    expect(compensations).toBe(0)
    expect(
      fake.statements.some(
        (statement) =>
          statement.toLowerCase().includes('update "agent_workflow"."intent_apply_journal"') &&
          statement.toLowerCase().includes('returning "id"'),
      ),
    ).toBe(true)
  })

  test("a journal held by another process's live claim is never reaped", async () => {
    // RFC-401 T4：此前以「updatedAt 在十分钟内」判定在途；现在由持久 claim 判定——租约未过期，接管失败，不补偿、不写回。
    const fake = fixture(100, { expiresAt: 1_060_000 })
    const convergence = createAtomicApplyRecovery([
      createIntentApplyRecoveryScene({
        db: fake.db,
        artifacts: {
          async compensate() {
            throw new Error('held journal must not compensate')
          },
          async rollForward() {
            throw new Error('held journal must not roll forward')
          },
        },
        now: () => 1_000_000,
        log,
      }),
    ])
    await expect(convergence.converge({ intent: [] })).resolves.toEqual({
      failed: 0,
      rolledForward: 0,
    })
    expect(
      fake.statements.some(
        (statement) =>
          statement.toLowerCase().startsWith('update') &&
          statement.toLowerCase().includes('intent_apply_journal'),
      ),
    ).toBe(false)
  })

  test('active journals are never reaped by maintenance', async () => {
    const fake = fixture(999_999)
    const convergence = createAtomicApplyRecovery([
      createIntentApplyRecoveryScene({
        db: fake.db,
        artifacts: {
          async compensate() {
            throw new Error('active journal must not compensate')
          },
          async rollForward() {
            throw new Error('active journal must not roll forward')
          },
        },
        now: () => 1_000_000,
        log,
      }),
    ])
    await expect(convergence.converge({ intent: ['journal-1'] })).resolves.toEqual({
      failed: 0,
      rolledForward: 0,
    })
    expect(fake.statements.some((statement) => statement.toLowerCase().startsWith('update'))).toBe(
      false,
    )
  })
})

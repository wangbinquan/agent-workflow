// CI 37168434612 / Ubuntu9: fan-out startup encountered PostgreSQL serialization
// conflicts. The read-only host graph must remain coherent without joining the
// write transactions' SSI dependency graph. Exercise the actual persistence
// factory and DatabaseSession; keep the original RFC-185 fan-out tests intact.
import { describe, expect, test } from 'bun:test'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import {
  createPostgresqlDatabaseRuntime,
  type PostgresqlPool,
} from '@/platform/persistence/postgresqlRuntime'
import { withNativeTransactions } from './helpers/nativeTransactions'

import {
  createWorkgroupTurnsPersistence,
  type WorkgroupHostLedgerParticipantFactory,
} from '@/modules/resource-catalog/infrastructure/workgroupTurnsOperations'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'

type HostLedger = ReturnType<WorkgroupHostLedgerParticipantFactory['inTransaction']>
type HostSnapshot = Awaited<ReturnType<HostLedger['load']>>

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((ready) => {
    resolve = ready
  })
  return { promise, resolve }
}

function fixture(snapshot: HostSnapshot = null) {
  const queries: string[] = []
  const participants: unknown[] = []
  let transactions = 0
  let transactionError: unknown
  let loadError: unknown
  let transactionHandle: unknown
  let settled: ReturnType<typeof deferred> | undefined
  const entered = deferred()
  const connection = withNativeTransactions({
    unsafe(statement: string) {
      if (/^set transaction/i.test(statement)) queries.push(statement.toUpperCase())
      const rows = statement.includes('"workgroup_member_cursors"')
        ? [
            {
              taskId: 'task',
              memberId: 'human',
              lastConsumedMessageId: 'message-last',
              updatedAt: 1,
            },
          ]
        : []
      return Object.assign(Promise.resolve(rows), {
        async values() {
          return rows.map((row) => Object.values(row))
        },
      })
    },
    release() {},
  })
  const begin = connection.begin.bind(connection)
  connection.begin = async (body) => {
    transactions += 1
    if (transactionError !== undefined) throw transactionError
    return await begin(async (client) => {
      const value = await body(client)
      entered.resolve()
      if (settled !== undefined) await settled.promise
      return value
    })
  }
  const pool: PostgresqlPool = {
    unsafe: connection.unsafe,
    reserve: async () => connection,
    close: async () => {},
  }
  const runtime = createPostgresqlDatabaseRuntime({
    generationId: 'snapshot_fixture',
    config: {
      provider: 'postgresql',
      urlEnv: 'SNAPSHOT_FIXTURE_URL',
      poolMax: 1,
      connectTimeoutMs: 1000,
      statementTimeoutMs: 1000,
      idleTimeoutMs: 1000,
    },
    env: { SNAPSHOT_FIXTURE_URL: 'postgresql://fixture@localhost/snapshot' },
    poolFactory: () => pool,
  })
  const db = createPostgresqlDatabaseClient(runtime)
  const persistence = createWorkgroupTurnsPersistence({
    db,
    hostLedgerFactory: {
      inTransaction(transaction) {
        transactionHandle = transaction
        participants.push(transaction)
        return {
          async load() {
            if (loadError !== undefined) throw loadError
            return snapshot
          },
          async apply() {
            return { committed: true, mintedRuns: [], failedRunIds: [] }
          },
        }
      },
    },
    clarifyAskGate: { allowed: async () => false },
  })
  return {
    db,
    get tx() {
      return transactionHandle
    },
    persistence,
    queries,
    participants,
    entered,
    transactions: () => transactions,
    rejectTransaction: (error: unknown) => {
      transactionError = error
    },
    rejectLoad: (error: unknown) => {
      loadError = error
    },
    holdCompletion: () => {
      settled = deferred()
      return settled
    },
  }
}

describe('RFC-370 workgroup read snapshot CI repair', () => {
  test('missing host is read in one read-only repeatable snapshot', async () => {
    const f = fixture()
    expect(await f.persistence.load('task')).toBeNull()
    expect(f.transactions()).toBe(1)
    expect(f.queries).toEqual(['SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'])
    expect(f.participants).toEqual([f.tx])
  })

  test('the complete valid host graph and cursors are loaded on that same transaction', async () => {
    const f = fixture({
      workgroupConfigJson: JSON.stringify({
        workgroupId: 'group',
        workgroupName: 'read snapshot',
        mode: 'leader_worker',
        leaderMemberId: 'human',
        switches: { shareOutputs: true, directMessages: false, blackboard: false },
        maxRounds: 3,
        completionGate: false,
        instructions: 'preserve the graph',
        goal: 'read consistently',
        members: [
          {
            id: 'human',
            memberType: 'human',
            agentId: null,
            agentName: null,
            userId: 'user',
            displayName: 'human',
            roleDesc: 'review',
          },
        ],
      }),
      hostRuns: [],
      leaderClarifyParked: false,
    })
    const result = await f.persistence.load('task')
    expect(result).not.toBeNull()
    expect(result!.taskId).toBe('task')
    expect(result!.config.goal).toBe('read consistently')
    expect(result!.state.gateStatus).toBe('idle')
    expect(result!.assignments).toEqual([])
    expect(result!.messages).toEqual([])
    expect(result!.memberAgents).toEqual([])
    expect(result!.hostRuns).toEqual([])
    expect(result!.leaderClarifyParked).toBe(false)
    expect(result!.cursors.get('human')).toBe('message-last')
    expect(f.transactions()).toBe(1)
    expect(f.participants).toEqual([f.tx])
    expect(f.queries).toEqual(['SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'])
  })

  test('snapshot delivery waits for the original transaction completion', async () => {
    const f = fixture()
    const settled = f.holdCompletion()
    let delivered = false
    const pending = f.persistence.load('task').then((value) => {
      delivered = true
      return value
    })
    await f.entered.promise
    expect(delivered).toBe(false)
    settled.resolve()
    expect(await pending).toBeNull()
    expect(delivered).toBe(true)
  })

  test('nested reads reuse the existing serializable frame and preserve its isolation', async () => {
    const f = fixture()
    await databaseSessionFor(f.db).serializable(async (transaction) => {
      expect(await f.persistence.load('task')).toBeNull()
      expect<unknown>(transaction).toBe(f.tx)
    })
    expect(f.transactions()).toBe(1)
    expect(f.queries).toEqual(['SET TRANSACTION ISOLATION LEVEL SERIALIZABLE'])
    expect(f.participants).toEqual([f.tx])
  })

  test('commit keeps the original serializable transaction', async () => {
    const f = fixture()
    expect(await f.persistence.commit({ taskId: 'task', operations: [] })).toEqual({
      committed: true,
      mintedRuns: [],
      skippedOperationKeys: [],
      failedRunIds: [],
    })
    expect(f.transactions()).toBe(1)
    expect(f.queries).toEqual(['SET TRANSACTION ISOLATION LEVEL SERIALIZABLE'])
    expect(f.participants).toEqual([f.tx])
  })

  test('load and non-serialization commit errors retain their original identity', async () => {
    const boom = new Error('original database error')
    const read = fixture()
    read.rejectLoad(boom)
    await expect(read.persistence.load('task')).rejects.toBe(boom)
    expect(read.transactions()).toBe(1)
    const write = fixture()
    write.rejectTransaction(boom)
    await expect(write.persistence.commit({ taskId: 'task', operations: [] })).rejects.toBe(boom)
    expect(write.transactions()).toBe(1)
  })
})

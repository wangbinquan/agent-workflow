// CI37175515154 / Ubuntu9: sibling host-ledger write transactions encountered
// SSI contention. These cases use the production persistence factory and real
// DatabaseSession. The PG fixture controls protocol ACKs; it is not a real PG.
import { describe, expect, test } from 'bun:test'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core'

import { createInMemoryDb } from '@/db/client'
import type { ProviderNeutralDatabase } from '@/db/query'
import { holdsExplicitTransaction } from '@/db/transactionScope'
import {
  createWorkgroupTurnsPersistence,
  type WorkgroupHostLedgerParticipantFactory,
} from '@/modules/resource-catalog/infrastructure/workgroupTurnsOperations'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { POSTGRESQL_SERIALIZATION_ATTEMPTS } from '@/platform/persistence/postgresqlSerializationRetry'
import { MIGRATIONS } from './migration-freeze'

type HostLedger = ReturnType<WorkgroupHostLedgerParticipantFactory['inTransaction']>
type Apply = HostLedger['apply']
type ApplyReceipt = Awaited<ReturnType<Apply>>

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((ready) => {
    resolve = ready
  })
  return { promise, resolve }
}

async function microtasks() {
  for (let n = 0; n < 8; n += 1) await Promise.resolve()
}

function committed() {
  return { committed: true as const, mintedRuns: [], skippedOperationKeys: [], failedRunIds: [] }
}

function operation(key: string) {
  return { kind: 'fail-host-run' as const, operationKey: key, runId: key, message: key }
}

function persistenceOn(db: ProviderNeutralDatabase, apply: Apply = async () => committed()) {
  const participants: unknown[] = []
  const persistence = createWorkgroupTurnsPersistence({
    db,
    hostLedgerFactory: {
      inTransaction(transaction) {
        participants.push(transaction)
        return { load: async () => null, apply }
      },
    },
    clarifyAskGate: { allowed: async () => false },
  })
  return { persistence, participants }
}

function postgresqlFixture() {
  const queries: string[] = []
  const dialect = new PgDialect()
  let attempts = 0
  let afterBody: (attempt: number) => Promise<void> = async () => undefined
  const transactionHandle = () => ({
    async run(query: SQL) {
      queries.push(dialect.sqlToQuery(query).sql)
    },
  })
  const db = {
    $provider: 'postgresql' as const,
    async transaction<T>(
      body: (transaction: ReturnType<typeof transactionHandle>) => Promise<T>,
    ): Promise<T> {
      const attempt = ++attempts
      const result = await body(transactionHandle())
      await afterBody(attempt)
      return result
    },
  } as unknown as ProviderNeutralDatabase
  return {
    db,
    queries,
    attempts: () => attempts,
    afterBody: (hook: typeof afterBody) => {
      afterBody = hook
    },
  }
}

function sqliteFixture() {
  const db = createInMemoryDb(MIGRATIONS)
  const queries: string[] = []
  const dialect = new SQLiteSyncDialect()
  const run = db.run.bind(db)
  // Keep the actual client identity used by transactionScope and writerLease.
  Object.defineProperty(db, 'run', {
    configurable: true,
    value: (query: SQL) => {
      queries.push(dialect.sqlToQuery(query).sql)
      return run(query)
    },
  })
  return {
    db,
    queries,
    attempts: () => queries.filter((query) => query === 'BEGIN IMMEDIATE').length,
  }
}

describe('RFC-370 short workgroup commit queue', () => {
  test('same client/task factories wait for the full transaction ACK in FIFO order', async () => {
    const f = postgresqlFixture()
    const entered = deferred()
    const release = deferred()
    f.afterBody(async (attempt) => {
      if (attempt === 1) {
        entered.resolve()
        await release.promise
      }
    })
    const order: string[] = []
    const apply: Apply = async (input) => {
      order.push(input.operations[0]!.operationKey)
      return committed()
    }
    const a = persistenceOn(f.db, apply).persistence
    const b = persistenceOn(f.db, apply).persistence
    let firstSettled = false
    const first = a.commit({ taskId: 'task', operations: [operation('one')] }).then((value) => {
      firstSettled = true
      return value
    })
    await entered.promise
    const second = b.commit({ taskId: 'task', operations: [operation('two')] })
    const third = a.commit({ taskId: 'task', operations: [operation('three')] })
    try {
      await microtasks()
      expect(firstSettled).toBe(false)
      expect(f.attempts()).toBe(1)
      expect(order).toEqual(['one'])
      // Different task/client and snapshot load never join this commit queue.
      expect(await b.commit({ taskId: 'other', operations: [] })).toEqual(committed())
      const other = postgresqlFixture()
      expect(
        await persistenceOn(other.db).persistence.commit({ taskId: 'task', operations: [] }),
      ).toEqual(committed())
      expect(await b.load('task')).toBeNull()
      expect(f.attempts()).toBe(3)
      expect(f.queries).toEqual([
        'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE',
        'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE',
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      ])
      expect(order).toEqual(['one'])
    } finally {
      release.resolve()
    }
    expect(await Promise.all([first, second, third])).toEqual([
      committed(),
      committed(),
      committed(),
    ])
    expect(order).toEqual(['one', 'two', 'three'])
    expect(f.attempts()).toBe(5)
    // A later idle turn is still usable after the former tail has settled.
    expect(await a.commit({ taskId: 'task', operations: [] })).toEqual(committed())
    expect(f.attempts()).toBe(6)
  })

  for (const provider of ['postgresql', 'sqlite'] as const) {
    for (const nestedFactory of ['same', 'another'] as const) {
      test(`${provider}: ${nestedFactory} factory nested commits reuse the outer transaction`, async () => {
        const f = provider === 'postgresql' ? postgresqlFixture() : sqliteFixture()
        const entered = deferred()
        const release = deferred()
        const another = persistenceOn(f.db)
        const a = persistenceOn(f.db, async () => {
          expect(holdsExplicitTransaction(f.db)).toBe(true)
          const nested = nestedFactory === 'same' ? a.persistence : another.persistence
          expect(await nested.commit({ taskId: 'task', operations: [] })).toEqual(committed())
          expect(await nested.commit({ taskId: 'other', operations: [] })).toEqual(committed())
          entered.resolve()
          await release.promise
          return committed()
        })
        const outer = a.persistence.commit({ taskId: 'task', operations: [operation('outer')] })
        await entered.promise
        expect(holdsExplicitTransaction(f.db)).toBe(false)
        const external = another.persistence.commit({ taskId: 'task', operations: [] })
        try {
          await microtasks()
          expect(f.attempts()).toBe(1)
          expect(new Set([...a.participants, ...another.participants]).size).toBe(1)
        } finally {
          release.resolve()
        }
        expect(await Promise.all([outer, external])).toEqual([committed(), committed()])
        expect(f.attempts()).toBe(2)
        if (provider === 'sqlite') {
          expect(f.queries).toEqual(['BEGIN IMMEDIATE', 'COMMIT', 'BEGIN IMMEDIATE', 'COMMIT'])
        }
      })
    }
  }

  test('SQLite outer writer completes nested commit while an external queued commit waits for its lease', async () => {
    const f = sqliteFixture()
    const entered = deferred()
    const continueOuter = deferred()
    const innerDone = deferred()
    const releaseOuter = deferred()
    const p = persistenceOn(f.db).persistence
    const outer = databaseSessionFor(f.db).transaction(async () => {
      entered.resolve()
      await continueOuter.promise
      expect(await p.commit({ taskId: 'task', operations: [] })).toEqual(committed())
      innerDone.resolve()
      await releaseOuter.promise
    })
    await entered.promise
    let externalSettled = false
    const external = p.commit({ taskId: 'task', operations: [] }).then((value) => {
      externalSettled = true
      return value
    })
    try {
      await microtasks()
      expect(f.attempts()).toBe(1)
      continueOuter.resolve()
      await innerDone.promise
      expect(externalSettled).toBe(false)
      expect(f.attempts()).toBe(1)
    } finally {
      continueOuter.resolve()
      releaseOuter.resolve()
    }
    await outer
    expect(await external).toEqual(committed())
    expect(f.queries).toEqual(['BEGIN IMMEDIATE', 'COMMIT', 'BEGIN IMMEDIATE', 'COMMIT'])
  })

  for (const provider of ['postgresql', 'sqlite'] as const) {
    test(`${provider}: raw rejection and lost receipt release the next same-task commit`, async () => {
      const f = provider === 'postgresql' ? postgresqlFixture() : sqliteFixture()
      const entered = deferred()
      const release = deferred()
      const raw = Object.freeze({
        toString: () => {
          throw new Error('unprintable')
        },
      })
      let calls = 0
      const p = persistenceOn(f.db, async (): Promise<ApplyReceipt> => {
        calls += 1
        if (calls === 1) {
          entered.resolve()
          await release.promise
          throw raw
        }
        if (calls === 2) return { committed: false, conflictOperationKey: 'lost' }
        return committed()
      }).persistence
      const first = p
        .commit({ taskId: 'task', operations: [operation('reject')] })
        .catch((error: unknown) => error)
      await entered.promise
      const second = p.commit({ taskId: 'task', operations: [operation('lost')] })
      const third = p.commit({ taskId: 'task', operations: [operation('success')] })
      release.resolve()
      expect<unknown>(await first).toBe(raw)
      expect(await second).toEqual({ committed: false, conflictOperationKey: 'lost' })
      expect(await third).toEqual(committed())
      expect(f.attempts()).toBe(3)
      if (provider === 'sqlite') {
        expect(f.queries).toEqual([
          'BEGIN IMMEDIATE',
          'ROLLBACK',
          'BEGIN IMMEDIATE',
          'ROLLBACK',
          'BEGIN IMMEDIATE',
          'COMMIT',
        ])
      }
    })
  }

  test('PG serialization retries and the successful ACK remain in one queue turn', async () => {
    const f = postgresqlFixture()
    const firstBody = deferred()
    const releaseFailure = deferred()
    const successfulBody = deferred()
    const releaseAck = deferred()
    f.afterBody(async (attempt) => {
      if (attempt === 1) {
        firstBody.resolve()
        await releaseFailure.promise
        throw { errno: '40001' }
      }
      if (attempt === 2) {
        successfulBody.resolve()
        await releaseAck.promise
      }
    })
    const p = persistenceOn(f.db).persistence
    const first = p.commit({ taskId: 'task', operations: [] })
    await firstBody.promise
    let nextSettled = false
    const second = persistenceOn(f.db)
      .persistence.commit({ taskId: 'task', operations: [] })
      .then((value) => {
        nextSettled = true
        return value
      })
    releaseFailure.resolve()
    await successfulBody.promise
    try {
      expect(f.attempts()).toBe(2)
      expect(nextSettled).toBe(false)
    } finally {
      releaseAck.resolve()
    }
    expect(await Promise.all([first, second])).toEqual([committed(), committed()])
    expect(f.attempts()).toBe(3)
    expect(f.queries).toEqual(Array(3).fill('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE'))
  })

  test('PG original retry exhaustion preserves the raw error and releases its successor', async () => {
    const f = postgresqlFixture()
    const entered = deferred()
    const release = deferred()
    const raw = { errno: '40001' }
    f.afterBody(async (attempt) => {
      if (attempt === 1) {
        entered.resolve()
        await release.promise
      }
      if (attempt <= POSTGRESQL_SERIALIZATION_ATTEMPTS) throw raw
    })
    const p = persistenceOn(f.db).persistence
    const first = p.commit({ taskId: 'task', operations: [] }).catch((error: unknown) => error)
    await entered.promise
    const second = persistenceOn(f.db).persistence.commit({ taskId: 'task', operations: [] })
    release.resolve()
    expect<unknown>(await first).toBe(raw)
    expect(await second).toEqual(committed())
    expect(f.attempts()).toBe(POSTGRESQL_SERIALIZATION_ATTEMPTS + 1)
    expect(f.queries).toEqual(
      Array(POSTGRESQL_SERIALIZATION_ATTEMPTS + 1).fill(
        'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE',
      ),
    )
  })
})

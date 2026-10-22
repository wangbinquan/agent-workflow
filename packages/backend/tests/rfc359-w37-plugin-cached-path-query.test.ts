import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import { first } from '@/platform/persistence/queryHelpers'
import { beforeEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { pluginCachedPathQuery } from '@/modules/resource-catalog/infrastructure/pluginCachedPathQuery'
import { describeEachProvider } from './helpers/eachProvider'

const pluginRows = [
  {
    id: 'plugin-empty',
    name: 'Empty cache path',
    spec: 'file:empty',
    sourceKind: 'file',
    cachedPath: '',
    optionsJson: '{}',
    resolvedVersion: null,
    enabled: true,
  },
  {
    id: 'plugin-unicode',
    name: 'Unicode cache path',
    spec: 'file:unicode',
    sourceKind: 'file',
    cachedPath: '/query-fixture/零/entry.ts',
    optionsJson: '{ "z": null, "a": [1, "零"] }',
    resolvedVersion: '1.2.3',
    enabled: false,
  },
  {
    id: 'plugin-spaces',
    name: 'Cache path with spaces',
    spec: 'file:spaces',
    sourceKind: 'file',
    cachedPath: 'query fixture/cache\\entry.js',
    optionsJson: '{"nested":{"second":2,"first":1},"enabled":false}',
    resolvedVersion: null,
    enabled: true,
  },
] satisfies Omit<PersistenceTables['plugins']['$inferInsert'], 'installedAt'>[]

// Exact published read expressions, including each owner's awaited get terminal.
async function originalSqliteRead(db: PersistenceDb, artifact: { readonly pluginId: string }) {
  const input = { db }
  const { plugins } = tablesOf(input.db)
  return await first(
    input.db
      .select({ cachedPath: plugins.cachedPath })
      .from(plugins)
      .where(eq(plugins.id, artifact.pluginId)),
  )
}

async function originalPostgresqlRead(db: PersistenceDb, artifact: { readonly pluginId: string }) {
  const input = { db }
  const { plugins } = tablesOf(input.db)
  return await first(
    input.db
      .select({ cachedPath: plugins.cachedPath })
      .from(plugins)
      .where(eq(plugins.id, artifact.pluginId)),
  )
}

async function candidateReads(db: PersistenceDb, artifact: { readonly pluginId: string }) {
  return [
    await first(pluginCachedPathQuery(db, artifact)),
    await first(pluginCachedPathQuery(db, artifact)),
  ]
}

async function readPhysicalRows(db: PersistenceDb) {
  const { plugins } = tablesOf(db)
  return await db.select().from(plugins).orderBy(plugins.id)
}

function observeConstruction(db: PersistenceDb, events: string[]) {
  return new Proxy(db, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (property !== 'select') return value
      return new Proxy(target.select, {
        apply(select, thisArg, args) {
          events.push('select')
          const builder = Reflect.apply(select, thisArg, args)
          return new Proxy(builder, {
            get(selectBuilder, key, queryReceiver) {
              const member = Reflect.get(selectBuilder, key, queryReceiver)
              if (key !== 'from') return member
              return new Proxy(member, {
                apply(from, fromThis, fromArgs) {
                  events.push('from')
                  return Reflect.apply(from, fromThis, fromArgs)
                },
              })
            },
          })
        },
      })
    },
  })
}

describeEachProvider('RFC359 W37 plugin cached path query', (harness) => {
  beforeEach(async () => {
    const { plugins } = tablesOf(harness.db)
    await harness.db.insert(plugins).values(
      pluginRows.map((row, index) => ({
        ...row,
        installedAt: 1_800_000_000_000 + index,
        createdAt: 1_800_000_000_000 + index,
        updatedAt: 1_800_000_000_000 + index,
      })),
    )
  })

  test('preserves both original queries, keyed and missing results, bindings and complete rows', async () => {
    const before = await readPhysicalRows(harness.db)
    const recording = harness.recordStatements()
    try {
      for (const pluginId of [...pluginRows.map((row) => row.id), 'plugin-missing']) {
        const artifact = { pluginId }
        const start = recording.statements.length
        const original = [
          await originalSqliteRead(harness.db, artifact),
          await originalPostgresqlRead(harness.db, artifact),
        ]
        const originalStatements = recording.statements.slice(start)
        const candidate = await candidateReads(harness.db, artifact)
        const candidateStatements = recording.statements.slice(start + originalStatements.length)
        const row = pluginRows.find((plugin) => plugin.id === pluginId)
        const expected = row === undefined ? undefined : { cachedPath: row.cachedPath }
        expect(original).toEqual([expected, expected])
        expect(candidate).toEqual(original)
        expect(originalStatements).toHaveLength(2)
        expect(candidateStatements).toEqual(originalStatements)
        expect(originalStatements.map((statement) => statement.values)).toEqual([
          [pluginId, 1],
          [pluginId, 1],
        ])
        expect(originalStatements.map((statement) => statement.params)).toEqual([2, 2])
      }
    } finally {
      recording.stop()
    }
    expect(await readPhysicalRows(harness.db)).toEqual(before)
    expect(JSON.stringify(await readPhysicalRows(harness.db))).toBe(JSON.stringify(before))
    expect(before.filter((row) => row.resolvedVersion === null)).toHaveLength(2)
    expect(before.find((row) => row.id === 'plugin-unicode')?.optionsJson).toBe(
      '{ "z": null, "a": [1, "零"] }',
    )
  })

  test('keeps construction lazy and reads the artifact key after the real select and from calls', async () => {
    for (const read of [originalSqliteRead, originalPostgresqlRead]) {
      const events: string[] = []
      const observedDb = observeConstruction(harness.db, events)
      const artifact = {
        get pluginId() {
          events.push('pluginId')
          return 'plugin-unicode'
        },
      }
      expect(await read(observedDb, artifact)).toEqual({ cachedPath: '/query-fixture/零/entry.ts' })
      expect(events).toEqual(['select', 'from', 'pluginId'])
    }
    const events: string[] = []
    const observedDb = observeConstruction(harness.db, events)
    const artifact = {
      get pluginId() {
        events.push('pluginId')
        return 'plugin-unicode'
      },
    }
    const recording = harness.recordStatements()
    try {
      const query = pluginCachedPathQuery(observedDb, artifact)
      expect(events).toEqual(['select', 'from', 'pluginId'])
      expect(recording.statements).toHaveLength(0)
      expect(await first(query)).toEqual({ cachedPath: '/query-fixture/零/entry.ts' })
      expect(events).toEqual(['select', 'from', 'pluginId'])
      expect(recording.statements).toHaveLength(1)
    } finally {
      recording.stop()
    }
  })

  test('uses the caller transaction and restores every physical value and raw JSON after rollback', async () => {
    const before = await readPhysicalRows(harness.db)
    const failure = new Error('rollback plugin cached path read')
    await expect(
      harness.session.transaction(async (tx) => {
        const { plugins } = tablesOf(tx)
        await tx
          .update(plugins)
          .set({
            cachedPath: '/changed/路径',
            optionsJson: '{ "changed": true }',
            resolvedVersion: null,
          })
          .where(eq(plugins.id, 'plugin-unicode'))
        await tx.delete(plugins).where(eq(plugins.id, 'plugin-empty'))
        for (const pluginId of ['plugin-unicode', 'plugin-empty']) {
          const artifact = { pluginId }
          const original = [
            await originalSqliteRead(tx, artifact),
            await originalPostgresqlRead(tx, artifact),
          ]
          const expected = pluginId === 'plugin-empty' ? undefined : { cachedPath: '/changed/路径' }
          expect(original).toEqual([expected, expected])
          expect(await candidateReads(tx, artifact)).toEqual(original)
        }
        expect(await readPhysicalRows(tx)).toEqual(
          before
            .filter((row) => row.id !== 'plugin-empty')
            .map((row) =>
              row.id === 'plugin-unicode'
                ? {
                    ...row,
                    cachedPath: '/changed/路径',
                    optionsJson: '{ "changed": true }',
                    resolvedVersion: null,
                  }
                : row,
            ),
        )
        throw failure
      }),
    ).rejects.toBe(failure)
    expect(await readPhysicalRows(harness.db)).toEqual(before)
    expect(JSON.stringify(await readPhysicalRows(harness.db))).toBe(JSON.stringify(before))
  })
})

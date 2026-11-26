// Module contract audit: memory-service and RFC-352 cover CRUD and page equivalence.
// These cases drive the composed catalog to prove bounded sparse-filter scans and
// failure atomicity, rather than inferring either from the pagination helper alone.
import { expect, test } from 'bun:test'
import { buildActor } from '@/auth/actor'
import { composeIdentityAccess } from '@/modules/identity-access/composition'
import { composeMemoryCatalogOperations } from '@/modules/memory/composition'
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { describeEachProvider } from './helpers/eachProvider'
import {
  resourceScopeAuthority,
  TEST_RESOURCE_SCOPE_AUTHORIZATION,
} from './helpers/resourceScopeAuthority'

describeEachProvider('module contract — memory catalog', (harness) => {
  function catalog() {
    return composeMemoryCatalogOperations({
      db: harness.db,
      contexts: composeIdentityAccess(harness.db).contexts,
      authorization: TEST_RESOURCE_SCOPE_AUTHORIZATION,
    })
  }

  function authority() {
    return resourceScopeAuthority(
      harness.db,
      buildActor({
        user: {
          id: 'contract-admin',
          username: 'contract-admin',
          displayName: 'Contract Admin',
          role: 'admin',
          status: 'active',
        },
        source: 'session',
      }),
    )
  }

  test('malformed public page cursors fail before any database query', async () => {
    const operations = catalog()
    const actor = authority()
    const recording = harness.recordStatements()
    try {
      await expect(
        operations.queries.listPage(
          actor,
          {},
          { cursor: 'not-a-memory-cursor', limit: 10 },
          { includeCandidates: true },
        ),
      ).rejects.toMatchObject({ code: 'invalid-filter' })
    } finally {
      recording.stop()
    }
    expect(recording.selects()).toEqual([])
  })

  test('sparse tag pages stop at the ten-batch budget and the returned cursor still advances to exhaustion', async () => {
    const { memories } = tablesOf(harness.db)
    for (let index = 0; index < 45; index += 1) {
      await insertOne(harness.db, memories, {
        id: `memory-contract-${String(index).padStart(3, '0')}`,
        scopeType: 'global',
        scopeId: null,
        title: `Memory ${index}`,
        bodyMd: 'a body which a summary must not return',
        status: 'approved',
        sourceKind: 'manual',
        tags: JSON.stringify(['ordinary']),
        version: 1,
        createdAt: 1_000,
      })
    }
    const operations = catalog()
    const actor = authority()
    const recording = harness.recordStatements()
    let first: Awaited<ReturnType<typeof operations.queries.listPage>>
    try {
      first = await operations.queries.listPage(
        actor,
        { tags: ['unmatched'] },
        { cursor: null, limit: 2 },
        { includeCandidates: true },
      )
    } finally {
      recording.stop()
    }
    expect(first.items).toEqual([])
    expect(first.nextCursor).not.toBeNull()
    const reads = recording.selects().filter(({ sql }) => /"memories"/.test(sql))
    expect(reads).toHaveLength(10)
    expect(reads.every(({ rows }) => rows <= 4)).toBe(true)
    expect(reads.reduce((total, { rows }) => total + rows, 0)).toBe(40)
    expect(reads.every(({ sql }) => /\blimit\b/i.test(sql))).toBe(true)

    const last = await operations.queries.listPage(
      actor,
      { tags: ['unmatched'] },
      { cursor: first.nextCursor, limit: 2 },
      { includeCandidates: true },
    )
    expect(last).toEqual({ items: [], nextCursor: null })
    const visible = await operations.queries.listPage(
      actor,
      {},
      { cursor: null, limit: 2 },
      { includeCandidates: true },
    )
    expect(visible.items.map((row) => row.id)).toEqual([
      'memory-contract-044',
      'memory-contract-043',
    ])
    expect(visible.items.every((row) => !('bodyMd' in row) && !('createdAt' in row))).toBe(true)
  })

  test('a storage failure after a patch write leaves body, title, tags and version unchanged and permits a later retry', async () => {
    const operations = catalog()
    const memory = await operations.commands.createManual({
      scopeType: 'global',
      scopeId: null,
      title: 'Before',
      bodyMd: 'Original body',
      tags: ['original'],
    })
    const before = await operations.queries.getById(memory.id)
    const failure = new Error('transaction failed after memory update')
    const failing = composeMemoryCatalogOperations({
      db: harness.db,
      contexts: composeIdentityAccess(harness.db).contexts,
      authorization: TEST_RESOURCE_SCOPE_AUTHORIZATION,
      testHooks: {
        afterWriteInTransaction: async () => {
          throw failure
        },
      },
    })
    const patch = { title: 'After', bodyMd: 'Replacement body', tags: ['replacement'] }
    await expect(failing.commands.patch(memory.id, patch)).rejects.toBe(failure)
    expect(await operations.queries.getById(memory.id)).toEqual(before)
    const receipt = await operations.commands.patch(memory.id, patch)
    expect(receipt.changedFields).toEqual(['title', 'bodyMd', 'tags'])
    expect(receipt.memory).toMatchObject({ ...patch, version: memory.version + 1 })
    expect((await operations.queries.getById(memory.id))?.memory).toEqual(receipt.memory)
  })
})

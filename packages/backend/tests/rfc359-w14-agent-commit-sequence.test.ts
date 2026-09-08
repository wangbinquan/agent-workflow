// RFC-359 W14: the migrated legacy Agent suites exposed an actual synchronous
// commit boundary. Keep their entry points and prove the shared sequence with
// real database rollback, including the still-synchronous bundle participant.

import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import type { CreateAgent } from '@agent-workflow/shared'
import { createInMemoryDb } from '@/db/client'
import { agents } from '@/db/schema'
import { dbTxSync } from '@/db/txSync'
import {
  commitAgentCreateInTx,
  commitAgentUpdateInTx,
  createAgent,
  getAgentById,
  prepareAgentCreate,
  prepareAgentUpdate,
  updateAgent,
} from '@/modules/resource-catalog/infrastructure/legacy/agent'
import {
  continueResourceCommit,
  finishSynchronousResourceCommit,
  forEachResourceCommit,
} from '@/modules/resource-catalog/infrastructure/resourceCommitSequence'
import { describeEachProvider } from './helpers/eachProvider'
import { MIGRATIONS } from './migration-freeze'

function input(name: string): CreateAgent {
  return {
    name,
    description: 'before update',
    outputs: ['report'],
    inputs: [{ name: 'source', kind: 'markdown' }],
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: { retained: 'value' },
    bodyMd: 'original body',
  }
}

describe('resource commit sequencing', () => {
  test('immediate steps finish synchronously in the original iteration order', () => {
    const observed: string[] = []
    const result = forEachResourceCommit([1, 2], (value) =>
      continueResourceCommit(value, (loaded) => {
        observed.push(`read:${loaded}`, `write:${loaded}`)
      }),
    )
    expect(result).toBeUndefined()
    finishSynchronousResourceCommit(result)
    expect(observed).toEqual(['read:1', 'write:1', 'read:2', 'write:2'])
  })

  test('a pending read settles before the next item or completion is observed', async () => {
    const release = Promise.withResolvers<void>()
    const observed: string[] = []
    const result = forEachResourceCommit([1, 2], (value) => {
      observed.push(`start:${value}`)
      return continueResourceCommit(value === 1 ? release.promise : undefined, () => {
        observed.push(`finish:${value}`)
      })
    })
    expect(observed).toEqual(['start:1'])
    expect(() => finishSynchronousResourceCommit(result)).toThrow(
      'synchronous resource commit received an asynchronous step',
    )
    release.resolve()
    await result
    expect(observed).toEqual(['start:1', 'finish:1', 'start:2', 'finish:2'])
  })

  for (const asynchronous of [false, true]) {
    test(`a ${asynchronous ? 'pending' : 'synchronous'} failure keeps its identity and closes iteration`, async () => {
      const failure = new Error('commit step failed')
      const observed: string[] = []
      function* values() {
        try {
          yield 1
          observed.push('second item')
          yield 2
        } finally {
          observed.push('iterator closed')
        }
      }
      const run = async () => {
        await forEachResourceCommit(values(), () => {
          if (asynchronous) return Promise.reject(failure)
          throw failure
        })
      }
      await expect(run()).rejects.toBe(failure)
      expect(observed).toEqual(['iterator closed'])
    })
  }
})

test('the legacy SQLite bundle commit exports still finish before their void call returns', async () => {
  // This lane exercises the physical synchronous contract; the public async
  // entry points below run on both real providers.
  const db = createInMemoryDb(MIGRATIONS)
  try {
    const prepared = await prepareAgentCreate(db, input('synchronous-agent'), {
      id: 'synchronous-agent',
    })
    dbTxSync(db, (tx) => {
      expect(commitAgentCreateInTx(tx, prepared)).toBeUndefined()
      expect(tx.select().from(agents).where(eq(agents.id, prepared.id)).get()?.description).toBe(
        'before update',
      )
    })
    const before = await getAgentById(db, prepared.id)
    const patch = await prepareAgentUpdate(db, prepared.id, { description: 'inside transaction' })
    const failure = new Error('abort synchronous Agent update')
    expect(() =>
      dbTxSync(db, (tx) => {
        expect(commitAgentUpdateInTx(tx, patch)).toBeUndefined()
        expect(tx.select().from(agents).where(eq(agents.id, prepared.id)).get()?.description).toBe(
          'inside transaction',
        )
        throw failure
      }),
    ).toThrow(failure)
    expect(await getAgentById(db, prepared.id)).toEqual(before)
  } finally {
    db.$client.close()
  }
})

describeEachProvider('legacy Agent entry points use one atomic commit sequence', (harness) => {
  test('an outer abort rolls back the actual create and update entry points together', async () => {
    const failure = new Error('abort complete Agent transaction')
    await expect(
      harness.session.transaction(async (tx) => {
        const created = await createAgent(tx, input('rolled-back-agent'), {
          id: 'rolled-back-agent',
        })
        const updated = await updateAgent(tx, created.id, { description: 'inside transaction' })
        expect(updated.description).toBe('inside transaction')
        expect(updated.inputs).toEqual([{ name: 'source', kind: 'markdown' }])
        expect(updated.createdAt).toBe(created.createdAt)
        expect(updated.updatedAt).toBeGreaterThan(created.updatedAt)
        expect(await getAgentById(tx, created.id)).toEqual(updated)
        throw failure
      }),
    ).rejects.toBe(failure)
    expect(await getAgentById(harness.db, 'rolled-back-agent')).toBe(null)
  })

  test('an outer update abort preserves every original stored column', async () => {
    const created = await createAgent(harness.db, input('existing-agent'))
    const before = await harness.db.select().from(agents).where(eq(agents.id, created.id)).get()
    const failure = new Error('abort existing Agent update')
    await expect(
      harness.session.transaction(async (tx) => {
        const updated = await updateAgent(tx, created.id, {
          description: 'not committed',
          inputs: [],
          bodyMd: 'new body',
          frontmatterExtra: { replacement: true },
        })
        expect(updated.inputs).toEqual([])
        expect(updated.frontmatterExtra).toEqual({ replacement: true })
        expect((await getAgentById(tx, created.id))?.bodyMd).toBe('new body')
        throw failure
      }),
    ).rejects.toBe(failure)
    expect(await harness.db.select().from(agents).where(eq(agents.id, created.id)).get()).toEqual(
      before,
    )
  })

  test('the original beforeWrite hooks run before each commit and the returned read', async () => {
    const observed: string[] = []
    const created = await createAgent(harness.db, input('hook-agent'), {
      id: 'hook-agent',
      beforeWriteTransaction: async () => {
        expect(await getAgentById(harness.db, 'hook-agent')).toBe(null)
        observed.push('create hook')
      },
    })
    observed.push('create returned')
    const updated = await updateAgent(
      harness.db,
      created.id,
      { description: 'after update' },
      undefined,
      undefined,
      {
        beforeWriteTransaction: async () => {
          expect((await getAgentById(harness.db, created.id))?.description).toBe('before update')
          observed.push('update hook')
        },
      },
    )
    observed.push('update returned')
    expect(updated.description).toBe('after update')
    expect(updated.frontmatterExtra).toEqual({ retained: 'value' })
    expect(observed).toEqual(['create hook', 'create returned', 'update hook', 'update returned'])
  })

  test('a rejected beforeWrite hook propagates the original error without committing', async () => {
    const failure = new Error('beforeWrite hook rejected')
    const beforeWriteTransaction = async () => {
      await Promise.resolve()
      throw failure
    }
    await expect(
      createAgent(harness.db, input('rejected-agent'), {
        id: 'rejected-agent',
        beforeWriteTransaction,
      }),
    ).rejects.toBe(failure)
    expect(await getAgentById(harness.db, 'rejected-agent')).toBe(null)

    const created = await createAgent(harness.db, input('unchanged-agent'))
    await expect(
      updateAgent(harness.db, created.id, { description: 'not committed' }, undefined, undefined, {
        beforeWriteTransaction,
      }),
    ).rejects.toBe(failure)
    expect(await getAgentById(harness.db, created.id)).toEqual(created)
  })
})

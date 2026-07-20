// RFC-033-T2: TTL-based GC for completed batches.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { createInMemoryDb } from '../src/db/client'
import {
  __resetBatchImportForTests,
  gcBatches,
  getBatchSnapshot,
  startBatchImport,
  type RepoBatchImportDeps,
} from '../src/services/repoBatchImport'
import type { resolveCachedRepo } from '../src/services/gitRepoCache'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

type Resolver = typeof resolveCachedRepo

function happyResolver(): Resolver {
  return (async (_d, input) => {
    await new Promise((r) => setTimeout(r, 1))
    return {
      cached: {
        id: 'cr-1',
        urlRedacted: input.url,
        localPath: '/tmp/cr-1',
        defaultBranch: 'main',
        lastFetchedAt: '2026-05-17T00:00:00.000Z',
        createdAt: '2026-05-17T00:00:00.000Z',
        referencingTaskCount: 0,
      },
      cold: true,
      fetchOk: true,
      fetchError: null,
    }
  }) as Resolver
}

async function waitForCompleted(batchId: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const s = getBatchSnapshot(batchId)
    if (s && s.state === 'completed') return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('timeout')
}

describe('gcBatches (RFC-033-T2)', () => {
  beforeEach(() => __resetBatchImportForTests())
  afterEach(() => __resetBatchImportForTests())

  test('evicts completed batch past TTL', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const myDeps: RepoBatchImportDeps = { db, resolveCachedRepo: happyResolver(), emit: () => {} }
    const r = startBatchImport(myDeps, { urls: ['https://h/a.git'] })
    await waitForCompleted(r.batchId)
    expect(getBatchSnapshot(r.batchId)).not.toBeNull()
    // Move now() forward 2 hours.
    const future = Date.now() + 2 * 60 * 60 * 1000
    const result = gcBatches({ now: () => future })
    expect(result.evicted).toBe(1)
    expect(getBatchSnapshot(r.batchId)).toBeNull()
  })

  test('running batch is never evicted', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    // Resolver never resolves: keeps the batch running.
    const heldResolver: Resolver = (async () =>
      new Promise(() => {
        /* never resolve */
      })) as Resolver
    const myDeps: RepoBatchImportDeps = { db, resolveCachedRepo: heldResolver, emit: () => {} }
    const r = startBatchImport(myDeps, { urls: ['https://h/a.git'] })
    const future = Date.now() + 10 * 60 * 60 * 1000
    const result = gcBatches({ now: () => future })
    expect(result.evicted).toBe(0)
    expect(getBatchSnapshot(r.batchId)).not.toBeNull()
  })
})

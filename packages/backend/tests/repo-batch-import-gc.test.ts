// RFC-033-T2: TTL-based GC for completed batches.

// RFC-285 B6②：startBatchImport 增 owner 第三参（ownership 落 BatchRecord），
// 本文件既有用例统一以 u_batch_owner 发起；门矩阵见 ws-repo-imports 套件。
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { describeEachProvider } from './helpers/eachProvider'
import {
  __resetBatchImportForTests,
  gcBatches,
  getBatchSnapshot,
  startBatchImport,
  startBatchImportGc,
  type RepoBatchImportDeps,
} from '../src/services/repoBatchImport'
import type { resolveCachedRepo } from '../src/services/gitRepoCache'
import { composeSqliteRepositoryWorkspaceStore } from '../src/modules/source-control/composition'

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

describeEachProvider('gcBatches (RFC-033-T2)', (harness) => {
  beforeEach(() => __resetBatchImportForTests())
  afterEach(() => __resetBatchImportForTests())

  test('RFC-370 an already armed host GC tick does not evict after authority loss', async () => {
    const result = startBatchImport(
      {
        store: composeSqliteRepositoryWorkspaceStore(harness.db),
        resolveCachedRepo: happyResolver(),
        emit: () => {},
      },
      { urls: ['https://h/host-gc.git'] },
      { userId: 'u_batch_owner' },
    )
    await waitForCompleted(result.batchId)
    let current = true
    const timeout = spyOn(globalThis, 'setTimeout')
    const ticker = startBatchImportGc(60_000, -1, 1, { current: () => current })
    try {
      const index = timeout.mock.calls.findIndex((args) => args[1] === 1)
      const args = timeout.mock.calls[index],
        timer = timeout.mock.results[index]
      if (args === undefined || timer?.type !== 'return' || typeof args[0] !== 'function')
        throw new Error('original GC phase timer missing')
      clearTimeout(timer.value)
      current = false
      args[0](...args.slice(2))
      expect(getBatchSnapshot(result.batchId)?.state).toBe('completed')
      expect(gcBatches({ retentionMs: -1 }).evicted).toBe(1)
    } finally {
      ticker.stop()
      timeout.mockRestore()
    }
  })

  test('evicts completed batch past TTL', async () => {
    const db = harness.db
    const myDeps: RepoBatchImportDeps = {
      store: composeSqliteRepositoryWorkspaceStore(db),
      resolveCachedRepo: happyResolver(),
      emit: () => {},
    }
    const r = startBatchImport(myDeps, { urls: ['https://h/a.git'] }, { userId: 'u_batch_owner' })
    await waitForCompleted(r.batchId)
    expect(getBatchSnapshot(r.batchId)).not.toBeNull()
    // Move now() forward 2 hours.
    const future = Date.now() + 2 * 60 * 60 * 1000
    const result = gcBatches({ now: () => future })
    expect(result.evicted).toBe(1)
    expect(getBatchSnapshot(r.batchId)).toBeNull()
  })

  test('running batch is never evicted', async () => {
    const db = harness.db
    // Resolver never resolves: keeps the batch running.
    const heldResolver: Resolver = (async () =>
      new Promise(() => {
        /* never resolve */
      })) as Resolver
    const myDeps: RepoBatchImportDeps = {
      store: composeSqliteRepositoryWorkspaceStore(db),
      resolveCachedRepo: heldResolver,
      emit: () => {},
    }
    const r = startBatchImport(myDeps, { urls: ['https://h/a.git'] }, { userId: 'u_batch_owner' })
    const future = Date.now() + 10 * 60 * 60 * 1000
    const result = gcBatches({ now: () => future })
    expect(result.evicted).toBe(0)
    expect(getBatchSnapshot(r.batchId)).not.toBeNull()
  })
})

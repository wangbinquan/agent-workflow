// RFC-033-T2: retry semantics for batch import rows.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  __resetBatchImportForTests,
  startBatchImport,
  retryBatchRow,
  getBatchSnapshot,
  type RepoBatchImportDeps,
} from '../src/services/repoBatchImport'
import { DomainError, NotFoundError } from '../src/util/errors'
import type { resolveCachedRepo } from '../src/services/gitRepoCache'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

type Resolver = typeof resolveCachedRepo

function happyResolver(): Resolver {
  let counter = 0
  return (async (_deps, input) => {
    counter += 1
    await new Promise((r) => setTimeout(r, 2))
    const id = `cr-${counter}`
    return {
      cached: {
        id,
        url: input.url,
        urlRedacted: input.url,
        localPath: `/tmp/${id}`,
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

function flakyOnceResolver(failingUrl: string): Resolver {
  const seen = new Set<string>()
  let counter = 0
  return (async (_deps, input) => {
    counter += 1
    await new Promise((r) => setTimeout(r, 2))
    if (input.url === failingUrl && !seen.has(input.url)) {
      seen.add(input.url)
      throw new DomainError('repo-clone-failed', `git clone failed: ${input.url}`, 400)
    }
    const id = `cr-${counter}`
    return {
      cached: {
        id,
        url: input.url,
        urlRedacted: input.url,
        localPath: `/tmp/${id}`,
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

async function waitForBatchCompleted(batchId: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const snap = getBatchSnapshot(batchId)
    if (snap && snap.state === 'completed') return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('timed out waiting for batch.completed')
}

function deps(db: DbClient, resolver: Resolver): RepoBatchImportDeps {
  return { db, resolveCachedRepo: resolver, emit: () => {} }
}

describe('retryBatchRow (RFC-033-T2)', () => {
  beforeEach(() => __resetBatchImportForTests())
  afterEach(() => __resetBatchImportForTests())

  test('failed row succeeds on retry', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const resolver = flakyOnceResolver('https://h/a.git')
    const sharedDeps = deps(db, resolver)
    const r = startBatchImport(sharedDeps, { urls: ['https://h/a.git'] })
    await waitForBatchCompleted(r.batchId)
    let snap = getBatchSnapshot(r.batchId)!
    expect(snap.rows[0]?.status).toBe('failed')
    const rowId = snap.rows[0]!.rowId
    retryBatchRow(sharedDeps, r.batchId, rowId)
    await waitForBatchCompleted(r.batchId)
    snap = getBatchSnapshot(r.batchId)!
    expect(snap.rows[0]?.status).toBe('done')
    expect(snap.rows[0]?.rowId).toBe(rowId)
  })

  test('done row can be retried (resets and re-runs)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const r = startBatchImport(deps(db, happyResolver()), { urls: ['https://h/a.git'] })
    await waitForBatchCompleted(r.batchId)
    const rowId = getBatchSnapshot(r.batchId)!.rows[0]!.rowId
    retryBatchRow(deps(db, happyResolver()), r.batchId, rowId)
    await waitForBatchCompleted(r.batchId)
    const snap = getBatchSnapshot(r.batchId)!
    expect(snap.rows[0]?.status).toBe('done')
  })

  test('running row cannot be retried (409 row-not-retryable)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    // Resolver that never resolves — keeps the row cloning forever.
    let release: (() => void) | null = null
    const heldResolver: Resolver = (async (_d, input) => {
      await new Promise<void>((r) => {
        release = r
      })
      return {
        cached: {
          id: 'cr-1',
          url: input.url,
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
    const r = startBatchImport(deps(db, heldResolver), { urls: ['https://h/a.git'] })
    // Wait until the row is in cloning state.
    for (let i = 0; i < 50; i++) {
      const snap = getBatchSnapshot(r.batchId)!
      if (snap.rows[0]?.status === 'cloning') break
      await new Promise((res) => setTimeout(res, 5))
    }
    const rowId = getBatchSnapshot(r.batchId)!.rows[0]!.rowId
    try {
      retryBatchRow(deps(db, heldResolver), r.batchId, rowId)
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError)
      expect((err as DomainError).code).toBe('row-not-retryable')
    }
    // Let it finish so afterEach can reset cleanly.
    if (release) (release as () => void)()
    await waitForBatchCompleted(r.batchId)
  })

  test('retry with override URL replaces the URL', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const calls: string[] = []
    const tracking: Resolver = (async (_d, input) => {
      calls.push(input.url)
      await new Promise((r) => setTimeout(r, 2))
      if (input.url === 'https://h/bad.git') {
        throw new DomainError('repo-clone-failed', 'fail', 400)
      }
      return {
        cached: {
          id: 'cr-1',
          url: input.url,
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
    const r = startBatchImport(deps(db, tracking), { urls: ['https://h/bad.git'] })
    await waitForBatchCompleted(r.batchId)
    const rowId = getBatchSnapshot(r.batchId)!.rows[0]!.rowId
    retryBatchRow(deps(db, tracking), r.batchId, rowId, { url: 'https://h/good.git' })
    await waitForBatchCompleted(r.batchId)
    expect(calls).toEqual(['https://h/bad.git', 'https://h/good.git'])
    const snap = getBatchSnapshot(r.batchId)!
    expect(snap.rows[0]?.status).toBe('done')
  })

  test('retry on completed batch rewinds state and re-emits batch.completed', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const events: string[] = []
    const myDeps: RepoBatchImportDeps = {
      db,
      resolveCachedRepo: happyResolver(),
      emit: (_b, msg) => {
        if (msg.type === 'batch.completed') events.push('completed')
      },
    }
    const r = startBatchImport(myDeps, { urls: ['https://h/a.git'] })
    await waitForBatchCompleted(r.batchId)
    expect(getBatchSnapshot(r.batchId)!.state).toBe('completed')
    expect(events).toEqual(['completed'])
    const rowId = getBatchSnapshot(r.batchId)!.rows[0]!.rowId
    retryBatchRow(myDeps, r.batchId, rowId)
    // After retry pump should re-run and re-emit.
    await waitForBatchCompleted(r.batchId)
    expect(events).toEqual(['completed', 'completed'])
  })

  test('row-not-found / batch-not-found surface as NotFoundError', () => {
    const db = createInMemoryDb(MIGRATIONS)
    expect(() => retryBatchRow(deps(db, happyResolver()), 'nope', 'nope')).toThrow(NotFoundError)
    const r = startBatchImport(deps(db, happyResolver()), { urls: ['https://h/a.git'] })
    expect(() => retryBatchRow(deps(db, happyResolver()), r.batchId, 'nope')).toThrow(NotFoundError)
  })

  test('retry with invalid URL parks row as failed/repo-url-invalid without queuing', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const r = startBatchImport(deps(db, happyResolver()), { urls: ['https://h/a.git'] })
    await waitForBatchCompleted(r.batchId)
    const rowId = getBatchSnapshot(r.batchId)!.rows[0]!.rowId
    retryBatchRow(deps(db, happyResolver()), r.batchId, rowId, { url: 'garbage' })
    const snap = getBatchSnapshot(r.batchId)!
    expect(snap.rows[0]?.status).toBe('failed')
    expect(snap.rows[0]?.errorCode).toBe('repo-url-invalid')
  })
})

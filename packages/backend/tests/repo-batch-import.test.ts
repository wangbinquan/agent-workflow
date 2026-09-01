// RFC-033-T2: locks the queue / concurrency / dedupe / failure-isolation
// invariants of services/repoBatchImport.ts. Uses a stub resolver so the
// suite stays hermetic (no git, no filesystem) — the real clone path is
// already covered by git-repo-cache.test.ts.

// RFC-285 B6②：startBatchImport 增 owner 第三参（ownership 落 BatchRecord），
// 本文件既有用例统一以 u_batch_owner 发起；门矩阵见 ws-repo-imports 套件。
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  __resetBatchImportForTests,
  startBatchImport,
  getBatchSnapshot,
  type RepoBatchImportDeps,
} from '../src/services/repoBatchImport'
import { DomainError } from '../src/util/errors'
import type { resolveCachedRepo } from '../src/services/gitRepoCache'
import type { RepoImportWsMessage } from '@agent-workflow/shared'
import { composeSqliteRepositoryWorkspaceStore } from '../src/modules/source-control/composition'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

type StubResolver = typeof resolveCachedRepo

interface Harness {
  db: DbClient
  events: Array<{ batchId: string; msg: RepoImportWsMessage }>
  resolverCalls: string[]
  peakInFlight: number
  inFlight: number
}

function makeHarness(): Harness {
  const db = createInMemoryDb(MIGRATIONS)
  const events: Harness['events'] = []
  return { db, events, resolverCalls: [], peakInFlight: 0, inFlight: 0 }
}

function stubResolver(
  harness: Harness,
  override?: (url: string) => Promise<unknown> | unknown,
): StubResolver {
  const stub: StubResolver = (async (_deps, input) => {
    harness.resolverCalls.push(input.url)
    harness.inFlight += 1
    if (harness.inFlight > harness.peakInFlight) {
      harness.peakInFlight = harness.inFlight
    }
    try {
      // Always yield once so concurrent calls can pile up before any resolves.
      await new Promise((r) => setTimeout(r, 5))
      if (override) {
        const v = await override(input.url)
        if (v !== undefined) {
          return v as Awaited<ReturnType<typeof resolveCachedRepo>>
        }
      }
      const cachedId = `cr-${harness.resolverCalls.length}`
      return {
        cached: {
          id: cachedId,
          urlRedacted: input.url,
          localPath: `/tmp/${cachedId}`,
          defaultBranch: 'main',
          lastFetchedAt: '2026-05-17T00:00:00.000Z',
          createdAt: '2026-05-17T00:00:00.000Z',
          referencingTaskCount: 0,
        },
        cold: true,
        fetchOk: true,
        fetchError: null,
      } as Awaited<ReturnType<typeof resolveCachedRepo>>
    } finally {
      harness.inFlight -= 1
    }
  }) as StubResolver
  return stub
}

function deps(harness: Harness, resolver: StubResolver, concurrency = 3): RepoBatchImportDeps {
  return {
    store: composeSqliteRepositoryWorkspaceStore(harness.db),
    resolveCachedRepo: resolver,
    concurrency,
    emit: (batchId, msg) => {
      harness.events.push({ batchId, msg })
    },
  }
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

describe('startBatchImport (RFC-033-T2)', () => {
  beforeEach(() => {
    __resetBatchImportForTests()
  })
  afterEach(() => {
    __resetBatchImportForTests()
  })

  test('happy path: 3 URLs all done; order preserved', async () => {
    const h = makeHarness()
    const r = startBatchImport(
      deps(h, stubResolver(h)),
      {
        urls: ['https://h/a.git', 'https://h/b.git', 'https://h/c.git'],
      },
      { userId: 'u_batch_owner' },
    )
    expect(r.snapshot.state).toBe('running')
    expect(r.snapshot.rows.map((x) => x.inputUrlRedacted)).toEqual([
      'https://h/a.git',
      'https://h/b.git',
      'https://h/c.git',
    ])
    await waitForBatchCompleted(r.batchId)
    const snap = getBatchSnapshot(r.batchId)!
    expect(snap.state).toBe('completed')
    expect(snap.rows.every((x) => x.status === 'done')).toBe(true)
  })

  test('invalid URL stays terminal and does not occupy a worker', async () => {
    const h = makeHarness()
    const r = startBatchImport(
      deps(h, stubResolver(h)),
      {
        urls: ['not a url', 'https://h/b.git'],
      },
      { userId: 'u_batch_owner' },
    )
    expect(r.snapshot.rows[0]?.status).toBe('failed')
    expect(r.snapshot.rows[0]?.errorCode).toBe('repo-url-invalid')
    expect(r.snapshot.rows[1]?.status).toBe('queued')
    await waitForBatchCompleted(r.batchId)
    expect(h.resolverCalls).toEqual(['https://h/b.git'])
    const snap = getBatchSnapshot(r.batchId)!
    expect(snap.rows[1]?.status).toBe('done')
  })

  test('clone failure isolated: other rows still complete', async () => {
    const h = makeHarness()
    const resolver = stubResolver(h, (url) => {
      if (url === 'https://h/b.git') {
        throw new DomainError('repo-clone-failed', `git clone failed: ${url}`, 400)
      }
      return undefined
    })
    const r = startBatchImport(
      deps(h, resolver),
      {
        urls: ['https://h/a.git', 'https://h/b.git', 'https://h/c.git'],
      },
      { userId: 'u_batch_owner' },
    )
    await waitForBatchCompleted(r.batchId)
    const snap = getBatchSnapshot(r.batchId)!
    expect(snap.state).toBe('completed')
    expect(snap.rows[0]?.status).toBe('done')
    expect(snap.rows[1]?.status).toBe('failed')
    expect(snap.rows[1]?.errorCode).toBe('repo-clone-failed')
    expect(snap.rows[2]?.status).toBe('done')
  })

  test('concurrency cap is honored', async () => {
    const h = makeHarness()
    const r = startBatchImport(
      deps(h, stubResolver(h), 2),
      {
        urls: [
          'https://h/a.git',
          'https://h/b.git',
          'https://h/c.git',
          'https://h/d.git',
          'https://h/e.git',
        ],
      },
      { userId: 'u_batch_owner' },
    )
    await waitForBatchCompleted(r.batchId)
    expect(h.peakInFlight).toBeLessThanOrEqual(2)
    expect(h.resolverCalls.length).toBe(5)
  })

  test('duplicate URLs in the same batch are de-duped', async () => {
    const h = makeHarness()
    const r = startBatchImport(
      deps(h, stubResolver(h)),
      {
        urls: ['https://h/a.git', 'https://h/a.git', '  https://h/a.git  '],
      },
      { userId: 'u_batch_owner' },
    )
    expect(r.snapshot.rows.length).toBe(1)
    await waitForBatchCompleted(r.batchId)
    expect(h.resolverCalls).toEqual(['https://h/a.git'])
  })

  test('all-invalid batch flips to completed without starting any worker', async () => {
    const h = makeHarness()
    const r = startBatchImport(
      deps(h, stubResolver(h)),
      {
        urls: ['not a url', 'also not'],
      },
      { userId: 'u_batch_owner' },
    )
    // batch should be already completed synchronously
    const snap = getBatchSnapshot(r.batchId)!
    expect(snap.state).toBe('completed')
    expect(snap.rows.every((x) => x.status === 'failed')).toBe(true)
    expect(h.resolverCalls).toEqual([])
  })

  test('empty URLs throws batch-empty', () => {
    const h = makeHarness()
    expect(() =>
      startBatchImport(deps(h, stubResolver(h)), { urls: [] }, { userId: 'u_batch_owner' }),
    ).toThrow(DomainError)
    try {
      startBatchImport(
        deps(h, stubResolver(h)),
        { urls: ['', '  ', '\n'] },
        { userId: 'u_batch_owner' },
      )
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError)
      expect((err as DomainError).code).toBe('batch-empty')
    }
  })

  test('too-large batch throws batch-too-large', () => {
    const h = makeHarness()
    const urls = Array.from({ length: 101 }, (_, i) => `https://h/${i}.git`)
    try {
      startBatchImport(deps(h, stubResolver(h)), { urls }, { userId: 'u_batch_owner' })
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError)
      expect((err as DomainError).code).toBe('batch-too-large')
    }
  })

  test('WS broadcast emits row.update + batch.completed', async () => {
    const h = makeHarness()
    const r = startBatchImport(
      deps(h, stubResolver(h)),
      {
        urls: ['https://h/a.git', 'not-a-url'],
      },
      { userId: 'u_batch_owner' },
    )
    await waitForBatchCompleted(r.batchId)
    // Valid row: queued→cloning→done = 2 row.update events.
    // Invalid row: born terminal, not emitted via emit on creation, but is in
    // snapshot. So row.update count == 2 (from the valid row) and 1 batch.completed.
    const rowUpdates = h.events.filter((e) => e.msg.type === 'row.update')
    const batchDone = h.events.filter((e) => e.msg.type === 'batch.completed')
    expect(rowUpdates.length).toBe(2)
    expect(batchDone.length).toBe(1)
  })

  test('credential URL never leaks via row payload', async () => {
    const h = makeHarness()
    const cred = 'https://x-token-auth:s3cr3t@github.com/foo/bar.git'
    const r = startBatchImport(
      deps(h, stubResolver(h)),
      { urls: [cred] },
      { userId: 'u_batch_owner' },
    )
    await waitForBatchCompleted(r.batchId)
    const snap = getBatchSnapshot(r.batchId)!
    expect(snap.rows[0]?.inputUrlRedacted).not.toContain('s3cr3t')
    expect(snap.rows[0]?.inputUrl).not.toContain('s3cr3t')
    for (const { msg } of h.events) {
      const s = JSON.stringify(msg)
      expect(s).not.toContain('s3cr3t')
    }
  })

  test('threads the SecretBox into the cache resolver so imported credentials are durable', async () => {
    const h = makeHarness()
    const secretBox = createSecretBoxFromKey(Buffer.alloc(32, 27))
    let receivedSecretBox = false
    const resolver: StubResolver = (async (cacheDeps, input) => {
      receivedSecretBox = cacheDeps.secretBox === secretBox
      return {
        cached: {
          id: 'cr-sealed-import',
          urlRedacted: input.url,
          localPath: '/tmp/cr-sealed-import',
          defaultBranch: 'main',
          lastFetchedAt: '2026-08-25T00:00:00.000Z',
          createdAt: '2026-08-25T00:00:00.000Z',
          referencingTaskCount: 0,
        },
        cold: true,
        fetchOk: true,
        fetchError: null,
      } as Awaited<ReturnType<typeof resolveCachedRepo>>
    }) as StubResolver
    const importDeps = deps(h, resolver)
    importDeps.secretBox = secretBox
    const result = startBatchImport(
      importDeps,
      { urls: ['https://refresh-bot:secret@example.test/repo.git'] },
      { userId: 'u_batch_owner' },
    )

    await waitForBatchCompleted(result.batchId)
    expect(receivedSecretBox).toBe(true)
  })
})

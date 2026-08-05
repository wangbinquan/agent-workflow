// RFC-258 T4 — the code-intel resolver + SCIP index cache. Locks the design
// gate's P0s at behaviour level:
//  - F-03: `local N` SCIP symbols are DOCUMENT-scoped — two files both using
//    `local 0` must never cross-pollinate definitions/references.
//  - F-01/F-02: the cache key is (task, repo, worktree SNAPSHOT digest,
//    indexer) — a body-only edit (symbol manifest unchanged) MUST miss; the
//    same digest must hit without a second indexer spawn.
//  - F-15: concurrent first clicks share ONE indexer run (singleflight) and a
//    failed/unavailable indexer is negative-cached (no per-click re-probe).
//  - F-05/F-07: base-side queries and un-indexed documents degrade to
//    baseline with an honest degradedReason.

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { tasks, workflows } from '../src/db/schema'
import { runGit } from '../src/util/git'
import {
  encodeScipFixture,
  occurrencesOf,
  parseScip,
} from '../src/services/structuralDiff/deep/scip'
import { ScipIndexCache } from '../src/services/structuralDiff/deep/indexCache'
import { worktreeSnapshotDigest } from '../src/services/codeIntel/snapshot'
import { getCodeIntel } from '../src/services/codeIntel/codeIntel'
import type { IndexerProbe } from '../src/services/structuralDiff/deep/indexers'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

async function makeRepo(files: Record<string, string>): Promise<{ dir: string; commit: string }> {
  const dir = tempDir('aw-ci-repo-')
  await runGit(dir, ['init', '-q', '-b', 'main'])
  await runGit(dir, ['config', 'user.email', 't@t.test'])
  await runGit(dir, ['config', 'user.name', 't'])
  for (const [p, content] of Object.entries(files)) writeFileSync(join(dir, p), content)
  await runGit(dir, ['add', '.'])
  await runGit(dir, ['commit', '-q', '-m', 'init'])
  const commit = (await runGit(dir, ['rev-parse', 'HEAD'])).stdout.trim()
  return { dir, commit }
}

async function seedTask(
  db: DbClient,
  opts: { worktreePath: string; baseCommit: string | null },
): Promise<string> {
  const taskId = `01CI${Math.random().toString(36).slice(2, 10).toUpperCase()}`
  const workflowId = `wf-${taskId}`
  await db.insert(workflows).values({
    id: workflowId,
    name: 'w',
    definition: JSON.stringify({ nodes: [], edges: [] }),
    version: 1,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 't',
    workflowId,
    workflowSnapshot: JSON.stringify({ nodes: [], edges: [] }),
    repoPath: opts.worktreePath,
    worktreePath: opts.worktreePath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'done',
    inputs: '{}',
    startedAt: Date.now(),
    baseCommit: opts.baseCommit,
    repoCount: 1,
  })
  return taskId
}

function db(): DbClient {
  return createInMemoryDb(MIGRATIONS)
}

const availableProbe = async (): Promise<IndexerProbe> =>
  ({ available: true, bin: '/fake/indexer' }) as IndexerProbe

describe('SCIP local-symbol document scoping (F-03)', () => {
  test('two documents both emitting `local 0` never cross-pollinate', () => {
    const graph = parseScip(
      encodeScipFixture([
        {
          relativePath: 'a.ts',
          occurrences: [
            { symbol: 'local 0', range: [0, 0, 3], isDefinition: true },
            { symbol: 'local 0', range: [5, 0, 3], isDefinition: false },
          ],
        },
        {
          relativePath: 'b.ts',
          occurrences: [{ symbol: 'local 0', range: [9, 0, 3], isDefinition: true }],
        },
      ]),
    )
    const inA = occurrencesOf(graph, 'local 0', 'a.ts')
    expect(inA).toHaveLength(2)
    expect(inA.every((o) => o.doc === 'a.ts')).toBe(true)
    const inB = occurrencesOf(graph, 'local 0', 'b.ts')
    expect(inB).toHaveLength(1)
    expect(inB[0]?.doc).toBe('b.ts')
  })

  test('global symbols still resolve across documents', () => {
    const graph = parseScip(
      encodeScipFixture([
        {
          relativePath: 'a.ts',
          occurrences: [{ symbol: 'scip . . X#f().', range: [0, 0, 3], isDefinition: true }],
        },
        {
          relativePath: 'b.ts',
          occurrences: [{ symbol: 'scip . . X#f().', range: [4, 0, 3], isDefinition: false }],
        },
      ]),
    )
    expect(occurrencesOf(graph, 'scip . . X#f().', 'a.ts')).toHaveLength(2)
  })
})

describe('worktreeSnapshotDigest (F-01)', () => {
  test('body-only edit (same symbol manifest) still changes the digest; identical bytes do not', async () => {
    const repo = await makeRepo({ 'a.ts': 'export function f() { return 1 }\n' })
    const d1 = await worktreeSnapshotDigest(repo.dir)
    const d1again = await worktreeSnapshotDigest(repo.dir)
    expect(d1again).toBe(d1)
    // body-only edit: name/kind/range identical shape, content differs
    writeFileSync(join(repo.dir, 'a.ts'), 'export function f() { return 2 }\n')
    const d2 = await worktreeSnapshotDigest(repo.dir)
    expect(d2).not.toBe(d1)
  })

  test('an untracked file is part of the snapshot', async () => {
    const repo = await makeRepo({ 'a.ts': 'export const x = 1\n' })
    const d1 = await worktreeSnapshotDigest(repo.dir)
    writeFileSync(join(repo.dir, 'new.ts'), 'export const y = 2\n')
    const d2 = await worktreeSnapshotDigest(repo.dir)
    expect(d2).not.toBe(d1)
  })
})

describe('ScipIndexCache (F-02/F-15)', () => {
  const FIXTURE = encodeScipFixture([
    {
      relativePath: 'a.ts',
      occurrences: [{ symbol: 'scip . . X#f().', range: [0, 0, 3], isDefinition: true }],
    },
  ])

  test('same key hits without a second run; digest change misses', async () => {
    let runs = 0
    const cache = new ScipIndexCache({
      probeIndexer: availableProbe,
      runIndexer: async () => {
        runs += 1
        return { ok: true, scipBytes: FIXTURE }
      },
    })
    const base = {
      taskId: 't1',
      repoKey: '',
      indexerId: 'scip-typescript' as const,
      worktreePath: '/wt',
    }
    const a = await cache.get({ ...base, snapshotDigest: 'd1' })
    const b = await cache.get({ ...base, snapshotDigest: 'd1' })
    expect(a.ok && b.ok).toBe(true)
    expect(runs).toBe(1)
    await cache.get({ ...base, snapshotDigest: 'd2' })
    expect(runs).toBe(2)
  })

  test('concurrent first clicks singleflight into ONE indexer run', async () => {
    let runs = 0
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const cache = new ScipIndexCache({
      probeIndexer: availableProbe,
      runIndexer: async () => {
        runs += 1
        await gate
        return { ok: true, scipBytes: FIXTURE }
      },
    })
    const base = {
      taskId: 't1',
      repoKey: '',
      snapshotDigest: 'd1',
      indexerId: 'scip-typescript' as const,
      worktreePath: '/wt',
    }
    const p1 = cache.get(base)
    const p2 = cache.get(base)
    release()
    const [a, b] = await Promise.all([p1, p2])
    expect(a.ok && b.ok).toBe(true)
    expect(runs).toBe(1)
  })

  test('unavailable indexer is negative-cached until the cooldown lapses', async () => {
    let probes = 0
    let clock = 1_000
    const cache = new ScipIndexCache({
      probeIndexer: async () => {
        probes += 1
        return { available: false } as IndexerProbe
      },
      runIndexer: async () => {
        throw new Error('never')
      },
      now: () => clock,
    })
    const base = {
      taskId: 't1',
      repoKey: '',
      snapshotDigest: 'd1',
      indexerId: 'scip-typescript' as const,
      worktreePath: '/wt',
    }
    expect((await cache.get(base)).ok).toBe(false)
    expect((await cache.get(base)).ok).toBe(false)
    expect(probes).toBe(1) // second click hit the negative cache
    clock += 6 * 60_000
    await cache.get(base)
    expect(probes).toBe(2) // cooldown lapsed → re-probe
  })

  test('per-repo + per-indexer namespacing: keys never collide across repos', async () => {
    const seen: string[] = []
    const cache = new ScipIndexCache({
      probeIndexer: availableProbe,
      runIndexer: async ({ worktreePath }) => {
        seen.push(worktreePath)
        return { ok: true, scipBytes: FIXTURE }
      },
    })
    await cache.get({
      taskId: 't1',
      repoKey: '',
      snapshotDigest: 'd1',
      indexerId: 'scip-typescript',
      worktreePath: '/root',
    })
    await cache.get({
      taskId: 't1',
      repoKey: 'vendor/lib',
      snapshotDigest: 'd1',
      indexerId: 'scip-typescript',
      worktreePath: '/sub',
    })
    expect(seen).toEqual(['/root', '/sub']) // second repo built its own graph
    expect(cache.stats().entries).toBe(2)
  })
})

describe('ScipIndexCache — weight eviction and oversize refusal (P1-9⑥)', () => {
  test('weight-bounded LRU evicts the oldest entry, never the one just built', async () => {
    // Each fixture graph carries ~1.1M occurrences of weight? No — mint two
    // graphs whose occurrence counts straddle the 2M budget.
    const heavy = (n: number, file: string) =>
      encodeScipFixture([
        {
          relativePath: file,
          occurrences: Array.from({ length: n }, (_, i) => ({
            symbol: `scip . . X#f${i}().`,
            range: [i, 0, 3],
            isDefinition: i % 2 === 0,
          })),
        },
      ])
    let which = 0
    const cache = new ScipIndexCache({
      probeIndexer: availableProbe,
      runIndexer: async () => ({
        ok: true,
        scipBytes: which++ === 0 ? heavy(1_200_000, 'a.ts') : heavy(1_200_000, 'b.ts'),
      }),
    })
    const base = {
      taskId: 't1',
      repoKey: '',
      indexerId: 'scip-typescript' as const,
      worktreePath: '/wt',
    }
    const a = await cache.get({ ...base, snapshotDigest: 'd1' })
    expect(a.ok).toBe(true)
    const b = await cache.get({ ...base, snapshotDigest: 'd2' })
    expect(b.ok).toBe(true)
    // total 2.4M > 2M budget → the older d1 entry was evicted, d2 kept
    expect(cache.stats().entries).toBe(1)
    expect(cache.stats().totalWeight).toBeLessThanOrEqual(2_000_000)
  })

  test('a single index above the byte cap is refused, not cached', async () => {
    const cache = new ScipIndexCache({
      probeIndexer: availableProbe,
      runIndexer: async () => ({ ok: true, scipBytes: new Uint8Array(65 * 1024 * 1024) }),
    })
    const res = await cache.get({
      taskId: 't1',
      repoKey: '',
      snapshotDigest: 'd1',
      indexerId: 'scip-typescript',
      worktreePath: '/wt',
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('index-oversized')
    expect(cache.stats().entries).toBe(0)
  })
})

describe('getCodeIntel — engines and degradation', () => {
  test('deep resolves definition + cross-file references from the cached index', async () => {
    const d = db()
    const repo = await makeRepo({ 'a.ts': 'export function f() {}\nf()\n' })
    const taskId = await seedTask(d, { worktreePath: repo.dir, baseCommit: repo.commit })
    const SYM = 'scip . . `a`/f().'
    const cache = new ScipIndexCache({
      probeIndexer: availableProbe,
      runIndexer: async () => ({
        ok: true,
        scipBytes: encodeScipFixture([
          {
            relativePath: 'a.ts',
            occurrences: [
              { symbol: SYM, range: [0, 16, 17], isDefinition: true },
              { symbol: SYM, range: [1, 0, 1], isDefinition: false },
            ],
          },
          {
            relativePath: 'other.ts',
            occurrences: [{ symbol: SYM, range: [4, 2, 3], isDefinition: false }],
          },
        ]),
      }),
    })
    const res = await getCodeIntel(
      d,
      taskId,
      { path: 'a.ts', side: 'worktree', line: 1, col: 17, name: 'f', mode: 'deep' },
      { cache },
    )
    expect(res.engine).toBe('deep')
    expect(res.symbol).toBe(SYM)
    expect(res.definitions).toHaveLength(1)
    expect(res.definitions[0]?.startLine).toBe(1)
    expect(res.references.map((r) => r.filePath).sort()).toEqual(['a.ts', 'other.ts'])
    expect(res.references.every((r) => r.confidence === 'extracted')).toBe(true)
  })

  test('deep miss inside an INDEXED document is a precise empty result, not a degradation (F-07)', async () => {
    const d = db()
    const repo = await makeRepo({ 'a.ts': '// comment\n' })
    const taskId = await seedTask(d, { worktreePath: repo.dir, baseCommit: repo.commit })
    const cache = new ScipIndexCache({
      probeIndexer: availableProbe,
      runIndexer: async () => ({
        ok: true,
        scipBytes: encodeScipFixture([{ relativePath: 'a.ts', occurrences: [] }]),
      }),
    })
    const res = await getCodeIntel(
      d,
      taskId,
      { path: 'a.ts', side: 'worktree', line: 1, col: 4, name: 'comment', mode: 'deep' },
      { cache },
    )
    expect(res.engine).toBe('deep')
    expect(res.degradedReason).toBeUndefined()
    expect(res.definitions).toEqual([])
  })

  test('un-indexed document degrades to baseline with document-not-indexed (F-07)', async () => {
    const d = db()
    const repo = await makeRepo({ 'a.ts': 'export function g() {}\n' })
    const taskId = await seedTask(d, { worktreePath: repo.dir, baseCommit: repo.commit })
    const cache = new ScipIndexCache({
      probeIndexer: availableProbe,
      runIndexer: async () => ({
        ok: true,
        scipBytes: encodeScipFixture([{ relativePath: 'zzz.ts', occurrences: [] }]),
      }),
    })
    const res = await getCodeIntel(
      d,
      taskId,
      { path: 'a.ts', side: 'worktree', line: 1, col: 17, name: 'g', mode: 'deep' },
      { cache },
    )
    expect(res.requestedEngine).toBe('deep')
    expect(res.engine).toBe('baseline')
    expect(res.degradedReason).toBe('document-not-indexed')
    // baseline still answered from the clicked file's own symbols
    expect(res.definitions.map((p) => p.filePath)).toContain('a.ts')
  })

  test('base-side deep request resolves baseline against the BASE revision (F-05)', async () => {
    const d = db()
    const repo = await makeRepo({ 'a.py': 'def old_fn():\n    pass\n' })
    writeFileSync(join(repo.dir, 'a.py'), 'def new_fn():\n    pass\n')
    const taskId = await seedTask(d, { worktreePath: repo.dir, baseCommit: repo.commit })
    const res = await getCodeIntel(d, taskId, {
      path: 'a.py',
      side: 'base',
      line: 1,
      col: 5,
      name: 'old_fn',
      mode: 'deep',
    })
    expect(res.engine).toBe('baseline')
    expect(res.degradedReason).toBe('base-side-not-indexed')
    expect(res.definitions).toHaveLength(1)
    expect(res.definitions[0]?.side).toBe('base')
  })

  test('missing params → code-intel-missing-params', async () => {
    const d = db()
    const repo = await makeRepo({ 'a.ts': 'export const x = 1\n' })
    const taskId = await seedTask(d, { worktreePath: repo.dir, baseCommit: repo.commit })
    await expect(
      getCodeIntel(d, taskId, {
        path: '',
        side: 'worktree',
        line: 1,
        col: 1,
        name: 'x',
        mode: 'baseline',
      }),
    ).rejects.toThrow(/required/)
  })
})

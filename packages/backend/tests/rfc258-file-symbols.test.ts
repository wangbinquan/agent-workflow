// RFC-258 T3 — file-symbols endpoint service: symbol tables for the full-file
// anchor bar / baseline lookups / graph→source resolution. Locks the gate
// findings baked into the contract:
//  - F-04: multi-repo selection is by RFC-248 wire key ('.' = the ROOT repo,
//    whose canonical key is '' and which the legacy label path could not read).
//  - F-09: completeness is an honest 200 state — degraded (partial parse),
//    unsupported (no extractor / binary), parse-error — never a silent 'ok'.
//  - F-05: side='base' reads the base commit's blob, not the worktree.

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { taskRepos, tasks, workflows } from '../src/db/schema'
import { runGit } from '../src/util/git'
import { getTaskFileSymbols } from '../src/services/codeIntel/fileSymbols'

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
  const dir = tempDir('aw-fs-repo-')
  await runGit(dir, ['init', '-q', '-b', 'main'])
  await runGit(dir, ['config', 'user.email', 't@t.test'])
  await runGit(dir, ['config', 'user.name', 't'])
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(join(dir, resolve('/', p, '..').slice(1)), { recursive: true })
    writeFileSync(join(dir, p), content)
  }
  await runGit(dir, ['add', '.'])
  await runGit(dir, ['commit', '-q', '-m', 'init'])
  const commit = (await runGit(dir, ['rev-parse', 'HEAD'])).stdout.trim()
  return { dir, commit }
}

async function seedTask(
  db: DbClient,
  opts: { worktreePath: string; baseCommit: string | null; repoCount?: number },
): Promise<string> {
  const taskId = `01FS${Math.random().toString(36).slice(2, 10).toUpperCase()}`
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
    repoCount: opts.repoCount ?? 1,
  })
  return taskId
}

function db(): DbClient {
  return createInMemoryDb(MIGRATIONS)
}

const TS_SOURCE = `export class OrderService {
  charge(amount: number): void {}
  refund(): void {}
}
export function topLevel(): number { return 1 }
`

describe('getTaskFileSymbols — worktree side', () => {
  test('typescript file yields class + methods + top-level function with 1-based ranges', async () => {
    const d = db()
    const repo = await makeRepo({ 'src/svc.ts': TS_SOURCE })
    const taskId = await seedTask(d, { worktreePath: repo.dir, baseCommit: repo.commit })
    const res = await getTaskFileSymbols(d, taskId, { path: 'src/svc.ts', side: 'worktree' })
    expect(res.lang).toBe('typescript')
    expect(res.status).toBe('ok')
    const names = res.symbols.map((s) => s.qualifiedName)
    expect(names).toContain('OrderService')
    expect(names).toContain('OrderService.charge')
    expect(names).toContain('topLevel')
    const cls = res.symbols.find((s) => s.qualifiedName === 'OrderService')
    expect(cls?.range.startLine).toBe(1)
  })

  test('unsupported language and binary content are honest 200 states (F-09)', async () => {
    const d = db()
    const repo = await makeRepo({ 'notes.txt': 'hello\n', 'bin.dat': 'x\x00y' })
    const taskId = await seedTask(d, { worktreePath: repo.dir, baseCommit: repo.commit })
    const txt = await getTaskFileSymbols(d, taskId, { path: 'notes.txt', side: 'worktree' })
    expect(txt).toMatchObject({ lang: null, status: 'unsupported', symbols: [] })
    const bin = await getTaskFileSymbols(d, taskId, { path: 'bin.dat', side: 'worktree' })
    expect(bin).toMatchObject({ lang: null, status: 'unsupported', symbols: [] })
  })

  test('oversized file → 413 file-symbols-oversized', async () => {
    const d = db()
    const repo = await makeRepo({ 'a.ts': 'export const x = 1\n' })
    writeFileSync(join(repo.dir, 'big.ts'), `// ${'x'.repeat(1_600_000)}\n`)
    const taskId = await seedTask(d, { worktreePath: repo.dir, baseCommit: repo.commit })
    await expect(
      getTaskFileSymbols(d, taskId, { path: 'big.ts', side: 'worktree' }),
    ).rejects.toThrow(/analyzable limit/)
  })

  test('missing path / escaping path / missing file map to the declared error codes', async () => {
    const d = db()
    const repo = await makeRepo({ 'a.ts': 'export const x = 1\n' })
    const taskId = await seedTask(d, { worktreePath: repo.dir, baseCommit: repo.commit })
    await expect(getTaskFileSymbols(d, taskId, { path: '', side: 'worktree' })).rejects.toThrow(
      /path query param required/,
    )
    await expect(
      getTaskFileSymbols(d, taskId, { path: '../out.ts', side: 'worktree' }),
    ).rejects.toThrow(/outside the worktree/)
    await expect(
      getTaskFileSymbols(d, taskId, { path: 'nope.ts', side: 'worktree' }),
    ).rejects.toThrow(/not found/)
  })
})

describe('getTaskFileSymbols — remaining language matrix (P1-9⑦)', () => {
  const CASES: Array<[string, string, string]> = [
    ['m.go', 'package m\nfunc GoFn() {}\n', 'GoFn'],
    ['l.rs', 'pub fn rust_fn() {}\n', 'rust_fn'],
    ['J.java', 'class J { void javaFn() {} }\n', 'javaFn'],
    ['c.cpp', 'void cppFn() {}\n', 'cppFn'],
    ['S.scala', 'object S { def scalaFn(): Int = 1 }\n', 'scalaFn'],
  ]
  for (const [file, source, symbol] of CASES) {
    test(`${file} extracts ${symbol}`, async () => {
      const d = db()
      const repo = await makeRepo({ [file]: source })
      const taskId = await seedTask(d, { worktreePath: repo.dir, baseCommit: repo.commit })
      const res = await getTaskFileSymbols(d, taskId, { path: file, side: 'worktree' })
      expect(res.status === 'ok' || res.status === 'degraded').toBe(true)
      expect(res.symbols.map((s) => s.name)).toContain(symbol)
    })
  }
})

describe('getTaskFileSymbols — base side (F-05)', () => {
  test('reads the base commit blob, not the edited worktree', async () => {
    const d = db()
    const repo = await makeRepo({ 'a.py': 'def old_name():\n    pass\n' })
    // edit the worktree after the commit
    writeFileSync(join(repo.dir, 'a.py'), 'def new_name():\n    pass\n')
    const taskId = await seedTask(d, { worktreePath: repo.dir, baseCommit: repo.commit })
    const base = await getTaskFileSymbols(d, taskId, { path: 'a.py', side: 'base' })
    expect(base.symbols.map((s) => s.name)).toContain('old_name')
    const wt = await getTaskFileSymbols(d, taskId, { path: 'a.py', side: 'worktree' })
    expect(wt.symbols.map((s) => s.name)).toContain('new_name')
  })

  test('no base commit → task-no-base-commit; file absent in base → not-found', async () => {
    const d = db()
    const repo = await makeRepo({ 'a.py': 'x = 1\n' })
    const noBase = await seedTask(d, { worktreePath: repo.dir, baseCommit: null })
    await expect(getTaskFileSymbols(d, noBase, { path: 'a.py', side: 'base' })).rejects.toThrow(
      /no base commit/,
    )
    const taskId = await seedTask(d, { worktreePath: repo.dir, baseCommit: repo.commit })
    writeFileSync(join(repo.dir, 'new.py'), 'y = 2\n')
    await expect(getTaskFileSymbols(d, taskId, { path: 'new.py', side: 'base' })).rejects.toThrow(
      /not in base/,
    )
  })
})

describe('getTaskFileSymbols — multi-repo wire keys (F-04)', () => {
  test("root repo is addressable as '.' and a mounted repo by its mount path", async () => {
    const d = db()
    const root = await makeRepo({ 'root.go': 'package main\nfunc RootFn() {}\n' })
    const sub = await makeRepo({ 'lib.rs': 'pub fn sub_fn() {}\n' })
    const taskId = await seedTask(d, {
      worktreePath: root.dir,
      baseCommit: root.commit,
      repoCount: 2,
    })
    await d.insert(taskRepos).values([
      {
        taskId,
        repoIndex: 0,
        repoPath: root.dir,
        worktreePath: root.dir,
        baseCommit: root.commit,
        branch: 'b0',
        mountPath: '',
      },
      {
        taskId,
        repoIndex: 1,
        repoPath: sub.dir,
        worktreePath: sub.dir,
        baseCommit: sub.commit,
        branch: 'b1',
        mountPath: 'vendor/lib',
      },
    ])
    const rootRes = await getTaskFileSymbols(d, taskId, {
      path: 'root.go',
      side: 'worktree',
      repo: '.',
    })
    expect(rootRes.symbols.map((s) => s.name)).toContain('RootFn')
    const subRes = await getTaskFileSymbols(d, taskId, {
      path: 'lib.rs',
      side: 'worktree',
      repo: 'vendor/lib',
    })
    expect(subRes.symbols.map((s) => s.name)).toContain('sub_fn')
    await expect(
      getTaskFileSymbols(d, taskId, { path: 'root.go', side: 'worktree' }),
    ).rejects.toThrow(/repo query param required/)
    await expect(
      getTaskFileSymbols(d, taskId, { path: 'root.go', side: 'worktree', repo: 'ghost' }),
    ).rejects.toThrow(/not found/)
  })
})

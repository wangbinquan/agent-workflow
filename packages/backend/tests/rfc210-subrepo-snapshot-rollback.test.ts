// RFC-210 T5/T6/T17 — 子仓快照与回滚（G10）+ 全局性能门。
//
// 为什么这些测试存在：
//
//  1. RFC-210 让平台第一次在**用户的 submodule 里造 commit**（iso 内自动提交、
//     auto-commit-push 递归提交）。用户 2026-07-20 拍板要配套回退能力。既有的
//     `gitStashSnapshot`/`rollbackToSnapshot` 用不上——`git stash create` 丢弃
//     untracked，而且 RFC-130 之后 `pre_snapshot` 早已无写入者、列恒 NULL
//     （scheduler.ts 注释："the pre-snapshot … is GONE"）。所以这是一套独立原语。
//
//  2. **pinRef 必填**。快照是 commit-tree 造的 dangling object，没有 ref 就是
//     一次 gc 的事（`util/git.ts` 里 gitStashSnapshot 的注释写过同一条教训）。
//     RFC-210 v2 的签名漏了 pinRef，二轮设计门把它揪了出来。
//
//  3. **嵌套回滚必须两趟**。实测：回滚 `vendor/nested` 会把 `vendor` 的 gitlink
//     弄脏（父仓 status 出现 ' M nested'）。所以先自底向上还原内容，再自顶向下
//     把每层 gitlink 摆回快照记录的 head。
//
//  4. **`hasDirtySubmoduleContent` 的性能门**（AC-11/AC-12）：它过去无条件 spawn
//     `submodule status --recursive`，让每个不含 submodule 的仓平白多一个 git
//     进程，也让 `gitRecurseSubmodules='never'` 无法做到"零 submodule argv"。

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  rollbackSubmodule,
  rollbackSubmodulesRecursive,
  snapshotSubmodule,
  type SubSnapshot,
} from '@/services/gitSubmodule'
import { hasDirtySubmoduleContent } from '@/util/git'

function git(cwd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const p = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    p.stdout.on('data', (d: Buffer) => (out += d.toString()))
    p.stderr.on('data', (d: Buffer) => (out += d.toString()))
    p.on('close', (code) => resolve({ code: code ?? 1, out: out.trim() }))
    p.on('error', () => resolve({ code: 1, out: 'spawn failed' }))
  })
}

let root = ''
let prevGlobal: string | undefined

async function initRepo(dir: string, file: string, content: string): Promise<void> {
  mkdirSync(dir, { recursive: true })
  await git(dir, ['init', '-q', '-b', 'main'])
  writeFileSync(join(dir, file), content)
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-qm', 'init'])
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'aw-rfc210-snap-'))
  const cfg = join(root, 'gitconfig')
  writeFileSync(cfg, '[protocol "file"]\n\tallow = always\n[user]\n\tname = t\n\temail = t@t\n')
  prevGlobal = process.env.GIT_CONFIG_GLOBAL
  process.env.GIT_CONFIG_GLOBAL = cfg
})

afterAll(() => {
  if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
  else process.env.GIT_CONFIG_GLOBAL = prevGlobal
  if (root !== '') rmSync(root, { recursive: true, force: true })
})

describe('RFC-210 submodule snapshot / rollback', () => {
  test('captures tracked + untracked without touching the real index or HEAD', async () => {
    const repo = join(root, 'snap1')
    await initRepo(repo, 'a.txt', 'v1\n')
    const headBefore = (await git(repo, ['rev-parse', 'HEAD'])).out

    writeFileSync(join(repo, 'a.txt'), 'dirty\n')
    writeFileSync(join(repo, 'untracked.txt'), 'NEW\n')

    const snap = await snapshotSubmodule(repo, 'refs/aw-test/snap1')
    expect(snap.head).toBe(headBefore)

    const listed = (await git(repo, ['ls-tree', '--name-only', snap.snapshot])).out.split('\n')
    expect(listed).toContain('a.txt')
    expect(listed).toContain('untracked.txt') // git stash create would have dropped this

    // Real state untouched: still dirty, HEAD unmoved.
    expect((await git(repo, ['rev-parse', 'HEAD'])).out).toBe(headBefore)
    expect((await git(repo, ['status', '--porcelain'])).out).toContain('?? untracked.txt')
  })

  test('rollback undoes a platform commit and restores tracked + untracked', async () => {
    const repo = join(root, 'snap2')
    await initRepo(repo, 'a.txt', 'v1\n')
    const head = (await git(repo, ['rev-parse', 'HEAD'])).out

    writeFileSync(join(repo, 'a.txt'), 'dirty\n')
    writeFileSync(join(repo, 'untracked.txt'), 'NEW\n')
    const snap = await snapshotSubmodule(repo, 'refs/aw-test/snap2')

    // Platform commits on the user's behalf (what §2.2 / §5.1 will do).
    await git(repo, ['add', '-A'])
    await git(repo, ['commit', '-qm', 'aw: auto-commit'])
    expect((await git(repo, ['rev-list', '--count', 'HEAD'])).out).toBe('2')

    await rollbackSubmodule(repo, snap)

    expect((await git(repo, ['rev-parse', 'HEAD'])).out).toBe(head)
    expect((await git(repo, ['rev-list', '--count', 'HEAD'])).out).toBe('1')
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('dirty\n')
    expect(readFileSync(join(repo, 'untracked.txt'), 'utf8')).toBe('NEW\n')
    // Pin is dropped so the snapshot doesn't linger in the user's odb.
    expect((await git(repo, ['rev-parse', '--verify', 'refs/aw-test/snap2'])).code).not.toBe(0)
  })

  test('pinRef keeps the snapshot alive across a pruning gc', async () => {
    const repo = join(root, 'snap3')
    await initRepo(repo, 'a.txt', 'v1\n')
    writeFileSync(join(repo, 'a.txt'), 'dirty\n')
    const snap = await snapshotSubmodule(repo, 'refs/aw-test/snap3')

    await git(repo, ['reflog', 'expire', '--expire=now', '--all'])
    await git(repo, ['gc', '--prune=now', '--quiet'])
    expect((await git(repo, ['cat-file', '-t', snap.snapshot])).out).toBe('commit')
  }, 30_000)

  test('recursive rollback restores nested content and leaves no dirty parent gitlink', async () => {
    const inner = join(root, 'inner-src')
    await initRepo(inner, 'i.txt', 'i1\n')
    const mid = join(root, 'mid-src')
    await initRepo(mid, 's.txt', 's1\n')
    await git(mid, ['submodule', 'add', '-q', inner, 'nested'])
    await git(mid, ['commit', '-qm', 'add nested'])

    const parent = join(root, 'parent')
    await initRepo(parent, 'r.txt', 'r1\n')
    await git(parent, ['submodule', 'add', '-q', mid, 'vendor'])
    await git(parent, ['commit', '-qm', 'add vendor'])
    await git(parent, ['submodule', 'update', '--init', '--recursive', '-q'])

    const vendor = join(parent, 'vendor')
    const nested = join(parent, 'vendor', 'nested')

    writeFileSync(join(vendor, 's.txt'), 's-dirty\n')
    writeFileSync(join(nested, 'i.txt'), 'i-dirty\n')

    const snaps: Record<string, SubSnapshot> = {
      vendor: await snapshotSubmodule(vendor, 'refs/aw-test/rec-vendor'),
      'vendor/nested': await snapshotSubmodule(nested, 'refs/aw-test/rec-nested'),
    }

    // Platform commits bottom-up, exactly as §2.2 prescribes.
    await git(nested, ['add', '-A'])
    await git(nested, ['commit', '-qm', 'aw: nested'])
    await git(vendor, ['add', '-A'])
    await git(vendor, ['commit', '-qm', 'aw: vendor'])

    await rollbackSubmodulesRecursive(parent, snaps)

    expect(readFileSync(join(vendor, 's.txt'), 'utf8')).toBe('s-dirty\n')
    expect(readFileSync(join(nested, 'i.txt'), 'utf8')).toBe('i-dirty\n')
    expect((await git(nested, ['rev-parse', 'HEAD'])).out).toBe(
      (snaps['vendor/nested'] as SubSnapshot).head,
    )
    expect((await git(vendor, ['rev-parse', 'HEAD'])).out).toBe(
      (snaps['vendor'] as SubSnapshot).head,
    )

    // What the second pass guarantees is GITLINK COHERENCE: `vendor`'s index
    // entry for `nested` must equal `nested`'s actual HEAD.
    //
    // It deliberately does NOT make `vendor`'s status empty — the snapshot
    // captured `nested` in a DIRTY state (i.txt edited, uncommitted), rollback
    // faithfully restores that dirt, and a superproject always reports a
    // submodule with uncommitted content as modified. An empty-status assertion
    // here would be asserting that rollback silently discarded the user's edits.
    const idxEntry = (await git(vendor, ['ls-files', '-s', 'nested'])).out
    expect(idxEntry.split(/\s+/)[1]).toBe((snaps['vendor/nested'] as SubSnapshot).head)
  }, 90_000)
})

describe('RFC-210 detectSubmodules performance gate', () => {
  test('hasDirtySubmoduleContent short-circuits when .gitmodules is absent', async () => {
    const repo = join(root, 'nosub')
    await initRepo(repo, 'a.txt', 'v1\n')
    expect(existsSync(join(repo, '.gitmodules'))).toBe(false)
    expect(await hasDirtySubmoduleContent(repo)).toBe(false)
  })

  test('source-level lock: the existsSync gate precedes any runGit call', () => {
    // Behavioural assertions cannot observe "zero processes spawned" here, so the
    // ordering is pinned in source. If someone moves the probe below the git call,
    // AC-11 ("never ⟹ zero submodule argv") silently regresses.
    const src = readFileSync(resolve(import.meta.dir, '..', 'src', 'util', 'git.ts'), 'utf8')
    const fn = src.slice(src.indexOf('export async function hasDirtySubmoduleContent'))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    const gateAt = body.indexOf(".gitmodules'")
    const firstGitAt = body.indexOf('runGit(')
    expect(gateAt).toBeGreaterThan(-1)
    expect(firstGitAt).toBeGreaterThan(-1)
    expect(gateAt).toBeLessThan(firstGitAt)
  })
})

// RFC-248/RFC-308 — surviving repository primitives. The preset-commit suite
// was deleted: platform exclusions now live in the RFC-308 profile test and
// never edit business .gitignore.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'
import {
  applySparseSubdir,
  createWorktree,
  findTrackedPathUnderMounts,
  nonInteractiveGitEnv,
} from '../src/util/git'

let tmp = ''
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'aw-rfc248-git-'))
})
afterEach(() => {
  if (tmp !== '') rmSync(tmp, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: nonInteractiveGitEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function makeRepo(name: string, files: Record<string, string>): string {
  const dir = join(tmp, name)
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@example.invalid')
  git(dir, 'config', 'user.name', 'Test')
  for (const [path, content] of Object.entries(files)) {
    const abs = join(dir, path)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content)
  }
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'seed')
  return dir
}

// **每条用例都显式给了 60s 预算**（2026-09-07 实撞）：这些用例的 `makeRepo` 要连续 spawn
// 好几次 `git`（init / config ×2 / add / commit），bun 默认的 5000ms 在**空载**机器上够、
// 在 CI 的 macOS runner 上不够——实测 `git config user.name Test` 在 5010ms 被 SIGTERM 掐断，
// 报出来的却是「用例超时」，看上去像 `findTrackedPathUnderMounts` 的逻辑坏了。
//
// 与本仓 `rfc199-workflow-validation-context-ratchet` 的 120s 同一类处置：**凡是 spawn 外部进程
// 或扫全源码树的用例，都要显式给足预算**。窄预算在这种用例上迟早假红，而假红会掩盖真红。
// 见 `docs/dev-gotchas.md` §「『扫全源码树』的守卫用例要显式给超时」。

describe('applySparseSubdir（D17）', () => {
  test('non-cone checkout contains only the selected subtree', async () => {
    const repo = makeRepo('sparse', {
      'guides/a.md': 'a',
      'api/b.md': 'b',
      'README.md': 'root',
    })
    const wt = join(tmp, 'wt')
    await createWorktree({ repoPath: repo, taskId: ulid(), appHome: tmp, overrideWorktreePath: wt })
    await applySparseSubdir(wt, 'guides')
    expect(existsSync(join(wt, 'guides/a.md'))).toBe(true)
    expect(existsSync(join(wt, 'api'))).toBe(false)
    expect(existsSync(join(wt, 'README.md'))).toBe(false)
  }, 60_000)
})

describe('branchName 覆盖（D14）', () => {
  test('same source repo can own two worktrees on suffixed branches', async () => {
    const repo = makeRepo('branches', { 'f.txt': 'f' })
    const taskId = ulid()
    const wt1 = join(tmp, 'wt1')
    const wt2 = join(tmp, 'wt2')
    await createWorktree({
      repoPath: repo,
      taskId,
      appHome: tmp,
      overrideWorktreePath: wt1,
      branchName: `agent-workflow/${taskId}`,
    })
    await createWorktree({
      repoPath: repo,
      taskId,
      appHome: tmp,
      overrideWorktreePath: wt2,
      branchName: `agent-workflow/${taskId}-2`,
    })
    expect(git(wt1, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(`agent-workflow/${taskId}`)
    expect(git(wt2, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(`agent-workflow/${taskId}-2`)
  }, 60_000)
})

describe('findTrackedPathUnderMounts（设计门二轮 H8）', () => {
  test('finds tracked descendants even when a sparse worktree hides them', async () => {
    const repo = makeRepo('container', {
      'hidden/dep/file.txt': 'x',
      'visible/keep.txt': 'v',
    })
    expect(await findTrackedPathUnderMounts(repo, 'HEAD', ['hidden/dep'])).toEqual({
      mountRel: 'hidden/dep',
      trackedPath: 'hidden/dep/file.txt',
    })

    const wt = join(tmp, 'sparse-wt')
    await createWorktree({
      repoPath: repo,
      taskId: ulid(),
      appHome: tmp,
      overrideWorktreePath: wt,
      sparseSubdir: 'visible',
    })
    expect(existsSync(join(wt, 'hidden'))).toBe(false)
    expect(await findTrackedPathUnderMounts(repo, 'HEAD', ['hidden/dep'])).not.toBeNull()
  }, 60_000)

  test('returns null for empty or segment-neighbor mounts', async () => {
    const repo = makeRepo('clean', { 'vendor/xy/f': 'f' })
    expect(await findTrackedPathUnderMounts(repo, 'HEAD', [])).toBeNull()
    expect(await findTrackedPathUnderMounts(repo, 'HEAD', ['vendor/x'])).toBeNull()
  }, 60_000)
})

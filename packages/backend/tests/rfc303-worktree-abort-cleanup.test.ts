// RFC-303 launch cancellation can kill `git worktree add` after Git has
// mutated the common registry/ref but before the helper receives provenance.
// These tests deterministically materialize both ambiguous outcomes at the
// lifecycle seam: launch-owned residue must be reclaimed, while a directory
// that existed before spawn must never be removed.
import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createWorktree } from '@/util/git'

const roots: string[] = []

function fixture(): { root: string; repoPath: string; appHome: string } {
  const root = mkdtempSync(join(tmpdir(), 'aw-rfc303-worktree-abort-'))
  roots.push(root)
  const repoPath = join(root, 'repo')
  const appHome = join(root, 'home')
  mkdirSync(repoPath, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoPath })
  writeFileSync(join(repoPath, 'README.md'), 'base\n')
  execFileSync('git', ['add', 'README.md'], { cwd: repoPath })
  execFileSync(
    'git',
    ['-c', 'user.name=RFC303', '-c', 'user.email=rfc303@example.test', 'commit', '-qm', 'base'],
    { cwd: repoPath },
  )
  return { root, repoPath, appHome }
}

function worktreeRegistry(repoPath: string): string {
  return execFileSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: repoPath,
    encoding: 'utf8',
  })
}

/**
 * 被 abort 掐掉的 `git worktree add` 可能把 `refs/heads/<branch>.lock` 留在仓里
 * （2026-09-04 实测：CI 的 ubuntu shard 2/4 上本用例因此红过一次，同一轮之前是绿的）。
 * 用例接下来要在**同一个分支名**上重新 `worktree add` 来复现「crash 后的残留形态」，
 * 撞上那把残锁就会拿到 `cannot lock ref … File exists`，而那与本用例要验的东西无关。
 *
 * 这里只让**用例的复现步骤**对残锁鲁棒：等锁自然消失，超时就删掉它再重试一次。
 * ⚠️ 产品侧的问题是另一回事——「被杀掉的 git 子进程留下的 stale lock 该由谁清」目前
 * 平台没有任何路径处理，那属于 RFC-356（残留工作树回收）的刀口，不在本文件里补。
 */
function addWorktreeToleratingStaleRefLock(
  repoPath: string,
  branch: string,
  branchRef: string,
  worktreePath: string,
): void {
  const lockPath = join(repoPath, '.git', `${branchRef}.lock`)
  for (let attempt = 0; ; attempt += 1) {
    try {
      execFileSync('git', ['worktree', 'add', '-q', '-b', branch, worktreePath, 'HEAD'], {
        cwd: repoPath,
      })
      return
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('cannot lock ref') || attempt >= 20) throw error
      if (attempt === 19) rmSync(lockPath, { force: true })
      else Bun.sleepSync(25)
    }
  }
}

function branchExists(repoPath: string, branchRef: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', branchRef], {
      cwd: repoPath,
      stdio: 'ignore',
    })
    return true
  } catch {
    return false
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('RFC-303 aborted worktree materialization cleanup', () => {
  test('reclaims a launch-owned registration, directory, and branch created before kill settles', async () => {
    const { repoPath, appHome } = fixture()
    const controller = new AbortController()
    let worktreePath = ''
    let branchRef = ''

    try {
      await createWorktree({
        repoPath,
        appHome,
        taskId: 'terminal-race',
        signal: controller.signal,
        lifecycleHook: (event) => {
          if (event.stage === 'before-worktree-add') controller.abort()
          if (event.stage !== 'worktree-add-failed-before-cleanup') return
          worktreePath = event.worktreePath
          branchRef = event.branchRef

          // Normalize any platform-dependent partial result, then materialize
          // the exact post-ref/post-registration crash shape for reconciliation.
          if (worktreeRegistry(repoPath).includes(`worktree ${event.worktreePath}\n`)) {
            execFileSync('git', ['worktree', 'remove', '--force', event.worktreePath], {
              cwd: repoPath,
            })
          }
          if (branchExists(repoPath, event.branchRef)) {
            execFileSync('git', ['update-ref', '-d', event.branchRef], { cwd: repoPath })
          }
          rmSync(event.worktreePath, { recursive: true, force: true })
          addWorktreeToleratingStaleRefLock(
            repoPath,
            event.branch,
            event.branchRef,
            event.worktreePath,
          )
        },
      })
      throw new Error('expected terminal launch revocation')
    } catch (error) {
      expect(error).toMatchObject({ code: 'webhook-mr-launch-terminal' })
    }

    expect(worktreePath).not.toBe('')
    expect(existsSync(worktreePath)).toBe(false)
    expect(worktreeRegistry(repoPath)).not.toContain(worktreePath)
    expect(branchExists(repoPath, branchRef)).toBe(false)
  })

  test('preserves a non-empty directory that existed before the aborted add', async () => {
    const { root, repoPath, appHome } = fixture()
    const worktreePath = join(root, 'pre-existing')
    const sentinel = join(worktreePath, 'KEEP.txt')
    mkdirSync(worktreePath, { recursive: true })
    writeFileSync(sentinel, 'belongs to somebody else\n')
    const controller = new AbortController()

    try {
      await createWorktree({
        repoPath,
        appHome,
        taskId: 'occupied-path',
        overrideWorktreePath: worktreePath,
        signal: controller.signal,
        lifecycleHook: (event) => {
          if (event.stage === 'before-worktree-add') controller.abort()
        },
      })
      throw new Error('expected terminal launch revocation')
    } catch (error) {
      expect(error).toMatchObject({ code: 'webhook-mr-launch-terminal' })
    }

    expect(readFileSync(sentinel, 'utf8')).toBe('belongs to somebody else\n')
    expect(worktreeRegistry(repoPath)).not.toContain(worktreePath)
  })
})

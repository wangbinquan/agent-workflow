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
          execFileSync(
            'git',
            ['worktree', 'add', '-q', '-b', event.branch, event.worktreePath, 'HEAD'],
            { cwd: repoPath },
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

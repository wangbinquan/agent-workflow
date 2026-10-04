// RFC-370's native ownership split must preserve existing function/class
// identity. Old direct consumers continue to use the exact native helpers;
// cleanup alone owns the Task receipt shell.
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as legacy from '@/services/nodeIsolation'
import * as native from '@/platform/workspace/local/isolation'
import { discardNodeIso } from '@/modules/task-execution/infrastructure/isolationCleanup'
import { repoRelForcedPaths as taskPaths } from '@/modules/task-execution/public/queries'
import { repoRelForcedPaths as sourcePaths } from '@/modules/source-control/public/queries'
import { runGit } from '@/util/git'
import { removeTempDirSync } from './fixtures/tempDir'

describe('RFC-370 isolation native compatibility', () => {
  test('every legacy native runtime export keeps the original object identity', () => {
    for (const [name, value] of Object.entries(native)) {
      if (name === 'discardIsolationWorkspace') continue
      expect((legacy as Record<string, unknown>)[name], name).toBe(value)
    }
    expect(legacy.discardNodeIso).toBe(discardNodeIso)
    expect('discardIsolationWorkspace' in legacy).toBe(false)
  })

  test('the canonical workspace error retains native class identity and its old payload', () => {
    const error = new legacy.CanonicalWorktreeMissingError('original-workspace')
    expect(error).toBeInstanceOf(native.CanonicalWorktreeMissingError)
    expect(error.code).toBe('workspace-missing')
    expect(error.worktreePath).toBe('original-workspace')
    expect(error.message).toBe(
      'workspace-missing: canonical worktree does not exist: original-workspace',
    )
  })

  test('the old Task path mapper is the same source-control domain function', () => {
    expect(taskPaths).toBe(sourcePaths)
  })

  test('cleanup decides passthrough once before its receipt await', async () => {
    const canon = mkdtempSync(join(tmpdir(), 'aw-rfc370-cleanup-canon-'))
    const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc370-cleanup-home-'))
    try {
      expect((await runGit(canon, ['init', '-q', '-b', 'main'])).exitCode).toBe(0)
      expect((await runGit(canon, ['config', 'user.email', 't@e.com'])).exitCode).toBe(0)
      expect((await runGit(canon, ['config', 'user.name', 'T'])).exitCode).toBe(0)
      writeFileSync(join(canon, 'base.txt'), 'base\n')
      expect((await runGit(canon, ['add', '.'])).exitCode).toBe(0)
      expect((await runGit(canon, ['commit', '-q', '-m', 'init'])).exitCode).toBe(0)
      const handle = await legacy.createNodeIso({
        appHome,
        taskId: 'rfc370-cleanup-decision',
        nodeRunId: 'actual-run',
        canonRepos: [
          { repoPath: canon, worktreePath: canon, worktreeDirName: '', baseBranch: 'main' },
        ],
      })
      const iso = handle.repos[0]!.isoWorktreePath
      expect(handle.passthrough).toBe(false)
      expect(existsSync(iso)).toBe(true)
      let reads = 0
      Object.defineProperty(handle, 'passthrough', {
        get() {
          reads += 1
          return reads > 1
        },
      })
      await legacy.discardNodeIso(handle)
      expect(reads).toBe(1)
      expect(existsSync(iso)).toBe(false)
      expect(existsSync(join(canon, 'base.txt'))).toBe(true)
    } finally {
      removeTempDirSync(appHome)
      removeTempDirSync(canon)
    }
  }, 60_000)
})

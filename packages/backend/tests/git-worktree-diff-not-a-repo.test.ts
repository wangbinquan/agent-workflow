import { rimrafDir } from './helpers/cleanup'
// Regression: the task detail "工作目录 diff" tab surfaced the raw error
//   worktree-diff-failed: git diff failed: warning: not a git repository. <...600-line git --no-index usage dump...>
// whenever a task's worktree directory still existed on disk but was no longer
// a git repository (its source repo had been moved/deleted, so the linked
// worktree's gitdir pointer dangled — or the dir simply never had a `.git`).
// `existsSync(worktreePath)` passed, so the 410 guard in getTaskDiff was
// skipped and `gitDiffSnapshot` blew up as a 500.
//
// Two-part fix locked here:
//   1. `isGitWorkTree` distinguishes a real work tree from a dir that merely
//      exists — getTaskDiff uses it to return a clean 410 (see tasks.test.ts).
//   2. `gitDiffSnapshot` collapses git's "not a git repository" failure (the
//      `--no-index` usage block) into one actionable line instead of echoing
//      hundreds of lines of stderr.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitDiffSnapshot, isGitWorkTree, runGit } from '../src/util/git'

interface Fixture {
  /** A real git work tree with one commit on `main`. */
  repo: string
  /** A directory that exists but has never been `git init`-ed. */
  plain: string
  /** A linked worktree whose source repo has been deleted (dangling gitdir). */
  dangling: string
  cleanup: () => void
}

async function initRepo(path: string): Promise<void> {
  mkdirSync(path)
  await runGit(path, ['init', '-q', '-b', 'main'])
  await runGit(path, ['config', 'user.email', 'test@example.com'])
  await runGit(path, ['config', 'user.name', 'Test'])
  await runGit(path, ['commit', '-q', '--allow-empty', '-m', 'init'])
}

async function buildFixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'aw-notrepo-'))

  const repo = join(root, 'repo')
  await initRepo(repo)

  // A directory that exists but was never git-init-ed (no `.git` at all).
  const plain = join(root, 'plain')
  mkdirSync(plain)

  // A linked worktree whose source repo we then delete: the worktree dir and
  // its `.git` *file* survive, but the gitdir it points at is gone.
  const source = join(root, 'src')
  await initRepo(source)
  const dangling = join(root, 'wt')
  await runGit(source, ['worktree', 'add', '-q', dangling])
  rimrafDir(source)

  return {
    repo,
    plain,
    dangling,
    cleanup: () => rimrafDir(root),
  }
}

describe('isGitWorkTree', () => {
  let f: Fixture
  beforeEach(async () => {
    f = await buildFixture()
  })
  afterEach(() => f.cleanup())

  test('true for a real git work tree', async () => {
    expect(await isGitWorkTree(f.repo)).toBe(true)
  })

  test('false for a directory that exists but was never git-init-ed', async () => {
    expect(await isGitWorkTree(f.plain)).toBe(false)
  })

  test('false for a missing path', async () => {
    expect(await isGitWorkTree(join(f.repo, 'does-not-exist'))).toBe(false)
  })

  test('false for a worktree whose source repo was deleted (dangling gitdir)', async () => {
    // The directory and its `.git` file still exist on disk — `existsSync`
    // would say true — but git can no longer resolve it. This is the exact
    // shape that produced the reported "worktree-diff-failed" 500.
    expect(await isGitWorkTree(f.dangling)).toBe(false)
  })
})

describe('gitDiffSnapshot on a non-git directory', () => {
  let f: Fixture
  beforeEach(async () => {
    f = await buildFixture()
  })
  afterEach(() => f.cleanup())

  test("throws a concise message, NOT git's --no-index usage dump", async () => {
    let caught: unknown
    try {
      await gitDiffSnapshot(f.plain, 'HEAD')
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(Error)
    const msg = (caught as Error).message
    // The actionable summary names the path and the cause...
    expect(msg).toContain('is not a git repository')
    expect(msg).toContain(f.plain)
    // ...and crucially does NOT echo git's giant `--no-index` usage block, which
    // is what reached the UI before the fix.
    expect(msg).not.toContain('usage: git diff --no-index')
    expect(msg).not.toContain('--unified')
    expect(msg.length).toBeLessThan(300)
  })

  test('also collapses the dangling-worktree (fatal) variant', async () => {
    let caught: unknown
    try {
      await gitDiffSnapshot(f.dangling, 'HEAD')
    } catch (e) {
      caught = e
    }
    const msg = (caught as Error).message
    expect(msg).toContain('is not a git repository')
    // Raw git stderr here is `fatal: not a git repository: <...>/worktrees/<id>`;
    // the concise message must not leak that prefix / internal gitdir path.
    expect(msg).not.toContain('fatal:')
  })
})

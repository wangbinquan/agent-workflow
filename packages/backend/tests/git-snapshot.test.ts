// gitStashSnapshot + rollbackToSnapshot end-to-end against a real git
// fixture (P-3-07).

// RFC-395 II-a A2 update (the original rationale above is retained as history):
// RFC-395 II-a A2: historical stash fixtures exercise surviving rollback and diff behavior.

import { legacyStashSnapshotFixture } from './helpers/legacyStashSnapshot'
import { rollbackNodeRunWorktrees } from '@/services/nodeRollback'
import { createLogger } from '@/util/log'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitDiffSnapshot, rollbackToSnapshot, runGit } from '../src/util/git'

interface Repo {
  path: string
  cleanup: () => void
}

async function buildRepo(): Promise<Repo> {
  const path = mkdtempSync(join(tmpdir(), 'aw-snap-'))
  await runGit(path, ['init', '-q', '-b', 'main'])
  await runGit(path, ['config', 'user.email', 'test@example.com'])
  await runGit(path, ['config', 'user.name', 'Test'])
  writeFileSync(join(path, 'a.txt'), 'original\n')
  await runGit(path, ['add', '.'])
  await runGit(path, ['commit', '-q', '-m', 'init'])
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) }
}

describe('historical snapshots and rollbackToSnapshot', () => {
  let r: Repo
  beforeEach(async () => {
    r = await buildRepo()
  })
  afterEach(() => r.cleanup())

  test('historical clean-tree marker skips resume rollback after later edits', async () => {
    const snapshot = await legacyStashSnapshotFixture(r.path)
    expect(snapshot).toBe('')
    writeFileSync(join(r.path, 'a.txt'), 'later\n')
    const outcome = await rollbackNodeRunWorktrees(
      { worktreePath: r.path, repos: [] },
      {
        id: 'historical-clean',
        checkpoints: [{ mountPath: '', preSnapshot: snapshot }],
        checkpointScope: 'workspace' as const,
      },
      {},
      createLogger('snapshot-fixture'),
    )
    expect(outcome).toEqual({ attempted: false, failures: [] })
    expect(readFileSync(join(r.path, 'a.txt'), 'utf8')).toBe('later\n')
  })

  test('rollback accepts a historical unreferenced stash object', async () => {
    writeFileSync(join(r.path, 'a.txt'), 'modified\n')
    const sha = await legacyStashSnapshotFixture(r.path)
    expect(sha).toMatch(/^[a-f0-9]{40}$/)
    // git stash create does NOT push to stash list; verify the entry isn't
    // there but the commit object is reachable.
    const list = await runGit(r.path, ['stash', 'list'])
    expect(list.stdout.trim()).toBe('')
    const cat = await runGit(r.path, ['cat-file', '-t', sha])
    expect(cat.stdout.trim()).toBe('commit')
    writeFileSync(join(r.path, 'a.txt'), 'later\n')
    await rollbackToSnapshot(r.path, sha)
    expect(readFileSync(join(r.path, 'a.txt'), 'utf8')).toBe('modified\n')
  })

  test('historical empty marker preserves untracked files on resume', async () => {
    writeFileSync(join(r.path, 'fresh.txt'), 'new\n')
    const sha = await legacyStashSnapshotFixture(r.path)
    expect(sha).toBe('')
    const outcome = await rollbackNodeRunWorktrees(
      { worktreePath: r.path, repos: [] },
      {
        id: 'historical-untracked',
        checkpoints: [{ mountPath: '', preSnapshot: sha }],
        checkpointScope: 'workspace' as const,
      },
      {},
      createLogger('snapshot-fixture'),
    )
    expect(outcome).toEqual({ attempted: false, failures: [] })
    expect(readFileSync(join(r.path, 'fresh.txt'), 'utf8')).toBe('new\n')
  })

  test('rollback restores the snapshot after subsequent edits', async () => {
    writeFileSync(join(r.path, 'a.txt'), 'snap-time\n')
    const sha = await legacyStashSnapshotFixture(r.path)

    // Simulate an agent write that we want to undo.
    writeFileSync(join(r.path, 'a.txt'), 'post-snap garbage\n')
    writeFileSync(join(r.path, 'new.txt'), 'unwanted\n')

    await rollbackToSnapshot(r.path, sha)

    expect(readFileSync(join(r.path, 'a.txt'), 'utf-8')).toBe('snap-time\n')
    expect(existsSync(join(r.path, 'new.txt'))).toBe(false)
  })

  test('rollback with empty sha just resets + cleans', async () => {
    writeFileSync(join(r.path, 'a.txt'), 'changed\n')
    writeFileSync(join(r.path, 'extra.txt'), 'extra\n')
    await rollbackToSnapshot(r.path, '')
    expect(readFileSync(join(r.path, 'a.txt'), 'utf-8')).toBe('original\n')
    expect(existsSync(join(r.path, 'extra.txt'))).toBe(false)
  })

  test('rollback with unknown sha → snapshot-missing, worktree untouched (RFC-098 WP-9 fail-closed)', async () => {
    // FLIPPED by RFC-098 B2: pre-fix this threw 'worktree-apply-failed' AFTER
    // reset --hard + clean -fd had already destroyed the dirty state. The
    // fail-closed head check ('cat-file -e <sha>^{commit}') now rejects with
    // 'snapshot-missing' BEFORE any destructive git command runs.
    writeFileSync(join(r.path, 'a.txt'), 'changed\n')
    writeFileSync(join(r.path, 'extra.txt'), 'extra\n')
    await expect(rollbackToSnapshot(r.path, 'deadbeef'.repeat(5))).rejects.toMatchObject({
      code: 'snapshot-missing',
    })
    // Worktree untouched: no reset --hard (tracked change kept), no clean -fd
    // (untracked file kept).
    expect(readFileSync(join(r.path, 'a.txt'), 'utf-8')).toBe('changed\n')
    expect(existsSync(join(r.path, 'extra.txt'))).toBe(true)
  })
})

describe('gitDiffSnapshot — untracked file regression coverage', () => {
  // Locks in the fix for the bug where any task whose only diff was an
  // untracked file with a non-ASCII path produced an empty `worktreeDiff`
  // (and therefore an empty review payload). Cause: ls-files defaulted to
  // `core.quotepath=true`, returning a C-escaped, double-quoted name that
  // the subsequent `git diff --no-index` could not open.
  let r: Repo
  beforeEach(async () => {
    r = await buildRepo()
  })
  afterEach(() => r.cleanup())

  test('captures untracked ASCII file as add diff', async () => {
    writeFileSync(join(r.path, 'NEWFILE.md'), 'hello\n')
    const head = (await runGit(r.path, ['rev-parse', 'HEAD'])).stdout.trim()
    const diff = await gitDiffSnapshot(r.path, head)
    expect(diff).toContain('+++ b/NEWFILE.md')
    expect(diff).toContain('+hello')
  })

  test('captures untracked file whose path contains non-ASCII (Chinese) chars', async () => {
    mkdirSync(join(r.path, 'docs'))
    const name = 'docs/贪吃蛇游戏软件设计说明书.md'
    writeFileSync(join(r.path, name), '# 设计\n正文\n')
    const head = (await runGit(r.path, ['rev-parse', 'HEAD'])).stdout.trim()
    const diff = await gitDiffSnapshot(r.path, head)
    expect(diff).toContain(`+++ b/${name}`)
    expect(diff).toContain('+# 设计')
  })

  test('captures untracked file whose name contains spaces', async () => {
    writeFileSync(join(r.path, 'has space.md'), 'spaced\n')
    const head = (await runGit(r.path, ['rev-parse', 'HEAD'])).stdout.trim()
    const diff = await gitDiffSnapshot(r.path, head)
    expect(diff).toContain('has space.md')
    expect(diff).toContain('+spaced')
  })

  // Locks the fix for a UI bug where untracked-only diffs began with a
  // stray '\n', which the frontend DiffViewer split into a phantom
  // `(preamble)` block above the first real file.
  test('untracked-only diff has no leading blank line', async () => {
    writeFileSync(join(r.path, 'NEWFILE.md'), 'hello\n')
    const head = (await runGit(r.path, ['rev-parse', 'HEAD'])).stdout.trim()
    const diff = await gitDiffSnapshot(r.path, head)
    expect(diff.startsWith('diff --git ')).toBe(true)
    expect(diff[0]).not.toBe('\n')
  })

  test('tracked + untracked diff joins without an empty line between them', async () => {
    // Modify the tracked seed file AND add an untracked one; the boundary
    // between the two `diff --git` blocks must be a single '\n', not two
    // (which would render as a `(preamble)`-style empty block in the UI).
    writeFileSync(join(r.path, 'a.txt'), 'changed\n')
    writeFileSync(join(r.path, 'NEWFILE.md'), 'hello\n')
    const head = (await runGit(r.path, ['rev-parse', 'HEAD'])).stdout.trim()
    const diff = await gitDiffSnapshot(r.path, head)
    expect(diff).toContain('a.txt')
    expect(diff).toContain('NEWFILE.md')
    expect(diff.includes('\n\ndiff --git ')).toBe(false)
  })
})

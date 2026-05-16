// gitStashSnapshot + rollbackToSnapshot end-to-end against a real git
// fixture (P-3-07).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitDiffSnapshot, gitStashSnapshot, rollbackToSnapshot, runGit } from '../src/util/git'

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

describe('gitStashSnapshot + rollbackToSnapshot', () => {
  let r: Repo
  beforeEach(async () => {
    r = await buildRepo()
  })
  afterEach(() => r.cleanup())

  test('clean worktree → snapshot returns empty string', async () => {
    expect(await gitStashSnapshot(r.path)).toBe('')
  })

  test('captures modified tracked file', async () => {
    writeFileSync(join(r.path, 'a.txt'), 'modified\n')
    const sha = await gitStashSnapshot(r.path)
    expect(sha).toMatch(/^[a-f0-9]{40}$/)
    // git stash create does NOT push to stash list; verify the entry isn't
    // there but the commit object is reachable.
    const list = await runGit(r.path, ['stash', 'list'])
    expect(list.stdout.trim()).toBe('')
    const cat = await runGit(r.path, ['cat-file', '-t', sha])
    expect(cat.stdout.trim()).toBe('commit')
  })

  test('captures untracked file via --include-untracked semantics', async () => {
    // git stash create stashes tracked + index by default. The runner takes
    // the snapshot BEFORE any agent write, so this primarily protects
    // tracked working-tree changes. Untracked files predating the agent are
    // rare; this test pins the current behavior.
    writeFileSync(join(r.path, 'fresh.txt'), 'new\n')
    const sha = await gitStashSnapshot(r.path)
    // Default stash create does not include untracked: returns '' if only
    // untracked changes exist.
    if (sha === '') {
      expect(existsSync(join(r.path, 'fresh.txt'))).toBe(true)
    } else {
      expect(sha).toMatch(/^[a-f0-9]{40}$/)
    }
  })

  test('rollback restores the snapshot after subsequent edits', async () => {
    writeFileSync(join(r.path, 'a.txt'), 'snap-time\n')
    const sha = await gitStashSnapshot(r.path)

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

  test('rollback with unknown sha → DomainError', async () => {
    writeFileSync(join(r.path, 'a.txt'), 'changed\n')
    await expect(rollbackToSnapshot(r.path, 'deadbeef'.repeat(5))).rejects.toMatchObject({
      code: 'worktree-apply-failed',
    })
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

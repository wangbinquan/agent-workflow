import { rimrafDir } from './helpers/cleanup'
// RFC-092 T1 — direct unit coverage for the shared node-run worktree rollback
// (services/nodeRollback.ts `rollbackNodeRunWorktrees`).
//
// Locks the post-fix semantics of audit S-2 / S-2b / S-13 (WP-1), per
// design/RFC-092-scheduler-p0-stopgap/design.md §2.1 and 测试策略 §5-6:
//   - single-repo: non-empty sha restores the stash; empty sha is a no-op in
//     resume mode (`resetOnEmptySnapshot: false`) but a full reset+clean in
//     retry mode (`true`) — the clean-tree-gate lesson from
//     scheduler-boundary-presnapshot-rollback-skip.test.ts, generalized.
//   - multi-repo: per-repo map rollback, each sub-worktree independently;
//     per-repo sha='' forks the same way on the switch.
//   - legacy fallbacks: reposJson === null in resume mode falls through to the
//     single-string rollback of target.worktreePath (pre-RFC-066-PR-B rows);
//     in retry mode it must NOT — per-sub-repo '' resets instead.
//   - HARD GATE (the S-2 headline): with repoCount > 1 in retry mode the
//     container directory (plain mkdir, possibly nested inside an ancestor git
//     repo) never sees a git command — otherwise git resolves the ANCESTOR
//     repo and `clean -fd` wipes unrelated untracked files (the exact corner
//     RFC-092 §2.2 closes).
//   - corrupted reposJson === empty map (warn-continue, never throw): resume
//     skips every repo, retry does per-sub-repo '' resets.
//
// All git repos are real temp repos; no DB needed — the function is pure
// filesystem+git against the passed-in row shape.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { monotonicFactory } from 'ulid'
import { rollbackNodeRunWorktrees } from '../src/services/nodeRollback'
import type { RollbackTarget } from '../src/services/nodeRollback'
import { gitStashSnapshot, runGit } from '../src/util/git'
import { createLogger } from '../src/util/log'

const ulid = monotonicFactory()
const log = createLogger('test.rfc092-node-rollback')

/** Init a real git repo with one committed tracked file `data.txt` = 'HEAD\n'. */
async function makeRepo(path: string): Promise<void> {
  mkdirSync(path, { recursive: true })
  await runGit(path, ['init', '-q', '-b', 'main'])
  await runGit(path, ['config', 'user.email', 't@e.com'])
  await runGit(path, ['config', 'user.name', 'T'])
  writeFileSync(join(path, 'data.txt'), 'HEAD\n')
  await runGit(path, ['add', '.'])
  await runGit(path, ['commit', '-q', '-m', 'init'])
}

/** Simulate a failed attempt's partial writes: tracked mutation + untracked stray. */
function dirtyRepo(repo: string): void {
  writeFileSync(join(repo, 'data.txt'), 'MUTATED\n')
  writeFileSync(join(repo, 'stray.txt'), 'stray\n')
}

function expectDirty(repo: string): void {
  expect(readFileSync(join(repo, 'data.txt'), 'utf-8')).toBe('MUTATED\n')
  expect(existsSync(join(repo, 'stray.txt'))).toBe(true)
}

function expectResetClean(repo: string): void {
  expect(readFileSync(join(repo, 'data.txt'), 'utf-8')).toBe('HEAD\n')
  expect(existsSync(join(repo, 'stray.txt'))).toBe(false)
}

function singleTarget(repo: string): RollbackTarget {
  return { repoCount: 1, worktreePath: repo, repos: [] }
}

function multiTarget(container: string, repoA: string, repoB: string): RollbackTarget {
  return {
    repoCount: 2,
    worktreePath: container,
    repos: [
      { worktreePath: repoA, worktreeDirName: 'repo-a' },
      { worktreePath: repoB, worktreeDirName: 'repo-b' },
    ],
  }
}

describe('RFC-092 rollbackNodeRunWorktrees (shared rollback authority)', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aw-rfc092-rollback-'))
  })
  afterEach(() => {
    rimrafDir(root)
  })

  test('single repo, non-empty sha: restores the stash body and clears strays — identical in both opts modes', async () => {
    for (const resetOnEmptySnapshot of [false, true]) {
      const repo = join(root, `single-sha-${resetOnEmptySnapshot}`)
      await makeRepo(repo)
      // Snapshot-time body: tracked mutation vs HEAD so the stash is non-empty.
      writeFileSync(join(repo, 'data.txt'), 'SNAPSHOT-TIME\n')
      const sha = await gitStashSnapshot(repo)
      expect(sha).not.toBe('')
      dirtyRepo(repo)

      await rollbackNodeRunWorktrees(
        singleTarget(repo),
        { id: ulid(), preSnapshot: sha, preSnapshotReposJson: null },
        { resetOnEmptySnapshot },
        log,
      )

      expect(readFileSync(join(repo, 'data.txt'), 'utf-8')).toBe('SNAPSHOT-TIME\n')
      expect(existsSync(join(repo, 'stray.txt'))).toBe(false)
    }
  })

  test("single repo, empty sha × resetOnEmptySnapshot=true: reset --hard + clean -fd clears the failed attempt's partial writes", async () => {
    const repo = join(root, 'single-empty-retry')
    await makeRepo(repo)
    dirtyRepo(repo)

    await rollbackNodeRunWorktrees(
      singleTarget(repo),
      { id: ulid(), preSnapshot: '', preSnapshotReposJson: null },
      { resetOnEmptySnapshot: true },
      log,
    )

    expectResetClean(repo)
  })

  test('single repo, empty/NULL sha × resetOnEmptySnapshot=false: worktree untouched (historical resume guard)', async () => {
    // Cover both '' and NULL — the resume guard treats them identically.
    for (const preSnapshot of ['', null]) {
      const repo = join(root, `single-empty-resume-${preSnapshot === null ? 'null' : 'blank'}`)
      await makeRepo(repo)
      dirtyRepo(repo)

      await rollbackNodeRunWorktrees(
        singleTarget(repo),
        { id: ulid(), preSnapshot, preSnapshotReposJson: null },
        { resetOnEmptySnapshot: false },
        log,
      )

      expectDirty(repo)
    }
  })

  test('multi-repo: per-repo map rolls each sub-worktree back independently; the plain-mkdir container is untouched', async () => {
    const container = join(root, 'container')
    mkdirSync(container, { recursive: true })
    writeFileSync(join(container, 'container-marker.txt'), 'keep-me\n')
    const repoA = join(container, 'repo-a')
    const repoB = join(container, 'repo-b')
    await makeRepo(repoA)
    await makeRepo(repoB)
    writeFileSync(join(repoA, 'data.txt'), 'SNAP-A\n')
    writeFileSync(join(repoB, 'data.txt'), 'SNAP-B\n')
    const shaA = await gitStashSnapshot(repoA)
    const shaB = await gitStashSnapshot(repoB)
    expect(shaA).not.toBe('')
    expect(shaB).not.toBe('')
    dirtyRepo(repoA)
    dirtyRepo(repoB)

    await rollbackNodeRunWorktrees(
      multiTarget(container, repoA, repoB),
      {
        id: ulid(),
        preSnapshot: null,
        preSnapshotReposJson: JSON.stringify({ 'repo-a': shaA, 'repo-b': shaB }),
      },
      { resetOnEmptySnapshot: false },
      log,
    )

    expect(readFileSync(join(repoA, 'data.txt'), 'utf-8')).toBe('SNAP-A\n')
    expect(existsSync(join(repoA, 'stray.txt'))).toBe(false)
    expect(readFileSync(join(repoB, 'data.txt'), 'utf-8')).toBe('SNAP-B\n')
    expect(existsSync(join(repoB, 'stray.txt'))).toBe(false)
    expect(readFileSync(join(container, 'container-marker.txt'), 'utf-8')).toBe('keep-me\n')
  })

  test("multi-repo, per-repo sha='': skipped on resume, reset+clean on retry (mixed map shows the per-repo fork)", async () => {
    const container = join(root, 'container-mixed')
    mkdirSync(container, { recursive: true })
    const repoA = join(container, 'repo-a')
    const repoB = join(container, 'repo-b')
    await makeRepo(repoA)
    await makeRepo(repoB)
    writeFileSync(join(repoA, 'data.txt'), 'SNAP-A\n')
    const shaA = await gitStashSnapshot(repoA)
    expect(shaA).not.toBe('')
    dirtyRepo(repoA)
    dirtyRepo(repoB)
    const run = {
      id: ulid(),
      preSnapshot: null,
      preSnapshotReposJson: JSON.stringify({ 'repo-a': shaA, 'repo-b': '' }),
    }

    // Resume mode: repo-a (real sha) restored, repo-b (sha='') skipped.
    await rollbackNodeRunWorktrees(
      multiTarget(container, repoA, repoB),
      run,
      { resetOnEmptySnapshot: false },
      log,
    )
    expect(readFileSync(join(repoA, 'data.txt'), 'utf-8')).toBe('SNAP-A\n')
    expectDirty(repoB)

    // Retry mode on the same state: repo-b's '' now resets+cleans; repo-a
    // re-applies its stash (idempotent).
    await rollbackNodeRunWorktrees(
      multiTarget(container, repoA, repoB),
      run,
      { resetOnEmptySnapshot: true },
      log,
    )
    expect(readFileSync(join(repoA, 'data.txt'), 'utf-8')).toBe('SNAP-A\n')
    expectResetClean(repoB)
  })

  test('multi-repo, reposJson=NULL × resume: legacy pre-PR-B fallback rolls target.worktreePath via the single-string path; sub-repos untouched', async () => {
    // A legacy multi-repo row predating RFC-066 PR-B carries only the
    // single-string preSnapshot, and target.worktreePath points at a real
    // legacy worktree. Resume must keep that last-ditch fallback.
    const legacyWorktree = join(root, 'legacy-wt')
    await makeRepo(legacyWorktree)
    writeFileSync(join(legacyWorktree, 'data.txt'), 'LEGACY-SNAP\n')
    const legacySha = await gitStashSnapshot(legacyWorktree)
    expect(legacySha).not.toBe('')
    dirtyRepo(legacyWorktree)

    const repoA = join(root, 'legacy-sub-a')
    const repoB = join(root, 'legacy-sub-b')
    await makeRepo(repoA)
    await makeRepo(repoB)
    dirtyRepo(repoA)
    dirtyRepo(repoB)

    await rollbackNodeRunWorktrees(
      multiTarget(legacyWorktree, repoA, repoB),
      { id: ulid(), preSnapshot: legacySha, preSnapshotReposJson: null },
      { resetOnEmptySnapshot: false },
      log,
    )

    // Legacy worktree restored through the single-string path…
    expect(readFileSync(join(legacyWorktree, 'data.txt'), 'utf-8')).toBe('LEGACY-SNAP\n')
    expect(existsSync(join(legacyWorktree, 'stray.txt'))).toBe(false)
    // …and the per-repo loop was NOT entered: sub-repos keep their dirt.
    expectDirty(repoA)
    expectDirty(repoB)
  })

  test("HARD GATE: multi-repo, reposJson=NULL × retry: per-sub-repo '' resets fire; the container dir inside an ANCESTOR git repo gets ZERO git operations", async () => {
    // The corner S-2 names: tasks.worktreePath for a multi-repo task is a
    // plain mkdir container. If the retry rollback ever ran git against it,
    // git would resolve the nearest ANCESTOR repo and `clean -fd` would wipe
    // unrelated untracked files. Build exactly that trap and assert nothing
    // inside the container (other than the sub-repos themselves) moves.
    const ancestor = join(root, 'ancestor')
    await makeRepo(ancestor) // the trap: a real git repo ABOVE the container
    const container = join(ancestor, 'container')
    mkdirSync(container, { recursive: true })
    // Untracked (relative to the ancestor repo) content that `git clean -fd`
    // run anywhere under `ancestor` would delete.
    writeFileSync(join(container, 'container-marker.txt'), 'keep-me\n')
    mkdirSync(join(container, 'nested-plain-dir'), { recursive: true })
    writeFileSync(join(container, 'nested-plain-dir', 'inner.txt'), 'keep-me-too\n')

    const repoA = join(container, 'repo-a')
    const repoB = join(container, 'repo-b')
    await makeRepo(repoA)
    await makeRepo(repoB)
    dirtyRepo(repoA)
    dirtyRepo(repoB)

    await rollbackNodeRunWorktrees(
      multiTarget(container, repoA, repoB),
      // A non-empty single-string sha is deliberately present: the hard gate
      // must NOT be tempted into the single-repo branch by it.
      {
        id: ulid(),
        preSnapshot: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        preSnapshotReposJson: null,
      },
      { resetOnEmptySnapshot: true },
      log,
    )

    // Missing map degrades to per-sub-repo '' resets: both sub-repos cleaned.
    expectResetClean(repoA)
    expectResetClean(repoB)
    // Container contents are byte-for-byte intact — no git command ever ran
    // against the container / ancestor repo.
    expect(readFileSync(join(container, 'container-marker.txt'), 'utf-8')).toBe('keep-me\n')
    expect(readFileSync(join(container, 'nested-plain-dir', 'inner.txt'), 'utf-8')).toBe(
      'keep-me-too\n',
    )
    // The ancestor repo's own tracked file is untouched as well.
    expect(readFileSync(join(ancestor, 'data.txt'), 'utf-8')).toBe('HEAD\n')
  })

  test('multi-repo, corrupted reposJson = empty map: never throws; resume skips every repo, retry does per-sub-repo resets and the container stays intact', async () => {
    const container = join(root, 'container-corrupt')
    mkdirSync(container, { recursive: true })
    writeFileSync(join(container, 'container-marker.txt'), 'keep-me\n')
    const repoA = join(container, 'repo-a')
    const repoB = join(container, 'repo-b')
    await makeRepo(repoA)
    await makeRepo(repoB)
    dirtyRepo(repoA)
    dirtyRepo(repoB)
    const run = { id: ulid(), preSnapshot: null, preSnapshotReposJson: '{not valid json' }

    // Resume mode: parse failure → empty map → every repo reads sha='' and is
    // skipped (the historical outcome — task.ts's old comment claimed a
    // single-repo fallthrough that never actually happened).
    await rollbackNodeRunWorktrees(
      multiTarget(container, repoA, repoB),
      run,
      { resetOnEmptySnapshot: false },
      log,
    )
    expectDirty(repoA)
    expectDirty(repoB)

    // Retry mode: parse failure still means empty map, but the switch turns
    // each '' into a real reset+clean per sub-repo. Container never touched.
    await rollbackNodeRunWorktrees(
      multiTarget(container, repoA, repoB),
      run,
      { resetOnEmptySnapshot: true },
      log,
    )
    expectResetClean(repoA)
    expectResetClean(repoB)
    expect(readFileSync(join(container, 'container-marker.txt'), 'utf-8')).toBe('keep-me\n')
  })
})

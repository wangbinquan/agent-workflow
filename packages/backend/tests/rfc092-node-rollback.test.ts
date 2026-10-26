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

// RFC-395 II-a A2 update (the original rationale above is retained as history):
// RFC-395 II-a A2: preserve historical pre-snapshot rollback; unrecorded and clean checkpoints skip.
// Real Git fixtures cover scalar fallback, partial maps, malformed maps and repeated resume.

import { decodeTaskRollbackCheckpoints } from '@/modules/task-execution/infrastructure/migration/run/legacyCheckpointCodec'
import { legacyStashSnapshotFixture } from './helpers/legacyStashSnapshot'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { monotonicFactory } from 'ulid'
import { rollbackNodeRunWorktrees } from '../src/services/nodeRollback'
import type { RollbackTarget } from '../src/services/nodeRollback'
import { runGit } from '../src/util/git'
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

function singleTarget(repo: string): RollbackTarget {
  return { worktreePath: repo, repos: [{ worktreePath: repo, mountPath: '' }] }
}

function multiTarget(container: string, repoA: string, repoB: string): RollbackTarget {
  return {
    worktreePath: container,
    repos: [
      { worktreePath: repoA, mountPath: 'repo-a' },
      { worktreePath: repoB, mountPath: 'repo-b' },
    ],
  }
}

describe('RFC-092 rollbackNodeRunWorktrees (shared rollback authority)', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aw-rfc092-rollback-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test('single repo, non-empty sha: restores the stash body and clears strays — tracked and staged historical snapshots', async () => {
    for (const snapshotKind of ['tracked', 'staged']) {
      const repo = join(root, `single-sha-${snapshotKind}`)
      await makeRepo(repo)
      // Snapshot-time body: tracked mutation vs HEAD so the stash is non-empty.
      writeFileSync(join(repo, 'data.txt'), 'SNAPSHOT-TIME\n')
      if (snapshotKind === 'staged') await runGit(repo, ['add', 'data.txt'])
      const sha = await legacyStashSnapshotFixture(repo)
      expect(sha).not.toBe('')
      dirtyRepo(repo)

      await rollbackNodeRunWorktrees(
        singleTarget(repo),
        {
          id: ulid(),
          checkpoints: [{ mountPath: '', preSnapshot: sha }],
        },
        {},
        log,
      )

      expect(readFileSync(join(repo, 'data.txt'), 'utf-8')).toBe('SNAPSHOT-TIME\n')
      expect(existsSync(join(repo, 'stray.txt'))).toBe(false)
    }
  })

  test('single repo, clean-tree checkpoint: resume preserves subsequent writes', async () => {
    const repo = join(root, 'single-empty-retry')
    await makeRepo(repo)
    dirtyRepo(repo)

    await rollbackNodeRunWorktrees(
      singleTarget(repo),
      {
        id: ulid(),
        checkpoints: [{ mountPath: '', preSnapshot: '' }],
      },
      {},
      log,
    )

    expectDirty(repo)
  })

  test('single repo, empty/NULL checkpoint: worktree untouched', async () => {
    // Cover both '' and NULL — the resume guard treats them identically.
    for (const preSnapshot of ['', null]) {
      const repo = join(root, `single-empty-resume-${preSnapshot === null ? 'null' : 'blank'}`)
      await makeRepo(repo)
      dirtyRepo(repo)

      await rollbackNodeRunWorktrees(
        singleTarget(repo),
        { id: ulid(), checkpoints: preSnapshot === null ? [] : [{ mountPath: '', preSnapshot }] },
        {},
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
    const shaA = await legacyStashSnapshotFixture(repoA)
    const shaB = await legacyStashSnapshotFixture(repoB)
    expect(shaA).not.toBe('')
    expect(shaB).not.toBe('')
    dirtyRepo(repoA)
    dirtyRepo(repoB)

    await rollbackNodeRunWorktrees(
      multiTarget(container, repoA, repoB),
      {
        id: ulid(),
        checkpoints: Object.entries({ 'repo-a': shaA, 'repo-b': shaB }).map(
          ([mountPath, preSnapshot]) => ({ mountPath, preSnapshot }),
        ),
      },
      {},
      log,
    )

    expect(readFileSync(join(repoA, 'data.txt'), 'utf-8')).toBe('SNAP-A\n')
    expect(existsSync(join(repoA, 'stray.txt'))).toBe(false)
    expect(readFileSync(join(repoB, 'data.txt'), 'utf-8')).toBe('SNAP-B\n')
    expect(existsSync(join(repoB, 'stray.txt'))).toBe(false)
    expect(readFileSync(join(container, 'container-marker.txt'), 'utf-8')).toBe('keep-me\n')
  })

  test('multi-repo, partial map: repeated resume restores the recorded member and keeps the clean member', async () => {
    const container = join(root, 'container-mixed')
    mkdirSync(container, { recursive: true })
    const repoA = join(container, 'repo-a')
    const repoB = join(container, 'repo-b')
    await makeRepo(repoA)
    await makeRepo(repoB)
    writeFileSync(join(repoA, 'data.txt'), 'SNAP-A\n')
    const shaA = await legacyStashSnapshotFixture(repoA)
    expect(shaA).not.toBe('')
    dirtyRepo(repoA)
    dirtyRepo(repoB)
    const run = {
      id: ulid(),
      checkpoints: Object.entries({ 'repo-a': shaA, 'repo-b': '' }).map(
        ([mountPath, preSnapshot]) => ({ mountPath, preSnapshot }),
      ),
    }

    // Resume mode: repo-a (real sha) restored, repo-b (sha='') skipped.
    await rollbackNodeRunWorktrees(multiTarget(container, repoA, repoB), run, {}, log)
    expect(readFileSync(join(repoA, 'data.txt'), 'utf-8')).toBe('SNAP-A\n')
    expectDirty(repoB)

    // Repeated resume keeps the same per-mount decision.
    await rollbackNodeRunWorktrees(multiTarget(container, repoA, repoB), run, {}, log)
    expect(readFileSync(join(repoA, 'data.txt'), 'utf-8')).toBe('SNAP-A\n')
    expectDirty(repoB)
  })

  test('converted legacy scalar checkpoint rolls its materialized root mount; other mounts are untouched', async () => {
    // A legacy multi-repo row predating RFC-066 PR-B carries only the
    // single-string preSnapshot, and target.worktreePath points at a real
    // legacy worktree. Resume must keep that last-ditch fallback.
    const legacyWorktree = join(root, 'legacy-wt')
    await makeRepo(legacyWorktree)
    writeFileSync(join(legacyWorktree, 'data.txt'), 'LEGACY-SNAP\n')
    const legacySha = await legacyStashSnapshotFixture(legacyWorktree)
    expect(legacySha).not.toBe('')
    dirtyRepo(legacyWorktree)

    const repoA = join(root, 'legacy-sub-a')
    const repoB = join(root, 'legacy-sub-b')
    await makeRepo(repoA)
    await makeRepo(repoB)
    dirtyRepo(repoA)
    dirtyRepo(repoB)

    await rollbackNodeRunWorktrees(
      {
        ...multiTarget(legacyWorktree, repoA, repoB),
        repos: [
          { mountPath: '', worktreePath: legacyWorktree },
          ...multiTarget(legacyWorktree, repoA, repoB).repos,
        ],
      },
      {
        id: ulid(),
        checkpoints: [{ mountPath: '', preSnapshot: legacySha }],
      },
      {},
      log,
    )

    // Legacy worktree restored through the single-string path…
    expect(readFileSync(join(legacyWorktree, 'data.txt'), 'utf-8')).toBe('LEGACY-SNAP\n')
    expect(existsSync(join(legacyWorktree, 'stray.txt'))).toBe(false)
    // …and the per-repo loop was NOT entered: sub-repos keep their dirt.
    expectDirty(repoA)
    expectDirty(repoB)
  })

  test('HARD GATE: multi-repo ignores a stray workspace scalar and never touches its container', async () => {
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
      // A stray scalar must not turn the container into a root worktree.
      {
        id: ulid(),
        checkpoints: [{ mountPath: '', preSnapshot: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }],
      },
      {},
      log,
    )

    // Neither a member nor the root has a recorded rollback action.
    expectDirty(repoA)
    expectDirty(repoB)
    // Container contents are byte-for-byte intact — no git command ever ran
    // against the container / ancestor repo.
    expect(readFileSync(join(container, 'container-marker.txt'), 'utf-8')).toBe('keep-me\n')
    expect(readFileSync(join(container, 'nested-plain-dir', 'inner.txt'), 'utf-8')).toBe(
      'keep-me-too\n',
    )
    // The ancestor repo's own tracked file is untouched as well.
    expect(readFileSync(join(ancestor, 'data.txt'), 'utf-8')).toBe('HEAD\n')
  })

  test('multi-repo, corrupted reposJson: repeated resume skips every repo and keeps the container', async () => {
    const container = join(root, 'container-corrupt')
    mkdirSync(container, { recursive: true })
    writeFileSync(join(container, 'container-marker.txt'), 'keep-me\n')
    const repoA = join(container, 'repo-a')
    const repoB = join(container, 'repo-b')
    await makeRepo(repoA)
    await makeRepo(repoB)
    dirtyRepo(repoA)
    dirtyRepo(repoB)
    const run = decodeTaskRollbackCheckpoints(
      { id: ulid(), preSnapshot: null, preSnapshotReposJson: '{not valid json' },
      ['repo-a', 'repo-b'],
    )

    // Resume mode: parse failure → empty map → every repo reads sha='' and is
    // skipped (the historical outcome — task.ts's old comment claimed a
    // single-repo fallthrough that never actually happened).
    await rollbackNodeRunWorktrees(multiTarget(container, repoA, repoB), run, {}, log)
    expectDirty(repoA)
    expectDirty(repoB)

    // A second resume remains a no-op; corruption never becomes an invented checkpoint.
    await rollbackNodeRunWorktrees(multiTarget(container, repoA, repoB), run, {}, log)
    expectDirty(repoA)
    expectDirty(repoB)
    expect(readFileSync(join(container, 'container-marker.txt'), 'utf-8')).toBe('keep-me\n')
  })
})

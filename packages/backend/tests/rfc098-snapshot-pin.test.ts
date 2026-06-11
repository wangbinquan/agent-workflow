// RFC-098 B2 / WP-9 oracles — snapshot ref pinning end-to-end + gc ref
// cleanup + multi-repo two-phase all-or-nothing rollback (design.md §B2-WP-9
// + 对抗检视修订 #3).
//
// Covers the three WP-9 surfaces the unit FLIPs (scheduler-audit-s11 /
// git-snapshot) do NOT:
//   1. Full ref lifecycle against a REAL `git worktree add` worktree sharing
//      the source-repo odb: a pinned snapshot survives a user-side
//      `git gc --prune=now` in the SOURCE repo; `runWorktreeGc` (gc.ts) then
//      deletes refs/agent-workflow/snapshots/{taskId}/* alongside the
//      worktree (the only safe deletion point — every terminal status is
//      revivable via retryNode/resumeTask while the worktree exists), after
//      which the next gc finally collects the object. Multi-repo container
//      ref cleanup is deliberately OUT of scope (gc.ts multi-repo blindspot,
//      audit ⑥ gap-3 family).
//   2. Multi-repo rollback is two-phase all-or-nothing: when repo 2's
//      snapshot is gc-pruned, repo 1 must NOT be touched (the pre-fix
//      per-repo loop reset+cleaned repo 1 first, then discovered the missing
//      snapshot — violating the fail-closed promise). failures carry
//      code='snapshot-missing', attempted stays false, both modes
//      (resume/retry). With every snapshot present, phase 2 performs the
//      historical per-repo rollback unchanged.
//
// 确定性说明：纯本地 git（init/commit/worktree add/stash create/gc/update-ref），
//   无网络/clone——不属于 RUN_GIT_NETWORK 门控形态（8859a67）。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { monotonicFactory } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { tasks, workflows } from '../src/db/schema'
import { runWorktreeGc } from '../src/services/gc'
import { rollbackNodeRunWorktrees } from '../src/services/nodeRollback'
import type { RollbackTarget } from '../src/services/nodeRollback'
import {
  createWorktree,
  gitStashSnapshot,
  runGit,
  snapshotRefName,
  snapshotRefPrefix,
} from '../src/util/git'
import { createLogger } from '../src/util/log'

const ulid = monotonicFactory()
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const log = createLogger('test.rfc098-snapshot-pin')

/** `git cat-file -e <sha>` — exitCode 0 iff the object exists in the odb. */
async function objectExists(repoPath: string, sha: string): Promise<boolean> {
  const r = await runGit(repoPath, ['cat-file', '-e', sha])
  return r.exitCode === 0
}

/** Expire reflogs + prune all unreachable objects immediately. */
async function gcPruneNow(repoPath: string): Promise<void> {
  const expire = await runGit(repoPath, [
    'reflog',
    'expire',
    '--expire=now',
    '--expire-unreachable=now',
    '--all',
  ])
  expect(expire.exitCode).toBe(0)
  const gc = await runGit(repoPath, ['gc', '--prune=now', '--quiet'])
  expect(gc.exitCode).toBe(0)
}

/** List refnames under the task's snapshot prefix in `repoPath`. */
async function taskSnapshotRefs(repoPath: string, taskId: string): Promise<string[]> {
  const r = await runGit(repoPath, [
    'for-each-ref',
    '--format=%(refname)',
    snapshotRefPrefix(taskId),
  ])
  expect(r.exitCode).toBe(0)
  return r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
}

describe('RFC-098 WP-9 — pinned snapshot survives source-repo gc; worktree GC deletes the task refs', () => {
  let appHome: string
  let repoPath: string
  let db: DbClient
  beforeEach(async () => {
    appHome = mkdtempSync(join(tmpdir(), 'aw-rfc098-pin-'))
    repoPath = join(appHome, 'repo')
    await runGit(appHome, ['init', '-q', '-b', 'main', 'repo'])
    await runGit(repoPath, ['config', 'user.email', 'test@example.com'])
    await runGit(repoPath, ['config', 'user.name', 'Test'])
    writeFileSync(join(repoPath, 'data.txt'), 'HEAD\n')
    await runGit(repoPath, ['add', '.'])
    await runGit(repoPath, ['commit', '-q', '-m', 'init'])
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => rmSync(appHome, { recursive: true, force: true }))

  test('worktree-pinned snapshot lives in the shared odb past gc; runWorktreeGc removes worktree + refs, re-exposing the object', async () => {
    const workflowId = ulid()
    const taskId = ulid()
    const nodeRunId = ulid()
    const wt = await createWorktree({ repoPath, taskId, appHome })

    // Snapshot taken FROM the worktree (the scheduler's write-point shape):
    // the ref lands in the SHARED source-repo odb because snapshot refs are
    // common refs, not per-worktree refs.
    writeFileSync(join(wt.worktreePath, 'data.txt'), 'SNAPSHOT-STATE\n')
    const sha = await gitStashSnapshot(wt.worktreePath, {
      pinRef: snapshotRefName(taskId, nodeRunId),
      log,
    })
    expect(sha).toMatch(/^[a-f0-9]{40}$/)
    expect(await taskSnapshotRefs(repoPath, taskId)).toEqual([snapshotRefName(taskId, nodeRunId)])

    // A user-side gc in the SOURCE repo (the S-11 attack) keeps the object —
    // the ref makes it reachable.
    await gcPruneNow(repoPath)
    expect(await objectExists(repoPath, sha)).toBe(true)

    // Terminal task, old enough for the GC threshold.
    await db.insert(workflows).values({ id: workflowId, name: 'wf', definition: '{}' })
    await db.insert(tasks).values({
      name: 'fixture-task',
      id: taskId,
      workflowId,
      workflowSnapshot: '{}',
      repoPath,
      worktreePath: wt.worktreePath,
      baseBranch: 'main',
      branch: wt.branch,
      status: 'done',
      inputs: '{}',
      startedAt: Date.now() - 10 * 24 * 60 * 60 * 1000,
      finishedAt: Date.now() - 10 * 24 * 60 * 60 * 1000,
    })

    const r = await runWorktreeGc(db, { worktreeAutoGc: { enabled: true, olderThanDays: 1 } })
    expect(r.removed).toEqual([taskId])
    expect(existsSync(wt.worktreePath)).toBe(false)
    // gc.ts batch-deleted the task's snapshot refs from the source repo.
    expect(await taskSnapshotRefs(repoPath, taskId)).toEqual([])

    // Ref lifecycle == worktree lifecycle: with the pin gone, the next gc
    // finally collects the snapshot object (no permanent odb growth).
    await gcPruneNow(repoPath)
    expect(await objectExists(repoPath, sha)).toBe(false)
  })
})

describe('RFC-098 WP-9 修订#3 — multi-repo rollback is two-phase all-or-nothing', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aw-rfc098-allornothing-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  async function makeRepo(path: string): Promise<void> {
    mkdirSync(path, { recursive: true })
    await runGit(path, ['init', '-q', '-b', 'main'])
    await runGit(path, ['config', 'user.email', 't@e.com'])
    await runGit(path, ['config', 'user.name', 'T'])
    writeFileSync(join(path, 'data.txt'), 'HEAD\n')
    await runGit(path, ['add', '.'])
    await runGit(path, ['commit', '-q', '-m', 'init'])
  }

  function dirtyRepo(repo: string): void {
    writeFileSync(join(repo, 'data.txt'), 'MUTATED\n')
    writeFileSync(join(repo, 'stray.txt'), 'stray\n')
  }

  function expectUntouchedDirty(repo: string): void {
    expect(readFileSync(join(repo, 'data.txt'), 'utf-8')).toBe('MUTATED\n')
    expect(existsSync(join(repo, 'stray.txt'))).toBe(true)
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

  test("repo 2's snapshot missing → snapshot-missing failure, attempted=false, repo 1 NOT touched (both modes); all-present map still rolls back", async () => {
    const container = join(root, 'container')
    mkdirSync(container, { recursive: true })
    const repoA = join(container, 'repo-a')
    const repoB = join(container, 'repo-b')
    await makeRepo(repoA)
    await makeRepo(repoB)

    // repo-a has a REAL snapshot; repo-b's map entry points at a pruned
    // (never-existing) commit — the second-repo-missing attack from 修订#3.
    writeFileSync(join(repoA, 'data.txt'), 'SNAP-A\n')
    const shaA = await gitStashSnapshot(repoA)
    expect(shaA).not.toBe('')
    const missingSha = 'deadbeef'.repeat(5)
    dirtyRepo(repoA)
    dirtyRepo(repoB)
    const run = {
      id: ulid(),
      preSnapshot: null,
      preSnapshotReposJson: JSON.stringify({ 'repo-a': shaA, 'repo-b': missingSha }),
    }

    // Phase-1 pre-check fails in BOTH calling modes → zero repos touched.
    // Pre-fix shape: repo-a was reset+cleaned+stash-applied FIRST, then
    // repo-b's apply blew up — repo-a's failed-attempt dirt was already gone.
    for (const resetOnEmptySnapshot of [false, true]) {
      const outcome = await rollbackNodeRunWorktrees(
        multiTarget(container, repoA, repoB),
        run,
        { resetOnEmptySnapshot },
        log,
      )
      expect(outcome.attempted).toBe(false)
      expect(outcome.failures).toHaveLength(1)
      expect(outcome.failures[0]).toMatchObject({
        worktreeDirName: 'repo-b',
        code: 'snapshot-missing',
      })
      expectUntouchedDirty(repoA)
      expectUntouchedDirty(repoB)
    }

    // Phase 2 control: with EVERY snapshot present the historical per-repo
    // rollback executes unchanged.
    const fixedRun = {
      id: ulid(),
      preSnapshot: null,
      preSnapshotReposJson: JSON.stringify({ 'repo-a': shaA, 'repo-b': '' }),
    }
    const okOutcome = await rollbackNodeRunWorktrees(
      multiTarget(container, repoA, repoB),
      fixedRun,
      { resetOnEmptySnapshot: false },
      log,
    )
    expect(okOutcome.attempted).toBe(true)
    expect(okOutcome.failures).toEqual([])
    expect(readFileSync(join(repoA, 'data.txt'), 'utf-8')).toBe('SNAP-A\n')
    expect(existsSync(join(repoA, 'stray.txt'))).toBe(false)
    expectUntouchedDirty(repoB) // sha='' skipped in resume mode — semantics unchanged
  })
})

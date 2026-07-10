import { rimrafDir } from './helpers/cleanup'
// RFC-098 B1 REGRESSION LOCK — per-task write-lock registry (audit S-9 / ⑥-10,
// design/RFC-098-scheduler-closeout/design.md §B1 + 对抗检视修订 #1).
//
// WHY THIS FILE EXISTS:
//   Before B1 the scheduler's writer serialization was a per-runTask LOCAL
//   `new Semaphore(1)` that HTTP entry points could never reach — clarify /
//   review / cross-clarify answers ran `rollbackToSnapshot` (reset --hard +
//   clean -fd) straight against the worktree while an in-flight writer might
//   be mid-write (S-9). And all three HTTP rollbacks were single-track
//   (`preSnapshot` column only), so multi-repo tasks were silently NOT rolled
//   back at all (⑥-10). This file locks the fix from three angles:
//
//   1. Registry identity oracle — getTaskWriteSem returns THE SAME instance
//      (Object.is) across calls and across HTTP-style acquire/release use;
//      gcTaskWriteSem deletes only when idle (held / queued entries survive).
//      Adversarial-review revision #1 source guard: the ONLY gc call site is
//      runTask's finally — the HTTP rollback services never gc (an HTTP-side
//      gc would delete+recreate while the scheduler still caches the old
//      instance, splitting the mutex back into two: the exact S-9 pathology).
//
//   2. S-9 mutual exclusion (semi-integration) — with the task write lock
//      HELD (simulating an in-flight writer node), the clarify answer
//      (autoDispatchClarifyRound's self-rollback critical section) does not
//      complete and the worktree is NOT touched; after release, the rollback
//      applies (file-trace order proves rollback happened after the writer
//      released).
//
//   3. ⑥-10 multi-repo wiring — a dual-repo task answering a clarify rolls
//      back BOTH sub-repos via `preSnapshotReposJson` (red→green headline:
//      pre-fix the single-track call was a silent no-op for multi-repo rows
//      whose `preSnapshot` is NULL by design).

import type { ClarifyAnswer, ClarifyQuestion, WorkflowDefinition } from '@agent-workflow/shared'
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, taskRepos, tasks, workflows } from '../src/db/schema'
import { createClarifySession } from '../src/services/clarify'
import { autoDispatchClarifyRound } from '../src/services/clarifyAutoDispatch'
import { gcTaskWriteSem, getTaskWriteSem, taskWriteLockCount } from '../src/services/taskWriteLocks'
import { gitStashSnapshot, runGit } from '../src/util/git'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const SRC = (f: string) => resolve(import.meta.dir, '..', 'src', 'services', f)
const actor = { userId: 'u1', role: 'owner' as const }

beforeEach(() => resetBroadcastersForTests())
afterAll(() => resetBroadcastersForTests())

// ---------------------------------------------------------------------------
// 1. Registry identity + gc lifecycle (pure, no DB)
// ---------------------------------------------------------------------------

describe('RFC-098 B1 — taskWriteLocks registry identity & gc', () => {
  test('getTaskWriteSem is getOrCreate: same instance across calls AND across HTTP-style acquire/release use', async () => {
    const taskId = `t-identity-${Math.random().toString(36).slice(2, 8)}`
    const before = taskWriteLockCount()
    const s1 = getTaskWriteSem(taskId)
    const s2 = getTaskWriteSem(taskId)
    expect(Object.is(s1, s2)).toBe(true)
    expect(taskWriteLockCount()).toBe(before + 1)

    // HTTP-style use (mid-run rollback): acquire + release, then come back.
    // Revision #1 oracle — two successive HTTP rollbacks must observe the
    // SAME instance (the HTTP path never gc's).
    const release = await s1.acquire()
    release()
    expect(Object.is(getTaskWriteSem(taskId), s1)).toBe(true)
    expect(taskWriteLockCount()).toBe(before + 1)

    // Cleanup (idle → entry dropped).
    gcTaskWriteSem(taskId)
    expect(taskWriteLockCount()).toBe(before)
  })

  test('gcTaskWriteSem: held entry survives, queued entry survives, idle entry is dropped (next get mints a fresh instance)', async () => {
    const taskId = `t-gc-${Math.random().toString(36).slice(2, 8)}`
    const sem = getTaskWriteSem(taskId)

    // Held → gc must NOT delete (a delete here would let the next
    // getTaskWriteSem mint a second Semaphore: split-brain mutex, S-9 redux).
    const rel1 = await sem.acquire()
    gcTaskWriteSem(taskId)
    expect(Object.is(getTaskWriteSem(taskId), sem)).toBe(true)

    // Held + a queued waiter → still must not delete.
    let rel2: (() => void) | null = null
    const waiter = sem.acquire().then((r) => {
      rel2 = r
    })
    expect(sem.queueLength).toBe(1)
    gcTaskWriteSem(taskId)
    expect(Object.is(getTaskWriteSem(taskId), sem)).toBe(true)

    rel1()
    await waiter
    expect(rel2).not.toBeNull()
    // Still held by the (former) waiter → still alive.
    gcTaskWriteSem(taskId)
    expect(Object.is(getTaskWriteSem(taskId), sem)).toBe(true)
    rel2!()

    // Fully idle → gc drops the entry; the next get is a FRESH instance.
    gcTaskWriteSem(taskId)
    const fresh = getTaskWriteSem(taskId)
    expect(Object.is(fresh, sem)).toBe(false)
    gcTaskWriteSem(taskId) // leave the registry clean
  })

  test('revision #1 source guard: gc is called ONLY from runTask finally — HTTP rollback services never gc', () => {
    // An HTTP-side gc would race the scheduler's cached SchedulerState.writeSem
    // reference (delete + recreate ⇒ two instances ⇒ mutex silently split).
    // crossClarify.ts dropped from this list per RFC-056 patch 2026-06-22: its
    // cross-clarify designer rerun no longer rolls back the worktree, so it no
    // longer takes the task write lock at all. RFC-132: the live self-clarify
    // rollback critical section moved to clarifyAutoDispatch.ts (A OUTER ≻ B
    // INNER); it + review.ts still roll back under getTaskWriteSem and must
    // never gc.
    for (const f of ['clarifyAutoDispatch.ts', 'review.ts']) {
      const src = readFileSync(SRC(f), 'utf-8')
      expect(src).toContain('getTaskWriteSem')
      expect(src.includes('gcTaskWriteSem')).toBe(false)
    }
    const scheduler = readFileSync(SRC('scheduler.ts'), 'utf-8')
    // The one-and-only delete point: runTask's try/finally shell.
    expect(scheduler).toMatch(/finally\s*\{\s*gcTaskWriteSem\(opts\.taskId\)/)
    // No second call site sneaks in (one import line + one call).
    const calls = scheduler.match(/gcTaskWriteSem\(/g) ?? []
    expect(calls.length).toBe(1)
    // The scheduler's writer lock comes from the registry (S-9 wiring).
    expect(scheduler).toContain('writeSem: getTaskWriteSem(taskId)')
  })
})

// ---------------------------------------------------------------------------
// Shared clarify harness (mirrors clarify-rerun-write-ordering.test.ts, but
// with REAL worktrees + non-empty pre-snapshots so the rollback path runs).
// ---------------------------------------------------------------------------

function makeQ(id: string): ClarifyQuestion {
  return {
    id,
    title: `Question ${id}`,
    kind: 'single',
    recommended: false,
    options: [
      { label: 'A', description: '', recommended: false, recommendationReason: '' },
      { label: 'B', description: '', recommended: false, recommendationReason: '' },
    ],
  }
}
function makeAns(qid: string): ClarifyAnswer {
  return { questionId: qid, selectedOptionIndices: [0], selectedOptionLabels: [], customText: '' }
}

function selfClarifyDef(): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [{ kind: 'text', key: 'requirement', label: 'r' }],
    nodes: [
      { id: 'in', kind: 'input' },
      { id: 'agent_x', kind: 'agent-single', agentName: 'agent_x' },
      { id: 'clarify_x', kind: 'clarify' },
    ],
    edges: [
      {
        id: 'e_in_x',
        source: { nodeId: 'in', portName: 'requirement' },
        target: { nodeId: 'agent_x', portName: 'requirement' },
      },
      {
        id: 'e_x_clarify',
        source: { nodeId: 'agent_x', portName: '__clarify__' },
        target: { nodeId: 'clarify_x', portName: 'questions' },
      },
      {
        id: 'e_clarify_x',
        source: { nodeId: 'clarify_x', portName: 'answers' },
        target: { nodeId: 'agent_x', portName: '__clarify_response__' },
      },
    ],
    outputs: [],
  }
}

/** Local-only git fixture: init + one commit of src.txt = 'base\n'. */
async function initRepo(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true })
  await runGit(dir, ['init', '-q', '-b', 'main'])
  await runGit(dir, ['config', 'user.email', 't@t.test'])
  await runGit(dir, ['config', 'user.name', 't'])
  writeFileSync(join(dir, 'src.txt'), 'base\n')
  await runGit(dir, ['add', '.'])
  await runGit(dir, ['commit', '-q', '-m', 'init'])
}

interface SeededClarify {
  taskId: string
  agentRunId: string
  clarifyNodeRunId: string
}

async function seedClarifyTask(
  db: DbClient,
  opts: {
    worktreePath: string
    repoPath: string
    repoCount?: number
    preSnapshot?: string | null
    preSnapshotReposJson?: string | null
    repos?: Array<{ worktreePath: string; worktreeDirName: string }>
  },
): Promise<SeededClarify> {
  const def = selfClarifyDef()
  const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
  const wfId = `wf_${taskId}`
  await db.insert(workflows).values({
    id: wfId,
    name: 'fixture',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'fixture-task',
    workflowId: wfId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: opts.repoPath,
    worktreePath: opts.worktreePath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
    repoCount: opts.repoCount ?? 1,
  })
  if (opts.repos !== undefined) {
    await db.insert(taskRepos).values(
      opts.repos.map((r, i) => ({
        taskId,
        repoIndex: i,
        repoPath: r.worktreePath,
        baseBranch: 'main',
        branch: `agent-workflow/${taskId}`,
        worktreePath: r.worktreePath,
        worktreeDirName: r.worktreeDirName,
      })),
    )
  }
  const agentRunId = `nr_agent_${Math.random().toString(36).slice(2, 8)}`
  await db.insert(nodeRuns).values({
    id: agentRunId,
    taskId,
    nodeId: 'agent_x',
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    startedAt: Date.now(),
    finishedAt: Date.now(),
    preSnapshot: opts.preSnapshot ?? null,
    preSnapshotReposJson: opts.preSnapshotReposJson ?? null,
  })
  const sess = await createClarifySession({
    db,
    taskId,
    sourceAgentNodeId: 'agent_x',
    sourceAgentNodeRunId: agentRunId,
    sourceShardKey: null,
    clarifyNodeId: 'clarify_x',
    iterationIndex: 0,
    questions: [makeQ('q1')],
    truncationWarnings: [],
  })
  return { taskId, agentRunId, clarifyNodeRunId: sess.clarifyNodeRunId }
}

// ---------------------------------------------------------------------------
// 2. S-9 mutual exclusion (semi-integration)
// ---------------------------------------------------------------------------

describe('RFC-098 B1 — S-9: clarify rollback serializes behind the task write lock', () => {
  test('answering the round stays pending while the write lock is held (worktree untouched); rollback applies only after release', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc098-s9-'))
    try {
      const repo = join(tmp, 'wt')
      await initRepo(repo)

      // Pre-snapshot the state the source agent started from (tracked
      // modification so `git stash create` yields a non-empty sha — the same
      // capture the scheduler does for writer nodes).
      writeFileSync(join(repo, 'src.txt'), 'pre-state\n')
      const sha = await gitStashSnapshot(repo)
      expect(sha).not.toBe('')

      // Simulate the in-flight WRITER's half-done work: a tracked overwrite +
      // an untracked stray. This is exactly what the S-9 backdoor used to
      // reset/clean from under the writer.
      writeFileSync(join(repo, 'src.txt'), 'writer-dirty\n')
      writeFileSync(join(repo, 'writer-inflight.txt'), 'half-done\n')

      const db = createInMemoryDb(MIGRATIONS)
      const seeded = await seedClarifyTask(db, {
        worktreePath: repo,
        repoPath: repo,
        preSnapshot: sha,
      })

      // Hold the task write lock — the registry hands the SAME instance the
      // clarify service will queue on (the whole point of B1).
      const release = await getTaskWriteSem(seeded.taskId).acquire()

      // Probe object (property reads survive TS closure-mutation narrowing;
      // the rejected branch is folded in so a pre-lock throw cannot become an
      // unhandled rejection during the sleep below).
      const probe: { outcome: { ok: true } | { err: unknown } | null } = { outcome: null }
      const submitP = autoDispatchClarifyRound({
        db,
        originNodeRunId: seeded.clarifyNodeRunId,
        answers: [makeAns('q1')],
        directive: 'continue',
        actor,
      }).then(
        () => {
          probe.outcome = { ok: true }
        },
        (err: unknown) => {
          probe.outcome = { err }
        },
      )

      // Probe: with the lock held the submit cannot complete…
      await Bun.sleep(150)
      expect(probe.outcome).toBeNull()
      // …and — the load-bearing S-9 invariant — the worktree is UNTOUCHED:
      // no reset/clean ran under the in-flight writer.
      expect(readFileSync(join(repo, 'src.txt'), 'utf-8')).toBe('writer-dirty\n')
      expect(existsSync(join(repo, 'writer-inflight.txt'))).toBe(true)

      // Writer finishes → releases the lock → the queued rollback runs and
      // the submit completes.
      release()
      await submitP
      expect(probe.outcome).toEqual({ ok: true })

      // File-trace order: the rollback happened AFTER the release — reset
      // (base) + clean (stray gone) + stash apply (pre-state restored).
      expect(readFileSync(join(repo, 'src.txt'), 'utf-8')).toBe('pre-state\n')
      expect(existsSync(join(repo, 'writer-inflight.txt'))).toBe(false)

      // And the answer still minted exactly one pending rerun (happy path
      // unbroken by the lock detour).
      const agentRows = await db
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, seeded.taskId), eq(nodeRuns.nodeId, 'agent_x')))
      expect(agentRows.filter((r) => r.status === 'pending').length).toBe(1)

      gcTaskWriteSem(seeded.taskId) // idle now — keep the registry clean
    } finally {
      rimrafDir(tmp)
    }
  }, 20_000)
})

// ---------------------------------------------------------------------------
// 3. ⑥-10 multi-repo rollback wiring
// ---------------------------------------------------------------------------

describe('RFC-098 B1 — ⑥-10: clarify answer rolls back EVERY sub-repo of a multi-repo task', () => {
  test('dual-repo task: both sub-repos are reset/cleaned/stash-applied from preSnapshotReposJson (pre-fix: silent single-track no-op)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc098-610-'))
    try {
      // Production multi-repo layout: tasks.worktreePath is a PLAIN mkdir
      // container; each repo is its own git tree in a sub-directory.
      const containerDir = join(tmp, 'container')
      mkdirSync(containerDir, { recursive: true })
      const repoA = join(containerDir, 'repo-a')
      const repoB = join(containerDir, 'repo-b')
      await initRepo(repoA)
      await initRepo(repoB)

      // Per-repo pre-snapshots (distinct contents so we can prove EACH repo
      // got ITS OWN sha applied, not just any reset).
      writeFileSync(join(repoA, 'src.txt'), 'pre-a\n')
      const shaA = await gitStashSnapshot(repoA)
      writeFileSync(join(repoB, 'src.txt'), 'pre-b\n')
      const shaB = await gitStashSnapshot(repoB)
      expect(shaA).not.toBe('')
      expect(shaB).not.toBe('')

      // The source agent's half-done work in BOTH repos.
      writeFileSync(join(repoA, 'src.txt'), 'dirty-a\n')
      writeFileSync(join(repoA, 'stray-a.txt'), 'x\n')
      writeFileSync(join(repoB, 'src.txt'), 'dirty-b\n')
      writeFileSync(join(repoB, 'stray-b.txt'), 'x\n')

      const db = createInMemoryDb(MIGRATIONS)
      const seeded = await seedClarifyTask(db, {
        worktreePath: containerDir,
        repoPath: repoA,
        repoCount: 2,
        // Multi-repo rows leave `preSnapshot` NULL by design (RFC-066 dual
        // write) — exactly the shape the pre-B1 single-track gate skipped.
        preSnapshot: null,
        preSnapshotReposJson: JSON.stringify({ 'repo-a': shaA, 'repo-b': shaB }),
        repos: [
          { worktreePath: repoA, worktreeDirName: 'repo-a' },
          { worktreePath: repoB, worktreeDirName: 'repo-b' },
        ],
      })

      await autoDispatchClarifyRound({
        db,
        originNodeRunId: seeded.clarifyNodeRunId,
        answers: [makeAns('q1')],
        directive: 'continue',
        actor,
      })

      // HEADLINE (red→green on ⑥-10): BOTH sub-repos rolled back to their own
      // pre-snapshot. Pre-fix nothing was touched (preSnapshot NULL → the old
      // single-track gate skipped the rollback entirely for multi-repo rows).
      expect(readFileSync(join(repoA, 'src.txt'), 'utf-8')).toBe('pre-a\n')
      expect(readFileSync(join(repoB, 'src.txt'), 'utf-8')).toBe('pre-b\n')
      expect(existsSync(join(repoA, 'stray-a.txt'))).toBe(false)
      expect(existsSync(join(repoB, 'stray-b.txt'))).toBe(false)

      // The container dir is NOT a git repo — the shared rollback's multi-repo
      // hard gate must never aim git at it (it would throw, and the worktree
      // states above would not hold).
      expect(existsSync(join(containerDir, '.git'))).toBe(false)

      // Rerun minted — the multi-repo detour didn't break the answer flow.
      const agentRows = await db
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, seeded.taskId), eq(nodeRuns.nodeId, 'agent_x')))
      expect(agentRows.filter((r) => r.status === 'pending').length).toBe(1)

      gcTaskWriteSem(seeded.taskId)
    } finally {
      rimrafDir(tmp)
    }
  }, 20_000)
})

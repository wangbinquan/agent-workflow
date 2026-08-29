// RFC-326 — the decision path commits in ONE transaction, effects follow the
// commit, and membership is linearised with the decision
// (proposal AC-17 / AC-18 / AC-20; design §6.1-§6.4).
//
// WHY THIS FILE EXISTS (regression intent):
//   - AC-17: every persisted review write of a decision — archive, batch
//     comments / selections, outputs, status CAS, re-run mints, upstream
//     cancels — lands inside exactly one `dbTxSync` (the statement recorder
//     sees ONE `BEGIN` / ONE `COMMIT`). The distill row is a separate write
//     AFTER the commit and its failure never touches the decision (N10 / P14).
//   - AC-17: a failure injected after the archive step (a SQLite trigger inside
//     the transaction, on approve and on iterate; a prepare-time refusal on a
//     corrupt snapshot / a GC'd accepted body) leaves the six surfaces exactly
//     as they were and the run still `awaiting_review`. Archiving outside the
//     transaction again (mutation evidence ③) turns these red.
//   - AC-18: WS events are emitted only after the commit — zero on failure.
//   - AC-20: with `rollbackFilesOnIterate`, a member revoked BEFORE the queued
//     decision is refused 403 before any git command runs (worktree bytes
//     untouched); a decision queued BEFORE the revoke wins and the revoke
//     applies afterwards; a closed source fence refuses before the rollback;
//     `updateTaskMembers` re-reads the task inside the lock (a queued request
//     carrying a stale owner snapshot is refused) and the WS revalidation runs
//     after the lock is released. Dropping the lock from `updateTaskMembers`
//     (mutation evidence ⑦) turns the race cases red.

import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { asc, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { buildActor, type Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  agents as agentsTable,
  docVersions,
  memoryDistillJobs,
  nodeRunOutputs,
  nodeRuns,
  reviewComments,
  taskCollaborators,
  tasks,
  users,
  workflows,
} from '../src/db/schema'
import { submitReviewDecision, type SubmitReviewDecisionArgs } from '../src/services/review'
import { wakeHumanGateContinuation } from '../src/services/task'
import { __hasTaskReviewMutationQueueForTesting } from '../src/services/reviewMutationCoordinator'
import { hasActingMembership, updateTaskMembers } from '../src/services/taskCollab'
import { DomainError } from '../src/util/errors'
import { gitStashSnapshot, runGit } from '../src/util/git'
import { TASK_CHANNEL, taskBroadcaster } from '../src/ws/broadcaster'
import { registerRevalidationTrigger } from '../src/ws/revalidationHook'
import { recordStatements } from './helpers/statementRecorder'
import {
  installCommittedEventDeliveryHarness,
  type CommittedEventDeliveryTestHarness,
} from './helpers/committedEventHarness'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const NOW = 1_700_000_000_000
const BODY =
  '# Design v1\n\nThe `order_status` enum should include partially_refunded.\n\n## Notes\n\nexport job\n'

// ---------------------------------------------------------------------------
// Snapshot / events / errors
// ---------------------------------------------------------------------------

async function snapshot(db: DbClient): Promise<Record<string, unknown[]>> {
  const runs = await db.select().from(nodeRuns).orderBy(asc(nodeRuns.id))
  return {
    docVersions: await db.select().from(docVersions).orderBy(asc(docVersions.id)),
    reviewComments: await db.select().from(reviewComments).orderBy(asc(reviewComments.id)),
    nodeRuns: runs,
    nodeRunOutputs: await db
      .select()
      .from(nodeRunOutputs)
      .orderBy(asc(nodeRunOutputs.nodeRunId), asc(nodeRunOutputs.portName)),
    mergeStates: runs.map((r) => ({ id: r.id, mergeState: r.mergeState })),
    memoryDistillJobs: await db.select().from(memoryDistillJobs).orderBy(asc(memoryDistillJobs.id)),
  }
}

function taskEvents(taskId: string): { types: string[]; stop: () => void } {
  const types: string[] = []
  const stop = taskBroadcaster.subscribe(TASK_CHANNEL(taskId), (msg) => {
    types.push((msg as { type: string }).type)
  })
  return { types, stop }
}

async function failureOf(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn()
  } catch (err) {
    if (err instanceof Error) return err
    throw err
  }
  throw new Error('expected the call to fail')
}

function actorFor(id: string): Actor {
  return buildActor({
    user: { id, username: `u-${id.slice(-8)}`, displayName: id, role: 'user', status: 'active' },
    source: 'session',
  })
}

async function settleDecisionContinuation(
  f: Fixture,
  result: Awaited<ReturnType<typeof submitReviewDecision>>,
): Promise<void> {
  await wakeHumanGateContinuation(result.taskId, result.continuationRef, {
    db: f.db,
    appHome: f.appHome,
    schedulerDriver: { async drive() {} },
    awaitScheduler: true,
  })
}

// ---------------------------------------------------------------------------
// Fixture: real git worktree + seeded pre_snapshot + rollback-on-iterate review
// ---------------------------------------------------------------------------

interface Fixture {
  db: DbClient
  appHome: string
  repo: string
  taskId: string
  reviewRunId: string
  docRunId: string
  dvId: string
  owner: string
  member: string
  stranger: string
  extraUser: string
  committedEvents: CommittedEventDeliveryTestHarness
  cleanup: () => void
}

interface FixtureOpts {
  rollbackOnIterate?: boolean
  fence?: 'closed' | 'merged' | null
}

/** Worktree state the fixture leaves behind: a dirty tracked file + an untracked stray. */
const DIRTY = { data: 'MUTATED\n', stray: true }
const SNAPSHOT = { data: 'SNAPSHOT-TIME\n', stray: false }

function worktreeState(repo: string): { data: string; stray: boolean } {
  return {
    data: readFileSync(join(repo, 'data.txt'), 'utf8'),
    stray: existsSync(join(repo, 'stray.txt')),
  }
}

async function buildFixture(opts: FixtureOpts = {}): Promise<Fixture> {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc326-tx-'))
  const appHome = join(tmp, 'appHome')
  const repo = join(tmp, 'repo')
  mkdirSync(join(appHome, 'doc_versions'), { recursive: true })
  mkdirSync(repo, { recursive: true })
  await runGit(repo, ['init', '-q', '-b', 'main'])
  await runGit(repo, ['config', 'user.email', 't@t.test'])
  await runGit(repo, ['config', 'user.name', 't'])
  writeFileSync(join(repo, 'data.txt'), 'HEAD\n')
  await runGit(repo, ['add', '.'])
  await runGit(repo, ['-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', 'init'])
  // Snapshot-time body (what a rollback restores), then the "failed attempt".
  writeFileSync(join(repo, 'data.txt'), SNAPSHOT.data)
  const sha = await gitStashSnapshot(repo)
  if (sha === '') throw new Error('fixture: empty stash snapshot')
  writeFileSync(join(repo, 'data.txt'), DIRTY.data)
  writeFileSync(join(repo, 'stray.txt'), 'stray\n')

  const db = createInMemoryDb(MIGRATIONS)
  const committedEvents = installCommittedEventDeliveryHarness(db)
  const [owner, member, stranger, extraUser] = [ulid(), ulid(), ulid(), ulid()]
  await db.insert(users).values(
    [owner, member, stranger, extraUser].map((id, i) => ({
      id,
      username: `u${i}-${id.slice(-8)}`,
      displayName: id,
      role: 'user' as const,
      status: 'active' as const,
      createdAt: NOW,
      updatedAt: NOW,
    })),
  )
  await db.insert(agentsTable).values({
    id: ulid(),
    name: 'doc',
    description: '',
    outputs: JSON.stringify(['docpath']),
    permission: '{}',
    skills: '[]',
    frontmatterExtra: '{}',
    bodyMd: '',
  })
  const definition: WorkflowDefinition = {
    $schema_version: 2,
    inputs: [],
    nodes: [
      { id: 'doc', kind: 'agent-single', agentName: 'doc', promptTemplate: '' } as WorkflowNode,
      {
        id: 'rev_1',
        kind: 'review',
        inputSource: { nodeId: 'doc', portName: 'docpath' },
        rollbackFilesOnIterate: opts.rollbackOnIterate ?? true,
      } as unknown as WorkflowNode,
    ],
    edges: [],
  }
  const workflowId = ulid()
  await db
    .insert(workflows)
    .values({ id: workflowId, name: 'wf', definition: JSON.stringify(definition) })
  const taskId = ulid()
  await db.insert(tasks).values({
    id: taskId,
    name: 't',
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath: repo,
    worktreePath: repo,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'awaiting_review',
    inputs: '{}',
    startedAt: NOW,
    ownerUserId: owner,
    sourceTerminationFence: opts.fence ?? null,
  })
  await db.insert(taskCollaborators).values([
    { taskId, userId: owner, role: 'owner', addedBy: owner, addedAt: NOW },
    { taskId, userId: member, role: 'collaborator', addedBy: owner, addedAt: NOW },
  ])
  const docRunId = ulid()
  await db.insert(nodeRuns).values({
    id: docRunId,
    taskId,
    nodeId: 'doc',
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    preSnapshot: sha,
    startedAt: NOW - 1000,
    finishedAt: NOW - 900,
  })
  await db
    .insert(nodeRunOutputs)
    .values({ nodeRunId: docRunId, portName: 'docpath', content: BODY })
  const reviewRunId = ulid()
  await db.insert(nodeRuns).values({
    id: reviewRunId,
    taskId,
    nodeId: 'rev_1',
    status: 'awaiting_review',
    retryIndex: 0,
    iteration: 0,
    reviewIteration: 0,
    startedAt: NOW - 50,
  })
  const dvId = ulid()
  const bodyPath = `doc_versions/${dvId}.md`
  writeFileSync(join(appHome, bodyPath), BODY)
  await db.insert(docVersions).values({
    id: dvId,
    taskId,
    reviewNodeId: 'rev_1',
    reviewNodeRunId: reviewRunId,
    sourceNodeId: 'doc',
    sourcePortName: 'docpath',
    versionIndex: 1,
    reviewIteration: 0,
    bodyPath,
    decision: 'pending',
  })
  return {
    db,
    appHome,
    repo,
    taskId,
    reviewRunId,
    docRunId,
    dvId,
    owner,
    member,
    stranger,
    extraUser,
    committedEvents,
    cleanup: () => {
      committedEvents.dispose()
      db.$client.close()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

/**
 * A second review run on the same task with two INLINE documents, both accepted —
 * the multi-document shape for the transaction-count / rollback cases (impl gate
 * P2: a single-document fixture cannot tell "the second archive left the
 * transaction" from "everything committed").
 */
async function addMultiInlineRound(f: Fixture): Promise<{ runId: string; ids: [string, string] }> {
  const runId = ulid()
  await f.db.insert(nodeRuns).values({
    id: runId,
    taskId: f.taskId,
    nodeId: 'rev_1',
    status: 'awaiting_review',
    retryIndex: 1,
    iteration: 0,
    reviewIteration: 0,
    startedAt: NOW,
  })
  const ids: [string, string] = [ulid(), ulid()]
  for (const [i, id] of ids.entries()) {
    const bodyPath = `doc_versions/${id}.md`
    writeFileSync(join(f.appHome, bodyPath), `# Item ${i}\n\nbody ${i} with export job\n`)
    await f.db.insert(docVersions).values({
      id,
      taskId: f.taskId,
      reviewNodeId: 'rev_1',
      reviewNodeRunId: runId,
      sourceNodeId: 'doc',
      sourcePortName: 'docpath',
      versionIndex: 1,
      reviewIteration: 0,
      bodyPath,
      decision: 'pending',
      itemIndex: i,
      itemPath: null,
      selection: 'accepted',
    })
  }
  return { runId, ids }
}

function decisionArgs(
  f: Fixture,
  extra: Partial<SubmitReviewDecisionArgs> = {},
): SubmitReviewDecisionArgs {
  return {
    db: f.db,
    appHome: f.appHome,
    nodeRunId: f.reviewRunId,
    decision: 'iterated',
    expectedReviewIteration: 0,
    ...extra,
  }
}

const BATCH_COMMENT = { commentText: 'batched', anchorRequest: { quote: 'export job' } }

// ---------------------------------------------------------------------------
// AC-17 — one transaction, distill outside it
// ---------------------------------------------------------------------------

describe('RFC-326 AC-17 — one decision transaction; distill is a later durable consumer write', () => {
  let f: Fixture
  afterEach(() => f?.cleanup())

  test.each<['approved' | 'iterated' | 'rejected']>([['approved'], ['iterated'], ['rejected']])(
    '%s (with a batch comment): exactly one BEGIN / COMMIT, no inline distill write',
    async (decision) => {
      f = await buildFixture()
      const recording = recordStatements(f.db.$client)
      try {
        await submitReviewDecision(
          decisionArgs(f, {
            decision,
            ...(decision === 'rejected' ? { rejectReason: 'redo' } : {}),
            comments: [BATCH_COMMENT],
          }),
        )
      } finally {
        recording.stop()
      }
      const sqls = recording.statements.map((s) => s.sql)
      const begins = sqls.filter((s) => /^\s*begin/i.test(s))
      const commits = sqls.filter((s) => /^\s*commit/i.test(s))
      const rollbacks = sqls.filter((s) => /^\s*rollback/i.test(s))
      expect(begins.length).toBe(1)
      expect(commits.length).toBe(1)
      expect(rollbacks.length).toBe(0)
      const commitAt = sqls.findIndex((s) => /^\s*commit/i.test(s))
      const distillAt = sqls.findIndex((s) => /insert into "memory_distill_jobs"/i.test(s))
      expect(distillAt).toBe(-1)
      // Every review-state write sits between BEGIN and COMMIT.
      const beginAt = sqls.findIndex((s) => /^\s*begin/i.test(s))
      for (const [i, s] of sqls.entries()) {
        if (
          /^(insert into|update|delete from) "(doc_versions|review_comments|node_runs|node_run_outputs)"/i.test(
            s,
          )
        ) {
          expect(i, s).toBeGreaterThan(beginAt)
          expect(i, s).toBeLessThan(commitAt)
        }
      }
      await f.committedEvents.drain()
      expect((await f.db.select().from(memoryDistillJobs)).length).toBe(1)
    },
  )

  test('a failing distill enqueue never reverts the committed decision', async () => {
    f = await buildFixture()
    f.db.$client.exec(
      "CREATE TRIGGER distill_down BEFORE INSERT ON memory_distill_jobs BEGIN SELECT RAISE(ABORT, 'distill down'); END;",
    )
    const ev = taskEvents(f.taskId)
    try {
      const result = await submitReviewDecision(
        decisionArgs(f, { decision: 'approved', comments: [BATCH_COMMENT] }),
      )
      expect(result.batch?.commentsAdded).toBe(1)
      await f.committedEvents.drain()
    } finally {
      ev.stop()
    }
    const run = (await f.db.select().from(nodeRuns).where(eq(nodeRuns.id, f.reviewRunId)))[0]!
    expect(run.status).toBe('done')
    const dv = (await f.db.select().from(docVersions).where(eq(docVersions.id, f.dvId)))[0]!
    expect(dv.decision).toBe('approved')
    expect((JSON.parse(dv.commentsJson) as unknown[]).length).toBe(1)
    expect((await f.db.select().from(memoryDistillJobs)).length).toBe(0)
    expect(ev.types.at(-1)).toBe('review.decision_made')
  })
})

// ---------------------------------------------------------------------------
// AC-17 / AC-18 — injected failures roll everything back, emit nothing
// ---------------------------------------------------------------------------

describe('RFC-326 AC-17 / AC-18 — injected failures leave no trace', () => {
  let f: Fixture
  let ev: ReturnType<typeof taskEvents>
  afterEach(() => {
    ev?.stop()
    f?.cleanup()
  })

  async function expectRolledBack(
    before: Record<string, unknown[]>,
    run: () => Promise<unknown>,
  ): Promise<Error> {
    const err = await failureOf(run)
    expect(await snapshot(f.db)).toEqual(before)
    const row = (await f.db.select().from(nodeRuns).where(eq(nodeRuns.id, f.reviewRunId)))[0]!
    expect(row.status).toBe('awaiting_review')
    expect(row.reviewIteration).toBe(0)
    expect(ev.types).toEqual([])
    return err
  }

  test('approve: a failure after the archive step inside the transaction', async () => {
    f = await buildFixture()
    ev = taskEvents(f.taskId)
    const before = await snapshot(f.db)
    f.db.$client.exec(
      `CREATE TRIGGER inject_done BEFORE UPDATE OF status ON node_runs FOR EACH ROW WHEN NEW.status = 'done' BEGIN SELECT RAISE(ABORT, 'injected after archive'); END;`,
    )
    const err = await expectRolledBack(before, () =>
      submitReviewDecision(decisionArgs(f, { decision: 'approved', comments: [BATCH_COMMENT] })),
    )
    expect(err.message).toContain('injected after archive')
    // Repairable: drop the fault and the same request lands.
    f.db.$client.exec('DROP TRIGGER inject_done')
    const ok = await submitReviewDecision(
      decisionArgs(f, { decision: 'approved', comments: [BATCH_COMMENT] }),
    )
    expect(ok.batch?.commentsAdded).toBe(1)
    expect(ev.types.at(-1)).toBe('review.decision_made')
  })

  test('iterate with rollback: a failed decision leaves both DB and canonical worktree untouched', async () => {
    f = await buildFixture({ rollbackOnIterate: true })
    ev = taskEvents(f.taskId)
    expect(worktreeState(f.repo)).toEqual(DIRTY)
    const before = await snapshot(f.db)
    // The re-run mint is the last write group of an iterate: aborting it undoes
    // the archive, the batch comment and the upstream cancel with it.
    f.db.$client.exec(
      "CREATE TRIGGER inject_mint BEFORE INSERT ON node_runs BEGIN SELECT RAISE(ABORT, 'injected after rollback'); END;",
    )
    const err = await expectRolledBack(before, () =>
      submitReviewDecision(decisionArgs(f, { decision: 'iterated', comments: [BATCH_COMMENT] })),
    )
    expect(err.message).toContain('injected after rollback')
    const upstream = (await f.db.select().from(nodeRuns).where(eq(nodeRuns.id, f.docRunId)))[0]!
    expect(upstream.status).toBe('done')
    // RFC-333: prepare produced only a validated plan. The canonical worktree
    // cannot move unless the decision transaction commits an exact linked
    // continuation effect.
    expect(worktreeState(f.repo)).toEqual(DIRTY)
    f.db.$client.exec('DROP TRIGGER inject_mint')
    const ok = await submitReviewDecision(
      decisionArgs(f, { decision: 'iterated', comments: [BATCH_COMMENT] }),
    )
    await settleDecisionContinuation(f, ok)
    expect(ok.reviewIteration).toBe(1)
    const retired = (await f.db.select().from(nodeRuns).where(eq(nodeRuns.id, f.docRunId)))[0]!
    expect(retired.status).toBe('canceled')
    expect(retired.rolledBack).toBe(true)
    expect(retired.supersededByReview).toBe('iterated')
    expect(worktreeState(f.repo)).toEqual(SNAPSHOT)
  })

  test('a corrupt workflowSnapshot is refused in prepare — before the rollback, nothing written', async () => {
    f = await buildFixture({ rollbackOnIterate: true })
    ev = taskEvents(f.taskId)
    await f.db.update(tasks).set({ workflowSnapshot: '{not json' }).where(eq(tasks.id, f.taskId))
    const before = await snapshot(f.db)
    const err = await expectRolledBack(before, () =>
      submitReviewDecision(decisionArgs(f, { decision: 'iterated', comments: [BATCH_COMMENT] })),
    )
    expect(err).toBeInstanceOf(DomainError)
    expect((err as DomainError).code).toBe('workflow-snapshot-corrupt')
    expect(worktreeState(f.repo)).toEqual(DIRTY)
  })

  test('a GC-ed accepted body of a multi-inline round is refused before any write', async () => {
    f = await buildFixture()
    ev = taskEvents(f.taskId)
    // A second review run with two inline items, both accepted; item 1's body is gone.
    const runId = ulid()
    await f.db.insert(nodeRuns).values({
      id: runId,
      taskId: f.taskId,
      nodeId: 'rev_1',
      status: 'awaiting_review',
      retryIndex: 1,
      iteration: 0,
      reviewIteration: 0,
      startedAt: NOW,
    })
    const ids = [ulid(), ulid()]
    for (const [i, id] of ids.entries()) {
      const bodyPath = `doc_versions/${id}.md`
      writeFileSync(join(f.appHome, bodyPath), `# Item ${i}\n\nbody ${i}\n`)
      await f.db.insert(docVersions).values({
        id,
        taskId: f.taskId,
        reviewNodeId: 'rev_1',
        reviewNodeRunId: runId,
        sourceNodeId: 'doc',
        sourcePortName: 'docpath',
        versionIndex: 1,
        reviewIteration: 0,
        bodyPath,
        decision: 'pending',
        itemIndex: i,
        itemPath: null,
        selection: 'accepted',
      })
    }
    unlinkSync(join(f.appHome, `doc_versions/${ids[1]}.md`))
    const before = await snapshot(f.db)
    const err = await failureOf(() =>
      submitReviewDecision({
        db: f.db,
        appHome: f.appHome,
        nodeRunId: runId,
        decision: 'approved',
        expectedReviewIteration: 0,
      }),
    )
    expect((err as DomainError).code).toBe('doc-version-body-missing')
    expect(await snapshot(f.db)).toEqual(before)
    expect(ev.types).toEqual([])
    const run = (await f.db.select().from(nodeRuns).where(eq(nodeRuns.id, runId)))[0]!
    expect(run.status).toBe('awaiting_review')
  })
})

// ---------------------------------------------------------------------------
// AC-20 — membership is linearised with the decision
// ---------------------------------------------------------------------------

describe('RFC-326 AC-20 — membership changes and rollback-bearing decisions', () => {
  let f: Fixture
  let ev: ReturnType<typeof taskEvents>
  afterEach(() => {
    ev?.stop()
    registerRevalidationTrigger(async () => {})
    f?.cleanup()
  })

  test('revoke queued first: the decision is refused 403 before any git command; worktree bytes untouched', async () => {
    f = await buildFixture({ rollbackOnIterate: true })
    ev = taskEvents(f.taskId)
    const before = await snapshot(f.db)
    // Both calls join the task's FIFO lock in call order.
    const revoke = updateTaskMembers(
      f.db,
      actorFor(f.owner),
      { id: f.taskId, ownerUserId: f.owner },
      { members: [] },
    )
    const decide = submitReviewDecision(
      decisionArgs(f, { decision: 'iterated', actor: actorFor(f.member) }),
    )
    await revoke
    const err = await failureOf(() => decide)
    expect(err).toBeInstanceOf(DomainError)
    expect((err as DomainError).code).toBe('not-task-member')
    expect((err as DomainError).status).toBe(403)
    expect(await snapshot(f.db)).toEqual(before)
    expect(ev.types).toEqual([])
    expect(worktreeState(f.repo)).toEqual(DIRTY)
    expect(await hasActingMembership(f.db, f.taskId, f.member)).toBe(false)
  })

  test('decision queued first: it commits, its continuation settles rollback, then revoke applies', async () => {
    f = await buildFixture({ rollbackOnIterate: true })
    ev = taskEvents(f.taskId)
    const decide = submitReviewDecision(
      decisionArgs(f, { decision: 'iterated', actor: actorFor(f.member) }),
    )
    const revoke = updateTaskMembers(
      f.db,
      actorFor(f.owner),
      { id: f.taskId, ownerUserId: f.owner },
      { members: [] },
    )
    const result = await decide
    await settleDecisionContinuation(f, result)
    await revoke
    expect(result.reviewIteration).toBe(1)
    expect(worktreeState(f.repo)).toEqual(SNAPSHOT)
    const retired = (await f.db.select().from(nodeRuns).where(eq(nodeRuns.id, f.docRunId)))[0]!
    expect(retired.status).toBe('canceled')
    expect(retired.rolledBack).toBe(true)
    expect(ev.types.at(-1)).toBe('review.decision_made')
    expect(await hasActingMembership(f.db, f.taskId, f.member)).toBe(false)
  })

  test('closed source fence + rollback flag: refused 409 and the rollback never runs', async () => {
    f = await buildFixture({ rollbackOnIterate: true, fence: 'closed' })
    ev = taskEvents(f.taskId)
    const before = await snapshot(f.db)
    const err = await failureOf(() =>
      submitReviewDecision(decisionArgs(f, { decision: 'iterated', actor: actorFor(f.member) })),
    )
    expect((err as DomainError).code).toBe('task-source-terminal-closed')
    expect((err as DomainError).status).toBe(409)
    expect(await snapshot(f.db)).toEqual(before)
    expect(ev.types).toEqual([])
    expect(worktreeState(f.repo)).toEqual(DIRTY)
    // approve moves the review row to `done`, which the fence allows.
    const ok = await submitReviewDecision(
      decisionArgs(f, { decision: 'approved', actor: actorFor(f.member) }),
    )
    expect(ok.resumeRequired).toBe(true)
  })

  test('the actor is optional (trusted internal caller) — the route contract passes it', async () => {
    f = await buildFixture({ rollbackOnIterate: false })
    const result = await submitReviewDecision(decisionArgs(f, { decision: 'approved' }))
    expect(result.taskId).toBe(f.taskId)
  })

  test('updateTaskMembers: a queued request carrying a stale owner snapshot is refused inside the lock', async () => {
    f = await buildFixture()
    const staleRow = { id: f.taskId, ownerUserId: f.owner }
    // First: the owner hands the task to `extraUser`. Second (queued with the
    // row the route loaded BEFORE the transfer): the former owner adds `stranger`.
    const transfer = updateTaskMembers(f.db, actorFor(f.owner), staleRow, {
      ownerUserId: f.extraUser,
    })
    const stale = updateTaskMembers(f.db, actorFor(f.owner), staleRow, {
      members: [{ userId: f.stranger, role: 'collaborator' }],
    })
    await transfer
    const err = await failureOf(() => stale)
    expect((err as DomainError).code).toBe('forbidden')
    expect((err as DomainError).status).toBe(403)
    const task = (await f.db.select().from(tasks).where(eq(tasks.id, f.taskId)))[0]!
    expect(task.ownerUserId).toBe(f.extraUser)
    const rows = await f.db
      .select()
      .from(taskCollaborators)
      .where(eq(taskCollaborators.taskId, f.taskId))
    const roles = new Map(rows.map((r) => [r.userId, r.role]))
    expect(roles.get(f.extraUser)).toBe('owner')
    expect(roles.get(f.owner)).toBe('collaborator') // previous owner keeps a seat
    expect(roles.has(f.stranger)).toBe(false) // the stale request wrote nothing
  })

  test('updateTaskMembers: the WS revalidation runs after the task lock is released', async () => {
    f = await buildFixture()
    const seen: Array<{ reason: string; lockHeld: boolean }> = []
    registerRevalidationTrigger(async (_db, reason) => {
      seen.push({ reason, lockHeld: __hasTaskReviewMutationQueueForTesting(f.taskId) })
    })
    await updateTaskMembers(
      f.db,
      actorFor(f.owner),
      { id: f.taskId, ownerUserId: f.owner },
      {
        members: [{ userId: f.member, role: 'observer' }],
      },
    )
    expect(seen).toEqual([{ reason: 'task-members-changed', lockHeld: false }])
    expect(await hasActingMembership(f.db, f.taskId, f.member)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Impl-gate additions: multi-document transactions, fresh role, members snapshot
// ---------------------------------------------------------------------------

describe('RFC-326 AC-17 (multi-document) — one transaction, and the second archive cannot outlive the first', () => {
  let f: Fixture
  let ev: ReturnType<typeof taskEvents>
  afterEach(() => {
    ev?.stop()
    f?.cleanup()
  })

  test.each<['approved' | 'iterated' | 'rejected']>([['approved'], ['iterated'], ['rejected']])(
    '%s with a batch: both documents archive inside ONE BEGIN / COMMIT',
    async (decision) => {
      f = await buildFixture({ rollbackOnIterate: false })
      const round = await addMultiInlineRound(f)
      const recording = recordStatements(f.db.$client)
      try {
        await submitReviewDecision({
          db: f.db,
          appHome: f.appHome,
          nodeRunId: round.runId,
          decision,
          expectedReviewIteration: 0,
          ...(decision === 'rejected' ? { rejectReason: 'redo' } : {}),
          comments: [
            {
              docVersionId: round.ids[0],
              commentText: 'on item 0',
              anchorRequest: { quote: 'export job' },
            },
            {
              docVersionId: round.ids[1],
              commentText: 'on item 1',
              anchorRequest: { quote: 'export job' },
            },
          ],
        })
      } finally {
        recording.stop()
      }
      const sqls = recording.statements.map((st) => st.sql)
      expect(sqls.filter((st) => /^\s*begin/i.test(st)).length).toBe(1)
      expect(sqls.filter((st) => /^\s*commit/i.test(st)).length).toBe(1)
      const beginAt = sqls.findIndex((st) => /^\s*begin/i.test(st))
      const commitAt = sqls.findIndex((st) => /^\s*commit/i.test(st))
      const archives = sqls
        .map((st, i) => [st, i] as const)
        .filter(([st]) => /^update "doc_versions" set/i.test(st) && /"decision"/i.test(st))
      expect(archives.length).toBe(2)
      for (const [, i] of archives) {
        expect(i).toBeGreaterThan(beginAt)
        expect(i).toBeLessThan(commitAt)
      }
      const rows = await f.db
        .select()
        .from(docVersions)
        .where(eq(docVersions.reviewNodeRunId, round.runId))
      expect(rows.map((r) => r.decision)).toEqual([decision, decision])
      for (const r of rows) expect((JSON.parse(r.commentsJson) as unknown[]).length).toBe(1)
    },
  )

  test('a failure injected after the FIRST archive rolls the first one back too (six surfaces, zero events)', async () => {
    f = await buildFixture({ rollbackOnIterate: false })
    const round = await addMultiInlineRound(f)
    ev = taskEvents(f.taskId)
    const before = await snapshot(f.db)
    f.db.$client.exec(
      `CREATE TRIGGER inject_second_archive BEFORE UPDATE OF decision ON doc_versions FOR EACH ROW WHEN NEW.id = '${round.ids[1]}' AND NEW.decision <> 'pending' BEGIN SELECT RAISE(ABORT, 'injected after first archive'); END;`,
    )
    const batch = [
      {
        docVersionId: round.ids[0],
        commentText: 'batched',
        anchorRequest: { quote: 'export job' },
      },
    ]
    const err = await failureOf(() =>
      submitReviewDecision({
        db: f.db,
        appHome: f.appHome,
        nodeRunId: round.runId,
        decision: 'approved',
        expectedReviewIteration: 0,
        comments: batch,
      }),
    )
    expect(err.message).toContain('injected after first archive')
    expect(await snapshot(f.db)).toEqual(before)
    expect(ev.types).toEqual([])
    const rows = await f.db
      .select()
      .from(docVersions)
      .where(eq(docVersions.reviewNodeRunId, round.runId))
    expect(rows.map((r) => r.decision)).toEqual(['pending', 'pending'])
    const run = (await f.db.select().from(nodeRuns).where(eq(nodeRuns.id, round.runId)))[0]!
    expect(run.status).toBe('awaiting_review')
    f.db.$client.exec('DROP TRIGGER inject_second_archive')
    const ok = await submitReviewDecision({
      db: f.db,
      appHome: f.appHome,
      nodeRunId: round.runId,
      decision: 'approved',
      expectedReviewIteration: 0,
      comments: batch,
    })
    expect(ok.batch?.commentsAdded).toBe(1)
  })
})

describe('RFC-326 AC-20 (impl gate) — the role written at the commit point is the fresh one', () => {
  let f: Fixture
  afterEach(() => {
    registerRevalidationTrigger(async () => {})
    f?.cleanup()
  })

  test('owner transferred while the decision queued: decidedByRole / authorRole say collaborator, not owner', async () => {
    f = await buildFixture({ rollbackOnIterate: false })
    // The route read A as `owner` and queued; the transfer to extraUser holds the
    // lock first, leaving A a collaborator by the time the decision commits.
    const transfer = updateTaskMembers(
      f.db,
      actorFor(f.owner),
      { id: f.taskId, ownerUserId: f.owner },
      { ownerUserId: f.extraUser },
    )
    const decide = submitReviewDecision(
      decisionArgs(f, {
        decision: 'approved',
        actor: actorFor(f.owner),
        author: f.owner,
        authorRole: 'owner',
        comments: [BATCH_COMMENT],
      }),
    )
    await transfer
    const result = await decide
    expect(result.batch?.commentsAdded).toBe(1)
    const dv = (await f.db.select().from(docVersions).where(eq(docVersions.id, f.dvId)))[0]!
    expect(dv.decidedBy).toBe(f.owner)
    expect(dv.decidedByRole).toBe('user')
    const archived = JSON.parse(dv.commentsJson) as Array<{ authorRole: string | null }>
    expect(archived.map((c) => c.authorRole)).toEqual(['user'])
  })

  test("no actor (trusted internal caller): the caller's role snapshot is written as before", async () => {
    f = await buildFixture({ rollbackOnIterate: false })
    await submitReviewDecision(
      decisionArgs(f, { decision: 'approved', author: 'sys', authorRole: 'admin' }),
    )
    const dv = (await f.db.select().from(docVersions).where(eq(docVersions.id, f.dvId)))[0]!
    expect(dv.decidedByRole).toBe('admin')
  })

  test('updateTaskMembers: the response is the snapshot of ITS commit, not rows a later commit wrote during revalidation', async () => {
    f = await buildFixture()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let calls = 0
    registerRevalidationTrigger(async () => {
      calls += 1
      if (calls === 1) await gate // the first request blocks OUTSIDE the lock
    })
    // A → extraUser (owner); A stays as a collaborator.
    const first = updateTaskMembers(
      f.db,
      actorFor(f.owner),
      { id: f.taskId, ownerUserId: f.owner },
      { ownerUserId: f.extraUser },
    )
    while (calls < 1) await Bun.sleep(5)
    // extraUser → stranger, keeping extraUser as a collaborator — lands while
    // the first request is still waiting on its revalidation.
    await updateTaskMembers(
      f.db,
      actorFor(f.extraUser),
      { id: f.taskId, ownerUserId: f.extraUser },
      {
        ownerUserId: f.stranger,
        members: [
          { userId: f.extraUser, role: 'collaborator' },
          { userId: f.member, role: 'collaborator' },
        ],
      },
    )
    release()
    const firstResult = await first
    // What the FIRST commit produced: extraUser is the owner and NOT a member row.
    expect(firstResult.ownerUserId).toBe(f.extraUser)
    expect(firstResult.members.map((m) => m.user.id)).not.toContain(f.extraUser)
    expect(firstResult.members.map((m) => m.user.id).sort()).toEqual([f.member, f.owner].sort())
    // …while the database has moved on to the second commit.
    const task = (await f.db.select().from(tasks).where(eq(tasks.id, f.taskId)))[0]!
    expect(task.ownerUserId).toBe(f.stranger)
  })
})

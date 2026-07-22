// RFC-023 PR-B T11 — scheduler dispatch / state machine for clarify.
//
// What this locks in:
//   1. agent-single emits <workflow-clarify> → task transitions to
//      awaiting_human; the clarify node_run is parked awaiting_human; the
//      source agent's node_run row is `done` (it successfully expressed an
//      ask); no rerun row exists yet.
//   2. happy path output envelope through a clarify-channel-wired agent
//      proceeds normally — protocol block present but agent chose to answer.
//   3. agent-multi shard child emits clarify → ONLY that shard parks; other
//      shard children proceed to done; the parent node row is awaiting_human
//      and task is awaiting_human. Aggregation does not fire until all
//      shards are done OR the awaiting shards complete via clarify rerun.
//   4. recomputeTaskStatus / scope bubble: when scope has both
//      awaiting_human (clarify) and awaiting_review (review), awaiting_human
//      wins on the task chip per design §7.3.
//   5. A pre-existing answered clarify_session re-injects via buildClarifyPromptContext
//      end-to-end: a new node_run with clarifyIteration=1 fires runNode with
//      a prompt that contains the rendered Q&A markdown.
//
// Together with clarify-options-cap.test.ts (CLI limits guard) this rounds
// out the 7-case T11 unit budget per RFC-023 design.md §13.

import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { monotonicFactory } from 'ulid'
// RFC-074 PR-C: freshness is pure ULID id-order (isFresherNodeRun). Several
// cases below synchronously seed a stale higher-retryIndex `done` row AND the
// clarify-rerun row back-to-back; two plain ulid() calls in the same ms can
// invert (the random component decides order), letting the stale row shadow
// the rerun and flake the assertion. A shared monotonicFactory guarantees the
// later-seeded rerun always sorts freshest — mirrors scheduler-clarify-mid-batch.test.ts.
const ulid = monotonicFactory()
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, clarifyRounds, nodeRuns, taskQuestions, tasks, workflows } from '../src/db/schema'
import { runTask } from '../src/services/scheduler'
import { setNodeClarifyDirective } from '../src/services/taskClarifyDirective'
import { runGit } from '../src/util/git'

// RFC-132 (PR-C): the unified flat injector (buildClarifyQueueContext) reads DISPATCHED
// task_questions — not clarify_rounds directly. These tests synthesize an answered round
// out-of-band (mirrorClarifyAnswered), so seed the dispatched+sealed self entries the real
// dispatch path would create: originNodeRunId = the round's intermediary run; triggerRunId = the
// 承接 rerun (derived aging keys off it — a still-running / interrupted rerun is un-aged, so the
// Q&A injects). A 'stop' round ALSO needs the per-node clarify state written (the flat context
// carries no directive — the scheduler reads nodeStopOverride), so callers pair this with
// setNodeClarifyDirective(...,'stop').
async function seedDispatchedSelfQuestions(
  db: DbClient,
  taskId: string,
  originNodeRunId: string,
  questionIds: string[],
  targetNodeId: string,
  triggerRunId: string | null,
): Promise<void> {
  for (const qid of questionIds) {
    await db.insert(taskQuestions).values({
      id: ulid(),
      taskId,
      originNodeRunId,
      questionId: qid,
      questionTitle: qid,
      sourceKind: 'self',
      roleKind: 'self',
      iteration: 0,
      loopIter: 0,
      defaultTargetNodeId: targetNodeId,
      overrideTargetNodeId: null,
      sealedAt: Date.now(),
      sealedBy: 'u1',
      dispatchedAt: Date.now(),
      dispatchedBy: 'u1',
      triggerRunId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  }
}

// RFC-058 T13: scheduler now reads clarify state via `clarify_rounds`
// (unified self+cross table). These tests directly UPDATE the legacy
// `clarify_sessions` table to synthesize answered state without going through
// the answer channel (autoDispatchClarifyRound). We mirror the update onto
// `clarify_rounds` so the new read path observes the same state.
async function mirrorClarifyAnswered(
  db: DbClient,
  sessionId: string,
  fields: { answersJson: string; directive?: 'continue' | 'stop' },
): Promise<void> {
  await db
    .update(clarifyRounds)
    .set({
      status: 'answered',
      answeredAt: Date.now(),
      answeredBy: 'local',
      directive: fields.directive ?? null,
      answersJson: fields.answersJson,
    })
    .where(eq(clarifyRounds.id, sessionId))
}

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  repoPath: string
  cleanup: () => void
}

async function buildHarness(): Promise<Harness> {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-sched-clarify-'))
  const repoPath = join(appHome, 'repo')
  const worktreePath = join(appHome, 'wt')
  mkdirSync(repoPath, { recursive: true })
  mkdirSync(worktreePath, { recursive: true })
  // Real git init for both — the scheduler's gitStashSnapshot helper needs a
  // real working tree to take snapshots from. The agents are readonly in
  // this suite so the stash path is permissive; we still wire git so the
  // pre_snapshot column gets populated and the rerun-path test passes.
  await runGit(repoPath, ['init', '-b', 'main'])
  await runGit(repoPath, ['config', 'user.email', 't@t.test'])
  await runGit(repoPath, ['config', 'user.name', 't'])
  writeFileSync(join(repoPath, 'README.md'), '# r\n')
  await runGit(repoPath, ['add', '.'])
  await runGit(repoPath, ['commit', '-m', 'init'])
  await runGit(worktreePath, ['init', '-b', 'main'])
  await runGit(worktreePath, ['config', 'user.email', 't@t.test'])
  await runGit(worktreePath, ['config', 'user.name', 't'])
  writeFileSync(join(worktreePath, 'r.md'), '# r\n')
  await runGit(worktreePath, ['add', '.'])
  await runGit(worktreePath, ['commit', '-m', 'init'])
  const db = createInMemoryDb(MIGRATIONS)
  return {
    db,
    appHome,
    worktreePath,
    repoPath,
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

async function seedAgent(
  db: DbClient,
  name: string,
  outputs: string[] = ['summary'],
): Promise<void> {
  await db.insert(agents).values({
    id: ulid(),
    name,
    description: 'test',
    outputs: JSON.stringify(outputs),
    permission: '{}',
    skills: '[]',
    frontmatterExtra: '{}',
    bodyMd: '',
  })
}

async function seedWorkflowAndTask(
  h: Harness,
  definition: WorkflowDefinition,
  inputs: Record<string, string> = {},
): Promise<{ workflowId: string; taskId: string }> {
  const workflowId = ulid()
  const taskId = ulid()
  await h.db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: JSON.stringify(definition),
  })
  await h.db.insert(tasks).values({
    name: 'fixture-task',

    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath: h.repoPath,
    worktreePath: h.worktreePath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'pending',
    inputs: JSON.stringify(inputs),
    startedAt: Date.now(),
  })
  return { workflowId, taskId }
}

function withEnv<T>(env: Record<string, string>, body: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {}
  for (const k of Object.keys(env)) {
    prev[k] = process.env[k]
    process.env[k] = env[k]
  }
  return body().finally(() => {
    for (const k of Object.keys(env)) {
      const p = prev[k]
      if (p === undefined) delete process.env[k]
      else process.env[k] = p
    }
  })
}

const CLARIFY_BODY = JSON.stringify({
  questions: [
    {
      id: 'qdb',
      title: 'Which database?',
      kind: 'single',
      recommended: true,
      options: ['Postgres', 'MySQL'],
    },
  ],
})

describe('scheduler RFC-023 clarify dispatch', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => h.cleanup())

  test('agent-single emits clarify → task awaiting_human, clarify_session created, agent node_run done', async () => {
    await seedAgent(h.db, 'designer', ['design'])
    const def: WorkflowDefinition = {
      $schema_version: 3,
      inputs: [{ kind: 'text', key: 'req', label: 'r' }],
      nodes: [
        { id: 'in1', kind: 'input', inputKey: 'req' } as WorkflowNode,
        { id: 'd', kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
        { id: 'c', kind: 'clarify', title: 'Clarify me' } as WorkflowNode,
      ],
      edges: [
        {
          id: 'e_in',
          source: { nodeId: 'in1', portName: 'req' },
          target: { nodeId: 'd', portName: 'req' },
        },
        {
          id: 'e_ask',
          source: { nodeId: 'd', portName: '__clarify__' },
          target: { nodeId: 'c', portName: 'questions' },
        },
        {
          id: 'e_ans',
          source: { nodeId: 'c', portName: 'answers' },
          target: { nodeId: 'd', portName: '__clarify_response__' },
        },
      ],
    }
    const { taskId } = await seedWorkflowAndTask(h, def, { req: 'pick' })

    await withEnv({ MOCK_OPENCODE_CLARIFY_BODY: CLARIFY_BODY }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
      }),
    )

    const taskRow = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(taskRow?.status).toBe('awaiting_human')

    const sessions = await h.db.select().from(clarifyRounds).where(eq(clarifyRounds.taskId, taskId))
    expect(sessions.length).toBe(1)
    expect(sessions[0]?.status).toBe('awaiting_human')
    expect(sessions[0]?.askingNodeId).toBe('d')
    expect(sessions[0]?.askingShardKey).toBeNull()

    const runs = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    const dRun = runs.find((r) => r.nodeId === 'd' && r.parentNodeRunId === null)
    const cRun = runs.find((r) => r.nodeId === 'c')
    expect(dRun?.status).toBe('done') // agent expressed an ask successfully
    expect(cRun?.status).toBe('awaiting_human')
  })

  // RFC-100: a wired clarify channel is MANDATORY ask-back. An agent that emits
  // <workflow-output> instead of asking is rejected (clarify-required); with the
  // mock stubbornly re-emitting output across followup retries the node — and the
  // task — hard-fail. There is no output escape hatch while clarify is active.
  test('agent with clarify channel that emits <workflow-output> instead of asking → task failed (clarify-required)', async () => {
    await seedAgent(h.db, 'designer', ['design'])
    const def: WorkflowDefinition = {
      $schema_version: 3,
      inputs: [{ kind: 'text', key: 'req', label: 'r' }],
      nodes: [
        { id: 'in1', kind: 'input', inputKey: 'req' } as WorkflowNode,
        { id: 'd', kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
        { id: 'c', kind: 'clarify', title: 'Clarify me' } as WorkflowNode,
      ],
      edges: [
        {
          id: 'e_in',
          source: { nodeId: 'in1', portName: 'req' },
          target: { nodeId: 'd', portName: 'req' },
        },
        {
          id: 'e_ask',
          source: { nodeId: 'd', portName: '__clarify__' },
          target: { nodeId: 'c', portName: 'questions' },
        },
      ],
    }
    const { taskId } = await seedWorkflowAndTask(h, def, { req: 'pick' })

    await withEnv({ MOCK_OPENCODE_OUTPUTS: JSON.stringify({ design: 'plan' }) }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
      }),
    )

    const taskRow = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(taskRow?.status).toBe('failed')
    expect(taskRow?.errorMessage ?? '').toContain('clarify-required')

    // The agent never emitted a clarify envelope, so no session was ever created.
    const sessions = await h.db.select().from(clarifyRounds).where(eq(clarifyRounds.taskId, taskId))
    expect(sessions.length).toBe(0)
  })

  test('agent without clarify channel that erroneously emits clarify is rejected with clarify-no-channel', async () => {
    await seedAgent(h.db, 'designer', ['design'])
    const def: WorkflowDefinition = {
      $schema_version: 3,
      inputs: [{ kind: 'text', key: 'req', label: 'r' }],
      nodes: [
        { id: 'in1', kind: 'input', inputKey: 'req' } as WorkflowNode,
        { id: 'd', kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
      ],
      edges: [
        {
          id: 'e_in',
          source: { nodeId: 'in1', portName: 'req' },
          target: { nodeId: 'd', portName: 'req' },
        },
      ],
    }
    const { taskId } = await seedWorkflowAndTask(h, def, { req: 'pick' })

    await withEnv({ MOCK_OPENCODE_CLARIFY_BODY: CLARIFY_BODY }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
      }),
    )

    const taskRow = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(taskRow?.status).toBe('failed')
    expect(taskRow?.errorMessage ?? '').toContain('clarify-no-channel')
  })

  test('rerun row after a manually-seeded answered session: scheduler re-runs agent with clarifyIteration > 0 and prompt carries Q&A markdown', async () => {
    await seedAgent(h.db, 'designer', ['design'])
    const def: WorkflowDefinition = {
      $schema_version: 3,
      inputs: [{ kind: 'text', key: 'req', label: 'r' }],
      nodes: [
        { id: 'in1', kind: 'input', inputKey: 'req' } as WorkflowNode,
        { id: 'd', kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
        { id: 'c', kind: 'clarify', title: 'Clarify me' } as WorkflowNode,
      ],
      edges: [
        {
          id: 'e_in',
          source: { nodeId: 'in1', portName: 'req' },
          target: { nodeId: 'd', portName: 'req' },
        },
        {
          id: 'e_ask',
          source: { nodeId: 'd', portName: '__clarify__' },
          target: { nodeId: 'c', portName: 'questions' },
        },
      ],
    }
    const { taskId } = await seedWorkflowAndTask(h, def, { req: 'go' })

    // Step 1: drive the first run so the agent asks.
    await withEnv({ MOCK_OPENCODE_CLARIFY_BODY: CLARIFY_BODY }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
      }),
    )

    // Step 2: synthesize an answer + a rerun row (this is what the unified
    // answer dispatch normally does — we exercise scheduler->runner here
    // without invoking the REST path).
    const sessRow = (
      await h.db.select().from(clarifyRounds).where(eq(clarifyRounds.taskId, taskId))
    )[0]!
    const ANSWERS_JSON_S2 = JSON.stringify([
      {
        questionId: 'qdb',
        selectedOptionIndices: [0],
        selectedOptionLabels: ['Postgres'],
        customText: '',
      },
    ])
    await h.db
      .update(clarifyRounds)
      .set({
        status: 'answered',
        answeredAt: Date.now(),
        answeredBy: 'local',
        answersJson: ANSWERS_JSON_S2,
      })
      .where(eq(clarifyRounds.id, sessRow.id))
    // RFC-100: directive='stop' so this rerun is the finalize round — the agent
    // is released from ask-back mode and its <workflow-output> is accepted.
    await mirrorClarifyAnswered(h.db, sessRow.id, {
      answersJson: ANSWERS_JSON_S2,
      directive: 'stop',
    })
    await h.db
      .update(nodeRuns)
      .set({ status: 'done', finishedAt: Date.now() })
      .where(eq(nodeRuns.id, sessRow.intermediaryNodeRunId))
    const rerunId = ulid()
    await h.db.insert(nodeRuns).values({
      id: rerunId,
      taskId,
      nodeId: 'd',
      status: 'pending',
      retryIndex: 0,
      iteration: 0,
      // RFC-098 WP-10: synthesized as the clarify-answer rerun the answer
      // dispatch mints — incl. the rerun_cause column gate-2 now reads.
      rerunCause: 'clarify-answer',
    })
    // RFC-132 (PR-C): dispatch the answered round to the rerun + record the 'stop' node state.
    await seedDispatchedSelfQuestions(
      h.db,
      taskId,
      sessRow.intermediaryNodeRunId,
      ['qdb'],
      'd',
      rerunId,
    )
    await setNodeClarifyDirective(h.db, taskId, 'd', 'stop', 'u1')
    await h.db.update(tasks).set({ status: 'pending' }).where(eq(tasks.id, taskId))

    await withEnv({ MOCK_OPENCODE_OUTPUTS: JSON.stringify({ design: 'with pg' }) }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
      }),
    )

    const rerunRow = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, rerunId)))[0]!
    expect(rerunRow.status).toBe('done')
    // RFC-132 (PR-C): the flat `## Clarify Q&A` block carries the answer as an equal peer.
    expect(rerunRow.promptText ?? '').toContain('Clarify Q&A')
    expect(rerunRow.promptText ?? '').toContain('Postgres')
  })

  // Regression: prior to the isFresherNodeRun comparator, the latest-row
  // ordering put retryIndex first. When a user (a) had previously triggered
  // single-node retries that left a high retryIndex `done` row on the agent,
  // and then (b) answered a fresh clarify session — the then-current immediate
  // mint created the rerun row at (retryIndex=0, clarifyIteration+1) per
  // RFC-023's "process-retry budget intact" rule. The old ordering let the stale
  // (retryIndex=N, clarifyIteration=0) done row beat the rerun, so the
  // scheduler marked the node completed, returned ok, marked the TASK done,
  // and the pending rerun was left to be swept to `interrupted` on daemon
  // shutdown. Observed in production task 01KRT38TKXQGKEDHCPQXPXTB9J.
  test('clarify rerun (retry=0, clarifyIter=N+1) beats a stale higher-retryIndex done row', async () => {
    await seedAgent(h.db, 'designer', ['design'])
    const def: WorkflowDefinition = {
      $schema_version: 3,
      inputs: [{ kind: 'text', key: 'req', label: 'r' }],
      nodes: [
        { id: 'in1', kind: 'input', inputKey: 'req' } as WorkflowNode,
        { id: 'd', kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
        { id: 'c', kind: 'clarify', title: 'Clarify me' } as WorkflowNode,
      ],
      edges: [
        {
          id: 'e_in',
          source: { nodeId: 'in1', portName: 'req' },
          target: { nodeId: 'd', portName: 'req' },
        },
        {
          id: 'e_ask',
          source: { nodeId: 'd', portName: '__clarify__' },
          target: { nodeId: 'c', portName: 'questions' },
        },
        {
          id: 'e_ans',
          source: { nodeId: 'c', portName: 'answers' },
          target: { nodeId: 'd', portName: '__clarify_response__' },
        },
      ],
    }
    const { taskId } = await seedWorkflowAndTask(h, def, { req: 'go' })

    // Step 1: drive the first run so the agent asks (creates clarify_session
    // + clarify node_run + agent node_run at retry=0/clarifyIter=0/done).
    await withEnv({ MOCK_OPENCODE_CLARIFY_BODY: CLARIFY_BODY }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
      }),
    )

    // Step 2: simulate the historical single-node-retry storm by inserting a
    // late `done` row for the agent at a high retryIndex but clarifyIter=0.
    // This is what production task 01KRT38TKXQGKEDHCPQXPXTB9J actually had:
    // retry=6 / clarify=0 / done from process retries that succeeded.
    await h.db.insert(nodeRuns).values({
      id: ulid(),
      taskId,
      nodeId: 'd',
      status: 'done',
      retryIndex: 6,
      iteration: 0,
      startedAt: Date.now() - 1000,
      finishedAt: Date.now() - 500,
    })

    // Step 3: synthesize an answered clarify session + a rerun row at the
    // tuple the then-current immediate mint produced (retry=0, clarifyIter=1
    // — the production incident's exact shape; the comparator must beat it
    // by pure id order regardless of retryIndex).
    const sessRow = (
      await h.db.select().from(clarifyRounds).where(eq(clarifyRounds.taskId, taskId))
    )[0]!
    const ANSWERS_JSON_S3A = JSON.stringify([
      {
        questionId: 'qdb',
        selectedOptionIndices: [0],
        selectedOptionLabels: ['Postgres'],
        customText: '',
      },
    ])
    await h.db
      .update(clarifyRounds)
      .set({
        status: 'answered',
        answeredAt: Date.now(),
        answeredBy: 'local',
        // RFC-100: stop = finalize round, so the rerun's <workflow-output> is accepted.
        directive: 'stop',
        answersJson: ANSWERS_JSON_S3A,
      })
      .where(eq(clarifyRounds.id, sessRow.id))
    await mirrorClarifyAnswered(h.db, sessRow.id, {
      answersJson: ANSWERS_JSON_S3A,
      directive: 'stop',
    })
    await h.db
      .update(nodeRuns)
      .set({ status: 'done', finishedAt: Date.now() })
      .where(eq(nodeRuns.id, sessRow.intermediaryNodeRunId))
    const rerunId = ulid()
    await h.db.insert(nodeRuns).values({
      id: rerunId,
      taskId,
      nodeId: 'd',
      status: 'pending',
      retryIndex: 0,
      iteration: 0,
      // RFC-098 WP-10: synthesized as the clarify-answer rerun the answer
      // dispatch mints — incl. the rerun_cause column gate-2 now reads.
      rerunCause: 'clarify-answer',
    })
    // RFC-132 (PR-C): dispatch to the fresh rerun (triggerRunId=rerunId, minted AFTER the stale
    // retry=6 done row, so derived aging keys off the fresher id — the stale row can't age it out)
    // + record the 'stop' node state so the finalize round is released.
    await seedDispatchedSelfQuestions(
      h.db,
      taskId,
      sessRow.intermediaryNodeRunId,
      ['qdb'],
      'd',
      rerunId,
    )
    await setNodeClarifyDirective(h.db, taskId, 'd', 'stop', 'u1')
    await h.db.update(tasks).set({ status: 'pending' }).where(eq(tasks.id, taskId))

    await withEnv({ MOCK_OPENCODE_OUTPUTS: JSON.stringify({ design: 'with pg' }) }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
      }),
    )

    // The fresh rerun must actually run — not be shadowed by the retry=6 row.
    const rerunRow = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, rerunId)))[0]!
    expect(rerunRow.status).toBe('done')
    expect(rerunRow.promptText ?? '').toContain('Postgres')

    // And the task must reach done via the rerun, not by short-circuiting on
    // the stale retry=6 done row.
    const finalTask = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!
    expect(finalTask.status).toBe('done')
  })

  // Regression: when a daemon restart sweeps a clarify-driven rerun row to
  // 'interrupted' (RFC-024 P-4-07 path), resume / scheduler re-entry used to
  // mint a fresh pending row via insertNodeRun() that defaulted
  // clarifyIteration to 0 — buildClarifyPromptContext then returned undefined
  // and the next prompt carried zero Q&A history. scheduleAgentNode must now
  // inherit clarifyIteration (and shard / parent / review iteration) from the
  // latest existing row when minting the fresh attempt.
  test('interrupted clarify rerun: re-entering scheduler keeps clarifyIteration on the fresh attempt + Q&A in prompt', async () => {
    await seedAgent(h.db, 'designer', ['design'])
    const def: WorkflowDefinition = {
      $schema_version: 3,
      inputs: [{ kind: 'text', key: 'req', label: 'r' }],
      nodes: [
        { id: 'in1', kind: 'input', inputKey: 'req' } as WorkflowNode,
        { id: 'd', kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
        { id: 'c', kind: 'clarify', title: 'Clarify me' } as WorkflowNode,
      ],
      edges: [
        {
          id: 'e_in',
          source: { nodeId: 'in1', portName: 'req' },
          target: { nodeId: 'd', portName: 'req' },
        },
        {
          id: 'e_ask',
          source: { nodeId: 'd', portName: '__clarify__' },
          target: { nodeId: 'c', portName: 'questions' },
        },
        {
          id: 'e_ans',
          source: { nodeId: 'c', portName: 'answers' },
          target: { nodeId: 'd', portName: '__clarify_response__' },
        },
      ],
    }
    const { taskId } = await seedWorkflowAndTask(h, def, { req: 'go' })

    // Step 1: first run — agent asks, parks at awaiting_human.
    await withEnv({ MOCK_OPENCODE_CLARIFY_BODY: CLARIFY_BODY }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
      }),
    )

    // Step 2: synthesize the answered session + the clarify-rerun row the
    // answer channel normally mints (synthesized here at retry=0).
    const sessRow = (
      await h.db.select().from(clarifyRounds).where(eq(clarifyRounds.taskId, taskId))
    )[0]!
    const ANSWERS_JSON_S2B = JSON.stringify([
      {
        questionId: 'qdb',
        selectedOptionIndices: [0],
        selectedOptionLabels: ['Postgres'],
        customText: '',
      },
    ])
    await h.db
      .update(clarifyRounds)
      .set({
        status: 'answered',
        answeredAt: Date.now(),
        answeredBy: 'local',
        // RFC-100 + RFC-098 + Codex review #2: the interrupted rerun below is
        // revived with cause='revival'. isClarifyRerunCause excludes 'revival',
        // BUT applyLatestDirective = isClarifyRerun || reviewContext === undefined
        // and a revival is NOT review-driven — so the directive IS applied now.
        // Here it is 'continue' → mandatory ask-back stays ON → the revived run
        // asks again (driven by the clarify body below). The STOP-revival sibling
        // test locks the other half: a revived 'stop' round stays RELEASED.
        directive: 'continue',
        answersJson: ANSWERS_JSON_S2B,
      })
      .where(eq(clarifyRounds.id, sessRow.id))
    await mirrorClarifyAnswered(h.db, sessRow.id, {
      answersJson: ANSWERS_JSON_S2B,
      directive: 'continue',
    })
    await h.db
      .update(nodeRuns)
      .set({ status: 'done', finishedAt: Date.now() })
      .where(eq(nodeRuns.id, sessRow.intermediaryNodeRunId))
    const rerunId = ulid()
    await h.db.insert(nodeRuns).values({
      id: rerunId,
      taskId,
      nodeId: 'd',
      status: 'pending',
      retryIndex: 0,
      iteration: 0,
      // RFC-098 WP-10: synthesized as the clarify-answer rerun the answer
      // dispatch mints — incl. the rerun_cause column gate-2 now reads.
      rerunCause: 'clarify-answer',
    })
    // RFC-132 (PR-C): dispatch the answered 'continue' round to this rerun (bound now; the fresh
    // revival attempt re-binds + re-injects since an interrupted rerun never produced output).
    await seedDispatchedSelfQuestions(
      h.db,
      taskId,
      sessRow.intermediaryNodeRunId,
      ['qdb'],
      'd',
      rerunId,
    )

    // Step 3: simulate the daemon restart sweep — the rerun row never got a
    // chance to run; orphans.ts flips pending/running rows to 'interrupted'.
    await h.db
      .update(nodeRuns)
      .set({ status: 'interrupted', finishedAt: Date.now() })
      .where(eq(nodeRuns.id, rerunId))
    await h.db.update(tasks).set({ status: 'pending' }).where(eq(tasks.id, taskId))

    // Step 4: re-enter the scheduler (what /resume or runTask after restart
    // does). The scheduler must mint a fresh attempt that INHERITS
    // clarifyIteration=1 — not reset it to 0. RFC-100 (Codex review #2): the
    // revived run APPLIES the 'continue' directive (revival is not review-driven)
    // → mandatory ask-back → the agent asks again — the assertions below lock
    // clarifyIteration inheritance + Q&A.
    await withEnv({ MOCK_OPENCODE_CLARIFY_BODY: CLARIFY_BODY }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
      }),
    )

    const allRuns = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    // The fresh attempt is the most recent agent-d row (retry=1, ci=1).
    const dRuns = allRuns
      .filter((r) => r.nodeId === 'd' && r.parentNodeRunId === null)
      .sort((a, b) => b.retryIndex - a.retryIndex)
    const fresh = dRuns[0]!
    expect(fresh.id).not.toBe(rerunId)
    expect(fresh.status).toBe('done')
    expect(fresh.promptText ?? '').toContain('Clarify Q&A')
    expect(fresh.promptText ?? '').toContain('Postgres')
  })

  // RFC-100 (Codex review #2 / documented limitation-1 fix): a 'stop' (finalize)
  // round that is interrupted then REVIVED must stay RELEASED — the revived run
  // is handed the <workflow-output> format, NOT mandatory ask-back. Before the
  // fix, revival (cause='revival') dropped the stored directive →
  // applyLatestDirective=false → effectiveHasClarifyChannel was re-forced true →
  // the agent's final <workflow-output> was rejected (clarify-required) and the
  // finalize round could never complete after a daemon restart.
  test('interrupted STOP-clarify rerun: revival stays released (outputs), not re-forced into ask-back', async () => {
    await seedAgent(h.db, 'designer', ['design'])
    const def: WorkflowDefinition = {
      $schema_version: 3,
      inputs: [{ kind: 'text', key: 'req', label: 'r' }],
      nodes: [
        { id: 'in1', kind: 'input', inputKey: 'req' } as WorkflowNode,
        { id: 'd', kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
        { id: 'c', kind: 'clarify', title: 'Clarify me' } as WorkflowNode,
      ],
      edges: [
        {
          id: 'e_in',
          source: { nodeId: 'in1', portName: 'req' },
          target: { nodeId: 'd', portName: 'req' },
        },
        {
          id: 'e_ask',
          source: { nodeId: 'd', portName: '__clarify__' },
          target: { nodeId: 'c', portName: 'questions' },
        },
        {
          id: 'e_ans',
          source: { nodeId: 'c', portName: 'answers' },
          target: { nodeId: 'd', portName: '__clarify_response__' },
        },
      ],
    }
    const { taskId } = await seedWorkflowAndTask(h, def, { req: 'go' })

    // Step 1: first run — agent asks, parks at awaiting_human.
    await withEnv({ MOCK_OPENCODE_CLARIFY_BODY: CLARIFY_BODY }, () =>
      runTask({ taskId, db: h.db, appHome: h.appHome, opencodeCmd: ['bun', 'run', MOCK_OPENCODE] }),
    )

    // Step 2: synthesize the answered session with directive='stop' (the user
    // clicked Stop → finalize round) + the clarify-rerun row.
    const sessRow = (
      await h.db.select().from(clarifyRounds).where(eq(clarifyRounds.taskId, taskId))
    )[0]!
    const ANSWERS_JSON = JSON.stringify([
      {
        questionId: 'qdb',
        selectedOptionIndices: [0],
        selectedOptionLabels: ['Postgres'],
        customText: '',
      },
    ])
    await h.db
      .update(clarifyRounds)
      .set({
        status: 'answered',
        answeredAt: Date.now(),
        answeredBy: 'local',
        directive: 'stop',
        answersJson: ANSWERS_JSON,
      })
      .where(eq(clarifyRounds.id, sessRow.id))
    await mirrorClarifyAnswered(h.db, sessRow.id, { answersJson: ANSWERS_JSON, directive: 'stop' })
    await h.db
      .update(nodeRuns)
      .set({ status: 'done', finishedAt: Date.now() })
      .where(eq(nodeRuns.id, sessRow.intermediaryNodeRunId))
    const rerunId = ulid()
    await h.db.insert(nodeRuns).values({
      id: rerunId,
      taskId,
      nodeId: 'd',
      status: 'pending',
      retryIndex: 0,
      iteration: 0,
      rerunCause: 'clarify-answer',
    })
    // RFC-132 (PR-C): dispatch the answered 'stop' round + record the 'stop' node state so the
    // revived finalize round stays RELEASED (nodeStopOverride → effectiveHasClarifyChannel=false).
    await seedDispatchedSelfQuestions(
      h.db,
      taskId,
      sessRow.intermediaryNodeRunId,
      ['qdb'],
      'd',
      rerunId,
    )
    await setNodeClarifyDirective(h.db, taskId, 'd', 'stop', 'u1')

    // Step 3: simulate the daemon restart sweep → the rerun row is interrupted.
    await h.db
      .update(nodeRuns)
      .set({ status: 'interrupted', finishedAt: Date.now() })
      .where(eq(nodeRuns.id, rerunId))
    await h.db.update(tasks).set({ status: 'pending' }).where(eq(tasks.id, taskId))

    // Step 4: re-enter the scheduler. The revived stop-round run must be RELEASED
    // → it sees the <workflow-output> format → emits output → done. The mock
    // emits OUTPUT (not clarify), proving the runtime guard did NOT reject it.
    await withEnv({ MOCK_OPENCODE_OUTPUTS: JSON.stringify({ design: 'FINAL_V1' }) }, () =>
      runTask({ taskId, db: h.db, appHome: h.appHome, opencodeCmd: ['bun', 'run', MOCK_OPENCODE] }),
    )

    const allRuns = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    const fresh = allRuns
      .filter((r) => r.nodeId === 'd' && r.parentNodeRunId === null)
      .sort((a, b) => b.retryIndex - a.retryIndex)[0]!
    expect(fresh.id).not.toBe(rerunId)
    // RELEASED: the revived finalize round got the output format, NOT ask-back.
    expect(fresh.promptText ?? '').toContain('You MUST end your reply with a')
    expect(fresh.promptText ?? '').not.toContain('MANDATORY ASK-BACK (clarify) mode')
    // And it actually finalized (output accepted, not clarify-required looped).
    expect(fresh.status).toBe('done')
  })

  // Multi-round boundary: with TWO already-answered rounds (ci=0 and ci=1)
  // plus a clarify-rerun row at ci=2 that got swept to 'interrupted' by a
  // daemon restart, the freshly minted attempt must keep clarifyIteration=2
  // AND buildClarifyPromptContext must render BOTH Round 1 + Round 2 Q&A in
  // the next prompt (chronological order). This locks the multi-round-history
  // slice of clarify.ts and the inheritance path in scheduler.ts together —
  // neither in isolation suffices.
  test('multi-round (ci=2) interrupted rerun: every prior round renders in next prompt', async () => {
    await seedAgent(h.db, 'designer', ['design'])
    const def: WorkflowDefinition = {
      $schema_version: 3,
      inputs: [{ kind: 'text', key: 'req', label: 'r' }],
      nodes: [
        { id: 'in1', kind: 'input', inputKey: 'req' } as WorkflowNode,
        { id: 'd', kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
        { id: 'c', kind: 'clarify', title: 'Clarify me' } as WorkflowNode,
      ],
      edges: [
        {
          id: 'e_in',
          source: { nodeId: 'in1', portName: 'req' },
          target: { nodeId: 'd', portName: 'req' },
        },
        {
          id: 'e_ask',
          source: { nodeId: 'd', portName: '__clarify__' },
          target: { nodeId: 'c', portName: 'questions' },
        },
        {
          id: 'e_ans',
          source: { nodeId: 'c', portName: 'answers' },
          target: { nodeId: 'd', portName: '__clarify_response__' },
        },
      ],
    }
    const { taskId } = await seedWorkflowAndTask(h, def, { req: 'go' })

    // Round 1 (ci=0): first run asks "Which database?".
    await withEnv({ MOCK_OPENCODE_CLARIFY_BODY: CLARIFY_BODY }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
      }),
    )
    const round1Sess = (
      await h.db.select().from(clarifyRounds).where(eq(clarifyRounds.taskId, taskId))
    )[0]!
    const ANSWERS_JSON_R1 = JSON.stringify([
      {
        questionId: 'qdb',
        selectedOptionIndices: [0],
        selectedOptionLabels: ['Postgres'],
        customText: '',
      },
    ])
    await h.db
      .update(clarifyRounds)
      .set({
        status: 'answered',
        answeredAt: Date.now(),
        answeredBy: 'local',
        directive: 'continue',
        answersJson: ANSWERS_JSON_R1,
      })
      .where(eq(clarifyRounds.id, round1Sess.id))
    await mirrorClarifyAnswered(h.db, round1Sess.id, {
      answersJson: ANSWERS_JSON_R1,
      directive: 'continue',
    })
    await h.db
      .update(nodeRuns)
      .set({ status: 'done', finishedAt: Date.now() })
      .where(eq(nodeRuns.id, round1Sess.intermediaryNodeRunId))

    // Round 2 (ci=1): mint rerun row, drive it through to ask "Which env?".
    const ci1Id = ulid()
    await h.db.insert(nodeRuns).values({
      id: ci1Id,
      taskId,
      nodeId: 'd',
      status: 'pending',
      retryIndex: 0,
      iteration: 0,
      // RFC-098 WP-10: synthesized as the clarify-answer rerun the answer
      // dispatch mints — incl. the rerun_cause column gate-2 now reads.
      rerunCause: 'clarify-answer',
    })
    // RFC-132 (PR-C): dispatch round 1's answer to the round-2-asking rerun (ci1Id). It stays un-aged
    // (ci1 only ever emits <workflow-clarify>, never output), so it accumulates into every later
    // rerun's flat block — 01KWDKBS: round 1 must not vanish.
    await seedDispatchedSelfQuestions(
      h.db,
      taskId,
      round1Sess.intermediaryNodeRunId,
      ['qdb'],
      'd',
      ci1Id,
    )
    await h.db.update(tasks).set({ status: 'pending' }).where(eq(tasks.id, taskId))
    const ROUND2_BODY = JSON.stringify({
      questions: [
        {
          id: 'qenv',
          title: 'Which environment first?',
          kind: 'single',
          recommended: true,
          options: ['Staging', 'Prod'],
        },
      ],
    })
    await withEnv({ MOCK_OPENCODE_CLARIFY_BODY: ROUND2_BODY }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
      }),
    )
    const allSess = await h.db.select().from(clarifyRounds).where(eq(clarifyRounds.taskId, taskId))
    const round2Sess = allSess.find((s) => s.iteration === 1)!
    const ANSWERS_JSON_R2 = JSON.stringify([
      {
        questionId: 'qenv',
        selectedOptionIndices: [0],
        selectedOptionLabels: ['Staging'],
        customText: '',
      },
    ])
    await h.db
      .update(clarifyRounds)
      .set({
        status: 'answered',
        answeredAt: Date.now(),
        answeredBy: 'local',
        // RFC-100 + RFC-098 revival boundary: the ci=2 rerun is revived with
        // cause='revival' (isClarifyRerunCause excludes it), so the revived run
        // re-enters mandatory ask-back regardless of this directive and asks
        // again — locking Round 1 + Round 2 Q&A rendering, the test's intent.
        directive: 'continue',
        answersJson: ANSWERS_JSON_R2,
      })
      .where(eq(clarifyRounds.id, round2Sess.id))
    await mirrorClarifyAnswered(h.db, round2Sess.id, {
      answersJson: ANSWERS_JSON_R2,
      directive: 'continue',
    })
    await h.db
      .update(nodeRuns)
      .set({ status: 'done', finishedAt: Date.now() })
      .where(eq(nodeRuns.id, round2Sess.intermediaryNodeRunId))

    // Mint the ci=2 rerun row, immediately mark interrupted (daemon restart).
    const ci2Id = ulid()
    await h.db.insert(nodeRuns).values({
      id: ci2Id,
      taskId,
      nodeId: 'd',
      status: 'interrupted',
      retryIndex: 0,
      iteration: 0,
      finishedAt: Date.now(),
    })
    // RFC-132 (PR-C): dispatch round 2's answer to the ci=2 rerun (interrupted → un-aged), so the
    // revival's flat block carries BOTH rounds.
    await seedDispatchedSelfQuestions(
      h.db,
      taskId,
      round2Sess.intermediaryNodeRunId,
      ['qenv'],
      'd',
      ci2Id,
    )
    await h.db.update(tasks).set({ status: 'pending' }).where(eq(tasks.id, taskId))

    // Re-enter scheduler. Fresh row must inherit ci=2 and prompt must carry
    // BOTH 'Postgres' (Round 1) and 'Staging' (Round 2). RFC-100: the revived
    // run is mandatory ask-back (directive dropped on revival), so it asks again.
    await withEnv({ MOCK_OPENCODE_CLARIFY_BODY: ROUND2_BODY }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
      }),
    )

    const allRuns = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    const dRuns = allRuns
      .filter((r) => r.nodeId === 'd' && r.parentNodeRunId === null)
      .sort((a, b) => b.retryIndex - a.retryIndex)
    const fresh = dRuns[0]!
    expect(fresh.id).not.toBe(ci2Id)
    expect(fresh.status).toBe('done')
    const prompt = fresh.promptText ?? ''
    // RFC-132 (PR-C): both rounds render as EQUAL peers in the single flat `## Clarify Q&A` block —
    // no `### Round N` grouping. Both answers still accumulate (derived aging keeps both un-aged).
    expect(prompt).toContain('## Clarify Q&A')
    expect(prompt).not.toContain('### Round')
    expect(prompt).toContain('Which database?')
    expect(prompt).toContain('Which environment first?')
    expect(prompt).toContain('Postgres')
    expect(prompt).toContain('Staging')
  })
})

// RFC-060 PR-E: agent-multi removed; the prior per-shard clarify dispatch
// suite is no longer applicable. wrapper-fanout per-shard clarify (D.T5) is
// deferred to PR-D2 by design — see runFanoutWrapperNode v1 inner-kind
// limitation in scheduler.ts.

import { rimrafDir } from './helpers/cleanup'
// RFC-127 T5 → RFC-131 T4 «去借壳» (dispatch-only de-borrow). This file WAS the positive lock for the
// RFC-127「借壳」(borrow-the-shell) path; RFC-131 T4 RETIRES 借壳 — a reassign now MOVES the rerun to
// the target node (which runs its OWN agent), no borrow. design §4 authorizes「rfc127-*-borrow 改语义
// 或删」; per that, the pure-borrow feature tests (per-home multi-borrow gate, cascade borrow
// propagation, borrow carry-leak, retry-keeps-borrow) are DELETED, and the rest are re-pointed to the
// de-borrow semantics:
//
//   effectiveTarget = override ?? default   (the node a rerun is MINTED on — run.node_id — 去借壳)
//
//   • clarify-designer, no override → effectiveTarget=default=D
//       → mint node_id=D, agent_override_name NULL (byte-for-byte the baseline; golden-lock KEPT).
//   • clarify-designer, override X  → effectiveTarget=X
//       → mint node_id=**X** + agent_override_name NULL (X runs its OWN agent on X's own artifact);
//         the answer injects into X's per-node queue. A never-run X is REJECTED (no prior run to inherit).
//
// The reversed/adapted old-behavior cases also live in rfc120-deferred-dispatch.test.ts; this file
// keeps the de-borrow positive net + the two golden-locks so a refactor that re-introduces borrow
// («override lends its agent instead of moving the run») goes red here.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRunOutputs, nodeRuns, taskQuestions, tasks, workflows } from '../src/db/schema'
import { createAgent } from '../src/services/agent'
import { createCrossClarifySession } from '../src/services/crossClarify'
import { sealRoundQuestions } from '../src/services/clarifySeal'
import { bindTriggerRun } from '../src/services/clarifyQueue'
import { runTask } from '../src/services/scheduler'
import { reassignTaskQuestion } from '../src/services/taskQuestions'
import { dispatchTaskQuestions } from '../src/services/taskQuestionDispatch'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type { ClarifyQuestion, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')

const DESIGNER = 'designer'
const QUESTIONER = 'questioner'
const CC = 'cross1'
// A plain agent node (no __external_feedback__ edge) — a valid reassign target. RFC-131 T4 去借壳:
// when a clarify-designer question is reassigned to it, the rerun is minted ON this node and runs
// its OWN agent (OTHER_AGENT) — no borrow.
const OTHER = 'other'
const OTHER_AGENT = 'other'

const actor = { userId: 'u1', role: 'owner' as const }

function liveDef(): WorkflowDefinition {
  const nodes: WorkflowNode[] = [
    { id: DESIGNER, kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
    { id: QUESTIONER, kind: 'agent-single', agentName: 'questioner' } as WorkflowNode,
    { id: OTHER, kind: 'agent-single', agentName: OTHER_AGENT } as WorkflowNode,
    { id: CC, kind: 'clarify-cross-agent', title: 'cc' } as WorkflowNode,
  ]
  return {
    $schema_version: 4,
    inputs: [],
    nodes,
    edges: [
      {
        id: 'e_q_cc',
        source: { nodeId: QUESTIONER, portName: '__clarify__' },
        target: { nodeId: CC, portName: 'questions' },
      },
      {
        id: 'e_cc_d',
        source: { nodeId: CC, portName: 'to_designer' },
        target: { nodeId: DESIGNER, portName: '__external_feedback__' },
      },
      {
        id: 'e_cc_q',
        source: { nodeId: CC, portName: 'to_questioner' },
        target: { nodeId: QUESTIONER, portName: '__clarify_response__' },
      },
    ],
    outputs: [],
  }
}

function mkQ(id: string, title: string): ClarifyQuestion {
  return {
    id,
    title,
    kind: 'single',
    recommended: false,
    options: [
      { label: 'A', description: '', recommended: false, recommendationReason: '' },
      { label: 'B', description: '', recommended: false, recommendationReason: '' },
    ],
  }
}

function ans(qid: string) {
  return {
    questionId: qid,
    selectedOptionIndices: [0],
    selectedOptionLabels: ['A'],
    customText: '',
  }
}

/** Seed a DEFERRED task on liveDef + the designer's prior `done` draft + the questioner's
 *  `done` asking run, then open one cross-clarify session. Optionally seed OTHER's prior run. */
async function seedTask(
  db: DbClient,
  opts: { otherHasRun: boolean },
): Promise<{ taskId: string; crossClarifyNodeRunId: string }> {
  const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
  const def = liveDef()
  const workflowId = `wf_${taskId}`
  await db.insert(workflows).values({
    id: workflowId,
    name: 'rfc127-borrow',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'rfc127-borrow',
    workflowId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/aw-rfc127/repo',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: JSON.stringify({}),
    startedAt: Date.now(),
  })
  // ULID ids (production-accurate freshness ordering): the seeded runs sort BEFORE later mints.
  await db.insert(nodeRuns).values({
    id: ulid(),
    taskId,
    nodeId: DESIGNER,
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    startedAt: Date.now() - 1000,
  })
  if (opts.otherHasRun) {
    await db.insert(nodeRuns).values({
      id: ulid(),
      taskId,
      nodeId: OTHER,
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now() - 500,
    })
  }
  const questionerRunId = ulid()
  await db.insert(nodeRuns).values({
    id: questionerRunId,
    taskId,
    nodeId: QUESTIONER,
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    startedAt: Date.now(),
  })
  const { crossClarifyNodeRunId } = await createCrossClarifySession({
    db,
    taskId,
    crossClarifyNodeId: CC,
    sourceQuestionerNodeId: QUESTIONER,
    sourceQuestionerNodeRunId: questionerRunId,
    targetDesignerNodeId: DESIGNER,
    loopIter: 0,
    questions: [mkQ('q1', 'designer-scoped?')],
  })
  return { taskId, crossClarifyNodeRunId }
}

async function designerEntries(db: DbClient, taskId: string) {
  return db
    .select()
    .from(taskQuestions)
    .where(and(eq(taskQuestions.taskId, taskId), eq(taskQuestions.roleKind, 'designer')))
}

interface RunHarness {
  db: DbClient
  appHome: string
  worktreePath: string
  argvLog: string
  cleanup: () => void
}

function buildRunHarness(): RunHarness {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc127-borrow-'))
  const worktreePath = join(appHome, 'wt')
  mkdirSync(worktreePath, { recursive: true })
  const argvLog = join(appHome, 'argv.log')
  writeFileSync(argvLog, '')
  return {
    db: createInMemoryDb(MIGRATIONS),
    appHome,
    worktreePath,
    argvLog,
    cleanup: () => rimrafDir(appHome),
  }
}

function withEnv<T>(env: Record<string, string>, body: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {}
  for (const k of Object.keys(env)) {
    prev[k] = process.env[k]
    process.env[k] = env[k]
  }
  return body().finally(() => {
    for (const k of Object.keys(env)) {
      const old = prev[k]
      if (old === undefined) delete process.env[k]
      else process.env[k] = old
    }
  })
}

function readSpawnedAgents(path: string): string[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line).agent as string)
}

async function seedRunnableAgent(db: DbClient, name: string): Promise<void> {
  await createAgent(db, {
    name,
    description: '',
    outputs: ['result'],
    outputKinds: { result: 'markdown' },
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: '',
  })
}

async function seedRunnableAgents(db: DbClient, names: string[]): Promise<void> {
  for (const name of names) await seedRunnableAgent(db, name)
}

function upstreamDesignerDef(): WorkflowDefinition {
  const nodes: WorkflowNode[] = [
    { id: 'source', kind: 'agent-single', agentName: 'source' } as WorkflowNode,
    { id: DESIGNER, kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
    { id: QUESTIONER, kind: 'agent-single', agentName: 'questioner' } as WorkflowNode,
    { id: OTHER, kind: 'agent-single', agentName: OTHER_AGENT } as WorkflowNode,
    { id: CC, kind: 'clarify-cross-agent', title: 'cc' } as WorkflowNode,
  ]
  return {
    $schema_version: 4,
    inputs: [],
    nodes,
    edges: [
      {
        id: 'e_source_designer',
        source: { nodeId: 'source', portName: 'result' },
        target: { nodeId: DESIGNER, portName: 'source' },
      },
      {
        id: 'e_q_cc',
        source: { nodeId: QUESTIONER, portName: '__clarify__' },
        target: { nodeId: CC, portName: 'questions' },
      },
      {
        id: 'e_cc_d',
        source: { nodeId: CC, portName: 'to_designer' },
        target: { nodeId: DESIGNER, portName: '__external_feedback__' },
      },
      {
        id: 'e_cc_q',
        source: { nodeId: CC, portName: 'to_questioner' },
        target: { nodeId: QUESTIONER, portName: '__clarify_response__' },
      },
    ],
    outputs: [],
  }
}

async function insertRunnableTask(h: RunHarness, def: WorkflowDefinition, name: string) {
  const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
  const workflowId = `wf_${taskId}`
  await h.db.insert(workflows).values({
    id: workflowId,
    name,
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 4,
  })
  await h.db.insert(tasks).values({
    id: taskId,
    name,
    workflowId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/aw-rfc127-borrow/repo',
    worktreePath: h.worktreePath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'pending',
    inputs: JSON.stringify({}),
    startedAt: Date.now(),
  })
  return taskId
}

async function seedDoneRun(
  db: DbClient,
  taskId: string,
  nodeId: string,
  opts: {
    retryIndex?: number
    consumedUpstreamRunsJson?: string | null
    output?: string
    startedAt?: number
  } = {},
): Promise<string> {
  const id = ulid()
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId,
    status: 'done',
    retryIndex: opts.retryIndex ?? 0,
    iteration: 0,
    consumedUpstreamRunsJson: opts.consumedUpstreamRunsJson ?? null,
    startedAt: opts.startedAt,
  })
  if (opts.output !== undefined) {
    await db
      .insert(nodeRunOutputs)
      .values({ nodeRunId: id, portName: 'result', content: opts.output })
  }
  return id
}

async function runSchedulerOnce(h: RunHarness, taskId: string, env: Record<string, string> = {}) {
  await withEnv(
    {
      MOCK_OPENCODE_CAPTURE_ARGV_TO: h.argvLog,
      MOCK_OPENCODE_OUTPUTS: JSON.stringify({ result: 'ok' }),
      ...env,
    },
    () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
        defaultNodeRetries: 0,
      }),
  )
}

beforeEach(() => resetBroadcastersForTests())
afterAll(() => resetBroadcastersForTests())

describe('RFC-127 T5 — designer dispatch 借壳 (borrow the shell)', () => {
  test('去借壳 mint: clarify-designer override X → mint node_id=X + agent_override_name NULL (X runs its OWN agent, NOT a mint on D)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, crossClarifyNodeRunId } = await seedTask(db, { otherHasRun: true })
    // Control-channel full seal (board flow): the designer entry is sealed + left UNDISPATCHED for
    // the manual reassign/dispatch below (the quick channel would auto-dispatch it, RFC-132 §6).
    await sealRoundQuestions({
      db,
      originNodeRunId: crossClarifyNodeRunId,
      answers: [ans('q1')],
      directive: 'continue',
    })
    const entry = (await designerEntries(db, taskId))[0]!
    expect(entry.defaultTargetNodeId).toBe(DESIGNER)
    await reassignTaskQuestion(db, entry.id, OTHER, actor) // reassign → OTHER (run moves to OTHER)

    const result = await dispatchTaskQuestions(db, taskId, [entry.id], actor)
    // RFC-131 T4 去借壳: effectiveTarget = override ?? default = OTHER → the rerun is minted ON OTHER.
    expect(result.reruns.length).toBe(1)
    expect(result.reruns[0]?.targetNodeId).toBe(OTHER)
    const runId = result.reruns[0]!.nodeRunId

    const minted = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, runId)))[0]
    expect(minted?.nodeId).toBe(OTHER) // node_id is the TARGET, not the origin designer
    expect(minted?.status).toBe('pending')
    expect(minted?.rerunCause).toBe('cross-clarify-answer')
    expect(minted?.agentOverrideName).toBeNull() // 去借壳: OTHER runs its OWN agent (no borrow)

    // The origin designer D is NOT minted — the entry moved to OTHER (no pending run on D).
    const designerRuns = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, DESIGNER)))
    expect(designerRuns.some((r) => r.status === 'pending')).toBe(false)

    // The TARGET OTHER's per-node queue (keyed by effectiveTarget) binds the answer to OTHER's rerun.
    await bindTriggerRun(db, [(await designerEntries(db, taskId))[0]!.id], runId)
    expect((await designerEntries(db, taskId))[0]?.triggerRunId).toBe(runId)
  })

  test('golden-lock: a clarify-designer with NO override → mint D + agent_override_name NULL (byte-for-byte the baseline)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, crossClarifyNodeRunId } = await seedTask(db, { otherHasRun: false })
    await sealRoundQuestions({
      db,
      originNodeRunId: crossClarifyNodeRunId,
      answers: [ans('q1')],
      directive: 'continue',
    })
    const entry = (await designerEntries(db, taskId))[0]!
    expect(entry.overrideTargetNodeId).toBeNull() // no override → home=default=DESIGNER, borrow=null

    const result = await dispatchTaskQuestions(db, taskId, [entry.id], actor)
    expect(result.reruns.length).toBe(1)
    expect(result.reruns[0]?.targetNodeId).toBe(DESIGNER)
    const minted = (
      await db.select().from(nodeRuns).where(eq(nodeRuns.id, result.reruns[0]!.nodeRunId))
    )[0]
    expect(minted?.nodeId).toBe(DESIGNER)
    expect(minted?.agentOverrideName).toBeNull() // NO borrow → home runs its own agent
  })

  test('never-run reassign target → REJECTED (去借壳: the rerun mints ON the target X, which never ran → no prior run to inherit)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, crossClarifyNodeRunId } = await seedTask(db, { otherHasRun: false }) // OTHER never ran
    await sealRoundQuestions({
      db,
      originNodeRunId: crossClarifyNodeRunId,
      answers: [ans('q1')],
      directive: 'continue',
    })
    const entry = (await designerEntries(db, taskId))[0]!
    await reassignTaskQuestion(db, entry.id, OTHER, actor) // reassign to a never-run node

    // RFC-127 借壳 minted on the origin D (which HAS a run), so a never-run borrow target dispatched
    // fine. RFC-131 T4 去借壳 REVERSES that: the rerun is minted ON the effective target OTHER — which
    // never ran → no prior node_run to inherit → REJECTED. Nothing stamped, nothing minted.
    let threw: unknown = null
    try {
      await dispatchTaskQuestions(db, taskId, [entry.id], actor)
    } catch (e) {
      threw = e
    }
    expect((threw as { code?: string }).code).toBe('task-question-unsafe-dispatch-target')
    expect((await designerEntries(db, taskId))[0]?.dispatchedAt).toBeNull() // nothing stamped
    const pending = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.status, 'pending')))
    expect(pending.length).toBe(0) // nothing minted
  })

  test('golden-lock: no reassignment dispatch runs home agent and never stamps agent_override_name', async () => {
    const h = buildRunHarness()
    try {
      const def = upstreamDesignerDef()
      await seedRunnableAgents(h.db, ['source', 'designer', 'questioner', OTHER_AGENT])
      const taskId = await insertRunnableTask(h, def, 'rfc127-no-borrow-golden')
      await seedDoneRun(h.db, taskId, OTHER, { output: 'old-other' })
      const sourceDoneId = await seedDoneRun(h.db, taskId, 'source', { output: 'old-source' })
      await seedDoneRun(h.db, taskId, DESIGNER, {
        consumedUpstreamRunsJson: JSON.stringify({ source: sourceDoneId }),
      })
      const questionerRunId = await seedDoneRun(h.db, taskId, QUESTIONER)
      const cc = (
        await createCrossClarifySession({
          db: h.db,
          taskId,
          crossClarifyNodeId: CC,
          sourceQuestionerNodeId: QUESTIONER,
          sourceQuestionerNodeRunId: questionerRunId,
          targetDesignerNodeId: DESIGNER,
          loopIter: 0,
          questions: [mkQ('q1', 'designer-scoped?')],
        })
      ).crossClarifyNodeRunId
      await sealRoundQuestions({
        db: h.db,
        originNodeRunId: cc,
        answers: [ans('q1')],
        directive: 'continue',
      })
      const entry = (await designerEntries(h.db, taskId))[0]!
      const result = await dispatchTaskQuestions(h.db, taskId, [entry.id], actor)
      const minted = (
        await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, result.reruns[0]!.nodeRunId))
      )[0]
      expect(minted?.agentOverrideName).toBeNull()

      await runSchedulerOnce(h, taskId)

      expect(readSpawnedAgents(h.argvLog)).toEqual(['designer'])
      const designerRows = await h.db
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, DESIGNER)))
      expect(designerRows.every((r) => r.agentOverrideName === null)).toBe(true)
    } finally {
      h.cleanup()
    }
  })
})

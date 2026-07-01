// RFC-127 T5 — designer dispatch 从「换节点」切「借壳」(borrow-the-shell). Positive lock for the
// core dimension flip:
//
//   home  = default ?? override   (the node a rerun is MINTED on — run.node_id)
//   borrow = override             (only when override ≠ home; the node whose AGENT is borrowed)
//
//   • clarify-designer, no override → home=default=D, borrow=null
//       → mint node_id=D, agent_override_name NULL (byte-for-byte the baseline).
//   • clarify-designer, override X  → home=default=D, borrow=X
//       → mint node_id=**D** (NOT X!) + agent_override_name = X 节点的 agentName;
//         产出归 D、走 D 下游 (借壳：D runs X's brain on D's artifact).
//   • manual (default=null)         → home=override=X, borrow=null
//       → mint node_id=X, no override (byte-for-byte the baseline; covered in rfc120 manual tests).
//
// These tests lock the override (clarify) borrow path end-to-end: the per-home single-borrow gate,
// the golden-lock no-override baseline, and the never-run borrow relaxation. The reversed/adapted
// old-behavior cases live in rfc120-deferred-dispatch.test.ts; this file is the dedicated
// positive net so a refactor that re-introduces "override moves the home" goes red here.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRunOutputs, nodeRuns, taskQuestions, tasks, workflows } from '../src/db/schema'
import { createAgent } from '../src/services/agent'
import {
  buildExternalFeedbackContext,
  createCrossClarifySession,
  submitCrossClarifyAnswers,
} from '../src/services/crossClarify'
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
const DOWN = 'downstream'
const DOWN_AGENT = 'downstream'
// A plain agent node (no __external_feedback__ edge) — a valid reassign/borrow target. Its
// agentName is what a clarify-designer override BORROWS (rides on the home designer's rerun).
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
    deferredQuestionDispatch: true,
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
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
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

function chainDef(): WorkflowDefinition {
  const nodes: WorkflowNode[] = [
    { id: DESIGNER, kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
    { id: DOWN, kind: 'agent-single', agentName: DOWN_AGENT } as WorkflowNode,
    { id: QUESTIONER, kind: 'agent-single', agentName: 'questioner' } as WorkflowNode,
    { id: 'q_down', kind: 'agent-single', agentName: 'q_down' } as WorkflowNode,
    { id: OTHER, kind: 'agent-single', agentName: OTHER_AGENT } as WorkflowNode,
    { id: 'cc_a', kind: 'clarify-cross-agent', title: 'cc_a' } as WorkflowNode,
    { id: 'cc_b', kind: 'clarify-cross-agent', title: 'cc_b' } as WorkflowNode,
  ]
  return {
    $schema_version: 4,
    inputs: [],
    nodes,
    edges: [
      {
        id: 'e_designer_down',
        source: { nodeId: DESIGNER, portName: 'result' },
        target: { nodeId: DOWN, portName: 'design' },
      },
      {
        id: 'e_q_a',
        source: { nodeId: QUESTIONER, portName: '__clarify__' },
        target: { nodeId: 'cc_a', portName: 'questions' },
      },
      {
        id: 'e_cc_a_d',
        source: { nodeId: 'cc_a', portName: 'to_designer' },
        target: { nodeId: DESIGNER, portName: '__external_feedback__' },
      },
      {
        id: 'e_cc_a_q',
        source: { nodeId: 'cc_a', portName: 'to_questioner' },
        target: { nodeId: QUESTIONER, portName: '__clarify_response__' },
      },
      {
        id: 'e_q_b',
        source: { nodeId: 'q_down', portName: '__clarify__' },
        target: { nodeId: 'cc_b', portName: 'questions' },
      },
      {
        id: 'e_cc_b_down',
        source: { nodeId: 'cc_b', portName: 'to_designer' },
        target: { nodeId: DOWN, portName: '__external_feedback__' },
      },
      {
        id: 'e_cc_b_q',
        source: { nodeId: 'cc_b', portName: 'to_questioner' },
        target: { nodeId: 'q_down', portName: '__clarify_response__' },
      },
    ],
    outputs: [],
  }
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
    deferredQuestionDispatch: true,
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

async function seedCascadeBorrowTask(h: RunHarness): Promise<{
  taskId: string
  entryAId: string
  entryBId: string
}> {
  const def = chainDef()
  await seedRunnableAgents(h.db, ['designer', DOWN_AGENT, 'questioner', 'q_down', OTHER_AGENT])
  const taskId = await insertRunnableTask(h, def, 'rfc127-cascade-borrow')
  await seedDoneRun(h.db, taskId, OTHER, {
    startedAt: Date.now() - 4000,
    output: 'old-other',
  })
  const designerDoneId = await seedDoneRun(h.db, taskId, DESIGNER, {
    startedAt: Date.now() - 3000,
    output: 'old-a',
  })
  await seedDoneRun(h.db, taskId, DOWN, {
    consumedUpstreamRunsJson: JSON.stringify({ [DESIGNER]: designerDoneId }),
    startedAt: Date.now() - 2000,
    output: 'old-b',
  })
  const questionerRunId = await seedDoneRun(h.db, taskId, QUESTIONER, {
    startedAt: Date.now() - 1000,
  })
  const qDownRunId = await seedDoneRun(h.db, taskId, 'q_down', { startedAt: Date.now() - 500 })
  const ccA = (
    await createCrossClarifySession({
      db: h.db,
      taskId,
      crossClarifyNodeId: 'cc_a',
      sourceQuestionerNodeId: QUESTIONER,
      sourceQuestionerNodeRunId: questionerRunId,
      targetDesignerNodeId: DESIGNER,
      loopIter: 0,
      questions: [mkQ('a1', 'designer-scoped?')],
    })
  ).crossClarifyNodeRunId
  const ccB = (
    await createCrossClarifySession({
      db: h.db,
      taskId,
      crossClarifyNodeId: 'cc_b',
      sourceQuestionerNodeId: 'q_down',
      sourceQuestionerNodeRunId: qDownRunId,
      targetDesignerNodeId: DOWN,
      loopIter: 0,
      questions: [mkQ('b1', 'downstream-scoped?')],
    })
  ).crossClarifyNodeRunId
  await submitCrossClarifyAnswers({
    db: h.db,
    crossClarifyNodeRunId: ccA,
    answers: [ans('a1')],
    directive: 'continue',
  })
  await submitCrossClarifyAnswers({
    db: h.db,
    crossClarifyNodeRunId: ccB,
    answers: [ans('b1')],
    directive: 'continue',
  })
  const entries = await designerEntries(h.db, taskId)
  const entryA = entries.find((e) => e.originNodeRunId === ccA)!
  const entryB = entries.find((e) => e.originNodeRunId === ccB)!
  await reassignTaskQuestion(h.db, entryB.id, OTHER, actor)
  const result = await dispatchTaskQuestions(h.db, taskId, [entryA.id, entryB.id], actor)
  expect(result.reruns.map((r) => r.targetNodeId)).toEqual([DESIGNER])
  return { taskId, entryAId: entryA.id, entryBId: entryB.id }
}

async function seedBorrowDispatchTask(h: RunHarness): Promise<{
  taskId: string
  sourceDoneId: string
  entryId: string
}> {
  const def = upstreamDesignerDef()
  await seedRunnableAgents(h.db, ['source', 'designer', 'questioner', OTHER_AGENT])
  const taskId = await insertRunnableTask(h, def, 'rfc127-borrow-lifecycle')
  await seedDoneRun(h.db, taskId, OTHER, {
    startedAt: Date.now() - 3000,
    output: 'old-other',
  })
  const sourceDoneId = await seedDoneRun(h.db, taskId, 'source', {
    startedAt: Date.now() - 2000,
    output: 'old-source',
  })
  await seedDoneRun(h.db, taskId, DESIGNER, {
    consumedUpstreamRunsJson: JSON.stringify({ source: sourceDoneId }),
    startedAt: Date.now() - 1000,
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
  await submitCrossClarifyAnswers({
    db: h.db,
    crossClarifyNodeRunId: cc,
    answers: [ans('q1')],
    directive: 'continue',
  })
  const entry = (await designerEntries(h.db, taskId))[0]!
  await reassignTaskQuestion(h.db, entry.id, OTHER, actor)
  const result = await dispatchTaskQuestions(h.db, taskId, [entry.id], actor)
  expect(result.reruns.map((r) => r.targetNodeId)).toEqual([DESIGNER])
  return { taskId, sourceDoneId, entryId: entry.id }
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
  test('借壳 mint: clarify-designer override X → mint the HOME D + agent_override_name = X’s agentName (NOT a mint on X)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, crossClarifyNodeRunId } = await seedTask(db, { otherHasRun: true })
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [ans('q1')],
      directive: 'continue',
    })
    const entry = (await designerEntries(db, taskId))[0]!
    expect(entry.defaultTargetNodeId).toBe(DESIGNER)
    await reassignTaskQuestion(db, entry.id, OTHER, actor) // override → OTHER (borrow its agent)

    const result = await dispatchTaskQuestions(db, taskId, [entry.id], actor)
    // home = default ?? override = DESIGNER → the rerun is minted ON DESIGNER.
    expect(result.reruns.length).toBe(1)
    expect(result.reruns[0]?.targetNodeId).toBe(DESIGNER)
    const runId = result.reruns[0]!.nodeRunId

    const minted = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, runId)))[0]
    expect(minted?.nodeId).toBe(DESIGNER) // node_id is the HOME, not the borrowed node
    expect(minted?.status).toBe('pending')
    expect(minted?.rerunCause).toBe('cross-clarify-answer')
    expect(minted?.agentOverrideName).toBe(OTHER_AGENT) // borrow = X node's agentName

    // The borrowed node X is NEVER minted — no run appears on OTHER beyond the seeded done one.
    const otherRuns = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, OTHER)))
    expect(otherRuns.some((r) => r.status === 'pending')).toBe(false)

    // The HOME D's per-node queue (keyed by home=default) carries + binds the answer to D's rerun.
    const ctx = await buildExternalFeedbackContext({
      db,
      taskId,
      designerNodeId: DESIGNER,
      loopIter: 0,
      designerGeneration: 1,
      definition: liveDef(),
      dispatchedRunId: runId,
    })
    expect(ctx?.block).toContain('A')
    expect(ctx?.graphOwned).toBe(true) // default==home==DESIGNER → D owns its artifact (D3)
    expect((await designerEntries(db, taskId))[0]?.triggerRunId).toBe(runId)
  })

  test('per-home 多借用门: two rounds default=D but override→X1/X2 → one dispatch is rejected task-question-home-multi-borrow (nothing stamped/minted)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    // Two cross-clarify sources both → DESIGNER (one home), plus two distinct borrow targets X1/X2.
    const X1 = 'fix1'
    const X2 = 'fix2'
    const nodes: WorkflowNode[] = [
      { id: DESIGNER, kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
      { id: X1, kind: 'agent-single', agentName: 'fix1' } as WorkflowNode,
      { id: X2, kind: 'agent-single', agentName: 'fix2' } as WorkflowNode,
      { id: 'q_a', kind: 'agent-single', agentName: 'q_a' } as WorkflowNode,
      { id: 'q_b', kind: 'agent-single', agentName: 'q_b' } as WorkflowNode,
      { id: 'cc_a', kind: 'clarify-cross-agent', title: 'cc_a' } as WorkflowNode,
      { id: 'cc_b', kind: 'clarify-cross-agent', title: 'cc_b' } as WorkflowNode,
    ]
    const edges: WorkflowDefinition['edges'] = []
    for (const { q, cc } of [
      { q: 'q_a', cc: 'cc_a' },
      { q: 'q_b', cc: 'cc_b' },
    ]) {
      edges.push({
        id: `e_q_${cc}`,
        source: { nodeId: q, portName: '__clarify__' },
        target: { nodeId: cc, portName: 'questions' },
      })
      edges.push({
        id: `e_d_${cc}`,
        source: { nodeId: cc, portName: 'to_designer' },
        target: { nodeId: DESIGNER, portName: '__external_feedback__' },
      })
      edges.push({
        id: `e_qb_${cc}`,
        source: { nodeId: cc, portName: 'to_questioner' },
        target: { nodeId: q, portName: '__clarify_response__' },
      })
    }
    const def: WorkflowDefinition = { $schema_version: 4, inputs: [], nodes, edges, outputs: [] }
    const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
    await db.insert(workflows).values({
      id: `wf_${taskId}`,
      name: 'rfc127-multi-borrow',
      description: '',
      definition: JSON.stringify(def),
      version: 1,
      schemaVersion: 4,
    })
    await db.insert(tasks).values({
      id: taskId,
      name: 'rfc127-multi-borrow',
      workflowId: `wf_${taskId}`,
      workflowSnapshot: JSON.stringify(def),
      repoPath: '/tmp/aw-rfc127-mb/repo',
      worktreePath: '',
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'running',
      inputs: JSON.stringify({}),
      startedAt: Date.now(),
      deferredQuestionDispatch: true,
    })
    await db
      .insert(nodeRuns)
      .values({ id: ulid(), taskId, nodeId: DESIGNER, status: 'done', retryIndex: 0, iteration: 0 })
    const open = async (q: string, cc: string, qid: string): Promise<string> => {
      const runId = ulid()
      await db
        .insert(nodeRuns)
        .values({ id: runId, taskId, nodeId: q, status: 'done', retryIndex: 0, iteration: 0 })
      const { crossClarifyNodeRunId } = await createCrossClarifySession({
        db,
        taskId,
        crossClarifyNodeId: cc,
        sourceQuestionerNodeId: q,
        sourceQuestionerNodeRunId: runId,
        targetDesignerNodeId: DESIGNER,
        loopIter: 0,
        questions: [mkQ(qid, 'designer-scoped?')],
      })
      return crossClarifyNodeRunId
    }
    const ccA = await open('q_a', 'cc_a', 'a1')
    const ccB = await open('q_b', 'cc_b', 'b1')
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: ccA,
      answers: [ans('a1')],
      directive: 'continue',
    })
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: ccB,
      answers: [ans('b1')],
      directive: 'continue',
    })
    const entryA = (await designerEntries(db, taskId)).find((e) => e.originNodeRunId === ccA)!
    const entryB = (await designerEntries(db, taskId)).find((e) => e.originNodeRunId === ccB)!
    // Both default=DESIGNER → both home=DESIGNER; but they borrow DIFFERENT agents (X1 vs X2).
    await reassignTaskQuestion(db, entryA.id, X1, actor)
    await reassignTaskQuestion(db, entryB.id, X2, actor)

    // One dispatch onto the SAME home that names two borrow agents → a single rerun can run only
    // ONE agent → reject the whole dispatch up front (no partial stamp/mint).
    let threw: unknown = null
    try {
      await dispatchTaskQuestions(db, taskId, [entryA.id, entryB.id], actor)
    } catch (e) {
      threw = e
    }
    expect((threw as { code?: string }).code).toBe('task-question-home-multi-borrow')
    // Nothing stamped, nothing minted.
    expect((await designerEntries(db, taskId)).every((e) => e.dispatchedAt === null)).toBe(true)
    const pending = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.status, 'pending')))
    expect(pending.length).toBe(0)
  })

  test('golden-lock: a clarify-designer with NO override → mint D + agent_override_name NULL (byte-for-byte the baseline)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, crossClarifyNodeRunId } = await seedTask(db, { otherHasRun: false })
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
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

  test('never-run 借用放宽: override to a NEVER-RUN node X, but home D has a run → dispatch succeeds (mint D borrowing X)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, crossClarifyNodeRunId } = await seedTask(db, { otherHasRun: false }) // OTHER never ran
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [ans('q1')],
      directive: 'continue',
    })
    const entry = (await designerEntries(db, taskId))[0]!
    await reassignTaskQuestion(db, entry.id, OTHER, actor) // borrow a never-run node's agent

    // home D HAS a run (the frontier mint inherits it); X is only the borrowed agent (never minted),
    // so its never-run state is irrelevant — dispatch SUCCEEDS (no unsafe-dispatch-target).
    const result = await dispatchTaskQuestions(db, taskId, [entry.id], actor)
    expect(result.reruns.length).toBe(1)
    expect(result.reruns[0]?.targetNodeId).toBe(DESIGNER)
    const minted = (
      await db.select().from(nodeRuns).where(eq(nodeRuns.id, result.reruns[0]!.nodeRunId))
    )[0]
    expect(minted?.nodeId).toBe(DESIGNER)
    expect(minted?.agentOverrideName).toBe(OTHER_AGENT)
    // The never-run borrowed node still has NO node_run.
    const otherRuns = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, OTHER)))
    expect(otherRuns.length).toBe(0)
  })

  test('cascade 保留 borrow: downstream non-frontier B is scheduler-minted but still runs borrowed agent X', async () => {
    const h = buildRunHarness()
    try {
      const { taskId, entryBId } = await seedCascadeBorrowTask(h)
      await runSchedulerOnce(h, taskId)

      const spawned = readSpawnedAgents(h.argvLog)
      expect(spawned).toContain('designer')
      expect(spawned).toContain(OTHER_AGENT)
      expect(spawned).not.toContain(DOWN_AGENT)
      const entryB = (
        await h.db.select().from(taskQuestions).where(eq(taskQuestions.id, entryBId))
      )[0]
      expect(entryB?.triggerRunId).toBeTruthy()
      const downRuns = await h.db
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, DOWN)))
      const cascadeRun = downRuns.find((r) => r.id === entryB?.triggerRunId)
      expect(cascadeRun?.agentOverrideName).toBe(OTHER_AGENT)
      expect(cascadeRun?.status).toBe('done')
    } finally {
      h.cleanup()
    }
  })

  test('carry 不泄漏: consumed borrow question does not carry override into unrelated future stale rerun', async () => {
    const h = buildRunHarness()
    try {
      const { taskId } = await seedBorrowDispatchTask(h)
      await runSchedulerOnce(h, taskId)
      expect(readSpawnedAgents(h.argvLog)).toEqual([OTHER_AGENT])

      const newSourceRunId = ulid()
      await h.db.insert(nodeRuns).values({
        id: newSourceRunId,
        taskId,
        nodeId: 'source',
        status: 'done',
        retryIndex: 1,
        iteration: 0,
        startedAt: Date.now(),
      })
      await h.db
        .insert(nodeRunOutputs)
        .values({ nodeRunId: newSourceRunId, portName: 'result', content: 'new-source' })
      await h.db.update(tasks).set({ status: 'pending' }).where(eq(tasks.id, taskId))
      writeFileSync(h.argvLog, '')

      await runSchedulerOnce(h, taskId)

      expect(readSpawnedAgents(h.argvLog)).toEqual(['designer'])
      const designerRows = await h.db
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, DESIGNER)))
      const latest = designerRows.sort((a, b) => b.id.localeCompare(a.id))[0]
      expect(latest?.status).toBe('done')
      expect(latest?.agentOverrideName).toBeNull()
    } finally {
      h.cleanup()
    }
  })

  test('retry 保留: failed borrowed dispatch remains borrowed on scheduler revival retry', async () => {
    const h = buildRunHarness()
    try {
      const { taskId } = await seedBorrowDispatchTask(h)
      await runSchedulerOnce(h, taskId, {
        MOCK_OPENCODE_EXIT_CODE: '7',
        MOCK_OPENCODE_SKIP_ENVELOPE: '1',
      })
      expect(readSpawnedAgents(h.argvLog)).toEqual([OTHER_AGENT])

      await h.db.update(tasks).set({ status: 'pending' }).where(eq(tasks.id, taskId))
      writeFileSync(h.argvLog, '')
      await runSchedulerOnce(h, taskId)

      expect(readSpawnedAgents(h.argvLog)).toEqual([OTHER_AGENT])
      const designerRows = await h.db
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, DESIGNER)))
      const latest = designerRows.sort((a, b) => b.id.localeCompare(a.id))[0]
      expect(latest?.status).toBe('done')
      expect(latest?.agentOverrideName).toBe(OTHER_AGENT)
    } finally {
      h.cleanup()
    }
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
      await submitCrossClarifyAnswers({
        db: h.db,
        crossClarifyNodeRunId: cc,
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

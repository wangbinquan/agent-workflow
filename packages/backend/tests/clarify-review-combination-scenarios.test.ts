import { rimrafDir } from './helpers/cleanup'
// EXPLORATORY combination-scenario probes (agent × review × clarify).
//
// Goal: drive end-to-end flows through the REAL scheduler (runTask) + REAL
// decision handlers (autoDispatchClarifyRound / submitReviewDecision) and
// assert the EXPECTED-CORRECT behavior. Any failing assertion = a current flow
// that does not meet expectations.
//
// NOT an RFC implementation. These are probes to surface misbehaving flows
// (notably the cci/cascade/review-freshness interplay). Scenarios annotated
// `[KNOWN-INCIDENT]` are expected to expose the live bug from task
// 01KSHVXCH6RQ5F5P64MZ4FZVN6 on current code.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '../src/db/client'
import { createInMemoryDb } from '../src/db/client'
import {
  clarifySessions,
  crossClarifySessions,
  nodeRunOutputs,
  nodeRuns,
  tasks,
} from '../src/db/schema'
import { createAgent } from '../src/services/agent'
import { createWorkflow } from '../src/services/workflow'
// RFC-132 ②a 缺口② 回归锁: S3 + S6 drive answers through the unified autoDispatchClarifyRound.
// They previously deadlocked on a genuine behavior gap — review iterate/reject SUPERSEDES the
// designer's freshest run (done clarify-answer continuation → `canceled` superseded-by-review-*,
// parked forever per RFC-095), and the unified dispatch's in-flight gates (isDispatchedEntryConsumed
// run-obligation / lineage + openImmediateRounds 'in-flight') treated that canceled row as OPEN, so
// the NEXT clarify answer's mint deferred forever (task-question-node-dispatch-in-flight). Fixed in
// clarifyRerunLedger via the isReviewSupersededCanceled exception (same predicate as
// isTargetNodeConsumed's aging-side supersede exception). If S3/S6 wedge again on
// dispatch-in-flight, that exception regressed.
import { autoDispatchClarifyRound } from '../src/services/clarifyAutoDispatch'
import { setNodeClarifyDirective } from '../src/services/taskClarifyDirective'
import { addReviewComment, submitReviewDecision } from '../src/services/review'
import { runTask } from '../src/services/scheduler'
import { startTask } from '../src/services/task'
// RFC-097: runTask's entry CAS only claims pending tasks. Every scheduler
// re-entry below (the post-decision / post-answer `await runTask(...)` calls)
// is preceded by reenterScheduler — the test stand-in for resumeTask.
import { reenterScheduler } from './reenter-scheduler'
import type {
  ClarifyAnswer,
  ClarifyQuestion,
  WorkflowDefinition,
  WorkflowNode,
} from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const SCENARIO_STUB = resolve(import.meta.dir, 'fixtures', 'scenario-opencode.ts')
const actor = { userId: 'u1', role: 'owner' as const }

type Step =
  | { output: Record<string, string> }
  | { clarify: unknown }
  | { skipEnvelope: true }
  | { crash: true }

const CLARIFY_BODY = {
  questions: [
    {
      id: 'q1',
      title: 'Which option?',
      kind: 'single',
      recommended: false,
      options: [
        { label: 'A', description: '', recommended: true, recommendationReason: '' },
        { label: 'B', description: '', recommended: false, recommendationReason: '' },
      ],
    } as ClarifyQuestion,
  ],
}
const CLARIFY_ANSWER: ClarifyAnswer = {
  questionId: 'q1',
  selectedOptionIndices: [0],
  selectedOptionLabels: ['A'],
  customText: '',
}

interface Ctx {
  db: DbClient
  appHome: string
  repoPath: string
  stateDir: string
  planFile: string
  cleanup: () => void
}

let idx = 0
function freshCtx(): Ctx {
  idx++
  const tmp = mkdtempSync(join(tmpdir(), `aw-combo-${idx}-`))
  const appHome = join(tmp, 'home')
  const repoPath = join(tmp, 'repo')
  const stateDir = join(tmp, 'state')
  const planFile = join(tmp, 'plan.json')
  mkdirSync(appHome, { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  execSync(`git init -b main "${repoPath}"`, { stdio: 'ignore' })
  execSync(`git -C "${repoPath}" config user.email t@t.test`, { stdio: 'ignore' })
  execSync(`git -C "${repoPath}" config user.name t`, { stdio: 'ignore' })
  writeFileSync(join(repoPath, 'README.md'), '# r\n')
  execSync(`git -C "${repoPath}" add . && git -C "${repoPath}" commit -m init`, { stdio: 'ignore' })
  const db = createInMemoryDb(MIGRATIONS)
  // RFC-W001: save the env vars these tests mutate (writePlan sets them) and
  // RESTORE them in cleanup instead of `delete`-ing. Deleting AGENT_WORKFLOW_HOME
  // mid-suite makes every later daemon-starting test fall back to the real
  // ~/.agent-workflow home -> on a dev box with real MCP servers configured,
  // each later test burns ~30s per mcpProbe (initialize timeout), which alone
  // pushes the full `bun test` past its 30min ceiling. Restoring preserves the
  // caller's env (tests that set a temp AGENT_WORKFLOW_HOME keep it).
  const savedPlan = process.env.SCENARIO_PLAN_FILE
  const savedState = process.env.SCENARIO_STATE_DIR
  const savedHome = process.env.AGENT_WORKFLOW_HOME
  return {
    db,
    appHome,
    repoPath,
    stateDir,
    planFile,
    cleanup: () => {
      rimrafDir(tmp)
      if (savedPlan === undefined) delete process.env.SCENARIO_PLAN_FILE
      else process.env.SCENARIO_PLAN_FILE = savedPlan
      if (savedState === undefined) delete process.env.SCENARIO_STATE_DIR
      else process.env.SCENARIO_STATE_DIR = savedState
      if (savedHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
      else process.env.AGENT_WORKFLOW_HOME = savedHome
    },
  }
}

function writePlan(c: Ctx, plan: Record<string, Step[]>): void {
  writeFileSync(c.planFile, JSON.stringify(plan))
  process.env.SCENARIO_PLAN_FILE = c.planFile
  process.env.SCENARIO_STATE_DIR = c.stateDir
  process.env.AGENT_WORKFLOW_HOME = c.appHome
}

function opencodeCmd(): string[] {
  return ['bun', 'run', SCENARIO_STUB]
}

async function topLevel(db: DbClient, taskId: string, nodeId: string) {
  const rows = await db
    .select()
    .from(nodeRuns)
    .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, nodeId)))
  return rows.filter((r) => r.parentNodeRunId === null)
}

async function openClarifyRunId(db: DbClient, taskId: string): Promise<string> {
  const rows = await db
    .select()
    .from(clarifySessions)
    .where(and(eq(clarifySessions.taskId, taskId), eq(clarifySessions.status, 'awaiting_human')))
  const id = rows[0]?.clarifyNodeRunId
  if (!id) throw new Error('no awaiting clarify session')
  return id
}

async function awaitingReviewRun(db: DbClient, taskId: string, nodeId: string) {
  const tops = await topLevel(db, taskId, nodeId)
  return tops.find((r) => r.status === 'awaiting_review')
}

async function taskStatus(db: DbClient, taskId: string): Promise<string> {
  const t = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
  return t?.status ?? '??'
}

async function waitForTaskStatus(
  db: DbClient,
  taskId: string,
  expected: string,
  timeoutMs = 5000,
): Promise<string> {
  // RFC-W001: runTask drives the demote cascade to a terminal status before
  // returning, but on a loaded Windows host the final setTaskStatus('done')
  // commit can land an event-loop tick after runTask resolves. Poll briefly
  // instead of racing it. (The test's own per-test timeout is raised below so
  // the demote - which re-runs 3 nodes - never trips bun's 5s default and
  // clobbers this file's shared `c` / process.env mid-run.)
  const deadline = Date.now() + timeoutMs
  let s = await taskStatus(db, taskId)
  while (s !== expected && Date.now() < deadline) {
    await Bun.sleep(10)
    s = await taskStatus(db, taskId)
  }
  return s
}

async function makeDesigner(c: Ctx, name = 'designer', outs = ['design']): Promise<void> {
  await createAgent(c.db, {
    name,
    description: '',
    outputs: outs,
    outputKinds: Object.fromEntries(outs.map((o) => [o, 'markdown'])),
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

describe('combination scenarios: agent × review × clarify (current code)', () => {
  let c: Ctx
  beforeEach(() => {
    c = freshCtx()
  })
  afterEach(() => {
    c.cleanup()
  })

  // ---------------------------------------------------------------------------
  // S1 — baseline: agent → review → approve → downstream consumes approved doc
  // ---------------------------------------------------------------------------
  test('S1 baseline: approve propagates the approved doc to the downstream agent', async () => {
    await makeDesigner(c)
    await makeDesigner(c, 'builder', ['build'])
    writePlan(c, {
      designer: [{ output: { design: 'DESIGN_V1' } }],
      builder: [{ output: { build: 'BUILT' } }],
    })
    const def: WorkflowDefinition = {
      $schema_version: 2,
      inputs: [{ kind: 'text', key: 'topic', label: 't' }],
      nodes: [
        { id: 'in1', kind: 'input', inputKey: 'topic' },
        { id: 'designer', kind: 'agent-single', agentName: 'designer' },
        {
          id: 'rev',
          kind: 'review',
          inputSource: { nodeId: 'designer', portName: 'design' },
          rerunnableOnIterate: ['designer'],
          rerunnableOnReject: ['designer'],
        },
        { id: 'builder', kind: 'agent-single', agentName: 'builder' },
      ] as WorkflowNode[],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'in1', portName: 'topic' },
          target: { nodeId: 'designer', portName: 'topic' },
        },
        {
          id: 'e2',
          source: { nodeId: 'designer', portName: 'design' },
          target: { nodeId: 'rev', portName: '__review_input__' },
        },
        {
          id: 'e3',
          source: { nodeId: 'rev', portName: 'approved_doc' },
          target: { nodeId: 'builder', portName: 'doc' },
        },
      ],
    }
    const wf = await createWorkflow(c.db, { name: 's1', description: '', definition: def })
    const task = await startTask(
      {
        workflowId: wf.id,
        name: 's1',
        repoPath: c.repoPath,
        baseBranch: 'main',
        inputs: { topic: 'x' },
      },
      { db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd(), awaitScheduler: true },
    )
    expect(await taskStatus(c.db, task.id)).toBe('awaiting_review')
    const rev = await awaitingReviewRun(c.db, task.id, 'rev')
    expect(rev).toBeDefined()

    await submitReviewDecision({
      db: c.db,
      appHome: c.appHome,
      nodeRunId: rev!.id,
      decision: 'approved',
      expectedReviewIteration: 0,
    })
    await reenterScheduler(c.db, task.id)
    await runTask({ taskId: task.id, db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd() })

    expect(await taskStatus(c.db, task.id)).toBe('done')
    const builderTops = await topLevel(c.db, task.id, 'builder')
    const builderDone = builderTops.find((r) => r.status === 'done')
    expect(builderDone).toBeDefined()
  })

  // ---------------------------------------------------------------------------
  // S2 — iterate: approved doc must reflect v2 (post-iterate), not v1
  // ---------------------------------------------------------------------------
  test('S2 iterate: approving after iterate yields v2 content and leaves no dead awaiting rows', async () => {
    await makeDesigner(c)
    writePlan(c, {
      designer: [{ output: { design: 'DESIGN_V1' } }, { output: { design: 'DESIGN_V2' } }],
    })
    const def: WorkflowDefinition = {
      $schema_version: 2,
      inputs: [{ kind: 'text', key: 'topic', label: 't' }],
      nodes: [
        { id: 'in1', kind: 'input', inputKey: 'topic' },
        { id: 'designer', kind: 'agent-single', agentName: 'designer' },
        {
          id: 'rev',
          kind: 'review',
          inputSource: { nodeId: 'designer', portName: 'design' },
          rerunnableOnIterate: ['designer'],
          rerunnableOnReject: ['designer'],
        },
      ] as WorkflowNode[],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'in1', portName: 'topic' },
          target: { nodeId: 'designer', portName: 'topic' },
        },
        {
          id: 'e2',
          source: { nodeId: 'designer', portName: 'design' },
          target: { nodeId: 'rev', portName: '__review_input__' },
        },
      ],
    }
    const wf = await createWorkflow(c.db, { name: 's2', description: '', definition: def })
    const task = await startTask(
      {
        workflowId: wf.id,
        name: 's2',
        repoPath: c.repoPath,
        baseBranch: 'main',
        inputs: { topic: 'x' },
      },
      { db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd(), awaitScheduler: true },
    )
    const rev1 = await awaitingReviewRun(c.db, task.id, 'rev')
    expect(rev1).toBeDefined()

    // iterate v1
    await addReviewComment({
      db: c.db,
      appHome: c.appHome,
      nodeRunId: rev1!.id,
      anchor: {
        sectionPath: '#',
        paragraphIdx: 0,
        offsetStart: 0,
        offsetEnd: 3,
        selectedText: 'DES',
        contextBefore: '',
        contextAfter: '',
        occurrenceIndex: 1,
      },
      commentText: 'please revise',
    })
    await submitReviewDecision({
      db: c.db,
      appHome: c.appHome,
      nodeRunId: rev1!.id,
      decision: 'iterated',
      expectedReviewIteration: 0,
    })
    await reenterScheduler(c.db, task.id)
    await runTask({ taskId: task.id, db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd() })

    // review should be awaiting again on v2
    const rev2 = await awaitingReviewRun(c.db, task.id, 'rev')
    expect(rev2).toBeDefined()
    await submitReviewDecision({
      db: c.db,
      appHome: c.appHome,
      nodeRunId: rev2!.id,
      decision: 'approved',
      expectedReviewIteration: 1,
    })
    await reenterScheduler(c.db, task.id)
    await runTask({ taskId: task.id, db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd() })

    expect(await taskStatus(c.db, task.id)).toBe('done')
    // approved_doc output must be v2
    const revTops = await topLevel(c.db, task.id, 'rev')
    const approvedRun = revTops.find((r) => r.status === 'done')
    expect(approvedRun).toBeDefined()
    const outs = await c.db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, approvedRun!.id))
    const approvedDoc = outs.find((o) => o.portName === 'approved_doc')?.content ?? ''
    expect(approvedDoc).toContain('DESIGN_V2')
    expect(approvedDoc).not.toContain('DESIGN_V1')
  })

  // ---------------------------------------------------------------------------
  // S3 — [KNOWN-INCIDENT] iterate → clarify×2 → v2 → approve must NOT spawn a
  // second review of the same content. Repro of 01KSHVXCH6RQ5F5P64MZ4FZVN6.
  // ---------------------------------------------------------------------------
  // RED on current code (reproduces 01KSHVXCH6RQ5F5P64MZ4FZVN6). skip keeps the
  // shared tree green; flips to live `test` + green under RFC-074 provenance.
  test('S3 [KNOWN-INCIDENT]: approve after iterate+clarify reruns must not re-open review on the same content', async () => {
    await makeDesigner(c)
    // RFC-100: the designer has a clarify channel, so it is in mandatory ask-back
    // mode and MUST ask before it can produce any <workflow-output>. The plan
    // therefore opens with a clarify (round 0, answered with stop → v1), then the
    // iterate path drives two more clarify rounds before v2.
    // plan: call0 clarify; call1 output v1; call2 clarify; call3 clarify; call4 output v2
    writePlan(c, {
      designer: [
        { clarify: CLARIFY_BODY },
        { output: { design: 'DESIGN_V1' } },
        { clarify: CLARIFY_BODY },
        { clarify: CLARIFY_BODY },
        { output: { design: 'DESIGN_V2' } },
      ],
    })
    const def: WorkflowDefinition = {
      $schema_version: 2,
      inputs: [{ kind: 'text', key: 'topic', label: 't' }],
      nodes: [
        { id: 'in1', kind: 'input', inputKey: 'topic' },
        { id: 'designer', kind: 'agent-single', agentName: 'designer' },
        { id: 'clr', kind: 'clarify', title: 'c' },
        {
          id: 'rev',
          kind: 'review',
          inputSource: { nodeId: 'designer', portName: 'design' },
          rerunnableOnIterate: ['designer'],
          rerunnableOnReject: ['designer'],
        },
      ] as WorkflowNode[],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'in1', portName: 'topic' },
          target: { nodeId: 'designer', portName: 'topic' },
        },
        {
          id: 'e2',
          source: { nodeId: 'designer', portName: 'design' },
          target: { nodeId: 'rev', portName: '__review_input__' },
        },
        {
          id: 'e3',
          source: { nodeId: 'designer', portName: '__clarify__' },
          target: { nodeId: 'clr', portName: 'questions' },
        },
        {
          id: 'e4',
          source: { nodeId: 'clr', portName: 'answers' },
          target: { nodeId: 'designer', portName: '__clarify_response__' },
        },
      ],
    }
    const wf = await createWorkflow(c.db, { name: 's3', description: '', definition: def })
    const task = await startTask(
      {
        workflowId: wf.id,
        name: 's3',
        repoPath: c.repoPath,
        baseBranch: 'main',
        inputs: { topic: 'x' },
      },
      { db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd(), awaitScheduler: true },
    )
    // RFC-100: the designer asks first (round 0); answer with stop → it outputs v1.
    expect(await taskStatus(c.db, task.id)).toBe('awaiting_human')
    await autoDispatchClarifyRound({
      db: c.db,
      originNodeRunId: await openClarifyRunId(c.db, task.id),
      answers: [CLARIFY_ANSWER],
      directive: 'stop',
      actor: { userId: 'u1', role: 'owner' },
    })
    await reenterScheduler(c.db, task.id)
    await runTask({ taskId: task.id, db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd() })
    const rev1 = await awaitingReviewRun(c.db, task.id, 'rev')
    expect(rev1).toBeDefined()

    // iterate → designer reruns and (per plan) emits clarify
    await addReviewComment({
      db: c.db,
      appHome: c.appHome,
      nodeRunId: rev1!.id,
      anchor: {
        sectionPath: '#',
        paragraphIdx: 0,
        offsetStart: 0,
        offsetEnd: 3,
        selectedText: 'DES',
        contextBefore: '',
        contextAfter: '',
        occurrenceIndex: 1,
      },
      commentText: 'revise',
    })
    await submitReviewDecision({
      db: c.db,
      appHome: c.appHome,
      nodeRunId: rev1!.id,
      decision: 'iterated',
      expectedReviewIteration: 0,
    })
    // RFC-123: answering the round-0 clarify with stop now writes the durable
    // per-(task, asking-node) directive (canvas toggle = single source of truth), so
    // the designer would stay muzzled (STOP CLARIFYING) on the iterate rerun. The
    // user re-enables clarification the way they would on the canvas — flip the
    // asking node's toggle back to 'continue' once the agent is re-triggered — which
    // restores the RFC-100 mandatory-ask-back flow the rest of this scenario locks.
    await setNodeClarifyDirective(c.db, task.id, 'designer', 'continue', 'local')
    await reenterScheduler(c.db, task.id)
    await runTask({ taskId: task.id, db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd() })
    expect(await taskStatus(c.db, task.id)).toBe('awaiting_human') // designer asked clarify #1

    // answer clarify #1 → designer reruns, asks clarify #2
    await autoDispatchClarifyRound({
      db: c.db,
      originNodeRunId: await openClarifyRunId(c.db, task.id),
      answers: [CLARIFY_ANSWER],
      // RFC-100: continue — this answer leads to ANOTHER clarify round (#2), not output.
      directive: 'continue',
      actor: { userId: 'u1', role: 'owner' },
    })
    await reenterScheduler(c.db, task.id)
    await runTask({ taskId: task.id, db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd() })
    expect(await taskStatus(c.db, task.id)).toBe('awaiting_human') // clarify #2

    // RFC-100 (Codex review #1) regression: the `continue` answer ABOVE happened
    // DURING a review-iterate cycle (reviewContext is populated). Mandatory
    // ask-back must still apply — the designer's rerun prompt here must carry the
    // MANDATORY ask-back preamble and NOT the <workflow-output> format. Without
    // the `|| isClarifyRerun` arm on effectiveHasClarifyChannel, the review
    // exemption would hand a real agent (unlike this scripted stub) the output
    // format and let it finalize before the user clicks Stop, silently bypassing
    // "Keep clarifying".
    const continueRerun = (await topLevel(c.db, task.id, 'designer')).sort((a, b) =>
      a.id < b.id ? 1 : -1,
    )[0]
    expect(continueRerun?.promptText ?? '').toContain('MANDATORY ASK-BACK (clarify) mode')
    expect(continueRerun?.promptText ?? '').not.toContain('You MUST end your reply with a')

    // answer clarify #2 → designer reruns, emits output v2 → review awaiting v2
    await autoDispatchClarifyRound({
      db: c.db,
      originNodeRunId: await openClarifyRunId(c.db, task.id),
      answers: [CLARIFY_ANSWER],
      // RFC-100: stop = finalize round so the post-answer rerun's <workflow-output> is accepted.
      directive: 'stop',
      actor: { userId: 'u1', role: 'owner' },
    })
    await reenterScheduler(c.db, task.id)
    await runTask({ taskId: task.id, db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd() })

    const rev2 = await awaitingReviewRun(c.db, task.id, 'rev')
    expect(rev2).toBeDefined()

    // approve v2 (whose content already reflects the latest designer run)
    await submitReviewDecision({
      db: c.db,
      appHome: c.appHome,
      nodeRunId: rev2!.id,
      decision: 'approved',
      expectedReviewIteration: rev2!.reviewIteration,
    })
    await reenterScheduler(c.db, task.id)
    await runTask({ taskId: task.id, db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd() })

    // EXPECTED: task done, no spurious re-opened review.
    const spurious = await awaitingReviewRun(c.db, task.id, 'rev')
    expect({
      status: await taskStatus(c.db, task.id),
      spuriousReview: spurious?.id ?? null,
    }).toEqual({
      status: 'done',
      spuriousReview: null,
    })
  })

  // ---------------------------------------------------------------------------
  // S4 — control: self-clarify BEFORE review (no iterate). Should be clean.
  // ---------------------------------------------------------------------------
  test('S4 control: clarify-before-review then approve completes cleanly', async () => {
    await makeDesigner(c)
    writePlan(c, { designer: [{ clarify: CLARIFY_BODY }, { output: { design: 'DESIGN_V1' } }] })
    const def: WorkflowDefinition = {
      $schema_version: 2,
      inputs: [{ kind: 'text', key: 'topic', label: 't' }],
      nodes: [
        { id: 'in1', kind: 'input', inputKey: 'topic' },
        { id: 'designer', kind: 'agent-single', agentName: 'designer' },
        { id: 'clr', kind: 'clarify', title: 'c' },
        {
          id: 'rev',
          kind: 'review',
          inputSource: { nodeId: 'designer', portName: 'design' },
          rerunnableOnIterate: ['designer'],
          rerunnableOnReject: ['designer'],
        },
      ] as WorkflowNode[],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'in1', portName: 'topic' },
          target: { nodeId: 'designer', portName: 'topic' },
        },
        {
          id: 'e2',
          source: { nodeId: 'designer', portName: 'design' },
          target: { nodeId: 'rev', portName: '__review_input__' },
        },
        {
          id: 'e3',
          source: { nodeId: 'designer', portName: '__clarify__' },
          target: { nodeId: 'clr', portName: 'questions' },
        },
        {
          id: 'e4',
          source: { nodeId: 'clr', portName: 'answers' },
          target: { nodeId: 'designer', portName: '__clarify_response__' },
        },
      ],
    }
    const wf = await createWorkflow(c.db, { name: 's4', description: '', definition: def })
    const task = await startTask(
      {
        workflowId: wf.id,
        name: 's4',
        repoPath: c.repoPath,
        baseBranch: 'main',
        inputs: { topic: 'x' },
      },
      { db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd(), awaitScheduler: true },
    )
    expect(await taskStatus(c.db, task.id)).toBe('awaiting_human')
    await autoDispatchClarifyRound({
      db: c.db,
      originNodeRunId: await openClarifyRunId(c.db, task.id),
      answers: [CLARIFY_ANSWER],
      // RFC-100: stop = finalize round so the post-answer rerun's <workflow-output> is accepted.
      directive: 'stop',
      actor,
    })
    await reenterScheduler(c.db, task.id)
    await runTask({ taskId: task.id, db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd() })

    const rev = await awaitingReviewRun(c.db, task.id, 'rev')
    expect(rev).toBeDefined()
    await submitReviewDecision({
      db: c.db,
      appHome: c.appHome,
      nodeRunId: rev!.id,
      decision: 'approved',
      expectedReviewIteration: rev!.reviewIteration,
    })
    await reenterScheduler(c.db, task.id)
    await runTask({ taskId: task.id, db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd() })

    expect(await taskStatus(c.db, task.id)).toBe('done')
    expect(await awaitingReviewRun(c.db, task.id, 'rev')).toBeUndefined()
  })

  // ---------------------------------------------------------------------------
  // S5 — sibling reviews: rejecting one must invalidate the approved sibling
  // ---------------------------------------------------------------------------
  test('S5 sibling reviews: rejecting reviewA invalidates the already-approved reviewB', async () => {
    await makeDesigner(c)
    writePlan(c, {
      designer: [{ output: { design: 'DESIGN_V1' } }, { output: { design: 'DESIGN_V2' } }],
    })
    const def: WorkflowDefinition = {
      $schema_version: 2,
      inputs: [{ kind: 'text', key: 'topic', label: 't' }],
      nodes: [
        { id: 'in1', kind: 'input', inputKey: 'topic' },
        { id: 'designer', kind: 'agent-single', agentName: 'designer' },
        {
          id: 'revA',
          kind: 'review',
          inputSource: { nodeId: 'designer', portName: 'design' },
          rerunnableOnReject: ['designer'],
          rerunnableOnIterate: ['designer'],
        },
        {
          id: 'revB',
          kind: 'review',
          inputSource: { nodeId: 'designer', portName: 'design' },
          rerunnableOnReject: ['designer'],
          rerunnableOnIterate: ['designer'],
        },
      ] as WorkflowNode[],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'in1', portName: 'topic' },
          target: { nodeId: 'designer', portName: 'topic' },
        },
        {
          id: 'e2',
          source: { nodeId: 'designer', portName: 'design' },
          target: { nodeId: 'revA', portName: '__review_input__' },
        },
        {
          id: 'e3',
          source: { nodeId: 'designer', portName: 'design' },
          target: { nodeId: 'revB', portName: '__review_input__' },
        },
      ],
    }
    const wf = await createWorkflow(c.db, { name: 's5', description: '', definition: def })
    const task = await startTask(
      {
        workflowId: wf.id,
        name: 's5',
        repoPath: c.repoPath,
        baseBranch: 'main',
        inputs: { topic: 'x' },
      },
      { db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd(), awaitScheduler: true },
    )
    const revA = await awaitingReviewRun(c.db, task.id, 'revA')
    const revB = await awaitingReviewRun(c.db, task.id, 'revB')
    expect(revA && revB).toBeTruthy()

    // approve B first
    await submitReviewDecision({
      db: c.db,
      appHome: c.appHome,
      nodeRunId: revB!.id,
      decision: 'approved',
      expectedReviewIteration: 0,
    })
    // then reject A (rerunnable designer) → designer reruns v2 → B's approval is now stale
    await submitReviewDecision({
      db: c.db,
      appHome: c.appHome,
      nodeRunId: revA!.id,
      decision: 'rejected',
      expectedReviewIteration: 0,
      rejectReason: 'no good',
    })
    await reenterScheduler(c.db, task.id)
    await runTask({ taskId: task.id, db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd() })

    // EXPECTED: B must NOT remain a finalized approval against the stale v1.
    // It should be pulled back (awaiting_review again or superseded), and the
    // task must not be 'done' with a stale B approval.
    const status = await taskStatus(c.db, task.id)
    const bTops = await topLevel(c.db, task.id, 'revB')
    // RFC-074 PR-C: "B's stale approval survived" ⟺ revB's own row is still the
    // freshest top-level revB row AND done. If B was pulled back, a newer
    // awaiting_review row (larger id) sits on top, so this is false.
    const bFreshest = bTops.slice().sort((a, b) => (a.id < b.id ? 1 : -1))[0]
    const bApprovedAgainstV1 = bFreshest?.id === revB!.id && bFreshest?.status === 'done'
    expect({ taskDone: status === 'done', bStillApproved: bApprovedAgainstV1 }).toEqual({
      taskDone: false,
      bStillApproved: false,
    })
  })

  // ---------------------------------------------------------------------------
  // S6 — does the incident class extend to the REJECT path (not just iterate)?
  // ---------------------------------------------------------------------------
  // RED on current code [NEW FINDING: bug class extends to the reject path].
  test('S6 probe: reject + clarify reruns then approve must not re-open review on the same content', async () => {
    await makeDesigner(c)
    // RFC-100: clarify channel ⇒ mandatory ask-back; the designer asks (round 0,
    // answered with stop → v1) before it can output. plan: clarify; output v1;
    // clarify (after reject); output v2.
    writePlan(c, {
      designer: [
        { clarify: CLARIFY_BODY },
        { output: { design: 'DESIGN_V1' } },
        { clarify: CLARIFY_BODY },
        { output: { design: 'DESIGN_V2' } },
      ],
    })
    const def: WorkflowDefinition = {
      $schema_version: 2,
      inputs: [{ kind: 'text', key: 'topic', label: 't' }],
      nodes: [
        { id: 'in1', kind: 'input', inputKey: 'topic' },
        { id: 'designer', kind: 'agent-single', agentName: 'designer' },
        { id: 'clr', kind: 'clarify', title: 'c' },
        {
          id: 'rev',
          kind: 'review',
          inputSource: { nodeId: 'designer', portName: 'design' },
          rerunnableOnIterate: ['designer'],
          rerunnableOnReject: ['designer'],
        },
      ] as WorkflowNode[],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'in1', portName: 'topic' },
          target: { nodeId: 'designer', portName: 'topic' },
        },
        {
          id: 'e2',
          source: { nodeId: 'designer', portName: 'design' },
          target: { nodeId: 'rev', portName: '__review_input__' },
        },
        {
          id: 'e3',
          source: { nodeId: 'designer', portName: '__clarify__' },
          target: { nodeId: 'clr', portName: 'questions' },
        },
        {
          id: 'e4',
          source: { nodeId: 'clr', portName: 'answers' },
          target: { nodeId: 'designer', portName: '__clarify_response__' },
        },
      ],
    }
    const wf = await createWorkflow(c.db, { name: 's6', description: '', definition: def })
    const task = await startTask(
      {
        workflowId: wf.id,
        name: 's6',
        repoPath: c.repoPath,
        baseBranch: 'main',
        inputs: { topic: 'x' },
      },
      { db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd(), awaitScheduler: true },
    )
    // RFC-100: the designer asks first (round 0); answer with stop → it outputs v1.
    expect(await taskStatus(c.db, task.id)).toBe('awaiting_human')
    await autoDispatchClarifyRound({
      db: c.db,
      originNodeRunId: await openClarifyRunId(c.db, task.id),
      answers: [CLARIFY_ANSWER],
      directive: 'stop',
      actor: { userId: 'u1', role: 'owner' },
    })
    await reenterScheduler(c.db, task.id)
    await runTask({ taskId: task.id, db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd() })
    const rev1 = await awaitingReviewRun(c.db, task.id, 'rev')
    await submitReviewDecision({
      db: c.db,
      appHome: c.appHome,
      nodeRunId: rev1!.id,
      decision: 'rejected',
      expectedReviewIteration: 0,
      rejectReason: 'redo',
    })
    // RFC-123: the round-0 'stop' answer wrote the durable node directive (toggle=stop),
    // and the RFC-123 follow-up now ENFORCES it — a stopped designer that emits clarify is
    // rejected (clarify-forbidden). To let the designer clarify again on the reject rerun,
    // re-enable the way the user would on the canvas: flip the asking node's toggle back to
    // 'continue' once the agent is re-triggered.
    await setNodeClarifyDirective(c.db, task.id, 'designer', 'continue', 'local')
    await reenterScheduler(c.db, task.id)
    await runTask({ taskId: task.id, db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd() })
    expect(await taskStatus(c.db, task.id)).toBe('awaiting_human') // designer asked clarify
    await autoDispatchClarifyRound({
      db: c.db,
      originNodeRunId: await openClarifyRunId(c.db, task.id),
      answers: [CLARIFY_ANSWER],
      // RFC-100: stop = finalize round so the post-answer rerun's <workflow-output> is accepted.
      directive: 'stop',
      actor: { userId: 'u1', role: 'owner' },
    })
    await reenterScheduler(c.db, task.id)
    await runTask({ taskId: task.id, db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd() })

    const rev2 = await awaitingReviewRun(c.db, task.id, 'rev')
    expect(rev2).toBeDefined()
    await submitReviewDecision({
      db: c.db,
      appHome: c.appHome,
      nodeRunId: rev2!.id,
      decision: 'approved',
      expectedReviewIteration: rev2!.reviewIteration,
    })
    await reenterScheduler(c.db, task.id)
    await runTask({ taskId: task.id, db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd() })

    const spurious = await awaitingReviewRun(c.db, task.id, 'rev')
    expect({
      status: await taskStatus(c.db, task.id),
      spuriousReview: spurious?.id ?? null,
    }).toEqual({ status: 'done', spuriousReview: null })
  })

  // ---------------------------------------------------------------------------
  // S8 — multi-hop A → B → review(B), with A self-clarifying before output
  // ---------------------------------------------------------------------------
  // RED on current code [NEW FINDING: most common trigger — a clarifying agent
  // with a non-clarifying intermediate agent before the review forces ONE
  // spurious re-review after the first approval, because the intermediate agent
  // is dispatched fresh at cci=0 while its upstream sits at cci=1. No
  // iterate/reject needed — just ask-clarify-then-proceed + a 2-hop chain].
  test('S8 multi-hop: A→B→review with A clarify-before-output completes cleanly', async () => {
    await makeDesigner(c, 'agentA', ['a'])
    await makeDesigner(c, 'agentB', ['b'])
    writePlan(c, {
      agentA: [{ clarify: CLARIFY_BODY }, { output: { a: 'A_OUT' } }],
      agentB: [{ output: { b: 'B_OUT' } }],
    })
    const def: WorkflowDefinition = {
      $schema_version: 2,
      inputs: [{ kind: 'text', key: 'topic', label: 't' }],
      nodes: [
        { id: 'in1', kind: 'input', inputKey: 'topic' },
        { id: 'agentA', kind: 'agent-single', agentName: 'agentA' },
        { id: 'clr', kind: 'clarify', title: 'c' },
        { id: 'agentB', kind: 'agent-single', agentName: 'agentB' },
        {
          id: 'rev',
          kind: 'review',
          inputSource: { nodeId: 'agentB', portName: 'b' },
          rerunnableOnIterate: ['agentB'],
          rerunnableOnReject: ['agentB'],
        },
      ] as WorkflowNode[],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'in1', portName: 'topic' },
          target: { nodeId: 'agentA', portName: 'topic' },
        },
        {
          id: 'e2',
          source: { nodeId: 'agentA', portName: '__clarify__' },
          target: { nodeId: 'clr', portName: 'questions' },
        },
        {
          id: 'e3',
          source: { nodeId: 'clr', portName: 'answers' },
          target: { nodeId: 'agentA', portName: '__clarify_response__' },
        },
        {
          id: 'e4',
          source: { nodeId: 'agentA', portName: 'a' },
          target: { nodeId: 'agentB', portName: 'a' },
        },
        {
          id: 'e5',
          source: { nodeId: 'agentB', portName: 'b' },
          target: { nodeId: 'rev', portName: '__review_input__' },
        },
      ],
    }
    const wf = await createWorkflow(c.db, { name: 's8', description: '', definition: def })
    const task = await startTask(
      {
        workflowId: wf.id,
        name: 's8',
        repoPath: c.repoPath,
        baseBranch: 'main',
        inputs: { topic: 'x' },
      },
      { db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd(), awaitScheduler: true },
    )
    expect(await taskStatus(c.db, task.id)).toBe('awaiting_human')
    await autoDispatchClarifyRound({
      db: c.db,
      originNodeRunId: await openClarifyRunId(c.db, task.id),
      answers: [CLARIFY_ANSWER],
      // RFC-100: stop = finalize round so the post-answer rerun's <workflow-output> is accepted.
      directive: 'stop',
      actor,
    })
    await reenterScheduler(c.db, task.id)
    await runTask({ taskId: task.id, db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd() })

    const rev = await awaitingReviewRun(c.db, task.id, 'rev')
    expect(rev).toBeDefined()
    await submitReviewDecision({
      db: c.db,
      appHome: c.appHome,
      nodeRunId: rev!.id,
      decision: 'approved',
      expectedReviewIteration: rev!.reviewIteration,
    })
    await reenterScheduler(c.db, task.id)
    await runTask({ taskId: task.id, db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd() })

    expect({
      status: await taskStatus(c.db, task.id),
      spurious: (await awaitingReviewRun(c.db, task.id, 'rev'))?.id ?? null,
    }).toEqual({ status: 'done', spurious: null })
  })

  // ---------------------------------------------------------------------------
  // S9 — downstream clarify must NOT re-open an already-approved upstream review
  // ---------------------------------------------------------------------------
  test('S9 freshness-direction: downstream agent clarify does not re-open the upstream approved review', async () => {
    await makeDesigner(c)
    await makeDesigner(c, 'builder', ['build'])
    writePlan(c, {
      designer: [{ output: { design: 'DESIGN_V1' } }],
      builder: [{ clarify: CLARIFY_BODY }, { output: { build: 'BUILT' } }],
    })
    const def: WorkflowDefinition = {
      $schema_version: 2,
      inputs: [{ kind: 'text', key: 'topic', label: 't' }],
      nodes: [
        { id: 'in1', kind: 'input', inputKey: 'topic' },
        { id: 'designer', kind: 'agent-single', agentName: 'designer' },
        {
          id: 'rev',
          kind: 'review',
          inputSource: { nodeId: 'designer', portName: 'design' },
          rerunnableOnIterate: ['designer'],
          rerunnableOnReject: ['designer'],
        },
        { id: 'builder', kind: 'agent-single', agentName: 'builder' },
        { id: 'clr', kind: 'clarify', title: 'c' },
      ] as WorkflowNode[],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'in1', portName: 'topic' },
          target: { nodeId: 'designer', portName: 'topic' },
        },
        {
          id: 'e2',
          source: { nodeId: 'designer', portName: 'design' },
          target: { nodeId: 'rev', portName: '__review_input__' },
        },
        {
          id: 'e3',
          source: { nodeId: 'rev', portName: 'approved_doc' },
          target: { nodeId: 'builder', portName: 'doc' },
        },
        {
          id: 'e4',
          source: { nodeId: 'builder', portName: '__clarify__' },
          target: { nodeId: 'clr', portName: 'questions' },
        },
        {
          id: 'e5',
          source: { nodeId: 'clr', portName: 'answers' },
          target: { nodeId: 'builder', portName: '__clarify_response__' },
        },
      ],
    }
    const wf = await createWorkflow(c.db, { name: 's9', description: '', definition: def })
    const task = await startTask(
      {
        workflowId: wf.id,
        name: 's9',
        repoPath: c.repoPath,
        baseBranch: 'main',
        inputs: { topic: 'x' },
      },
      { db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd(), awaitScheduler: true },
    )
    const rev = await awaitingReviewRun(c.db, task.id, 'rev')
    await submitReviewDecision({
      db: c.db,
      appHome: c.appHome,
      nodeRunId: rev!.id,
      decision: 'approved',
      expectedReviewIteration: 0,
    })
    await reenterScheduler(c.db, task.id)
    await runTask({ taskId: task.id, db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd() })
    // builder now asks clarify
    expect(await taskStatus(c.db, task.id)).toBe('awaiting_human')
    await autoDispatchClarifyRound({
      db: c.db,
      originNodeRunId: await openClarifyRunId(c.db, task.id),
      answers: [CLARIFY_ANSWER],
      // RFC-100: stop = finalize round so the post-answer rerun's <workflow-output> is accepted.
      directive: 'stop',
      actor,
    })
    await reenterScheduler(c.db, task.id)
    await runTask({ taskId: task.id, db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd() })

    // EXPECTED: review stays approved (done), task done, review NOT re-opened.
    const revTops = await topLevel(c.db, task.id, 'rev')
    const reopened = revTops.some((r) => r.status === 'awaiting_review')
    expect({ status: await taskStatus(c.db, task.id), reopened }).toEqual({
      status: 'done',
      reopened: false,
    })
  })

  // ---------------------------------------------------------------------------
  // S10 — pure agent chain A(clarify)→B→C (no review). Negative control: a
  // forward-only flow with a clarifying head should still reach `done` — the
  // cci lag only bites on a runScope RE-ENTRY (resume), of which there is none
  // here. If this fails, the lag is worse than S8 (bites forward flow too).
  // ---------------------------------------------------------------------------
  test('S10 control: pure agent chain with clarifying head reaches done (no re-entry)', async () => {
    await makeDesigner(c, 'agentA', ['a'])
    await makeDesigner(c, 'agentB', ['b'])
    await makeDesigner(c, 'agentC', ['cc'])
    writePlan(c, {
      agentA: [{ clarify: CLARIFY_BODY }, { output: { a: 'A_OUT' } }],
      agentB: [{ output: { b: 'B_OUT' } }],
      agentC: [{ output: { cc: 'C_OUT' } }],
    })
    const def: WorkflowDefinition = {
      $schema_version: 2,
      inputs: [{ kind: 'text', key: 'topic', label: 't' }],
      nodes: [
        { id: 'in1', kind: 'input', inputKey: 'topic' },
        { id: 'agentA', kind: 'agent-single', agentName: 'agentA' },
        { id: 'clr', kind: 'clarify', title: 'c' },
        { id: 'agentB', kind: 'agent-single', agentName: 'agentB' },
        { id: 'agentC', kind: 'agent-single', agentName: 'agentC' },
        {
          id: 'out',
          kind: 'output',
          ports: [{ name: 'final', bind: { nodeId: 'agentC', portName: 'cc' } }],
        },
      ] as unknown as WorkflowDefinition['nodes'],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'in1', portName: 'topic' },
          target: { nodeId: 'agentA', portName: 'topic' },
        },
        {
          id: 'e2',
          source: { nodeId: 'agentA', portName: '__clarify__' },
          target: { nodeId: 'clr', portName: 'questions' },
        },
        {
          id: 'e3',
          source: { nodeId: 'clr', portName: 'answers' },
          target: { nodeId: 'agentA', portName: '__clarify_response__' },
        },
        {
          id: 'e4',
          source: { nodeId: 'agentA', portName: 'a' },
          target: { nodeId: 'agentB', portName: 'a' },
        },
        {
          id: 'e5',
          source: { nodeId: 'agentB', portName: 'b' },
          target: { nodeId: 'agentC', portName: 'b' },
        },
      ],
    }
    const wf = await createWorkflow(c.db, { name: 's10', description: '', definition: def })
    const task = await startTask(
      {
        workflowId: wf.id,
        name: 's10',
        repoPath: c.repoPath,
        baseBranch: 'main',
        inputs: { topic: 'x' },
      },
      { db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd(), awaitScheduler: true },
    )
    expect(await taskStatus(c.db, task.id)).toBe('awaiting_human')
    await autoDispatchClarifyRound({
      db: c.db,
      originNodeRunId: await openClarifyRunId(c.db, task.id),
      answers: [CLARIFY_ANSWER],
      // RFC-100: stop = finalize round so the post-answer rerun's <workflow-output> is accepted.
      directive: 'stop',
      actor,
    })
    await reenterScheduler(c.db, task.id)
    await runTask({ taskId: task.id, db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd() })
    expect(await taskStatus(c.db, task.id)).toBe('done')
    // RFC-W001: re-enters the scheduler + spawns mock-opencode runs, >5s on
    // Windows CI; raise the per-test timeout (see S-RFC074 note below).
  }, 60_000)

  // ---------------------------------------------------------------------------
  // S-RFC074 §4.3 / D9 — the RFC's self-declared #1 risk. After deleting the
  // Layer A pre-mint cascade, a fresher upstream must propagate ONE HOP PER
  // BATCH down a pure-agent chain via the per-batch recomputeFreshnessAndDemote:
  // batch1 demotes B (re-runs reading the fresh A), batch2 demotes C (re-runs
  // reading the fresh B). A regression that demoted only the immediate
  // downstream non-transitively, or that broke the per-batch recompute, would
  // pass every other scenario yet silently let C run on a STALE B. We lock that
  // the freshly re-run B consumed the NEW A and the freshly re-run C the NEW B.
  // ---------------------------------------------------------------------------
  test('S-RFC074: in→A→B→C all-agent staged demote propagates one hop per batch', async () => {
    await makeDesigner(c, 'agentA', ['a'])
    await makeDesigner(c, 'agentB', ['b'])
    await makeDesigner(c, 'agentC', ['cc'])
    writePlan(c, {
      agentA: [{ output: { a: 'A_V1' } }, { output: { a: 'A_V2' } }],
      agentB: [{ output: { b: 'B_V1' } }, { output: { b: 'B_V2' } }],
      agentC: [{ output: { cc: 'C_V1' } }, { output: { cc: 'C_V2' } }],
    })
    const def: WorkflowDefinition = {
      $schema_version: 2,
      inputs: [{ kind: 'text', key: 'topic', label: 't' }],
      nodes: [
        { id: 'in1', kind: 'input', inputKey: 'topic' },
        { id: 'agentA', kind: 'agent-single', agentName: 'agentA' },
        { id: 'agentB', kind: 'agent-single', agentName: 'agentB' },
        { id: 'agentC', kind: 'agent-single', agentName: 'agentC' },
      ] as unknown as WorkflowDefinition['nodes'],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'in1', portName: 'topic' },
          target: { nodeId: 'agentA', portName: 'topic' },
        },
        {
          id: 'e4',
          source: { nodeId: 'agentA', portName: 'a' },
          target: { nodeId: 'agentB', portName: 'a' },
        },
        {
          id: 'e5',
          source: { nodeId: 'agentB', portName: 'b' },
          target: { nodeId: 'agentC', portName: 'b' },
        },
      ],
    }
    const wf = await createWorkflow(c.db, { name: 's-rfc074', description: '', definition: def })
    const task = await startTask(
      {
        workflowId: wf.id,
        name: 's-rfc074',
        repoPath: c.repoPath,
        baseBranch: 'main',
        inputs: { topic: 'x' },
      },
      { db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd(), awaitScheduler: true },
    )
    // The pure-agent chain runs straight to done (v1), each node consuming its
    // upstream's v1 run.
    expect(await taskStatus(c.db, task.id)).toBe('done')
    const consumedOf = (r: { consumedUpstreamRunsJson: string | null }) =>
      JSON.parse(r.consumedUpstreamRunsJson ?? '{}') as Record<string, string>
    const doneB1 = (await topLevel(c.db, task.id, 'agentB')).filter((r) => r.status === 'done')
    const doneC1 = (await topLevel(c.db, task.id, 'agentC')).filter((r) => r.status === 'done')
    expect(doneB1.length).toBe(1)
    expect(doneC1.length).toBe(1)
    const oldA = (await topLevel(c.db, task.id, 'agentA')).find((r) => r.status === 'done')!.id
    expect(consumedOf(doneB1[0]!).agentA).toBe(oldA) // B consumed the v1 A

    // Trigger a fresh A generation: mint a pending A rerun (the answer-
    // continuation shape) so the next runScope re-runs A → A_V2. With
    // Layer A gone, NOTHING pre-mints B/C — the per-batch demote must.
    await c.db.insert(nodeRuns).values({
      id: ulid(),
      taskId: task.id,
      nodeId: 'agentA',
      status: 'pending',
      retryIndex: 0,
      iteration: 0,
    })
    await c.db.update(tasks).set({ status: 'pending' }).where(eq(tasks.id, task.id))

    await runTask({ taskId: task.id, db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd() })
    // RFC-W001: the demote cascade re-runs 3 nodes (A->B->C), so this runTask
    // alone runs ~6s on Windows - over bun's 5s default per-test timeout. This
    // test's timeout is raised to 60s (see the test() call below); without that,
    // bun fires the timeout mid-runTask, starts the NEXT test's beforeEach
    // (clobbering this file's shared `c` + global process.env.SCENARIO_PLAN_FILE),
    // and the scenario stub then reads a wrong plan -> the demote fails. Poll
    // briefly for the terminal status in case the final commit lands a tick
    // after runTask resolves.
    expect(await waitForTaskStatus(c.db, task.id, 'done')).toBe('done')

    const doneA2 = (await topLevel(c.db, task.id, 'agentA')).filter((r) => r.status === 'done')
    const doneB2 = (await topLevel(c.db, task.id, 'agentB')).filter((r) => r.status === 'done')
    const doneC2 = (await topLevel(c.db, task.id, 'agentC')).filter((r) => r.status === 'done')
    const newest = (rows: typeof doneA2) => rows.reduce((m, r) => (r.id > m.id ? r : m))
    const newA = newest(doneA2)
    const newB = newest(doneB2)
    const newC = newest(doneC2)
    expect(newA.id).not.toBe(oldA) // A re-ran (A_V2)
    // B and C each demoted + re-ran EXACTLY once — staged, not double-run.
    expect(doneB2.length).toBe(2)
    expect(doneC2.length).toBe(2)
    // The crux of §4.3: the fresh downstream rows consumed the fresh upstream
    // rows (B reads the NEW A, C reads the NEW B). A non-transitive demote would
    // leave newC consuming the OLD B here.
    expect(consumedOf(newB).agentA).toBe(newA.id)
    expect(consumedOf(newC).agentB).toBe(newB.id)
  }, 60_000)

  // ---------------------------------------------------------------------------
  // S11 — A(clarify)→B(clarify)→review. A non-clarifying intermediate is the
  // S8 trigger; here B ALSO clarifies, bumping its own cci to match A. Probe:
  // does a self-clarifying intermediate avoid the spurious re-review?
  // ---------------------------------------------------------------------------
  test('S11 probe: A(clarify)→B(clarify)→review then approve completes without re-review', async () => {
    await makeDesigner(c, 'agentA', ['a'])
    await makeDesigner(c, 'agentB', ['b'])
    writePlan(c, {
      agentA: [{ clarify: CLARIFY_BODY }, { output: { a: 'A_OUT' } }],
      agentB: [{ clarify: CLARIFY_BODY }, { output: { b: 'B_OUT' } }],
    })
    const def: WorkflowDefinition = {
      $schema_version: 2,
      inputs: [{ kind: 'text', key: 'topic', label: 't' }],
      nodes: [
        { id: 'in1', kind: 'input', inputKey: 'topic' },
        { id: 'agentA', kind: 'agent-single', agentName: 'agentA' },
        { id: 'clrA', kind: 'clarify', title: 'a' },
        { id: 'agentB', kind: 'agent-single', agentName: 'agentB' },
        { id: 'clrB', kind: 'clarify', title: 'b' },
        {
          id: 'rev',
          kind: 'review',
          inputSource: { nodeId: 'agentB', portName: 'b' },
          rerunnableOnIterate: ['agentB'],
          rerunnableOnReject: ['agentB'],
        },
      ] as WorkflowNode[],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'in1', portName: 'topic' },
          target: { nodeId: 'agentA', portName: 'topic' },
        },
        {
          id: 'e2',
          source: { nodeId: 'agentA', portName: '__clarify__' },
          target: { nodeId: 'clrA', portName: 'questions' },
        },
        {
          id: 'e3',
          source: { nodeId: 'clrA', portName: 'answers' },
          target: { nodeId: 'agentA', portName: '__clarify_response__' },
        },
        {
          id: 'e4',
          source: { nodeId: 'agentA', portName: 'a' },
          target: { nodeId: 'agentB', portName: 'a' },
        },
        {
          id: 'e5',
          source: { nodeId: 'agentB', portName: '__clarify__' },
          target: { nodeId: 'clrB', portName: 'questions' },
        },
        {
          id: 'e6',
          source: { nodeId: 'clrB', portName: 'answers' },
          target: { nodeId: 'agentB', portName: '__clarify_response__' },
        },
        {
          id: 'e7',
          source: { nodeId: 'agentB', portName: 'b' },
          target: { nodeId: 'rev', portName: '__review_input__' },
        },
      ],
    }
    const wf = await createWorkflow(c.db, { name: 's11', description: '', definition: def })
    const task = await startTask(
      {
        workflowId: wf.id,
        name: 's11',
        repoPath: c.repoPath,
        baseBranch: 'main',
        inputs: { topic: 'x' },
      },
      { db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd(), awaitScheduler: true },
    )
    // answer A's clarify
    await autoDispatchClarifyRound({
      db: c.db,
      originNodeRunId: await openClarifyRunId(c.db, task.id),
      answers: [CLARIFY_ANSWER],
      // RFC-100: stop = finalize round so the post-answer rerun's <workflow-output> is accepted.
      directive: 'stop',
      actor,
    })
    await reenterScheduler(c.db, task.id)
    await runTask({ taskId: task.id, db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd() })
    // answer B's clarify
    expect(await taskStatus(c.db, task.id)).toBe('awaiting_human')
    await autoDispatchClarifyRound({
      db: c.db,
      originNodeRunId: await openClarifyRunId(c.db, task.id),
      answers: [CLARIFY_ANSWER],
      // RFC-100: stop = finalize round so the post-answer rerun's <workflow-output> is accepted.
      directive: 'stop',
      actor,
    })
    await reenterScheduler(c.db, task.id)
    await runTask({ taskId: task.id, db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd() })

    const rev = await awaitingReviewRun(c.db, task.id, 'rev')
    expect(rev).toBeDefined()
    await submitReviewDecision({
      db: c.db,
      appHome: c.appHome,
      nodeRunId: rev!.id,
      decision: 'approved',
      expectedReviewIteration: rev!.reviewIteration,
    })
    await reenterScheduler(c.db, task.id)
    await runTask({ taskId: task.id, db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd() })

    expect({
      status: await taskStatus(c.db, task.id),
      spurious: (await awaitingReviewRun(c.db, task.id, 'rev'))?.id ?? null,
    }).toEqual({ status: 'done', spurious: null })
  })

  // ---------------------------------------------------------------------------
  // S12 — diamond: designer(clarify) → revA(review) AND designer → builder → out.
  // After approving revA, the non-reviewed builder branch must not be silently
  // re-run just because builder's cci lags designer's (post-clarify) cci.
  // Asserts builder ran exactly once (exposes silent wasted reruns).
  // ---------------------------------------------------------------------------
  // RED on current code [NEW FINDING: lower severity — silent wasted rerun].
  // Task still reaches done + revA stays approved, but the non-reviewed builder
  // sibling re-runs (builderDoneRows=2) purely because builder.cci lagged
  // designer's post-clarify cci. No user-visible re-review, but wasted execution
  // (and a non-readonly sibling could churn worktree files for nothing).
  test('S12 diamond: approving the reviewed branch must not silently re-run the sibling builder branch', async () => {
    await makeDesigner(c)
    await makeDesigner(c, 'builder', ['build'])
    writePlan(c, {
      designer: [{ clarify: CLARIFY_BODY }, { output: { design: 'DESIGN_V1' } }],
      builder: [{ output: { build: 'BUILT' } }],
    })
    const def: WorkflowDefinition = {
      $schema_version: 2,
      inputs: [{ kind: 'text', key: 'topic', label: 't' }],
      nodes: [
        { id: 'in1', kind: 'input', inputKey: 'topic' },
        { id: 'designer', kind: 'agent-single', agentName: 'designer' },
        { id: 'clr', kind: 'clarify', title: 'c' },
        {
          id: 'revA',
          kind: 'review',
          inputSource: { nodeId: 'designer', portName: 'design' },
          rerunnableOnIterate: ['designer'],
          rerunnableOnReject: ['designer'],
        },
        { id: 'builder', kind: 'agent-single', agentName: 'builder' },
        {
          id: 'out',
          kind: 'output',
          ports: [{ name: 'f', bind: { nodeId: 'builder', portName: 'build' } }],
        },
      ] as unknown as WorkflowDefinition['nodes'],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'in1', portName: 'topic' },
          target: { nodeId: 'designer', portName: 'topic' },
        },
        {
          id: 'e2',
          source: { nodeId: 'designer', portName: '__clarify__' },
          target: { nodeId: 'clr', portName: 'questions' },
        },
        {
          id: 'e3',
          source: { nodeId: 'clr', portName: 'answers' },
          target: { nodeId: 'designer', portName: '__clarify_response__' },
        },
        {
          id: 'e4',
          source: { nodeId: 'designer', portName: 'design' },
          target: { nodeId: 'revA', portName: '__review_input__' },
        },
        {
          id: 'e5',
          source: { nodeId: 'designer', portName: 'design' },
          target: { nodeId: 'builder', portName: 'doc' },
        },
      ],
    }
    const wf = await createWorkflow(c.db, { name: 's12', description: '', definition: def })
    const task = await startTask(
      {
        workflowId: wf.id,
        name: 's12',
        repoPath: c.repoPath,
        baseBranch: 'main',
        inputs: { topic: 'x' },
      },
      { db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd(), awaitScheduler: true },
    )
    await autoDispatchClarifyRound({
      db: c.db,
      originNodeRunId: await openClarifyRunId(c.db, task.id),
      answers: [CLARIFY_ANSWER],
      // RFC-100: stop = finalize round so the post-answer rerun's <workflow-output> is accepted.
      directive: 'stop',
      actor,
    })
    await reenterScheduler(c.db, task.id)
    await runTask({ taskId: task.id, db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd() })
    const revA = await awaitingReviewRun(c.db, task.id, 'revA')
    expect(revA).toBeDefined()
    await submitReviewDecision({
      db: c.db,
      appHome: c.appHome,
      nodeRunId: revA!.id,
      decision: 'approved',
      expectedReviewIteration: revA!.reviewIteration,
    })
    await reenterScheduler(c.db, task.id)
    await runTask({ taskId: task.id, db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd() })

    const builderTops = await topLevel(c.db, task.id, 'builder')
    const builderDone = builderTops.filter((r) => r.status === 'done')
    expect({
      status: await taskStatus(c.db, task.id),
      builderDoneRows: builderDone.length,
    }).toEqual({
      status: 'done',
      builderDoneRows: 1,
    })
  })

  // ---------------------------------------------------------------------------
  // S13 — loop wrapper {designer + clarify} → post-loop agent → review(agent).
  // (review.inputSource must be an agent, not the wrapper — validator rule
  // review-input-source-not-markdown; so we review a post-loop agent.) Probes
  // cci freshness across the loop sub-scope boundary into the parent-scope
  // review.
  // ---------------------------------------------------------------------------
  test('S13 loop wrapper with inner clarify → post-loop agent → review approves cleanly', async () => {
    await makeDesigner(c)
    await makeDesigner(c, 'builder', ['build'])
    writePlan(c, {
      designer: [{ clarify: CLARIFY_BODY }, { output: { design: 'DESIGN_V1' } }],
      builder: [{ output: { build: 'BUILT' } }],
    })
    const def: WorkflowDefinition = {
      $schema_version: 3,
      inputs: [{ kind: 'text', key: 'topic', label: 't' }],
      nodes: [
        { id: 'in1', kind: 'input', inputKey: 'topic' },
        { id: 'designer', kind: 'agent-single', agentName: 'designer' },
        { id: 'clr', kind: 'clarify', title: 'c' },
        {
          id: 'loop',
          kind: 'wrapper-loop',
          nodeIds: ['designer', 'clr'],
          maxIterations: 3,
          exitCondition: { kind: 'port-not-empty', nodeId: 'designer', portName: 'design' },
          outputBindings: [{ name: 'looped', bind: { nodeId: 'designer', portName: 'design' } }],
        },
        { id: 'builder', kind: 'agent-single', agentName: 'builder' },
        {
          id: 'rev',
          kind: 'review',
          inputSource: { nodeId: 'builder', portName: 'build' },
          rerunnableOnIterate: ['builder'],
          rerunnableOnReject: ['builder'],
        },
      ] as unknown as WorkflowDefinition['nodes'],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'in1', portName: 'topic' },
          target: { nodeId: 'designer', portName: 'topic' },
        },
        {
          id: 'e2',
          source: { nodeId: 'designer', portName: '__clarify__' },
          target: { nodeId: 'clr', portName: 'questions' },
        },
        {
          id: 'e3',
          source: { nodeId: 'clr', portName: 'answers' },
          target: { nodeId: 'designer', portName: '__clarify_response__' },
        },
        {
          id: 'e4',
          source: { nodeId: 'loop', portName: 'looped' },
          target: { nodeId: 'builder', portName: 'doc' },
        },
        {
          id: 'e5',
          source: { nodeId: 'builder', portName: 'build' },
          target: { nodeId: 'rev', portName: '__review_input__' },
        },
      ],
    }
    const wf = await createWorkflow(c.db, { name: 's13', description: '', definition: def })
    const task = await startTask(
      {
        workflowId: wf.id,
        name: 's13',
        repoPath: c.repoPath,
        baseBranch: 'main',
        inputs: { topic: 'x' },
      },
      { db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd(), awaitScheduler: true },
    )
    expect(await taskStatus(c.db, task.id)).toBe('awaiting_human')
    await autoDispatchClarifyRound({
      db: c.db,
      originNodeRunId: await openClarifyRunId(c.db, task.id),
      answers: [CLARIFY_ANSWER],
      // RFC-100: stop = finalize round so the post-answer rerun's <workflow-output> is accepted.
      directive: 'stop',
      actor,
    })
    await reenterScheduler(c.db, task.id)
    await runTask({ taskId: task.id, db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd() })

    const rev = await awaitingReviewRun(c.db, task.id, 'rev')
    expect(rev).toBeDefined()
    await submitReviewDecision({
      db: c.db,
      appHome: c.appHome,
      nodeRunId: rev!.id,
      decision: 'approved',
      expectedReviewIteration: rev!.reviewIteration,
    })
    await reenterScheduler(c.db, task.id)
    await runTask({ taskId: task.id, db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd() })

    expect({
      status: await taskStatus(c.db, task.id),
      spurious: (await awaitingReviewRun(c.db, task.id, 'rev'))?.id ?? null,
    }).toEqual({ status: 'done', spurious: null })
    // RFC-W001: loop wrapper + inner clarify + post-loop agent + review ->
    // multiple mock-opencode spawns, >5s on Windows CI; raise per-test timeout.
  }, 60_000)

  // ---------------------------------------------------------------------------
  // S15 — cross-clarify + review (Layer A cascade mechanism, distinct from the
  // Layer B path S3/S6/S8 hit). questioner asks the designer; after continue,
  // designer reruns and the cascade re-mints downstream. Invariant: the task
  // converges to `done` after the legit re-reviews and never `failed`.
  // ---------------------------------------------------------------------------
  test('S15 cross-clarify + review: converges to done, never fails with internal inconsistency', async () => {
    await makeDesigner(c, 'designer', ['doc'])
    await makeDesigner(c, 'questioner', ['qdoc'])
    // designer: v1, then (after external feedback) v2.
    // questioner: first run asks cross-clarify, then outputs.
    writePlan(c, {
      designer: [
        { output: { doc: 'D_V1' } },
        { output: { doc: 'D_V2' } },
        { output: { doc: 'D_V3' } },
      ],
      questioner: [
        { clarify: CLARIFY_BODY },
        { output: { qdoc: 'Q_OUT' } },
        { output: { qdoc: 'Q_OUT2' } },
      ],
    })
    const def: WorkflowDefinition = {
      $schema_version: 3,
      inputs: [{ kind: 'text', key: 'req', label: 'r' }],
      nodes: [
        { id: 'in1', kind: 'input', inputKey: 'req' },
        { id: 'designer', kind: 'agent-single', agentName: 'designer' },
        {
          id: 'rev1',
          kind: 'review',
          inputSource: { nodeId: 'designer', portName: 'doc' },
          rerunnableOnIterate: ['designer'],
          rerunnableOnReject: ['designer'],
        },
        { id: 'questioner', kind: 'agent-single', agentName: 'questioner' },
        { id: 'cross1', kind: 'clarify-cross-agent' },
        {
          id: 'out',
          kind: 'output',
          ports: [{ name: 'final', bind: { nodeId: 'questioner', portName: 'qdoc' } }],
        },
      ] as unknown as WorkflowDefinition['nodes'],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'in1', portName: 'req' },
          target: { nodeId: 'designer', portName: 'req' },
        },
        {
          id: 'e2',
          source: { nodeId: 'designer', portName: 'doc' },
          target: { nodeId: 'rev1', portName: '__review_input__' },
        },
        {
          id: 'e3',
          source: { nodeId: 'rev1', portName: 'approved_doc' },
          target: { nodeId: 'questioner', portName: 'req' },
        },
        {
          id: 'e4',
          source: { nodeId: 'questioner', portName: '__clarify__' },
          target: { nodeId: 'cross1', portName: 'questions' },
        },
        {
          id: 'e5',
          source: { nodeId: 'cross1', portName: 'to_designer' },
          target: { nodeId: 'designer', portName: '__external_feedback__' },
        },
        {
          id: 'e6',
          source: { nodeId: 'cross1', portName: 'to_questioner' },
          // canonical answer-injection target is `__clarify_response__` (was a
          // copy-paste `__external_feedback__`; both are stripped identically by
          // buildScopeUpstreams so runtime is unchanged, but the launch-time
          // validator now rejects the non-canonical shape — see
          // workflow-validator-system-port-edges.test.ts).
          target: { nodeId: 'questioner', portName: '__clarify_response__' },
        },
      ],
    }
    const wf = await createWorkflow(c.db, { name: 's15', description: '', definition: def })
    const task = await startTask(
      {
        workflowId: wf.id,
        name: 's15',
        repoPath: c.repoPath,
        baseBranch: 'main',
        inputs: { req: 'x' },
      },
      { db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd(), awaitScheduler: true },
    )
    // designer v1 → rev1 awaiting. approve.
    const rev1 = await awaitingReviewRun(c.db, task.id, 'rev1')
    expect(rev1).toBeDefined()
    await submitReviewDecision({
      db: c.db,
      appHome: c.appHome,
      nodeRunId: rev1!.id,
      decision: 'approved',
      expectedReviewIteration: 0,
    })
    await reenterScheduler(c.db, task.id)
    await runTask({ taskId: task.id, db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd() })
    // questioner ran and asked cross-clarify → awaiting_human
    expect(await taskStatus(c.db, task.id)).toBe('awaiting_human')

    // answer cross-clarify with continue → designer reruns + cascade
    const ccRows = await c.db
      .select()
      .from(crossClarifySessions)
      .where(
        and(
          eq(crossClarifySessions.taskId, task.id),
          eq(crossClarifySessions.status, 'awaiting_human'),
        ),
      )
    expect(ccRows.length).toBe(1)
    await autoDispatchClarifyRound({
      db: c.db,
      originNodeRunId: ccRows[0]!.crossClarifyNodeRunId,
      answers: [CLARIFY_ANSWER],
      directive: 'stop',
      actor,
    })
    // Drive the scheduler to a fixed point: resume up to a few times, approving
    // any review that re-opens (legit: designer changed). Bounded loop.
    let guard = 0
    while (guard++ < 8) {
      await reenterScheduler(c.db, task.id)
      await runTask({ taskId: task.id, db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd() })
      const st = await taskStatus(c.db, task.id)
      if (st === 'done' || st === 'failed') break
      if (st === 'awaiting_review') {
        const r = await awaitingReviewRun(c.db, task.id, 'rev1')
        if (r) {
          await submitReviewDecision({
            db: c.db,
            appHome: c.appHome,
            nodeRunId: r.id,
            decision: 'approved',
            expectedReviewIteration: r.reviewIteration,
          })
          continue
        }
        break
      }
      if (st === 'awaiting_human') break // unexpected second clarify (stop should end it)
    }

    const finalStatus = await taskStatus(c.db, task.id)
    const failedRun = (await c.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, task.id))).find(
      (r) => r.status === 'failed',
    )
    expect({ finalStatus, failedReason: failedRun?.errorMessage ?? null }).toEqual({
      finalStatus: 'done',
      failedReason: null,
    })
  })

  // ---------------------------------------------------------------------------
  // S16 — multi-review pipeline: designer → rev1 → builder → rev2. Iterating
  // rev1 must propagate v2 through to builder; rev2 reviews builder's v2 output;
  // approving both ends clean with no spurious re-open.
  // ---------------------------------------------------------------------------
  test('S16 multi-review pipeline: iterate rev1 → approve → builder → approve rev2 ends clean', async () => {
    await makeDesigner(c)
    await makeDesigner(c, 'builder', ['build'])
    writePlan(c, {
      designer: [{ output: { design: 'DESIGN_V1' } }, { output: { design: 'DESIGN_V2' } }],
      builder: [{ output: { build: 'BUILT_FROM_V2' } }],
    })
    const def: WorkflowDefinition = {
      $schema_version: 2,
      inputs: [{ kind: 'text', key: 'topic', label: 't' }],
      nodes: [
        { id: 'in1', kind: 'input', inputKey: 'topic' },
        { id: 'designer', kind: 'agent-single', agentName: 'designer' },
        {
          id: 'rev1',
          kind: 'review',
          inputSource: { nodeId: 'designer', portName: 'design' },
          rerunnableOnIterate: ['designer'],
          rerunnableOnReject: ['designer'],
        },
        { id: 'builder', kind: 'agent-single', agentName: 'builder' },
        {
          id: 'rev2',
          kind: 'review',
          inputSource: { nodeId: 'builder', portName: 'build' },
          rerunnableOnIterate: ['builder'],
          rerunnableOnReject: ['builder'],
        },
      ] as WorkflowNode[],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'in1', portName: 'topic' },
          target: { nodeId: 'designer', portName: 'topic' },
        },
        {
          id: 'e2',
          source: { nodeId: 'designer', portName: 'design' },
          target: { nodeId: 'rev1', portName: '__review_input__' },
        },
        {
          id: 'e3',
          source: { nodeId: 'rev1', portName: 'approved_doc' },
          target: { nodeId: 'builder', portName: 'doc' },
        },
        {
          id: 'e4',
          source: { nodeId: 'builder', portName: 'build' },
          target: { nodeId: 'rev2', portName: '__review_input__' },
        },
      ],
    }
    const wf = await createWorkflow(c.db, { name: 's16', description: '', definition: def })
    const task = await startTask(
      {
        workflowId: wf.id,
        name: 's16',
        repoPath: c.repoPath,
        baseBranch: 'main',
        inputs: { topic: 'x' },
      },
      { db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd(), awaitScheduler: true },
    )
    const rev1a = await awaitingReviewRun(c.db, task.id, 'rev1')
    expect(rev1a).toBeDefined()
    await addReviewComment({
      db: c.db,
      appHome: c.appHome,
      nodeRunId: rev1a!.id,
      anchor: {
        sectionPath: '#',
        paragraphIdx: 0,
        offsetStart: 0,
        offsetEnd: 3,
        selectedText: 'DES',
        contextBefore: '',
        contextAfter: '',
        occurrenceIndex: 1,
      },
      commentText: 'revise',
    })
    await submitReviewDecision({
      db: c.db,
      appHome: c.appHome,
      nodeRunId: rev1a!.id,
      decision: 'iterated',
      expectedReviewIteration: 0,
    })
    await reenterScheduler(c.db, task.id)
    await runTask({ taskId: task.id, db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd() })

    const rev1b = await awaitingReviewRun(c.db, task.id, 'rev1')
    expect(rev1b).toBeDefined()
    await submitReviewDecision({
      db: c.db,
      appHome: c.appHome,
      nodeRunId: rev1b!.id,
      decision: 'approved',
      expectedReviewIteration: 1,
    })
    await reenterScheduler(c.db, task.id)
    await runTask({ taskId: task.id, db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd() })

    const rev2 = await awaitingReviewRun(c.db, task.id, 'rev2')
    expect(rev2).toBeDefined()
    await submitReviewDecision({
      db: c.db,
      appHome: c.appHome,
      nodeRunId: rev2!.id,
      decision: 'approved',
      expectedReviewIteration: rev2!.reviewIteration,
    })
    await reenterScheduler(c.db, task.id)
    await runTask({ taskId: task.id, db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd() })

    const spurious1 = await awaitingReviewRun(c.db, task.id, 'rev1')
    const spurious2 = await awaitingReviewRun(c.db, task.id, 'rev2')
    expect({
      status: await taskStatus(c.db, task.id),
      s1: spurious1?.id ?? null,
      s2: spurious2?.id ?? null,
    }).toEqual({ status: 'done', s1: null, s2: null })
    // RFC-W001: multi-review pipeline (iterate rev1 -> builder -> rev2) spawns
    // several mock-opencode runs, >5s on Windows CI; raise per-test timeout.
  }, 60_000)

  // ---------------------------------------------------------------------------
  // S17 — process crash then retry (RFC-042, same row) → review. A crashed-then-
  // recovered agent must produce a clean single done row + review approves once.
  // ---------------------------------------------------------------------------
  test('S17 crash-then-retry agent → review approves cleanly (single done row)', async () => {
    await makeDesigner(c)
    writePlan(c, { designer: [{ crash: true }, { output: { design: 'DESIGN_V1' } }] })
    const def: WorkflowDefinition = {
      $schema_version: 2,
      inputs: [{ kind: 'text', key: 'topic', label: 't' }],
      nodes: [
        { id: 'in1', kind: 'input', inputKey: 'topic' },
        { id: 'designer', kind: 'agent-single', agentName: 'designer' },
        {
          id: 'rev',
          kind: 'review',
          inputSource: { nodeId: 'designer', portName: 'design' },
          rerunnableOnIterate: ['designer'],
          rerunnableOnReject: ['designer'],
        },
      ] as WorkflowNode[],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'in1', portName: 'topic' },
          target: { nodeId: 'designer', portName: 'topic' },
        },
        {
          id: 'e2',
          source: { nodeId: 'designer', portName: 'design' },
          target: { nodeId: 'rev', portName: '__review_input__' },
        },
      ],
    }
    const wf = await createWorkflow(c.db, { name: 's17', description: '', definition: def })
    const task = await startTask(
      {
        workflowId: wf.id,
        name: 's17',
        repoPath: c.repoPath,
        baseBranch: 'main',
        inputs: { topic: 'x' },
      },
      { db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd(), awaitScheduler: true },
    )
    const rev = await awaitingReviewRun(c.db, task.id, 'rev')
    expect(rev).toBeDefined()
    const designerDone = (await topLevel(c.db, task.id, 'designer')).filter(
      (r) => r.status === 'done',
    )
    await submitReviewDecision({
      db: c.db,
      appHome: c.appHome,
      nodeRunId: rev!.id,
      decision: 'approved',
      expectedReviewIteration: 0,
    })
    await reenterScheduler(c.db, task.id)
    await runTask({ taskId: task.id, db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd() })

    expect({
      status: await taskStatus(c.db, task.id),
      designerDoneRows: designerDone.length,
      spurious: (await awaitingReviewRun(c.db, task.id, 'rev'))?.id ?? null,
    }).toEqual({
      status: 'done',
      designerDoneRows: 1,
      spurious: null,
    })
  })

  // ---------------------------------------------------------------------------
  // S18 — two independent branches A(clarify)→revA and B→revB. A's clarify must
  // not interfere with B's branch; both approve cleanly.
  // ---------------------------------------------------------------------------
  test('S18 parallel branches: clarify on branch A does not interfere with branch B review', async () => {
    await makeDesigner(c, 'agentA', ['a'])
    await makeDesigner(c, 'agentB', ['b'])
    writePlan(c, {
      agentA: [{ clarify: CLARIFY_BODY }, { output: { a: 'A_OUT' } }],
      agentB: [{ output: { b: 'B_OUT' } }],
    })
    const def: WorkflowDefinition = {
      $schema_version: 2,
      inputs: [{ kind: 'text', key: 'topic', label: 't' }],
      nodes: [
        { id: 'in1', kind: 'input', inputKey: 'topic' },
        { id: 'agentA', kind: 'agent-single', agentName: 'agentA' },
        { id: 'clr', kind: 'clarify', title: 'c' },
        {
          id: 'revA',
          kind: 'review',
          inputSource: { nodeId: 'agentA', portName: 'a' },
          rerunnableOnIterate: ['agentA'],
          rerunnableOnReject: ['agentA'],
        },
        { id: 'agentB', kind: 'agent-single', agentName: 'agentB' },
        {
          id: 'revB',
          kind: 'review',
          inputSource: { nodeId: 'agentB', portName: 'b' },
          rerunnableOnIterate: ['agentB'],
          rerunnableOnReject: ['agentB'],
        },
      ] as WorkflowNode[],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'in1', portName: 'topic' },
          target: { nodeId: 'agentA', portName: 'topic' },
        },
        {
          id: 'e2',
          source: { nodeId: 'agentA', portName: '__clarify__' },
          target: { nodeId: 'clr', portName: 'questions' },
        },
        {
          id: 'e3',
          source: { nodeId: 'clr', portName: 'answers' },
          target: { nodeId: 'agentA', portName: '__clarify_response__' },
        },
        {
          id: 'e4',
          source: { nodeId: 'agentA', portName: 'a' },
          target: { nodeId: 'revA', portName: '__review_input__' },
        },
        {
          id: 'e5',
          source: { nodeId: 'in1', portName: 'topic' },
          target: { nodeId: 'agentB', portName: 'topic' },
        },
        {
          id: 'e6',
          source: { nodeId: 'agentB', portName: 'b' },
          target: { nodeId: 'revB', portName: '__review_input__' },
        },
      ],
    }
    const wf = await createWorkflow(c.db, { name: 's18', description: '', definition: def })
    const task = await startTask(
      {
        workflowId: wf.id,
        name: 's18',
        repoPath: c.repoPath,
        baseBranch: 'main',
        inputs: { topic: 'x' },
      },
      { db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd(), awaitScheduler: true },
    )
    // A asked clarify; B should already be awaiting_review.
    await autoDispatchClarifyRound({
      db: c.db,
      originNodeRunId: await openClarifyRunId(c.db, task.id),
      answers: [CLARIFY_ANSWER],
      // RFC-100: stop = finalize round so the post-answer rerun's <workflow-output> is accepted.
      directive: 'stop',
      actor,
    })
    await reenterScheduler(c.db, task.id)
    await runTask({ taskId: task.id, db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd() })

    const revA = await awaitingReviewRun(c.db, task.id, 'revA')
    const revB = await awaitingReviewRun(c.db, task.id, 'revB')
    expect(revA && revB).toBeTruthy()
    await submitReviewDecision({
      db: c.db,
      appHome: c.appHome,
      nodeRunId: revA!.id,
      decision: 'approved',
      expectedReviewIteration: revA!.reviewIteration,
    })
    await submitReviewDecision({
      db: c.db,
      appHome: c.appHome,
      nodeRunId: revB!.id,
      decision: 'approved',
      expectedReviewIteration: revB!.reviewIteration,
    })
    await reenterScheduler(c.db, task.id)
    await runTask({ taskId: task.id, db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd() })

    expect({
      status: await taskStatus(c.db, task.id),
      sA: (await awaitingReviewRun(c.db, task.id, 'revA'))?.id ?? null,
      sB: (await awaitingReviewRun(c.db, task.id, 'revB'))?.id ?? null,
    }).toEqual({ status: 'done', sA: null, sB: null })
  })

  // ---------------------------------------------------------------------------
  // S19 — fanout → post-fanout agent → review. Locks that the wrapper's shard /
  // aggregator children (parentNodeRunId set) don't break the downstream review,
  // and approve completes cleanly.
  // ---------------------------------------------------------------------------
  // DEFERRED (not a product bug): the fanout wrapper's shardSource/outlet ports
  // need validator-compliant declarations that the runtime-only fanout e2e test
  // bypasses via direct seed. The "wrapper inner/child rows (parentNodeRunId set)
  // don't break a downstream review" property is already locked structurally by
  // S13 (loop wrapper → builder → review). Revisit with a direct-seed harness if
  // fanout-specific provenance needs its own lock.
  test.skip('S19 fanout → builder → review approves cleanly (shard children excluded)', async () => {
    await createAgent(c.db, {
      name: 'worker',
      description: '',
      outputs: ['result'],
      outputKinds: { result: 'markdown' },
      syncOutputsOnIterate: false,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: '',
    })
    await createAgent(c.db, {
      name: 'agg',
      description: '',
      outputs: ['result'],
      outputKinds: { result: 'markdown' },
      syncOutputsOnIterate: false,
      role: 'aggregator',
      outputWrapperPortNames: { result: 'final' },
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: '',
    })
    await makeDesigner(c, 'builder', ['build'])
    writePlan(c, {
      worker: [{ output: { result: 'processed' } }],
      agg: [{ output: { result: 'MERGED' } }],
      builder: [{ output: { build: 'BUILT' } }],
    })
    const def: WorkflowDefinition = {
      $schema_version: 4,
      inputs: [{ kind: 'text', key: 'docs', label: 'docs' }],
      nodes: [
        { id: 'inp', kind: 'input', inputKey: 'docs' },
        {
          id: 'fan',
          kind: 'wrapper-fanout',
          nodeIds: ['inner', 'aggNode'],
          inputs: [{ name: 'docs', kind: 'list<path<md>>', isShardSource: true }],
        },
        {
          id: 'inner',
          kind: 'agent-single',
          agentName: 'worker',
          promptTemplate: 'Process {{doc}}',
        },
        {
          id: 'aggNode',
          kind: 'agent-single',
          agentName: 'agg',
          promptTemplate: 'Merge {{items}}',
        },
        { id: 'builder', kind: 'agent-single', agentName: 'builder' },
        {
          id: 'rev',
          kind: 'review',
          inputSource: { nodeId: 'builder', portName: 'build' },
          rerunnableOnIterate: ['builder'],
          rerunnableOnReject: ['builder'],
        },
      ] as unknown as WorkflowDefinition['nodes'],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'inp', portName: 'docs' },
          target: { nodeId: 'fan', portName: 'docs' },
        },
        {
          id: 'eB',
          source: { nodeId: 'fan', portName: 'docs' },
          target: { nodeId: 'inner', portName: 'doc' },
          boundary: 'wrapper-input',
        },
        {
          id: 'eAgg',
          source: { nodeId: 'inner', portName: 'result' },
          target: { nodeId: 'aggNode', portName: 'items' },
        },
        {
          id: 'eOut',
          source: { nodeId: 'fan', portName: 'final' },
          target: { nodeId: 'builder', portName: 'doc' },
        },
        {
          id: 'eRev',
          source: { nodeId: 'builder', portName: 'build' },
          target: { nodeId: 'rev', portName: '__review_input__' },
        },
      ],
    }
    const wf = await createWorkflow(c.db, { name: 's19', description: '', definition: def })
    const task = await startTask(
      {
        workflowId: wf.id,
        name: 's19',
        repoPath: c.repoPath,
        baseBranch: 'main',
        inputs: { docs: 'a.md\nb.md' },
      },
      { db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd(), awaitScheduler: true },
    )
    const rev = await awaitingReviewRun(c.db, task.id, 'rev')
    expect(rev).toBeDefined()
    await submitReviewDecision({
      db: c.db,
      appHome: c.appHome,
      nodeRunId: rev!.id,
      decision: 'approved',
      expectedReviewIteration: rev!.reviewIteration,
    })
    await reenterScheduler(c.db, task.id)
    await runTask({ taskId: task.id, db: c.db, appHome: c.appHome, opencodeCmd: opencodeCmd() })

    expect({
      status: await taskStatus(c.db, task.id),
      spurious: (await awaitingReviewRun(c.db, task.id, 'rev'))?.id ?? null,
    }).toEqual({ status: 'done', spurious: null })
  })
})

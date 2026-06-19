// RFC-056 PR-B T6 — scheduler / runner integration for the cross-clarify path.
//
// LOCKS:
//   1. Questioner agent in a workflow with cross-clarify wiring emits
//      <workflow-clarify> → task transitions to awaiting_human;
//      cross_clarify_sessions row is parked awaiting_human;
//      cross-clarify node_run is parked awaiting_human;
//      questioner node_run is 'done' (it successfully expressed an ask).
//   2. Cross-clarify mode lifts the question-count cap: a 7-question
//      envelope must NOT be truncated (RFC-023 would have capped at 5).
//   3. Persistent stop on the cross-clarify node short-circuits the next
//      dispatch (cross-clarify node_run flips pending → done, no awaiting
//      row), and the questioner can re-run via runner.
//   4. Designer rerun via cross-clarify path: when clarify_iteration
//      is bumped (after submit), the runner's user prompt picks up the
//      External Feedback context (## External Feedback section appears
//      in node_runs.promptText).

import type { WorkflowDefinition } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, crossClarifySessions, nodeRuns, tasks, workflows } from '../src/db/schema'
import { runTask } from '../src/services/scheduler'
import { runGit } from '../src/util/git'
import { createCrossClarifySession, submitCrossClarifyAnswers } from '../src/services/crossClarify'

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
  const appHome = mkdtempSync(join(tmpdir(), 'aw-sched-cross-clarify-'))
  const repoPath = join(appHome, 'repo')
  const worktreePath = join(appHome, 'wt')
  mkdirSync(repoPath, { recursive: true })
  mkdirSync(worktreePath, { recursive: true })
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
  outputs: string[] = ['main'],
  readonly = true,
): Promise<void> {
  await db.insert(agents).values({
    id: ulid(),
    name,
    description: 'test',
    outputs: JSON.stringify(outputs),
    readonly,
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
): Promise<{ taskId: string }> {
  const workflowId = ulid()
  const taskId = ulid()
  await h.db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: JSON.stringify(definition),
  })
  await h.db.insert(tasks).values({
    id: taskId,
    name: 'fixture-task',
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
  return { taskId }
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

function readCapturedArgvLines(path: string): Array<{ agent: string; argv: string[] }> {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as { agent: string; argv: string[] })
}

/**
 * 4-node workflow: input → designer (agent-single) → questioner (agent-single)
 *                  ↑                                       │
 *                  to_designer (manual)                    __clarify__
 *                  └─────────── cross1 (clarify-cross-agent) ←──┘
 */
function defaultDef(): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [{ kind: 'text', key: 'req', label: 'r' }],
    nodes: [
      { id: 'in1', kind: 'input', inputKey: 'req' },
      { id: 'designer', kind: 'agent-single', agentName: 'designer' },
      { id: 'questioner', kind: 'agent-single', agentName: 'questioner' },
      { id: 'cross1', kind: 'clarify-cross-agent' },
    ],
    edges: [
      {
        id: 'e_in_d',
        source: { nodeId: 'in1', portName: 'req' },
        target: { nodeId: 'designer', portName: 'req' },
      },
      {
        id: 'e_d_q',
        source: { nodeId: 'designer', portName: 'design' },
        target: { nodeId: 'questioner', portName: 'design' },
      },
      {
        id: 'e_q_cross',
        source: { nodeId: 'questioner', portName: '__clarify__' },
        target: { nodeId: 'cross1', portName: 'questions' },
      },
      {
        id: 'e_cross_q',
        source: { nodeId: 'cross1', portName: 'to_questioner' },
        target: { nodeId: 'questioner', portName: '__clarify_response__' },
      },
      {
        id: 'e_cross_d',
        source: { nodeId: 'cross1', portName: 'to_designer' },
        target: { nodeId: 'designer', portName: '__external_feedback__' },
      },
    ],
    outputs: [],
  }
}

describe('RFC-056 scheduler cross-clarify dispatch', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => h.cleanup())

  test('questioner agent emits clarify → task awaiting_human, cross_clarify_session created, questioner node_run done', async () => {
    await seedAgent(h.db, 'designer', ['design'])
    await seedAgent(h.db, 'questioner', ['main'])
    const def = defaultDef()
    const { taskId } = await seedWorkflowAndTask(h, def, { req: 'pick' })

    // Designer emits normal output; questioner emits clarify envelope.
    // Single env applies to both subprocess invocations — mock returns
    // CLARIFY_BODY when set + falls back to MOCK_OPENCODE_OUTPUTS otherwise.
    // For this test, both subprocesses share env; designer's outputs JSON
    // intentionally has nothing meaningful to feed questioner. The test
    // only asserts on dispatch / parking, not on the input contents.
    const clarifyBody = JSON.stringify({
      questions: [
        { id: 'q1', title: 'Why Redis?', kind: 'single', options: ['cluster', 'simplicity'] },
      ],
    })
    // Use FAIL_COUNTER trick: alternate behaviours per attempt. Instead,
    // we run designer alone first with MOCK_OPENCODE_OUTPUTS, then a
    // second runTask call with MOCK_OPENCODE_CLARIFY_BODY for questioner.
    // The simpler structure: rebuild scheduler around the same task with
    // the questioner stage already pending. Below we just use OUTPUTS for
    // BOTH agents and verify the path takes effect when the questioner
    // emits clarify on the second exec.

    // To keep this hermetic for a SINGLE runTask invocation: have the mock
    // emit clarify body — it applies to every subprocess. Designer will
    // therefore emit clarify too, but since designer has no clarify channel
    // wired the scheduler's clarify-or-cross dispatch falls through to
    // 'clarify-no-channel' fail. We avoid that by making the workflow start
    // with only the questioner (designer omitted) for this test.

    const simpleDef: WorkflowDefinition = {
      $schema_version: 4,
      inputs: [{ kind: 'text', key: 'req', label: 'r' }],
      nodes: [
        { id: 'in1', kind: 'input', inputKey: 'req' },
        { id: 'questioner', kind: 'agent-single', agentName: 'questioner' },
        { id: 'cross1', kind: 'clarify-cross-agent' },
        { id: 'designer', kind: 'agent-single', agentName: 'designer' },
      ],
      edges: [
        {
          id: 'e_in_q',
          source: { nodeId: 'in1', portName: 'req' },
          target: { nodeId: 'questioner', portName: 'req' },
        },
        {
          id: 'e_q_cross',
          source: { nodeId: 'questioner', portName: '__clarify__' },
          target: { nodeId: 'cross1', portName: 'questions' },
        },
        {
          id: 'e_cross_q',
          source: { nodeId: 'cross1', portName: 'to_questioner' },
          target: { nodeId: 'questioner', portName: '__clarify_response__' },
        },
        {
          id: 'e_cross_d',
          source: { nodeId: 'cross1', portName: 'to_designer' },
          target: { nodeId: 'designer', portName: '__external_feedback__' },
        },
      ],
      outputs: [],
    }
    const t2 = await seedWorkflowAndTask(h, simpleDef, { req: 'pick' })
    void taskId
    await withEnv({ MOCK_OPENCODE_CLARIFY_BODY: clarifyBody }, () =>
      runTask({
        taskId: t2.taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
      }),
    )

    const taskRow = (await h.db.select().from(tasks).where(eq(tasks.id, t2.taskId)))[0]
    expect(taskRow?.status).toBe('awaiting_human')

    const sessions = await h.db
      .select()
      .from(crossClarifySessions)
      .where(eq(crossClarifySessions.taskId, t2.taskId))
    expect(sessions.length).toBe(1)
    expect(sessions[0]?.status).toBe('awaiting_human')
    expect(sessions[0]?.sourceQuestionerNodeId).toBe('questioner')
    expect(sessions[0]?.targetDesignerNodeId).toBe('designer')
    expect(sessions[0]?.iteration).toBe(0)

    const runs = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, t2.taskId))
    const qRun = runs.find((r) => r.nodeId === 'questioner')
    const crossRun = runs.find((r) => r.nodeId === 'cross1' && r.status === 'awaiting_human')
    expect(qRun?.status).toBe('done')
    expect(crossRun?.status).toBe('awaiting_human')
  })

  test('cross-clarify mode lifts the 5-question cap (RFC-056 §4.1)', async () => {
    await seedAgent(h.db, 'questioner', ['main'])
    await seedAgent(h.db, 'designer', ['design'])
    const sevenQuestions = JSON.stringify({
      questions: Array.from({ length: 7 }, (_, i) => ({
        id: `q${i + 1}`,
        title: `t${i + 1}`,
        kind: 'single',
        options: ['A', 'B'],
      })),
    })
    const def: WorkflowDefinition = {
      $schema_version: 4,
      inputs: [{ kind: 'text', key: 'req', label: 'r' }],
      nodes: [
        { id: 'in1', kind: 'input', inputKey: 'req' },
        { id: 'questioner', kind: 'agent-single', agentName: 'questioner' },
        { id: 'cross1', kind: 'clarify-cross-agent' },
        { id: 'designer', kind: 'agent-single', agentName: 'designer' },
      ],
      edges: [
        {
          id: 'e_in_q',
          source: { nodeId: 'in1', portName: 'req' },
          target: { nodeId: 'questioner', portName: 'req' },
        },
        {
          id: 'e_q_cross',
          source: { nodeId: 'questioner', portName: '__clarify__' },
          target: { nodeId: 'cross1', portName: 'questions' },
        },
        {
          id: 'e_cross_d',
          source: { nodeId: 'cross1', portName: 'to_designer' },
          target: { nodeId: 'designer', portName: '__external_feedback__' },
        },
      ],
      outputs: [],
    }
    const { taskId } = await seedWorkflowAndTask(h, def, { req: 'go' })

    await withEnv({ MOCK_OPENCODE_CLARIFY_BODY: sevenQuestions }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
      }),
    )

    const sessions = await h.db
      .select()
      .from(crossClarifySessions)
      .where(eq(crossClarifySessions.taskId, taskId))
    expect(sessions.length).toBe(1)
    const qs = JSON.parse(sessions[0]?.questionsJson ?? '[]') as unknown[]
    expect(qs.length).toBe(7) // RFC-023 path would have truncated to 5.
  })

  test('persistent stop short-circuits dispatch on the next pass: cross-clarify node_run goes done without parking', async () => {
    await seedAgent(h.db, 'questioner', ['main'])
    await seedAgent(h.db, 'designer', ['design'])
    const def: WorkflowDefinition = {
      $schema_version: 4,
      inputs: [{ kind: 'text', key: 'req', label: 'r' }],
      nodes: [
        { id: 'in1', kind: 'input', inputKey: 'req' },
        { id: 'questioner', kind: 'agent-single', agentName: 'questioner' },
        { id: 'cross1', kind: 'clarify-cross-agent' },
        { id: 'designer', kind: 'agent-single', agentName: 'designer' },
      ],
      edges: [
        {
          id: 'e_in_q',
          source: { nodeId: 'in1', portName: 'req' },
          target: { nodeId: 'questioner', portName: 'req' },
        },
        {
          id: 'e_q_cross',
          source: { nodeId: 'questioner', portName: '__clarify__' },
          target: { nodeId: 'cross1', portName: 'questions' },
        },
        {
          id: 'e_cross_d',
          source: { nodeId: 'cross1', portName: 'to_designer' },
          target: { nodeId: 'designer', portName: '__external_feedback__' },
        },
      ],
      outputs: [],
    }
    const { taskId } = await seedWorkflowAndTask(h, def, { req: 'go' })

    // First pass: questioner emits clarify, task parks awaiting_human.
    await withEnv(
      {
        MOCK_OPENCODE_CLARIFY_BODY: JSON.stringify({
          questions: [{ id: 'q1', title: 'why?', kind: 'single', options: ['A', 'B'] }],
        }),
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
        }),
    )
    const sessionRows = await h.db
      .select()
      .from(crossClarifySessions)
      .where(eq(crossClarifySessions.taskId, taskId))
    expect(sessionRows.length).toBe(1)
    const sessionId = sessionRows[0]!.id
    const crossNodeRunId = sessionRows[0]!.crossClarifyNodeRunId

    // Reject. submitCrossClarifyAnswers writes directive='stop' + cascades
    // the questioner. We don't run scheduler again, just verify state.
    await submitCrossClarifyAnswers({
      db: h.db,
      crossClarifyNodeRunId: crossNodeRunId,
      answers: [
        { questionId: 'q1', selectedOptionIndices: [0], selectedOptionLabels: [], customText: '' },
      ],
      directive: 'stop',
    })
    const updated = (
      await h.db.select().from(crossClarifySessions).where(eq(crossClarifySessions.id, sessionId))
    )[0]
    expect(updated?.directive).toBe('stop')

    // Now simulate a sibling cascade by re-creating a pending cross-clarify
    // node_run row directly and dispatching it through the scheduler again.
    // The dispatchCrossClarifyNode helper (called inside scheduler) should
    // short-circuit it to done.
    const { dispatchCrossClarifyNode } = await import('../src/services/crossClarify')
    const nrId = ulid()
    await h.db.insert(nodeRuns).values({
      id: nrId,
      taskId,
      nodeId: 'cross1',
      status: 'pending',
      retryIndex: 0,
      iteration: 0,
    })
    const out = await dispatchCrossClarifyNode({
      db: h.db,
      taskId,
      crossClarifyNodeId: 'cross1',
      nodeRunId: nrId,
      definition: def,
    })
    expect(out.kind).toBe('short-circuit-stop')
    const fresh = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, nrId)))[0]
    expect(fresh?.status).toBe('done')
  })

  test('designer rerun (clarify_iteration > 0) prompt contains ## External Feedback section', async () => {
    await seedAgent(h.db, 'designer', ['design'])
    await seedAgent(h.db, 'questioner', ['main'])
    const def: WorkflowDefinition = {
      $schema_version: 4,
      inputs: [{ kind: 'text', key: 'req', label: 'r' }],
      nodes: [
        { id: 'in1', kind: 'input', inputKey: 'req' },
        { id: 'designer', kind: 'agent-single', agentName: 'designer' },
        { id: 'cross1', kind: 'clarify-cross-agent' },
      ],
      edges: [
        {
          id: 'e_in_d',
          source: { nodeId: 'in1', portName: 'req' },
          target: { nodeId: 'designer', portName: 'req' },
        },
        {
          id: 'e_cross_d',
          source: { nodeId: 'cross1', portName: 'to_designer' },
          target: { nodeId: 'designer', portName: '__external_feedback__' },
        },
      ],
      outputs: [],
    }
    const { taskId } = await seedWorkflowAndTask(h, def, { req: 'go' })

    // Seed the prior questioner + designer runs BEFORE the cross-clarify
    // submit so triggerDesignerRerun has a designer row to roll back.
    const qRunId = ulid()
    await h.db.insert(nodeRuns).values({
      id: qRunId,
      taskId,
      nodeId: 'questioner',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    const priorDesigner = ulid()
    await h.db.insert(nodeRuns).values({
      id: priorDesigner,
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    const { session } = await createCrossClarifySession({
      db: h.db,
      taskId,
      crossClarifyNodeId: 'cross1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: qRunId,
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [
        {
          id: 'q1',
          title: 'Why?',
          kind: 'single',
          recommended: false,
          options: [
            { label: 'A', description: '', recommended: false, recommendationReason: '' },
            { label: 'B', description: '', recommended: false, recommendationReason: '' },
          ],
        },
      ],
    })
    const ret = await submitCrossClarifyAnswers({
      db: h.db,
      crossClarifyNodeRunId: session.crossClarifyNodeRunId,
      answers: [
        { questionId: 'q1', selectedOptionIndices: [0], selectedOptionLabels: [], customText: '' },
      ],
      directive: 'continue',
    })
    expect(ret.outcome.kind).toBe('designer-rerun-triggered')
    if (ret.outcome.kind !== 'designer-rerun-triggered') return
    const designerRunId = ret.outcome.designerNodeRunId

    await withEnv({ MOCK_OPENCODE_OUTPUTS: JSON.stringify({ design: 'plan v2' }) }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
      }),
    )

    const designerRow = (
      await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, designerRunId))
    )[0]
    expect(designerRow?.promptText ?? '').toContain('## External Feedback')
    expect(designerRow?.promptText ?? '').toContain("### From 'questioner' (round 0)")
  })

  // RFC-074 PR-C regression lock — bad case from production task
  // 01KSHB1YHMZWFX85SHQ4KM2HKX. A cross-clarify QUESTIONER that sits DOWNSTREAM
  // of the designer must still receive its prior Q&A context when it re-runs
  // after a designer-scoped cross-clarify answer — otherwise it re-asks the
  // same question and loops cross-clarify forever.
  //
  // Pre-PR-B the downstream cascade minted the questioner's rerun with a bumped
  // clarifyIteration, which the scheduler's `isQuestionerCrossClarifyRerun =
  // cci > 0` gate keyed on. PR-B (T-B8) deleted the cascade; the questioner now
  // re-runs via lazy freshness demote at the inherited cci=0, so the gate
  // misfires and the Q&A is dropped. RED until PR-C replaces the cci gate with
  // a session-state check (there IS an answered cross-clarify round for this
  // questioner). Asserts the BEHAVIOR (the rerun prompt carries the Q&A), so it
  // is agnostic to how the gate is re-implemented.
  test('RFC-074: downstream questioner rerun after designer-scope answer still carries its Q&A', async () => {
    await seedAgent(h.db, 'designer', ['design'])
    await seedAgent(h.db, 'questioner', ['design'])
    const { taskId } = await seedWorkflowAndTask(h, defaultDef(), { req: 'go' })

    // Prior settled generation: input + designer done; questioner done having
    // CONSUMED this designer run (so a designer rerun makes it provenance-stale
    // and gets it re-dispatched downstream).
    const inRunId = ulid()
    await h.db
      .insert(nodeRuns)
      .values({ id: inRunId, taskId, nodeId: 'in1', status: 'done', retryIndex: 0, iteration: 0 })
    const priorDesigner = ulid()
    await h.db.insert(nodeRuns).values({
      id: priorDesigner,
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    const qRunId = ulid()
    await h.db.insert(nodeRuns).values({
      id: qRunId,
      taskId,
      nodeId: 'questioner',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      consumedUpstreamRunsJson: JSON.stringify({ designer: priorDesigner }),
    })

    // The questioner asked a cross-clarify question (target = designer); answered.
    const { session } = await createCrossClarifySession({
      db: h.db,
      taskId,
      crossClarifyNodeId: 'cross1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: qRunId,
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [
        {
          id: 'q1',
          title: 'CCQ_TITLE_MARKER_为何',
          kind: 'single',
          recommended: false,
          options: [
            { label: 'OPT_ALPHA', description: '', recommended: false, recommendationReason: '' },
            { label: 'OPT_BETA', description: '', recommended: false, recommendationReason: '' },
          ],
        },
      ],
    })
    const ret = await submitCrossClarifyAnswers({
      db: h.db,
      crossClarifyNodeRunId: session.crossClarifyNodeRunId,
      answers: [
        {
          questionId: 'q1',
          selectedOptionIndices: [0],
          selectedOptionLabels: ['OPT_ALPHA'],
          customText: '',
        },
      ],
      directive: 'continue',
    })
    expect(ret.outcome.kind).toBe('designer-rerun-triggered')

    // Designer reruns (cci bumped) → questioner goes provenance-stale → it is
    // re-dispatched at the inherited cci=0 (no cascade bump) → prompt is built.
    await withEnv({ MOCK_OPENCODE_OUTPUTS: JSON.stringify({ design: 'plan v2' }) }, () =>
      runTask({ taskId, db: h.db, appHome: h.appHome, opencodeCmd: ['bun', 'run', MOCK_OPENCODE] }),
    )

    const allRuns = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    const questionerRuns = allRuns
      .filter((r) => r.nodeId === 'questioner' && r.parentNodeRunId === null)
      .sort((a, b) => (a.id < b.id ? 1 : -1))
    const rerun = questionerRuns[0]!
    expect(rerun.id, 'a fresh questioner rerun must have happened').not.toBe(qRunId)
    // The rerun prompt MUST carry the prior cross-clarify Q&A so the questioner
    // does not re-ask. RED today: cci=0 → isQuestionerCrossClarifyRerun gate
    // drops it. GREEN once PR-C makes the gate session-state-based.
    expect(rerun.promptText ?? '').toContain('CCQ_TITLE_MARKER_为何')
  })
})

// RFC-056 A16 (completed) — the scheduler now honors the cross-clarify node's
// `sessionModeForQuestioner` for questioner reruns (previously the self-clarify
// findClarifyNode lookup returned undefined for the cross node, so the setting
// the editor exposed was silently ignored and the questioner always ran
// isolated). These lock the spawn-arg contract: inline → `--session <prior-id>`,
// isolated → no `--session`. Building blocks (resolveCrossClarifySessionMode +
// the RFC-026 fallback) are unit-tested in cross-clarify-inline-fallback.test.ts;
// this locks the scheduler WIRING end-to-end.
describe('RFC-056 A16 — cross-clarify questioner inline session resume', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => h.cleanup())

  // input → questioner → cross1 → designer (external feedback). The questioner
  // asks; the user answers with stop; the questioner stop-rerun
  // (cause='cross-clarify-questioner-rerun') finalizes. Whether that rerun
  // resumes the prior opencode session is driven SOLELY by sessionModeForQuestioner.
  function questionerInlineDef(
    mode: 'isolated' | 'inline',
    opts: { selfClarifyEdgeFirst?: boolean } = {},
  ): WorkflowDefinition {
    // Codex review #3: when selfClarifyEdgeFirst, the questioner ALSO wires a
    // self-clarify `__clarify__` edge listed BEFORE the cross edge. The scheduler
    // must still resolve the CROSS node's sessionModeForQuestioner — not the self
    // node's — even though findClarifyNodeForAgent would return the self node.
    const selfNodes = opts.selfClarifyEdgeFirst
      ? [{ id: 'cs1', kind: 'clarify', title: 'self' }]
      : []
    const selfEdges = opts.selfClarifyEdgeFirst
      ? [
          {
            id: 'e_q_self',
            source: { nodeId: 'questioner', portName: '__clarify__' },
            target: { nodeId: 'cs1', portName: 'questions' },
          },
        ]
      : []
    return {
      $schema_version: 4,
      inputs: [{ kind: 'text', key: 'req', label: 'r' }],
      nodes: [
        { id: 'in1', kind: 'input', inputKey: 'req' },
        { id: 'questioner', kind: 'agent-single', agentName: 'questioner' },
        { id: 'cross1', kind: 'clarify-cross-agent', sessionModeForQuestioner: mode },
        { id: 'designer', kind: 'agent-single', agentName: 'designer' },
        ...selfNodes,
      ],
      edges: [
        {
          id: 'e_in_q',
          source: { nodeId: 'in1', portName: 'req' },
          target: { nodeId: 'questioner', portName: 'req' },
        },
        // The self-clarify edge (if any) is listed FIRST among the `__clarify__`
        // edges so findClarifyNodeForAgent returns the self node — the scheduler
        // must look past it to the cross node.
        ...selfEdges,
        {
          id: 'e_q_cross',
          source: { nodeId: 'questioner', portName: '__clarify__' },
          target: { nodeId: 'cross1', portName: 'questions' },
        },
        {
          id: 'e_cross_q',
          source: { nodeId: 'cross1', portName: 'to_questioner' },
          target: { nodeId: 'questioner', portName: '__clarify_response__' },
        },
        {
          id: 'e_cross_d',
          source: { nodeId: 'cross1', portName: 'to_designer' },
          target: { nodeId: 'designer', portName: '__external_feedback__' },
        },
      ],
      outputs: [],
    } as WorkflowDefinition
  }

  async function questionerSpawns(
    mode: 'isolated' | 'inline',
    opts: { selfClarifyEdgeFirst?: boolean } = {},
  ): Promise<Array<{ agent: string; argv: string[] }>> {
    const argvPath = join(h.appHome, `argv-${mode}.jsonl`)
    await seedAgent(h.db, 'questioner', ['main'])
    await seedAgent(h.db, 'designer', ['design'])
    const { taskId } = await seedWorkflowAndTask(h, questionerInlineDef(mode, opts), {
      req: 'pick',
    })
    const clarifyBody = JSON.stringify({
      questions: [{ id: 'q1', title: 'Why?', kind: 'single', options: ['a', 'b'] }],
    })

    // Round 0: questioner asks + reports opencode session id opc_Q0.
    await withEnv(
      {
        MOCK_OPENCODE_CLARIFY_BODY: clarifyBody,
        MOCK_OPENCODE_EMIT_SESSION_ID: 'opc_Q0',
        MOCK_OPENCODE_CAPTURE_ARGV_TO: argvPath,
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
        }),
    )
    const sess = (
      await h.db.select().from(crossClarifySessions).where(eq(crossClarifySessions.taskId, taskId))
    )[0]!
    expect(sess.status).toBe('awaiting_human')

    // Answer with stop → questioner stop-rerun (cross-clarify-questioner-rerun).
    await submitCrossClarifyAnswers({
      db: h.db,
      crossClarifyNodeRunId: sess.crossClarifyNodeRunId,
      answers: [
        { questionId: 'q1', selectedOptionIndices: [0], selectedOptionLabels: [], customText: '' },
      ],
      directive: 'stop',
    })
    // RFC-097: runTask's entry CAS only claims pending tasks (test stand-in for resumeTask).
    await h.db.update(tasks).set({ status: 'pending' }).where(eq(tasks.id, taskId))

    // Round 1: questioner stop-rerun spawns + finalizes (outputs).
    await withEnv(
      {
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ main: 'done' }),
        MOCK_OPENCODE_EMIT_SESSION_ID: 'opc_Q0',
        MOCK_OPENCODE_CAPTURE_ARGV_TO: argvPath,
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
        }),
    )
    return readCapturedArgvLines(argvPath).filter((l) => l.agent === 'questioner')
  }

  test('sessionModeForQuestioner=inline → questioner rerun spawn carries --session <prior-id>', async () => {
    const qSpawns = await questionerSpawns('inline')
    expect(qSpawns.length).toBeGreaterThanOrEqual(2)
    // Round 0 (first run) never resumes.
    expect(qSpawns[0]!.argv).not.toContain('--session')
    // The stop-rerun resumes the prior round's opencode session.
    const rerun = qSpawns[qSpawns.length - 1]!
    expect(rerun.argv).toContain('--session')
    expect(rerun.argv[rerun.argv.indexOf('--session') + 1]).toBe('opc_Q0')
  })

  test('sessionModeForQuestioner=isolated → questioner rerun never carries --session', async () => {
    const qSpawns = await questionerSpawns('isolated')
    expect(qSpawns.length).toBeGreaterThanOrEqual(2)
    for (const s of qSpawns) expect(s.argv).not.toContain('--session')
  })

  // Codex review #3 regression: a questioner wired with BOTH a self-clarify edge
  // (listed FIRST) AND a cross-clarify edge. findClarifyNodeForAgent returns the
  // self node, so the old wiring (which reused clarifyNodeForGate) resolved the
  // SELF node's sessionMode (isolated) and silently ignored the cross node's
  // sessionModeForQuestioner='inline'. The fix resolves the cross node via
  // findCrossClarifyNodeForQuestioner, so inline still takes effect (--session).
  test('cross inline resolves from the cross edge even when a self-clarify edge is wired first', async () => {
    const qSpawns = await questionerSpawns('inline', { selfClarifyEdgeFirst: true })
    expect(qSpawns.length).toBeGreaterThanOrEqual(2)
    expect(qSpawns[0]!.argv).not.toContain('--session')
    const rerun = qSpawns[qSpawns.length - 1]!
    expect(rerun.argv).toContain('--session')
    expect(rerun.argv[rerun.argv.indexOf('--session') + 1]).toBe('opc_Q0')
  })
})

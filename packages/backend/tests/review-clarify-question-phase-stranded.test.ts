// Regression — live incident 01KWDKBS9K22KB6HH4KNR3XMX6 (2026-07-09 会话):
//
//   agent(带反问通道) → review。agent 多轮反问：第 1 轮问 qa，用户答（继续）后 agent
//   续跑却**又问了第 2 轮 qb**（clarify-answer rerun 以 done 收尾、无 <workflow-output>）。
//   第 1 轮的问题 qa 绑在这条「done-无产出」的续跑上，其 lineage 窗口又被第 2 轮的
//   answer rerun 封顶——后续产出 run 永不进窗。旧 `done && hasOutput` 相位门把 qa 永久
//   卡在「处理中」，即便 agent 最终产出了待评审文档、任务走到评审节点。
//
//   用户现象逐段：评审等待阶段 qa 一直「处理中」；返回迭代仍没变；二次产出待评审文档
//   后才切「已处理待确认」（迭代重跑非 clarify-cause、不封顶，进了窗才被旧门放行）。
//
//   FIX（deriveQuestionPhase）：承接 run 只要 done 即「答案已被消费」→ 已处理待确认，
//   与 ledger 的 done=consumed（RFC-139）同口径。qa 在第 2 轮反问一落地即应切
//   awaiting_confirm，无需等到产出/迭代。
//
// Driven end-to-end through the REAL scheduler + REAL clarify-answer driver
// (autoDispatchClarifyRound) — same harness as clarify-review-combination-scenarios.

import { afterEach, beforeEach, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import type { DbClient } from '../src/db/client'
import { createInMemoryDb } from '../src/db/client'
import { clarifyRounds, nodeRuns, tasks } from '../src/db/schema'
import { createAgent } from '../src/services/agent'
import { createWorkflow } from '../src/services/workflow'
import { autoDispatchClarifyRound } from '../src/services/clarifyAutoDispatch'
import { runTask } from '../src/services/scheduler'
import { abortAllActiveTasks, startTaskWithLocalRepo } from '../src/services/task'
import { listTaskQuestions } from '../src/services/taskQuestions'
import { reenterScheduler } from './reenter-scheduler'
import { runTestGit } from './helpers/testCommand'
import type {
  ClarifyAnswer,
  ClarifyQuestion,
  WorkflowDefinition,
  WorkflowNode,
} from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const SCENARIO_STUB = resolve(import.meta.dir, 'fixtures', 'scenario-opencode.ts')
const actor = { userId: 'u1', role: 'owner' as const }
const GIT_TIMEOUT_MS = 10_000
const NODE_TIMEOUT_MS = 10_000
const FLOW_TIMEOUT_MS = 15_000

setDefaultTimeout(FLOW_TIMEOUT_MS * 2)

function git(...args: string[]): Promise<string> {
  return runTestGit(args, GIT_TIMEOUT_MS)
}

function clarifyBody(qid: string) {
  return {
    questions: [
      {
        id: qid,
        title: `Which option for ${qid}?`,
        kind: 'single',
        recommended: false,
        options: [
          { label: 'A', description: '', recommended: true, recommendationReason: '' },
          { label: 'B', description: '', recommended: false, recommendationReason: '' },
        ],
      } as ClarifyQuestion,
    ],
  }
}
function answerFor(qid: string): ClarifyAnswer {
  return {
    questionId: qid,
    selectedOptionIndices: [0],
    selectedOptionLabels: ['A'],
    customText: '',
  }
}

let tmp: string
let db: DbClient
let appHome: string
let repoPath: string
let previousScenarioPlanFile: string | undefined
let previousScenarioStateDir: string | undefined
let previousAppHome: string | undefined

beforeEach(async () => {
  previousScenarioPlanFile = process.env.SCENARIO_PLAN_FILE
  previousScenarioStateDir = process.env.SCENARIO_STATE_DIR
  previousAppHome = process.env.AGENT_WORKFLOW_HOME
  tmp = mkdtempSync(join(tmpdir(), 'aw-strand-q-'))
  appHome = join(tmp, 'home')
  repoPath = join(tmp, 'repo')
  mkdirSync(appHome, { recursive: true })
  mkdirSync(join(tmp, 'state'), { recursive: true })
  await git('init', '-b', 'main', repoPath)
  await git('-C', repoPath, 'config', 'user.email', 't@t.test')
  await git('-C', repoPath, 'config', 'user.name', 't')
  writeFileSync(join(repoPath, 'README.md'), '# r\n')
  await git('-C', repoPath, 'add', '.')
  await git('-C', repoPath, '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-m', 'init')
  db = createInMemoryDb(MIGRATIONS)
  process.env.SCENARIO_PLAN_FILE = join(tmp, 'plan.json')
  process.env.SCENARIO_STATE_DIR = join(tmp, 'state')
  process.env.AGENT_WORKFLOW_HOME = appHome
})

afterEach(() => {
  db.$client.close()
  rmSync(tmp, { recursive: true, force: true })
  if (previousScenarioPlanFile === undefined) delete process.env.SCENARIO_PLAN_FILE
  else process.env.SCENARIO_PLAN_FILE = previousScenarioPlanFile
  if (previousScenarioStateDir === undefined) delete process.env.SCENARIO_STATE_DIR
  else process.env.SCENARIO_STATE_DIR = previousScenarioStateDir
  if (previousAppHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
  else process.env.AGENT_WORKFLOW_HOME = previousAppHome
})

function opencodeCmd(): string[] {
  return ['bun', 'run', SCENARIO_STUB]
}
function writePlan(plan: unknown): void {
  writeFileSync(join(tmp, 'plan.json'), JSON.stringify(plan))
}

async function withActiveTaskDeadline<T>(operation: () => Promise<T>): Promise<T> {
  const watchdog = setTimeout(() => abortAllActiveTasks('test-timeout'), FLOW_TIMEOUT_MS)
  try {
    return await operation()
  } finally {
    clearTimeout(watchdog)
  }
}

async function runTaskWithDeadline(taskId: string): Promise<void> {
  const controller = new AbortController()
  const watchdog = setTimeout(() => controller.abort('test-timeout'), FLOW_TIMEOUT_MS)
  try {
    await runTask({
      taskId,
      db,
      appHome,
      opencodeCmd: opencodeCmd(),
      defaultPerNodeTimeoutMs: NODE_TIMEOUT_MS,
      defaultNodeRetries: 0,
      signal: controller.signal,
    })
  } finally {
    clearTimeout(watchdog)
  }
}
async function topLevel(nodeId: string, taskId: string) {
  const rows = await db
    .select()
    .from(nodeRuns)
    .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, nodeId)))
  return rows.filter((r) => r.parentNodeRunId === null)
}
async function taskStatus(taskId: string): Promise<string> {
  const t = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
  return t?.status ?? '??'
}
async function awaitingReviewRun(taskId: string, nodeId: string) {
  const tops = await topLevel(nodeId, taskId)
  return tops.find((r) => r.status === 'awaiting_review')
}
async function openClarifyRunId(taskId: string): Promise<string> {
  const rows = await db
    .select()
    .from(clarifyRounds)
    .where(and(eq(clarifyRounds.taskId, taskId), eq(clarifyRounds.status, 'awaiting_human')))
  const id = rows[0]?.intermediaryNodeRunId
  if (!id) throw new Error('no awaiting clarify session')
  return id
}

async function setupClarifyReviewWorkflow(name: string) {
  await createAgent(db, {
    name: 'designer',
    description: '',
    outputs: ['design'],
    outputKinds: { design: 'markdown' },
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: '',
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
  return createWorkflow(db, { name, description: '', definition: def })
}

function phaseOf(entries: Awaited<ReturnType<typeof listTaskQuestions>>, qid: string): string {
  const q = entries.find((e) => e.questionId === qid)
  if (!q)
    throw new Error(`no ${qid} entry; got ${JSON.stringify(entries.map((e) => e.questionId))}`)
  return q.phase
}

test('multi-round clarify: the round-0 question un-strands to 已处理待确认 once its answer rerun completes (even though that rerun asked round-1)', async () => {
  // call0 clarify(qa); call1 clarify(qb) [answered qa, asked again → done no-output];
  // call2 output v1 [answered qb → review park].
  writePlan({
    designer: [
      { clarify: clarifyBody('qa') },
      { clarify: clarifyBody('qb') },
      { output: { design: 'DESIGN_V1' } },
    ],
  })
  const wf = await setupClarifyReviewWorkflow('strand')
  const task = await withActiveTaskDeadline(() =>
    startTaskWithLocalRepo(
      {
        workflowId: wf.id,
        name: 'strand',
        repoPath,
        baseBranch: 'main',
        inputs: { topic: 'x' },
      },
      {
        db,
        appHome,
        opencodeCmd: opencodeCmd(),
        awaitScheduler: true,
        defaultPerNodeTimeoutMs: NODE_TIMEOUT_MS,
        defaultNodeRetries: 0,
      },
    ),
  )

  // Round 0: agent asked qa.
  expect(await taskStatus(task.id)).toBe('awaiting_human')

  // Answer qa with CONTINUE → designer reruns; per plan it asks qb (round 1).
  // That rerun is the qa handler and exits done WITHOUT output (clarify-ask ending).
  await autoDispatchClarifyRound({
    db,
    originNodeRunId: await openClarifyRunId(task.id),
    answers: [answerFor('qa')],
    directive: 'continue',
    actor,
  })
  await reenterScheduler(db, task.id)
  await runTaskWithDeadline(task.id)

  // Round 1 is now open (agent asked qb) — confirm the qa handler is done-no-output.
  expect(await taskStatus(task.id)).toBe('awaiting_human')
  const designerTops = await topLevel('designer', task.id)
  const qaHandler = designerTops.find((r) => r.rerunCause === 'clarify-answer')
  expect(qaHandler?.status).toBe('done')

  // ---- THE REGRESSION: qa was answered and its handler rerun COMPLETED (by asking
  // qb). qa must read 已处理待确认, NOT be stranded at 处理中. (Pre-fix: 'processing'.)
  const afterRound0 = await listTaskQuestions(db, task.id)
  expect(phaseOf(afterRound0, 'qa')).toBe('awaiting_confirm')

  // Finish the flow so afterEach doesn't race a live worktree write: answer qb
  // (stop) → designer emits v1 → review parks. qa STAYS 已处理待确认 (its window is
  // capped by qb's answer rerun; the v1 output run never enters it).
  await autoDispatchClarifyRound({
    db,
    originNodeRunId: await openClarifyRunId(task.id),
    answers: [answerFor('qb')],
    directive: 'stop',
    actor,
  })
  await reenterScheduler(db, task.id)
  await runTaskWithDeadline(task.id)

  const rev = await awaitingReviewRun(task.id, 'rev')
  expect(rev).toBeDefined()
  const atReviewPark = await listTaskQuestions(db, task.id)
  expect(phaseOf(atReviewPark, 'qa')).toBe('awaiting_confirm') // still, not dragged back
  expect(phaseOf(atReviewPark, 'qb')).toBe('awaiting_confirm') // qb's handler produced v1
})

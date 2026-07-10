import { rimrafDir } from './helpers/cleanup'
// RFC-131 验收 #4 组合 e2e — deferred self-clarify → done+output → review REJECT → 新 rerun，
// 经 runTask 端到端驱动。锁「reject 重做的 prompt 组合行为」两半都成立：
//   (a) RFC-119 prior-output：reject 重做带上上次产物（V1 doc）。
//   (b) RFC-131 §74 派生老化「不重注 clarify」：首轮 clarify Q&A 已老化 → reject 重做不重注
//       （重做靠 prior-output 带上次产物）。
//
// 曾经的 bug（本组合 e2e 揪出并修复）：只有「deferred + review-REJECT」这条路径同时踩到
//   1) `submitReviewDecision('rejected')` 把 target 的 done+output run supersede 成 `canceled`
//      （review.ts，errorMessage 带 `superseded-by-review-` 前缀，保留 node_run_outputs），且
//   2) 老化判据 `isTargetNodeConsumed`（clarifyRerunLedger.ts）——原仅认 `status === 'done'`。
// reject 后唯一带 output 的 run 已是 `canceled` → 老化落空 → deferred 注入器判「未老化」→ 首轮
// clarify 被重注（违反 design §74「第一次 done+output 即永久老化」）。两半各自单测（老化=注入层
// filter 单测；prior-output=rerun-prior-output-e2e 走 review-ITERATE）都绿、合起来漏这条，正是本
// 组合 e2e 的价值。**修复**：`isTargetNodeConsumed` 兼认 review-superseded 的 canceled+output run
// （对齐 prior-output 的 `freshestPriorRunWithOutput`——它一贯不按 status 过滤，故 prior-output 不受
// reject 影响）；`failed` / 非-review canceled 仍不老化（revivable，保 T1 锁）。
//
// 详见 design/RFC-131-task-question-queue-aging/{design.md §2, plan.md 验收}。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { monotonicFactory } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { clarifySessions, nodeRuns, taskQuestions, tasks, workflows } from '../src/db/schema'
import { createAgent } from '../src/services/agent'
import { runTask } from '../src/services/scheduler'
import { sealRoundQuestions } from '../src/services/clarifySeal'
import { dispatchTaskQuestions } from '../src/services/taskQuestionDispatch'
import { submitReviewDecision } from '../src/services/review'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import { runGit } from '../src/util/git'
import { reenterScheduler } from './reenter-scheduler'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

const ulid = monotonicFactory()
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')
const actor = { userId: 'u1', role: 'owner' as const }
const P = 'P' // the agent/designer node under review
const REV = 'REV' // the review node hanging off P.doc

// Unique markers so the assertions cannot false-match unrelated prompt text.
const CLARIFY_Q = 'ROUND1_PLATFORM_Q'
const CLARIFY_ANS = 'R1_ANS_REACT'
const DOC_V1 = 'DOC_BODY_V1_UNIQUE_MARKER'
const DOC_V2 = 'DOC_BODY_V2_UNIQUE_MARKER'
const REJECT_REASON = 'REJECT_REASON_UNIQUE redo it against the comments'

function clarifyBody(qid: string, title: string, options: string[]): string {
  return JSON.stringify({
    questions: [{ id: qid, title, kind: 'single', recommended: true, options }],
  })
}
function ans(qid: string, idx: number, label: string) {
  return {
    questionId: qid,
    selectedOptionIndices: [idx],
    selectedOptionLabels: [label],
    customText: '',
  }
}

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  repoPath: string
  cleanup: () => void
}

async function buildHarness(): Promise<Harness> {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc131-rej-'))
  const repoPath = join(appHome, 'repo')
  const worktreePath = join(appHome, 'wt')
  mkdirSync(repoPath, { recursive: true })
  mkdirSync(worktreePath, { recursive: true })
  for (const p of [repoPath, worktreePath]) {
    await runGit(p, ['init', '-b', 'main'])
    await runGit(p, ['config', 'user.email', 't@t.test'])
    await runGit(p, ['config', 'user.name', 't'])
    writeFileSync(join(p, 'r.md'), '# r\n')
    await runGit(p, ['add', '.'])
    await runGit(p, ['commit', '-m', 'init'])
  }
  const db = createInMemoryDb(MIGRATIONS)
  return {
    db,
    appHome,
    worktreePath,
    repoPath,
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
      const p = prev[k]
      if (p === undefined) delete process.env[k]
      else process.env[k] = p
    }
  })
}

const run = (h: Harness, taskId: string) =>
  runTask({
    taskId,
    db: h.db,
    appHome: h.appHome,
    opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
    defaultNodeRetries: 0,
  })

async function selfEntryId(h: Harness, taskId: string, originNodeRunId: string): Promise<string> {
  const rows = await h.db
    .select()
    .from(taskQuestions)
    .where(
      and(
        eq(taskQuestions.taskId, taskId),
        eq(taskQuestions.roleKind, 'self'),
        eq(taskQuestions.originNodeRunId, originNodeRunId),
      ),
    )
  return rows[0]!.id
}

/** The workflow snapshot used by every scenario: input → P(planner, outputs:[doc])
 *  with a self-clarify channel (C) + a review node REV reviewing P.doc,
 *  rerunnableOnReject:[P]. rollbackFilesOnReject:false keeps the worktree stash out
 *  of the picture — orthogonal to what we assert (aging reads run status, prior-output
 *  reads node_run_outputs; neither touches the worktree). */
function buildDefinition(): WorkflowDefinition {
  const nodes = [
    { id: 'in1', kind: 'input', inputKey: 'req' },
    { id: P, kind: 'agent-single', agentName: 'planner' },
    { id: 'C', kind: 'clarify', title: 'Clarify' },
    {
      id: REV,
      kind: 'review',
      inputSource: { nodeId: P, portName: 'doc' },
      rerunnableOnReject: [P],
      rollbackFilesOnReject: false,
    },
  ] as unknown as WorkflowNode[]
  return {
    $schema_version: 3,
    inputs: [{ kind: 'text', key: 'req', label: 'r' }],
    nodes,
    edges: [
      {
        id: 'e_in',
        source: { nodeId: 'in1', portName: 'req' },
        target: { nodeId: P, portName: 'req' },
      },
      {
        id: 'e_ask',
        source: { nodeId: P, portName: '__clarify__' },
        target: { nodeId: 'C', portName: 'questions' },
      },
      {
        id: 'e_ans',
        source: { nodeId: 'C', portName: 'answers' },
        target: { nodeId: P, portName: '__clarify_response__' },
      },
      {
        id: 'e_rev',
        source: { nodeId: P, portName: 'doc' },
        target: { nodeId: REV, portName: '__review_input__' },
      },
    ],
  }
}

async function seedDeferredTask(h: Harness): Promise<string> {
  await createAgent(h.db, {
    name: 'planner',
    description: '',
    outputs: ['doc'],
    outputKinds: { doc: 'markdown' },
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: '',
  })
  const def = buildDefinition()
  const workflowId = ulid()
  const taskId = ulid()
  await h.db
    .insert(workflows)
    .values({ id: workflowId, name: 'wf', definition: JSON.stringify(def) })
  await h.db.insert(tasks).values({
    id: taskId,
    name: 'rfc131-reject-combo',
    workflowId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: h.repoPath,
    worktreePath: h.worktreePath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'pending',
    inputs: JSON.stringify({ req: 'build dashboard' }),
    startedAt: Date.now(),
    // RFC-131 派生老化只走 deferred 路径（buildClarifyNodeQueueContext）。
  })
  return taskId
}

/** Drive: runTask#1 (P self-clarifies) → seal(stop)+dispatch → runTask#2 (P → doc V1 →
 *  done+output → review awaiting_review) → submitReviewDecision('rejected') → runTask#3
 *  (P reject-rerun → doc V2 → done). Returns the reject-rerun row + the review run id. */
async function driveToRejectRerun(h: Harness, taskId: string) {
  // ---- ROUND 1: P asks a self-clarify question ----
  await withEnv(
    { MOCK_OPENCODE_CLARIFY_BODY: clarifyBody('r1q', CLARIFY_Q, [CLARIFY_ANS, 'R1_ANS_VUE']) },
    () => run(h, taskId),
  )
  expect((await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]?.status).toBe(
    'awaiting_human',
  )
  const r1sess = (
    await h.db.select().from(clarifySessions).where(eq(clarifySessions.taskId, taskId))
  )[0]!
  // Answer with directive STOP → the 承接 rerun finalizes with <workflow-output> (not another clarify).
  await sealRoundQuestions({
    db: h.db,
    originNodeRunId: r1sess.clarifyNodeRunId,
    answers: [ans('r1q', 0, CLARIFY_ANS)],
    directive: 'stop',
    autoStage: true,
    sealedBy: 'u1',
  })
  await dispatchTaskQuestions(
    h.db,
    taskId,
    [await selfEntryId(h, taskId, r1sess.clarifyNodeRunId)],
    actor,
  )
  await h.db.update(tasks).set({ status: 'pending' }).where(eq(tasks.id, taskId))

  // ---- runTask#2: P (承接 rerun) produces doc V1 → done+output → REV awaiting_review ----
  await withEnv({ MOCK_OPENCODE_OUTPUTS: JSON.stringify({ doc: DOC_V1 }) }, () => run(h, taskId))
  expect((await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]?.status).toBe(
    'awaiting_review',
  )

  // The aging ANCHOR: P now has a top-level done+output run (retryIndex 1, cause clarify-answer).
  const pDoneOutput = (
    await h.db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, P)))
  ).find(
    (r) => r.status === 'done' && r.parentNodeRunId === null && r.rerunCause === 'clarify-answer',
  )
  expect(pDoneOutput).toBeDefined()

  const reviewRun = (
    await h.db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, REV)))
  ).find((r) => r.status === 'awaiting_review')
  expect(reviewRun).toBeDefined()

  // ---- REJECT (用户拍板「消费掉」重做) → supersedes P's done+output run + mints reject rerun ----
  const res = await submitReviewDecision({
    db: h.db,
    appHome: h.appHome,
    nodeRunId: reviewRun!.id,
    decision: 'rejected',
    rejectReason: REJECT_REASON,
    expectedReviewIteration: reviewRun!.reviewIteration,
  })
  expect(res.resumeRequired).toBe(true)

  // ---- runTask#3: P reject rerun re-produces doc V2 ----
  await reenterScheduler(h.db, taskId)
  await withEnv({ MOCK_OPENCODE_OUTPUTS: JSON.stringify({ doc: DOC_V2 }) }, () => run(h, taskId))

  const pRuns = await h.db
    .select()
    .from(nodeRuns)
    .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, P)))
  const rejectRerun = pRuns.find((r) => r.rerunCause === 'review-reject')
  return { rejectRerun, pDoneOutputId: pDoneOutput!.id, pRuns }
}

describe('RFC-131 验收#4 组合 — deferred self-clarify → review REJECT → 重做 (prior-output + 老化)', () => {
  let h: Harness
  beforeEach(async () => {
    resetBroadcastersForTests()
    h = await buildHarness()
  })
  afterEach(() => {
    h.cleanup()
    resetBroadcastersForTests()
  })

  // -------------------------------------------------------------------------
  // Test 1 — CHARACTERIZATION (green): locks the ACTUAL current behavior of the
  // whole combination through runTask. prior-output 半是真的对（RFC-119）；clarify
  // 半是已知 gap（违反 §74），显式锁「仍重注」并标注 flip 指引。
  // -------------------------------------------------------------------------
  test('reject 重做 prompt：带 RFC-119 prior-output(V1) ✓；老化锚已 review-supersede canceled ✓；clarify 已老化不重注（§74）✓', async () => {
    const taskId = await seedDeferredTask(h)
    const { rejectRerun, pDoneOutputId } = await driveToRejectRerun(h, taskId)

    expect(rejectRerun).toBeDefined()
    expect(rejectRerun!.status).toBe('done')
    const prompt = rejectRerun!.promptText ?? ''
    expect(prompt.length).toBeGreaterThan(0)

    // --- confirm this really is the review-REJECT rerun (context wired) ---
    expect(prompt).toContain('## Review Rejection')
    expect(prompt).toContain(REJECT_REASON)

    // --- (a) RFC-119 prior-output: the reject rerun carries the V1 product + neutral directive ---
    expect(prompt).toContain('## Prior Output (to update or regenerate)')
    expect(prompt).toContain(DOC_V1)
    expect(prompt).toContain('## Update Directive')
    expect(prompt.toLowerCase()).toContain('regenerate')
    expect(prompt.toLowerCase()).toContain('complete')
    expect(prompt.toLowerCase()).not.toContain('do not regenerate')

    // --- aging ANCHOR: P's first done+output run is now a review-reject supersede (canceled).
    //     THIS is why RFC-131 aging is lost on reject — the only output-bearing run is no
    //     longer `status='done'`, so isTargetNodeConsumed (needs status==='done') returns false.
    const anchor = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, pDoneOutputId)))[0]
    expect(anchor?.status).toBe('canceled')
    expect(anchor?.errorMessage ?? '').toContain('superseded-by-review-rejected')

    // --- (b) RFC-131 §74 老化在 review-reject 下存活：isTargetNodeConsumed 认「review-superseded 的
    //     canceled+output run」（errorMessage 带 superseded-by-review- 前缀，clarifyRerunLedger.ts），
    //     所以首轮 clarify Q&A 已老化 → reject 重做**不**重注（重做靠上面的 prior-output 带上次产物）。
    //     这条曾是真 bug——reject 把产出 run supersede 成 canceled 令老化判据（原仅认 status==='done'）
    //     落空、clarify 被重注；本验收4 组合 e2e 揪出并修复（design §74「第一次 done+output 即永久老化」）。
    expect(prompt).not.toContain(CLARIFY_Q) // aged: question NOT re-rendered
    expect(prompt).not.toContain(CLARIFY_ANS) // aged: answer NOT re-rendered
    expect(prompt).not.toContain('Round 1') // aged: round header NOT re-rendered
  })
})

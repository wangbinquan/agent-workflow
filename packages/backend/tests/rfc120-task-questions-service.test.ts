// RFC-120 T3 — integration test for the read-side service (lazy reconcile +
// handler resolution + list). Locks:
//   * self answered round → 1 self entry; handler resolved from the round's
//     consumed_by_consumer_run_id stamp; done+output → awaiting_confirm.
//   * cross answered designer-scoped → questioner + designer entries (the 两条).
//   * cross answered questioner-scoped → questioner only.
//   * cross UNanswered → questioner only, phase 'pending' (no designer entry,
//     scope unknown — design §3.1).
//   * reconcile is idempotent (listing twice does not duplicate rows).
//   * sourceNodeId + phase filters.

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  clarifyRounds,
  nodeRunOutputs,
  nodeRuns,
  taskQuestions,
  tasks,
  workflows,
} from '../src/db/schema'
import {
  confirmTaskQuestion,
  listTaskQuestions,
  reassignTaskQuestion,
  stageTaskQuestion,
} from '../src/services/taskQuestions'

const AGENT_SNAPSHOT = JSON.stringify({
  $schema_version: 3,
  inputs: [],
  nodes: [
    { id: 'designer', kind: 'agent-single', agentName: 'designer' },
    { id: 'coder', kind: 'agent-single', agentName: 'coder' },
    { id: 'fixer', kind: 'agent-single', agentName: 'fixer' },
    { id: 'auditor', kind: 'agent-single', agentName: 'auditor' },
    { id: 'c1', kind: 'clarify' },
  ],
  edges: [],
  outputs: [],
})

const ACTOR = { userId: 'u1', role: 'owner' }

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const Q = (id: string) => ({
  id,
  title: `title-${id}`,
  kind: 'single' as const,
  recommended: false,
  options: [
    { label: 'A', description: '', recommended: false, recommendationReason: '' },
    { label: 'B', description: '', recommended: false, recommendationReason: '' },
  ],
})

async function seedTask(db: DbClient, taskId = 'task-1') {
  await db.insert(workflows).values({
    id: 'wf-1',
    name: 'wf',
    definition: '{}',
    description: '',
    version: 1,
    schemaVersion: 3,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'fixture',
    workflowId: 'wf-1',
    workflowSnapshot: AGENT_SNAPSHOT,
    repoPath: '/tmp/r',
    worktreePath: '',
    baseBranch: 'main',
    branch: 'b',
    status: 'awaiting_human',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return taskId
}

async function seedRun(
  db: DbClient,
  taskId: string,
  id: string,
  nodeId: string,
  over: {
    status?: 'done' | 'running' | 'failed' | 'pending'
    rerunCause?: string | null
    iteration?: number
    withOutput?: boolean
  } = {},
) {
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId,
    status: over.status ?? 'done',
    rerunCause: over.rerunCause ?? null,
    iteration: over.iteration ?? 0,
    startedAt: Date.now(),
  })
  if (over.withOutput) {
    await db.insert(nodeRunOutputs).values({ nodeRunId: id, portName: 'result', content: 'x' })
  }
}

async function seedRound(
  db: DbClient,
  taskId: string,
  over: Partial<typeof clarifyRounds.$inferSelect> & {
    id: string
    kind: 'self' | 'cross'
    askingNodeId: string
    intermediaryNodeRunId: string
    questionsJson: string
  },
) {
  // FK: clarify_rounds.asking_node_run_id + intermediary_node_run_id → node_runs.
  const askingRunId = `${over.id}-ask`
  await seedRun(db, taskId, askingRunId, over.askingNodeId)
  await seedRun(db, taskId, over.intermediaryNodeRunId, `${over.id}-intnode`)
  await db.insert(clarifyRounds).values({
    taskId,
    askingNodeRunId: askingRunId,
    intermediaryNodeId: `${over.id}-int`,
    status: 'awaiting_human',
    ...over,
  })
}

describe('RFC-120 T3 listTaskQuestions', () => {
  test('self answered round → 1 self entry, done handler → awaiting_confirm', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await seedRun(db, taskId, 'r-handler', 'designer', {
      rerunCause: 'clarify-answer',
      status: 'done',
      withOutput: true,
    })
    await seedRound(db, taskId, {
      id: 'c1',
      kind: 'self',
      askingNodeId: 'designer',
      intermediaryNodeRunId: 'c1-int',
      questionsJson: JSON.stringify([Q('q1')]),
      status: 'answered',
      answersJson: JSON.stringify([
        {
          questionId: 'q1',
          selectedOptionIndices: [0],
          selectedOptionLabels: ['A'],
          customText: '',
        },
      ]),
    })
    // RFC-132: 相位派生自 entry 自身 dispatch 状态 — reconcile 建 entry 后 dispatch+bind 到
    // done+output handler(取代旧 consumption-stamp seed)。
    const [pre] = await listTaskQuestions(db, taskId)
    await db
      .update(taskQuestions)
      .set({ dispatchedAt: Date.now(), triggerRunId: 'r-handler' })
      .where(eq(taskQuestions.id, pre!.id))

    const list = await listTaskQuestions(db, taskId)
    expect(list).toHaveLength(1)
    expect(list[0]!.roleKind).toBe('self')
    expect(list[0]!.sourceNodeId).toBe('designer')
    expect(list[0]!.effectiveTargetNodeId).toBe('designer')
    expect(list[0]!.phase).toBe('awaiting_confirm')
    expect(list[0]!.answerSummary).toBe('A')
  })

  // RFC-162: a cross answered round is a SINGLE questioner card by default — NO designer entry
  // (scope / designer-by-default deleted). "Let the upstream revise" is a reassign (see below).
  test('RFC-162: cross answered → questioner single card, NO designer entry', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await seedRound(db, taskId, {
      id: 'x1',
      kind: 'cross',
      askingNodeId: 'auditor', // questioner
      targetConsumerNodeId: 'coder', // graph designer (NOT auto-added anymore)
      intermediaryNodeRunId: 'x1-int',
      questionsJson: JSON.stringify([Q('q1')]),
      status: 'answered',
      answersJson: JSON.stringify([
        {
          questionId: 'q1',
          selectedOptionIndices: [],
          selectedOptionLabels: [],
          customText: 'fix it',
        },
      ]),
    })

    const list = await listTaskQuestions(db, taskId)
    expect(list.map((e) => e.roleKind)).toEqual(['questioner'])
    const questioner = list[0]!
    expect(questioner.defaultTargetNodeId).toBe('auditor')
    expect(questioner.answerSummary).toBe('fix it')
  })

  test('cross UNanswered → questioner only, pending (no designer entry)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await seedRound(db, taskId, {
      id: 'x3',
      kind: 'cross',
      askingNodeId: 'auditor',
      targetConsumerNodeId: 'coder',
      intermediaryNodeRunId: 'x3-int',
      questionsJson: JSON.stringify([Q('q1')]),
      status: 'awaiting_human',
    })
    const list = await listTaskQuestions(db, taskId)
    expect(list).toHaveLength(1)
    expect(list[0]!.roleKind).toBe('questioner')
    expect(list[0]!.phase).toBe('pending')
    expect(list[0]!.answerSummary).toBeNull()
  })

  test('reconcile idempotent — listing twice does not duplicate', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await seedRound(db, taskId, {
      id: 'c2',
      kind: 'self',
      askingNodeId: 'designer',
      intermediaryNodeRunId: 'c2-int',
      questionsJson: JSON.stringify([Q('q1'), Q('q2')]),
      status: 'answered',
    })
    const first = await listTaskQuestions(db, taskId)
    const second = await listTaskQuestions(db, taskId)
    expect(first).toHaveLength(2)
    expect(second).toHaveLength(2)
    const rows = await db.select().from(taskQuestions)
    expect(rows.length).toBe(2)
  })

  test('sourceNodeId + phase filters', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await seedRound(db, taskId, {
      id: 'a1',
      kind: 'self',
      askingNodeId: 'nodeA',
      intermediaryNodeRunId: 'a1-int',
      questionsJson: JSON.stringify([Q('q1')]),
      status: 'awaiting_human',
    })
    await seedRound(db, taskId, {
      id: 'b1',
      kind: 'self',
      askingNodeId: 'nodeB',
      intermediaryNodeRunId: 'b1-int',
      questionsJson: JSON.stringify([Q('q1')]),
      status: 'awaiting_human',
    })
    const onlyA = await listTaskQuestions(db, taskId, { sourceNodeId: 'nodeA' })
    expect(onlyA.map((e) => e.sourceNodeId)).toEqual(['nodeA'])
    const pending = await listTaskQuestions(db, taskId, { phase: 'pending' })
    expect(pending).toHaveLength(2)
    const processing = await listTaskQuestions(db, taskId, { phase: 'processing' })
    expect(processing).toHaveLength(0)
  })
})

describe('RFC-120 PR-B writes (confirm / reassign / stage)', () => {
  async function seedSelfAwaitingConfirm(db: DbClient) {
    const taskId = await seedTask(db)
    await seedRun(db, taskId, 'r-handler', 'designer', {
      rerunCause: 'clarify-answer',
      status: 'done',
      withOutput: true,
    })
    await seedRound(db, taskId, {
      id: 'c1',
      kind: 'self',
      askingNodeId: 'designer',
      intermediaryNodeRunId: 'c1-int',
      questionsJson: JSON.stringify([Q('q1')]),
      status: 'answered',
    })
    // RFC-132: dispatch+bind 取代 consumption-stamp seed(相位读 entry 自身 dispatch 状态)。
    const [pre] = await listTaskQuestions(db, taskId)
    await db
      .update(taskQuestions)
      .set({ dispatchedAt: Date.now(), triggerRunId: 'r-handler' })
      .where(eq(taskQuestions.id, pre!.id))
    return taskId
  }

  test('confirm: awaiting_confirm → done with confirmedBy', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedSelfAwaitingConfirm(db)
    const [entry] = await listTaskQuestions(db, taskId)
    expect(entry!.phase).toBe('awaiting_confirm')
    await confirmTaskQuestion(db, entry!.id, ACTOR)
    const [after] = await listTaskQuestions(db, taskId)
    expect(after!.phase).toBe('done')
    expect(after!.confirmation).toBe('confirmed')
    expect(after!.confirmedBy).toBe('u1')
  })

  test('confirm: rejects when not awaiting_confirm', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await seedRound(db, taskId, {
      id: 'p1',
      kind: 'self',
      askingNodeId: 'designer',
      intermediaryNodeRunId: 'p1-int',
      questionsJson: JSON.stringify([Q('q1')]),
      status: 'awaiting_human',
    })
    const [entry] = await listTaskQuestions(db, taskId)
    expect(entry!.phase).toBe('pending')
    await expect(confirmTaskQuestion(db, entry!.id, ACTOR)).rejects.toThrow()
  })

  /** Seed an answered cross round (single questioner card) and return its taskId. */
  async function seedAnsweredCross(db: DbClient, id = 'x1') {
    const taskId = await seedTask(db)
    await seedRound(db, taskId, {
      id,
      kind: 'cross',
      askingNodeId: 'auditor', // questioner
      targetConsumerNodeId: 'coder', // graph designer (not auto-added)
      intermediaryNodeRunId: `${id}-int`,
      questionsJson: JSON.stringify([Q('q1')]),
      status: 'answered',
      answersJson: JSON.stringify([
        { questionId: 'q1', selectedOptionIndices: [], selectedOptionLabels: [], customText: 'x' },
      ]),
    })
    return taskId
  }

  // RFC-162 AC-2 — reassign a cross question to an UPSTREAM node ADDS a designer handler row
  // targeting it, and KEEPS the asker's questioner entry (no strand → no echo needed).
  test('RFC-162: reassign-to-upstream adds a designer handler and keeps the asker', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedAnsweredCross(db)
    const before = await listTaskQuestions(db, taskId)
    expect(before.map((e) => e.roleKind)).toEqual(['questioner'])
    const questioner = before[0]!

    const action = await reassignTaskQuestion(db, questioner.id, 'coder', ACTOR)
    expect(action).toBe('added-designer')

    const after = await listTaskQuestions(db, taskId)
    // The asker (questioner) entry is UNTOUCHED — the asker always reruns + gets the Q&A.
    const askerAfter = after.find((e) => e.roleKind === 'questioner')!
    expect(askerAfter.id).toBe(questioner.id)
    expect(askerAfter.effectiveTargetNodeId).toBe('auditor')
    // A designer handler now targets the upstream node.
    const designer = after.find((e) => e.roleKind === 'designer')!
    expect(designer.defaultTargetNodeId).toBe('coder')
    expect(designer.effectiveTargetNodeId).toBe('coder')
    expect(after.map((e) => e.roleKind).sort()).toEqual(['designer', 'questioner'])
  })

  // RFC-162 (Codex impl-gate P1) — a designer added AFTER a PARTIAL (per-question) seal must
  // inherit the asker's sealed state, not derive from whole-round status. RFC-128 P1 lets a
  // question be individually sealed while the round stays 'awaiting_human' (clarifySeal.ts:22);
  // keying the new designer's sealedAt only on round.status==='answered' would leave it NULL and
  // unstageable forever (no later seal re-includes an already-sealed question) → stranded handler.
  test('RFC-162: reassign after a PARTIAL seal — designer inherits the asker sealedAt (not stranded)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    // UNANSWERED cross round — status stays 'awaiting_human' (the partial-seal state).
    await seedRound(db, taskId, {
      id: 'x1',
      kind: 'cross',
      askingNodeId: 'auditor',
      targetConsumerNodeId: 'coder',
      intermediaryNodeRunId: 'x1-int',
      questionsJson: JSON.stringify([Q('q1')]),
      status: 'awaiting_human',
    })
    const [questioner] = await listTaskQuestions(db, taskId)
    expect(questioner!.roleKind).toBe('questioner')
    // Simulate RFC-128 P1 per-question seal: stamp the asker entry sealedAt while the round
    // stays 'awaiting_human' (a partial seal is a pure derived state — clarifySeal.ts:22).
    const sealTs = Date.now()
    await db
      .update(taskQuestions)
      .set({ sealedAt: sealTs })
      .where(eq(taskQuestions.id, questioner!.id))

    const action = await reassignTaskQuestion(db, questioner!.id, 'coder', ACTOR)
    expect(action).toBe('added-designer')

    // The new designer row inherits the asker's sealedAt → stageable, NOT stranded at NULL.
    const designer = (await db.select().from(taskQuestions)).find((r) => r.roleKind === 'designer')!
    expect(designer.sealedAt).not.toBeNull()
    expect(designer.sealedAt).toBe(sealTs)
  })

  // RFC-162 — reassign creates NO echo row (echo deleted; the asker keeps its own entry).
  test('RFC-162: reassign never materializes an echo row', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedAnsweredCross(db)
    const [questioner] = await listTaskQuestions(db, taskId)
    await reassignTaskQuestion(db, questioner!.id, 'coder', ACTOR)
    const rows = await db.select().from(taskQuestions)
    expect(rows.some((r) => (r.roleKind as string) === 'echo')).toBe(false)
  })

  // RFC-162 — re-targeting the added designer to another agent updates its handler node in place.
  test('RFC-162: re-targeting an added designer moves the designer handler', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedAnsweredCross(db)
    const [questioner] = await listTaskQuestions(db, taskId)
    await reassignTaskQuestion(db, questioner!.id, 'coder', ACTOR)
    const designer = (await listTaskQuestions(db, taskId)).find((e) => e.roleKind === 'designer')!
    await reassignTaskQuestion(db, designer.id, 'fixer', ACTOR)
    const list = await listTaskQuestions(db, taskId)
    // Still exactly one designer, now on 'fixer'; the asker is still present (single group).
    expect(list.filter((e) => e.roleKind === 'designer')).toHaveLength(1)
    const after = list.find((e) => e.roleKind === 'designer')!
    expect(after.effectiveTargetNodeId).toBe('fixer')
    expect(list.some((e) => e.roleKind === 'questioner')).toBe(true)
  })

  // RFC-162 — reassigning back to the ASKING node removes the designer (back to single card).
  test('RFC-162: reassign to the asking node removes the designer (single card)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedAnsweredCross(db)
    const [questioner] = await listTaskQuestions(db, taskId)
    await reassignTaskQuestion(db, questioner!.id, 'coder', ACTOR)
    expect((await listTaskQuestions(db, taskId)).some((e) => e.roleKind === 'designer')).toBe(true)
    // Target == the asking node (auditor) → remove the designer handler.
    const action = await reassignTaskQuestion(db, questioner!.id, 'auditor', ACTOR)
    expect(action).toBe('removed-designer')
    const list = await listTaskQuestions(db, taskId)
    expect(list.map((e) => e.roleKind)).toEqual(['questioner'])
  })

  // A non-agent target (a clarify node) is still rejected for any reassign.
  test('reassign: non-agent target rejected', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedAnsweredCross(db)
    const [questioner] = await listTaskQuestions(db, taskId)
    await expect(reassignTaskQuestion(db, questioner!.id, 'c1', ACTOR)).rejects.toThrow()
  })

  test('stage / unstage toggles the 待下发 phase', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await seedRound(db, taskId, {
      id: 's1',
      kind: 'self',
      askingNodeId: 'designer',
      intermediaryNodeRunId: 's1-int',
      questionsJson: JSON.stringify([Q('q1')]),
      status: 'awaiting_human',
    })
    const [entry] = await listTaskQuestions(db, taskId)
    expect(entry!.phase).toBe('pending')
    // RFC-128 P2 §11 — 待下发 gate: a question must be SEALED before it can be staged. Stamp
    // the per-question seal marker directly (a partial control-channel seal leaves the round
    // awaiting_human, so the entry stays 'pending' yet is now stageable). Without this the
    // stage below would (correctly) reject with `task-question-not-sealed`.
    await db
      .update(taskQuestions)
      .set({ sealedAt: Date.now() })
      .where(eq(taskQuestions.id, entry!.id))
    await stageTaskQuestion(db, entry!.id, true, ACTOR)
    expect((await listTaskQuestions(db, taskId))[0]!.phase).toBe('staged')
    await stageTaskQuestion(db, entry!.id, false, ACTOR)
    expect((await listTaskQuestions(db, taskId))[0]!.phase).toBe('pending')
  })
})

describe('RFC-120 Codex impl-gate regressions (F1/F2/F3)', () => {
  test('F1 (RFC-132): answered round, entry never dispatched → pending (板上待补 dispatch,不猜 run)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    // a LATER unrelated clarify-answer rerun on the same node must NOT be bound/guessed.
    await seedRun(db, taskId, 'r-later', 'designer', {
      rerunCause: 'clarify-answer',
      status: 'running',
    })
    await seedRound(db, taskId, {
      id: 'c1',
      kind: 'self',
      askingNodeId: 'designer',
      intermediaryNodeRunId: 'c1-int',
      questionsJson: JSON.stringify([Q('q1')]),
      status: 'answered', // answered but never dispatched (legacy / data-lost round)
    })
    // RFC-132 统一模型:相位一律派生自 entry 自身 dispatch 状态。answered-undispatched(迁移
    // 垫片 skip 的数据损轮)→ pending(可经 board dispatch 补救),不再是旧 consumption-stamp
    // 语义下的永久 processing;'r-later' 依然绝不被猜绑。
    const [entry] = await listTaskQuestions(db, taskId)
    expect(entry!.phase).toBe('pending')
  })

  // F2(旧「stamp 指 fanout CHILD run 也认」)随 consumption-stamp 一起删除(RFC-132):统一
  // 模型下 trigger 恒由 dispatch/bind 绑到 top-level anchor(resolveHandlerRun lineage 只扫
  // parentNodeRunId===null),fanout 的 awaiting_confirm 靠 parent 聚合输出(T3 已覆盖)。

  test('F3: reassign rejects a terminal (done) entry', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await seedRun(db, taskId, 'h', 'coder', {
      rerunCause: 'cross-clarify-answer',
      withOutput: true,
    })
    await seedRound(db, taskId, {
      id: 'x1',
      kind: 'cross',
      askingNodeId: 'auditor',
      targetConsumerNodeId: 'coder',
      intermediaryNodeRunId: 'x1-int',
      questionsJson: JSON.stringify([Q('q1')]),
      status: 'answered',
    })
    // RFC-162: a designer handler is created by a reassign (adds a designer row targeting the
    // upstream node), not by scope. Add one, then dispatch + bind it to the done+output handler
    // run 'h' so it reaches awaiting_confirm, confirm it (→ done), and lock the terminal reject.
    const [questioner] = await listTaskQuestions(db, taskId)
    await reassignTaskQuestion(db, questioner!.id, 'coder', ACTOR)
    let designer = (await listTaskQuestions(db, taskId)).find((e) => e.roleKind === 'designer')!
    await db
      .update(taskQuestions)
      .set({ dispatchedAt: Date.now(), triggerRunId: 'h' })
      .where(eq(taskQuestions.id, designer.id))
    designer = (await listTaskQuestions(db, taskId)).find((e) => e.roleKind === 'designer')!
    expect(designer.phase).toBe('awaiting_confirm')
    await confirmTaskQuestion(db, designer.id, ACTOR)
    expect(
      (await listTaskQuestions(db, taskId)).find((e) => e.roleKind === 'designer')!.phase,
    ).toBe('done')
    await expect(reassignTaskQuestion(db, designer.id, 'fixer', ACTOR)).rejects.toThrow()
  })
})

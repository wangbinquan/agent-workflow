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
      consumedByConsumerRunId: 'r-handler',
    })

    const list = await listTaskQuestions(db, taskId)
    expect(list).toHaveLength(1)
    expect(list[0]!.roleKind).toBe('self')
    expect(list[0]!.sourceNodeId).toBe('designer')
    expect(list[0]!.effectiveTargetNodeId).toBe('designer')
    expect(list[0]!.phase).toBe('awaiting_confirm')
    expect(list[0]!.answerSummary).toBe('A')
  })

  test('cross answered designer-scoped → questioner + designer entries', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await seedRound(db, taskId, {
      id: 'x1',
      kind: 'cross',
      askingNodeId: 'auditor', // questioner
      targetConsumerNodeId: 'coder', // designer
      intermediaryNodeRunId: 'x1-int',
      questionsJson: JSON.stringify([Q('q1')]),
      questionScopesJson: JSON.stringify({ q1: 'designer' }),
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
    const roles = list.map((e) => e.roleKind).sort()
    expect(roles).toEqual(['designer', 'questioner'])
    const designer = list.find((e) => e.roleKind === 'designer')!
    expect(designer.defaultTargetNodeId).toBe('coder')
    expect(designer.effectiveTargetNodeId).toBe('coder')
    const questioner = list.find((e) => e.roleKind === 'questioner')!
    expect(questioner.defaultTargetNodeId).toBe('auditor')
    expect(questioner.answerSummary).toBe('fix it')
  })

  test('cross answered questioner-scoped → questioner only', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await seedRound(db, taskId, {
      id: 'x2',
      kind: 'cross',
      askingNodeId: 'auditor',
      targetConsumerNodeId: 'coder',
      intermediaryNodeRunId: 'x2-int',
      questionsJson: JSON.stringify([Q('q1')]),
      questionScopesJson: JSON.stringify({ q1: 'questioner' }),
      status: 'answered',
    })
    const list = await listTaskQuestions(db, taskId)
    expect(list.map((e) => e.roleKind)).toEqual(['questioner'])
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
      consumedByConsumerRunId: 'r-handler',
    })
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

  test('reassign: designer entry → agent node overrides effective target', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await seedRound(db, taskId, {
      id: 'x1',
      kind: 'cross',
      askingNodeId: 'auditor',
      targetConsumerNodeId: 'coder',
      intermediaryNodeRunId: 'x1-int',
      questionsJson: JSON.stringify([Q('q1')]),
      questionScopesJson: JSON.stringify({ q1: 'designer' }),
      status: 'answered',
    })
    const designer = (await listTaskQuestions(db, taskId)).find((e) => e.roleKind === 'designer')!
    expect(designer.effectiveTargetNodeId).toBe('coder')
    await reassignTaskQuestion(db, designer.id, 'fixer', ACTOR)
    const after = (await listTaskQuestions(db, taskId)).find((e) => e.roleKind === 'designer')!
    expect(after.overrideTargetNodeId).toBe('fixer')
    expect(after.effectiveTargetNodeId).toBe('fixer')
  })

  test('reassign: rejects questioner entry and non-agent target', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await seedRound(db, taskId, {
      id: 'x2',
      kind: 'cross',
      askingNodeId: 'auditor',
      targetConsumerNodeId: 'coder',
      intermediaryNodeRunId: 'x2-int',
      questionsJson: JSON.stringify([Q('q1')]),
      questionScopesJson: JSON.stringify({ q1: 'designer' }),
      status: 'answered',
    })
    const list = await listTaskQuestions(db, taskId)
    const questioner = list.find((e) => e.roleKind === 'questioner')!
    const designer = list.find((e) => e.roleKind === 'designer')!
    // questioner is not re-targetable (阻塞-产出型)
    await expect(reassignTaskQuestion(db, questioner.id, 'fixer', ACTOR)).rejects.toThrow()
    // 'c1' is a clarify node, not an agent node
    await expect(reassignTaskQuestion(db, designer.id, 'c1', ACTOR)).rejects.toThrow()
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
    await stageTaskQuestion(db, entry!.id, true, ACTOR)
    expect((await listTaskQuestions(db, taskId))[0]!.phase).toBe('staged')
    await stageTaskQuestion(db, entry!.id, false, ACTOR)
    expect((await listTaskQuestions(db, taskId))[0]!.phase).toBe('pending')
  })
})

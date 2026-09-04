// RFC-359 —— 问题派发场景的双引擎夹具（移植自 rfc140-one-click-dispatch-all.test.ts 的种子）。
// 只用 provider-中立的 drizzle 写入，SQLite 与 PostgreSQL 共用。

import { eq } from 'drizzle-orm'
import { monotonicFactory } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  clarifyRounds,
  nodeRunOutputs,
  nodeRuns,
  taskQuestions,
  tasks,
  workflows,
} from '@/db/schema'
import { encodeLineageSlotPath } from '@/modules/task-execution/domain/executionIntent'
import type { ClarifyQuestion, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

const ulid = monotonicFactory()
export const ASKER = 'asker'
export const DESIGNER = 'designer'
export const OTHER = 'other'
export const CC = 'cc'
export const CL = 'cl'
export const DISPATCH_ACTOR = { userId: 'u1', role: 'owner' as const }

export function freshTaskId(): string {
  return `t_${ulid()}`
}

export function liveDef(): WorkflowDefinition {
  const nodes: WorkflowNode[] = [
    { id: ASKER, kind: 'agent-single', agentName: 'agent-asker' } as WorkflowNode,
    { id: DESIGNER, kind: 'agent-single', agentName: 'agent-designer' } as WorkflowNode,
    { id: OTHER, kind: 'agent-single', agentName: 'agent-other' } as WorkflowNode,
    { id: CC, kind: 'clarify-cross-agent', title: 'cc' } as WorkflowNode,
    { id: CL, kind: 'clarify', title: 'cl' } as WorkflowNode,
  ]
  return {
    $schema_version: 4,
    inputs: [],
    nodes,
    edges: [
      {
        id: 'e_dataflow',
        source: { nodeId: DESIGNER, portName: 'out' },
        target: { nodeId: ASKER, portName: 'in' },
      },
      {
        id: 'e_cc_designer',
        source: { nodeId: CC, portName: 'to_designer' },
        target: { nodeId: DESIGNER, portName: '__external_feedback__' },
      },
      {
        id: 'e_cc_questioner',
        source: { nodeId: CC, portName: 'to_questioner' },
        target: { nodeId: ASKER, portName: '__clarify_response__' },
      },
    ],
    outputs: [],
  } as unknown as WorkflowDefinition
}

export function mkQ(id: string): ClarifyQuestion {
  return {
    id,
    title: `${id}-title`,
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

export async function seedTask(db: ProviderNeutralDatabase, taskId: string): Promise<void> {
  const def = liveDef()
  await db.insert(workflows).values({
    id: `wf_${taskId}`,
    name: 'rfc359',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'rfc359',
    workflowId: `wf_${taskId}`,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/aw-rfc359-dispatch',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'awaiting_human',
    inputs: '{}',
    startedAt: Date.now(),
    // 决定路径的 continuation 准入要核对 lineage；SQLite 上有触发器回填这两列，PostgreSQL 还没有
    // （RFC-359 W3-T16b），夹具显式写全，两个引擎才是同一个起点。
    executionLineageId: taskId,
    lineageSlotPathJson: encodeLineageSlotPath([
      { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: null },
    ]),
  })
}

export async function seedRun(
  db: ProviderNeutralDatabase,
  taskId: string,
  nodeId: string,
  over: { status?: string; hasOutput?: boolean; rerunCause?: string } = {},
): Promise<string> {
  const id = ulid()
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId,
    status: (over.status ?? 'done') as 'done',
    retryIndex: 0,
    iteration: 0,
    ...(over.rerunCause ? { rerunCause: over.rerunCause } : {}),
  })
  if (over.hasOutput) {
    await db.insert(nodeRunOutputs).values({ nodeRunId: id, portName: 'out', content: 'x' })
  }
  return id
}

export async function seedRound(
  db: ProviderNeutralDatabase,
  taskId: string,
  kind: 'self' | 'cross',
  questions: ClarifyQuestion[],
  /** RFC-359 T2b：`awaiting_human` = 还没答的轮（澄清 node_run 也停在 awaiting_human），给快速澄清决定用。 */
  over: { status?: 'answered' | 'awaiting_human' } = {},
): Promise<{ roundId: string; origin: string }> {
  const open = over.status === 'awaiting_human'
  const askingRunId = await seedRun(db, taskId, kind === 'cross' ? ASKER : DESIGNER, {
    status: 'done',
  })
  const intRunId = await seedRun(db, taskId, kind === 'cross' ? CC : CL, {
    status: open ? 'awaiting_human' : 'done',
  })
  const roundId = ulid()
  await db.insert(clarifyRounds).values({
    id: roundId,
    taskId,
    kind,
    askingNodeId: kind === 'cross' ? ASKER : DESIGNER,
    askingNodeRunId: askingRunId,
    intermediaryNodeId: kind === 'cross' ? CC : CL,
    intermediaryNodeRunId: intRunId,
    targetConsumerNodeId: kind === 'cross' ? DESIGNER : null,
    iteration: 0,
    questionsJson: JSON.stringify(questions),
    answersJson: open ? '[]' : JSON.stringify(questions.map((q) => ans(q.id))),
    directive: 'continue',
    status: open ? 'awaiting_human' : 'answered',
    answeredAt: open ? null : Date.now(),
  })
  return { roundId, origin: intRunId }
}

export async function insertEntry(
  db: ProviderNeutralDatabase,
  taskId: string,
  e: {
    originNodeRunId: string
    questionId: string
    roleKind: 'self' | 'questioner' | 'designer'
    sourceKind?: 'self' | 'cross'
    defaultTargetNodeId: string | null
    stagedAt?: number | null
  },
): Promise<string> {
  const id = ulid()
  const now = Date.now()
  await db.insert(taskQuestions).values({
    id,
    taskId,
    originNodeRunId: e.originNodeRunId,
    questionId: e.questionId,
    questionTitle: `${e.questionId}-title`,
    sourceKind: e.sourceKind ?? 'cross',
    roleKind: e.roleKind,
    iteration: 0,
    loopIter: 0,
    defaultTargetNodeId: e.defaultTargetNodeId,
    overrideTargetNodeId: null,
    sealedAt: now,
    sealedBy: 'u1',
    dispatchedAt: null,
    dispatchedBy: null,
    stagedAt: e.stagedAt ?? null,
    stagedBy: e.stagedAt ? 'u1' : null,
    createdAt: now,
    updatedAt: now,
  })
  return id
}

export const entryById = async (db: ProviderNeutralDatabase, id: string) =>
  (await db.select().from(taskQuestions).where(eq(taskQuestions.id, id)))[0]

/** 混批夹具：DESIGNER home 上 self（clarify-answer）+ designer（cross-clarify-answer）两类 cause；
 *  self staged 更早 → aging 选 self 先发，designer 批被 defer。 */
export async function seedMixedBatch(
  db: ProviderNeutralDatabase,
  taskId: string,
): Promise<{ selfIds: string[]; designerIds: string[] }> {
  await seedTask(db, taskId)
  await seedRun(db, taskId, DESIGNER, { status: 'done', hasOutput: true })
  const self = await seedRound(db, taskId, 'self', [mkQ('sq1')])
  const cross = await seedRound(db, taskId, 'cross', [mkQ('dq1'), mkQ('dq2')])
  const selfIds = [
    await insertEntry(db, taskId, {
      originNodeRunId: self.origin,
      questionId: 'sq1',
      roleKind: 'self',
      sourceKind: 'self',
      defaultTargetNodeId: DESIGNER,
      stagedAt: Date.now() - 10_000,
    }),
  ]
  const designerIds: string[] = []
  for (const q of ['dq1', 'dq2']) {
    designerIds.push(
      await insertEntry(db, taskId, {
        originNodeRunId: cross.origin,
        questionId: q,
        roleKind: 'designer',
        defaultTargetNodeId: DESIGNER,
        stagedAt: Date.now(),
      }),
    )
  }
  return { selfIds, designerIds }
}

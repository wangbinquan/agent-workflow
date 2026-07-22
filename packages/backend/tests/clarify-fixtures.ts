// RFC-217 T8 — test fixtures for clarify rows AFTER the legacy tables dropped
// (the real RFC-058 T17). Helpers accept the LEGACY column names dozens of
// fixtures already use, so the migration sweep is a call-site rename instead
// of a 51-file reshape; internally everything lands in `clarify_rounds`.

import { clarifyRounds, nodeRuns } from '../src/db/schema'
import type { DbClient } from '../src/db/client'

type DbLike = Pick<DbClient, 'insert'>

export interface LegacySelfClarifyValues {
  id: string
  taskId: string
  sourceAgentNodeId: string
  sourceAgentNodeRunId: string
  sourceShardKey?: string | null
  clarifyNodeId: string
  clarifyNodeRunId: string
  iterationIndex?: number
  questionsJson: string
  answersJson?: string | null
  status?: 'awaiting_human' | 'answered' | 'canceled'
  truncationWarningsJson?: string | null
  createdAt?: number
  answeredAt?: number | null
  answeredBy?: string | null
  directive?: 'continue' | 'stop' | null
}

/**
 * 遗留 clarify 表没有 FK；clarify_rounds 两个 run 列都有（0031 起）。老夹具
 * 大量用假 run id——这里替它们补最小 node_run 桩（INSERT OR IGNORE 语义），
 * 保住测试意图而不逐文件手补。
 */
async function ensureRunStubs(
  db: DbLike,
  taskId: string,
  runIds: Array<string | null>,
): Promise<void> {
  for (const id of runIds) {
    if (id === null || id === '') continue
    await (db as unknown as DbClient)
      .insert(nodeRuns)
      .values({ id, taskId, nodeId: `stub:${id}`, status: 'done', retryIndex: 0, iteration: 0 })
      .onConflictDoNothing()
  }
}

export async function insertLegacySelfClarify(
  db: DbLike,
  v: LegacySelfClarifyValues,
): Promise<void> {
  await ensureRunStubs(db, v.taskId, [v.sourceAgentNodeRunId, v.clarifyNodeRunId])
  await db.insert(clarifyRounds).values({
    id: v.id,
    taskId: v.taskId,
    kind: 'self',
    askingNodeId: v.sourceAgentNodeId,
    askingNodeRunId: v.sourceAgentNodeRunId,
    askingShardKey: v.sourceShardKey ?? null,
    intermediaryNodeId: v.clarifyNodeId,
    intermediaryNodeRunId: v.clarifyNodeRunId,
    loopIter: 0,
    iteration: v.iterationIndex ?? 0,
    questionsJson: v.questionsJson,
    answersJson: v.answersJson ?? null,
    status: v.status ?? 'awaiting_human',
    truncationWarningsJson: v.truncationWarningsJson ?? null,
    createdAt: v.createdAt ?? Date.now(),
    answeredAt: v.answeredAt ?? null,
    answeredBy: v.answeredBy ?? null,
    directive: v.directive ?? null,
  })
}

export interface LegacyCrossClarifyValues {
  id: string
  taskId: string
  crossClarifyNodeId: string
  crossClarifyNodeRunId: string
  sourceQuestionerNodeId: string
  sourceQuestionerNodeRunId: string
  targetDesignerNodeId?: string | null
  loopIter?: number
  iteration?: number
  questionsJson: string
  answersJson?: string | null
  directive?: 'continue' | 'stop' | null
  status?: 'awaiting_human' | 'answered' | 'abandoned'
  designerRunTriggeredAt?: number | null
  createdAt?: number
  answeredAt?: number | null
  abandonedAt?: number | null
}

export async function insertLegacyCrossClarify(
  db: DbLike,
  v: LegacyCrossClarifyValues,
): Promise<void> {
  await ensureRunStubs(db, v.taskId, [v.sourceQuestionerNodeRunId, v.crossClarifyNodeRunId])
  await db.insert(clarifyRounds).values({
    id: v.id,
    taskId: v.taskId,
    kind: 'cross',
    askingNodeId: v.sourceQuestionerNodeId,
    askingNodeRunId: v.sourceQuestionerNodeRunId,
    askingShardKey: null,
    intermediaryNodeId: v.crossClarifyNodeId,
    intermediaryNodeRunId: v.crossClarifyNodeRunId,
    targetConsumerNodeId: v.targetDesignerNodeId ?? null,
    loopIter: v.loopIter ?? 0,
    iteration: v.iteration ?? 0,
    questionsJson: v.questionsJson,
    answersJson: v.answersJson ?? null,
    directive: v.directive ?? null,
    status: v.status ?? 'awaiting_human',
    designerRunTriggeredAt: v.designerRunTriggeredAt ?? null,
    createdAt: v.createdAt ?? Date.now(),
    answeredAt: v.answeredAt ?? null,
    abandonedAt: v.abandonedAt ?? null,
  })
}

/** rounds 键名直插（含 run 桩）——给已经手写统一表形状的夹具用。 */
export async function insertClarifyRoundRaw(
  db: DbLike,
  v: typeof clarifyRounds.$inferInsert,
): Promise<void> {
  await ensureRunStubs(db, v.taskId, [v.askingNodeRunId ?? null, v.intermediaryNodeRunId ?? null])
  await db.insert(clarifyRounds).values(v)
}

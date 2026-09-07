// RFC-359 W9 —— 协作已提交事件的 WS 投影：**一份实现，两个 provider 共用**。
//
// 合一前这里是一对适配器：本文件里的 `createSqliteCollaborationCommittedEventProjection`
// （bun:sqlite 同步 `.get()` / `.all()`）与 `postgresqlCollaborationCommittedEventProjection.ts`
// （273 行把同一批语义用异步 drizzle 重写了一遍）。两份逐帧对应、没有能力缺口，但那份重写
// **从未在真数据库上跑过**——它唯一的用例只对源码文本做断言。2026-09-07 的双引擎对拍
// （`tests/rfc359-w9-collaboration-committed-event-projection-conformance.test.ts`）把两份
// 各自在自己的引擎上跑了一遍，17 个场景逐帧相同：这一对**确实**没有分叉，于是按 PG 那份的
// 异步形状收成一份中立实现（`ProviderNeutralDatabase` + `engineOf(db)` 的 NULL 排序）。
//
// 唯一被丢掉的是 SQLite 那份多出来的 `questionIds` 前置过滤：`reruns[].entryIds` 由
// `dispatchedReruns` 生成、`questionIds = dispatchIds ∪ deferredEntryIds`
// （`taskQuestionDispatch.ts:1566` / `:1624`），因此
// `reruns[].entryIds ⊆ questionIds` 恒成立，那道过滤**可证冗余**。
//
// 两处 NULL 排序必须显式写出 SQLite 语义（能力矩阵的 `ascNullsFirst` / `descNullsLast`；
// RFC-359 W11 起那是唯一的渲染处，此前另有一份独立原件）：
// 评审门挑「哪一份待审文档」的 `item_index ASC`（NULL = RFC-079 单文档判别位）与澄清决定
// 回落读模型时的 `dispatched_at DESC`（NULL = 尚未下发）。两条都在对拍里带变异验证。

import type {
  ClarifyAnswer,
  ClarifyQuestion,
  ClarifySession,
  ClarifySessionSummary,
  ClarifyTruncationWarning,
  TaskWsMessage,
  WorkflowDefinition,
} from '@agent-workflow/shared'
import { and, asc, desc, eq, gte, isNotNull } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { clarifyRounds, committedEvents, docVersions, taskQuestions, tasks } from '@/db/schema'
import { engineOf } from '@/platform/persistence/databaseTransaction'
import type { CommittedEventConsumerDefinition } from '@/platform/events/committed/types'
import { TASK_CHANNEL, taskBroadcaster } from '@/ws/broadcaster'
import {
  COLLABORATION_COMMITTED_EVENT_TYPES,
  decodeCollaborationCommittedEvent,
  type CollaborationCommittedV1,
  type CollaborationProjectionFrame,
} from '../domain/collaborationCommittedEvent'
import type { CollaborationCommittedEventProjection } from '../application/ports/collaborationCommittedEventProjection'

function parseArray<T>(value: string | null): T[] | undefined {
  if (value === null) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? (parsed as T[]) : undefined
  } catch {
    return undefined
  }
}

function nodeTitle(snapshot: string, nodeId: string): string | null {
  try {
    const workflow = JSON.parse(snapshot) as WorkflowDefinition
    const value = workflow.nodes.find((node) => node.id === nodeId)?.title?.trim()
    return value === undefined || value.length === 0 ? null : value
  } catch {
    return null
  }
}

function selfSummary(
  round: typeof clarifyRounds.$inferSelect,
  task: Pick<typeof tasks.$inferSelect, 'name' | 'workflowSnapshot'>,
): ClarifySessionSummary {
  return {
    id: round.id,
    taskId: round.taskId,
    taskName: task.name,
    sourceAgentNodeId: round.askingNodeId,
    sourceAgentNodeTitle: nodeTitle(task.workflowSnapshot, round.askingNodeId),
    sourceShardKey: round.askingShardKey,
    clarifyNodeId: round.intermediaryNodeId,
    clarifyNodeTitle: nodeTitle(task.workflowSnapshot, round.intermediaryNodeId),
    clarifyNodeRunId: round.intermediaryNodeRunId,
    iterationIndex: round.iteration,
    questionCount: parseArray<ClarifyQuestion>(round.questionsJson)?.length ?? 0,
    status: round.status as ClarifySessionSummary['status'],
    createdAt: round.createdAt,
    answeredAt: round.answeredAt,
  }
}

function selfSession(round: typeof clarifyRounds.$inferSelect): ClarifySession {
  const session: ClarifySession = {
    id: round.id,
    taskId: round.taskId,
    sourceAgentNodeId: round.askingNodeId,
    sourceAgentNodeRunId: round.askingNodeRunId,
    sourceShardKey: round.askingShardKey,
    clarifyNodeId: round.intermediaryNodeId,
    clarifyNodeRunId: round.intermediaryNodeRunId,
    iterationIndex: round.iteration,
    questions: parseArray<ClarifyQuestion>(round.questionsJson) ?? [],
    status: round.status as ClarifySession['status'],
    createdAt: round.createdAt,
    answeredAt: round.answeredAt,
    answeredBy: round.answeredBy,
    directive: round.directive,
  }
  const answers = parseArray<ClarifyAnswer>(round.answersJson)
  if (answers !== undefined) session.answers = answers
  const warnings = parseArray<ClarifyTruncationWarning>(round.truncationWarningsJson)
  if (warnings !== undefined && warnings.length > 0) session.truncationWarnings = warnings
  return session
}

async function openFrames(
  db: ProviderNeutralDatabase,
  event: CollaborationCommittedV1,
): Promise<readonly CollaborationProjectionFrame[]> {
  const gate = event.payload.gate
  if (event.family === 'review') {
    const document = (
      await db
        .select()
        .from(docVersions)
        .where(
          and(eq(docVersions.reviewNodeRunId, gate.nodeRunId), eq(docVersions.decision, 'pending')),
        )
        // `item_index IS NULL` 是 RFC-079 的单文档判别位，SQLite 的 ASC 把它排最前。
        .orderBy(engineOf(db).ascNullsFirst(docVersions.itemIndex), asc(docVersions.versionIndex))
        .limit(1)
    )[0]
    if (document === undefined) return []
    return [
      {
        id: -1,
        type: 'review.created',
        nodeRunId: gate.nodeRunId,
        reviewNodeId: document.reviewNodeId,
        docVersionId: document.id,
        versionIndex: document.versionIndex,
        reviewIteration: document.reviewIteration,
      },
    ]
  }
  if (event.family !== 'clarify') return []
  const round = (
    await db
      .select()
      .from(clarifyRounds)
      .where(eq(clarifyRounds.id, gate.roundId ?? gate.gateId))
      .limit(1)
  )[0]
  if (round === undefined) return []
  if (round.kind === 'cross') {
    return [
      {
        id: -1,
        type: 'cross-clarify.created',
        nodeRunId: round.intermediaryNodeRunId,
        crossClarifyNodeId: round.intermediaryNodeId,
        sessionId: round.id,
        iteration: round.iteration,
        sourceQuestionerNodeId: round.askingNodeId,
        targetDesignerNodeId: round.targetConsumerNodeId,
      },
    ]
  }
  const task = (
    await db
      .select({ name: tasks.name, workflowSnapshot: tasks.workflowSnapshot })
      .from(tasks)
      .where(eq(tasks.id, round.taskId))
      .limit(1)
  )[0]
  if (task === undefined) return []
  return [
    {
      id: -1,
      type: 'clarify.created',
      nodeRunId: round.intermediaryNodeRunId,
      clarifyNodeId: round.intermediaryNodeId,
      sourceShardKey: round.askingShardKey,
      iterationIndex: round.iteration,
      session: selfSummary(round, task),
    },
  ]
}

async function clarifyDecisionFrames(
  db: ProviderNeutralDatabase,
  event: CollaborationCommittedV1,
): Promise<readonly CollaborationProjectionFrame[]> {
  if (
    event.type !== 'collaboration.human-gate-decision-committed.v1' ||
    event.family !== 'clarify' ||
    event.payload.gateStatus === 'deferred'
  ) {
    return []
  }
  const gate = event.payload.gate
  const round = (
    await db
      .select()
      .from(clarifyRounds)
      .where(eq(clarifyRounds.id, gate.roundId ?? gate.gateId))
      .limit(1)
  )[0]
  if (round === undefined || round.status !== 'answered') return []
  const triggered = (
    await db
      .select({ triggerRunId: taskQuestions.triggerRunId })
      .from(taskQuestions)
      .where(
        and(
          eq(taskQuestions.originNodeRunId, round.intermediaryNodeRunId),
          isNotNull(taskQuestions.triggerRunId),
        ),
      )
      // 未下发的条目 `dispatched_at IS NULL`，SQLite 的 DESC 把它们排最后。
      .orderBy(
        engineOf(db).descNullsLast(taskQuestions.dispatchedAt),
        desc(taskQuestions.updatedAt),
      )
      .limit(1)
  )[0]?.triggerRunId
  const committedRerunNodeRunId = await (async () => {
    const roundEntryIds = new Set(
      (
        await db
          .select({ id: taskQuestions.id })
          .from(taskQuestions)
          .where(eq(taskQuestions.originNodeRunId, round.intermediaryNodeRunId))
      ).map((row) => row.id),
    )
    if (roundEntryIds.size === 0) return null
    // The clarify decision and its follow-up question dispatch intentionally
    // have different gate-node correlation refs. Match the immutable question
    // ids instead; they are globally unique and preserve the exact rerun even
    // when the two commits belong to different gate aggregates.
    const dispatchEvents = await db
      .select({ payloadJson: committedEvents.payloadJson })
      .from(committedEvents)
      .where(
        and(
          eq(committedEvents.producer, 'collaboration'),
          eq(committedEvents.family, 'questions'),
          eq(committedEvents.eventType, 'collaboration.question-dispatch-committed.v1'),
          gte(committedEvents.occurredAt, Date.parse(event.occurredAt)),
        ),
      )
      .orderBy(asc(committedEvents.occurredAt), asc(committedEvents.createdAt))
      .limit(256)
    for (const stored of dispatchEvents) {
      try {
        const dispatchEvent = decodeCollaborationCommittedEvent(JSON.parse(stored.payloadJson))
        if (dispatchEvent.type !== 'collaboration.question-dispatch-committed.v1') continue
        const payload = dispatchEvent.payload
        if (!payload.questionIds.some((entryId) => roundEntryIds.has(entryId))) continue
        const rerun = payload.reruns.find((candidate) =>
          candidate.entryIds.some((entryId) => roundEntryIds.has(entryId)),
        )
        if (rerun !== undefined) return rerun.nodeRunId
      } catch {
        // A malformed immutable event is handled by its durable delivery. The
        // ephemeral compatibility projection falls back to the read model.
      }
    }
    return null
  })()
  const rerunNodeRunId = committedRerunNodeRunId ?? triggered ?? ''
  if (round.kind === 'self') {
    return [
      {
        id: -1,
        type: 'clarify.answered',
        nodeRunId: round.intermediaryNodeRunId,
        clarifyNodeId: round.intermediaryNodeId,
        sourceShardKey: round.askingShardKey,
        iterationIndex: round.iteration,
        rerunNodeRunId,
        session: selfSession(round),
      },
    ]
  }
  const frames: CollaborationProjectionFrame[] = [
    {
      id: -1,
      type: 'cross-clarify.answered',
      nodeRunId: round.intermediaryNodeRunId,
      sessionId: round.id,
      iteration: round.iteration,
      directive: round.directive ?? 'continue',
    },
  ]
  if (round.directive === 'stop') {
    frames.push({
      id: -1,
      type: 'cross-clarify.rejected',
      nodeRunId: round.intermediaryNodeRunId,
      sessionId: round.id,
      questionerNodeRunId: rerunNodeRunId,
    })
  }
  return frames
}

async function projectionFrames(
  db: ProviderNeutralDatabase,
  event: CollaborationCommittedV1,
): Promise<readonly CollaborationProjectionFrame[]> {
  if (event.payload.projectionFrames.length > 0) return event.payload.projectionFrames
  if (event.type === 'collaboration.human-gate-opened.v1') return await openFrames(db, event)
  return await clarifyDecisionFrames(db, event)
}

export function createCollaborationCommittedEventProjection(
  db: ProviderNeutralDatabase,
): CollaborationCommittedEventProjection {
  return Object.freeze({
    async frames(event: CollaborationCommittedV1) {
      return await projectionFrames(db, event)
    },
  })
}

export function createCollaborationWsProjector(
  projection: CollaborationCommittedEventProjection,
): CommittedEventConsumerDefinition {
  return {
    id: 'collaboration-ws-projector',
    eventTypes: COLLABORATION_COMMITTED_EVENT_TYPES,
    deliveryClass: 'ephemeral',
    settle: 'projection-attempted',
    async handle(value) {
      const event = decodeCollaborationCommittedEvent(value)
      for (const frame of await projection.frames(event)) {
        taskBroadcaster.broadcast(TASK_CHANNEL(event.payload.gate.taskId), frame as TaskWsMessage)
      }
    },
  }
}

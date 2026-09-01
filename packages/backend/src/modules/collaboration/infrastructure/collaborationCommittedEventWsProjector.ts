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

import type { DbClient } from '@/db/client'
import { clarifyRounds, committedEvents, docVersions, taskQuestions, tasks } from '@/db/schema'
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

function openFrames(
  db: DbClient,
  event: CollaborationCommittedV1,
): readonly CollaborationProjectionFrame[] {
  const gate = event.payload.gate
  if (event.family === 'review') {
    const document = db
      .select()
      .from(docVersions)
      .where(
        and(eq(docVersions.reviewNodeRunId, gate.nodeRunId), eq(docVersions.decision, 'pending')),
      )
      .orderBy(asc(docVersions.itemIndex), asc(docVersions.versionIndex))
      .limit(1)
      .get()
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
  const round = db
    .select()
    .from(clarifyRounds)
    .where(eq(clarifyRounds.id, gate.roundId ?? gate.gateId))
    .get()
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
  const task = db
    .select({ name: tasks.name, workflowSnapshot: tasks.workflowSnapshot })
    .from(tasks)
    .where(eq(tasks.id, round.taskId))
    .get()
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

function clarifyDecisionFrames(
  db: DbClient,
  event: CollaborationCommittedV1,
): readonly CollaborationProjectionFrame[] {
  if (
    event.type !== 'collaboration.human-gate-decision-committed.v1' ||
    event.family !== 'clarify' ||
    event.payload.gateStatus === 'deferred'
  ) {
    return []
  }
  const gate = event.payload.gate
  const round = db
    .select()
    .from(clarifyRounds)
    .where(eq(clarifyRounds.id, gate.roundId ?? gate.gateId))
    .get()
  if (round === undefined || round.status !== 'answered') return []
  const triggered = db
    .select({ triggerRunId: taskQuestions.triggerRunId })
    .from(taskQuestions)
    .where(
      and(
        eq(taskQuestions.originNodeRunId, round.intermediaryNodeRunId),
        isNotNull(taskQuestions.triggerRunId),
      ),
    )
    .orderBy(desc(taskQuestions.dispatchedAt), desc(taskQuestions.updatedAt))
    .limit(1)
    .get()?.triggerRunId
  const committedRerunNodeRunId = (() => {
    const roundEntryIds = new Set(
      db
        .select({ id: taskQuestions.id })
        .from(taskQuestions)
        .where(eq(taskQuestions.originNodeRunId, round.intermediaryNodeRunId))
        .all()
        .map((row) => row.id),
    )
    if (roundEntryIds.size === 0) return null
    // The clarify decision and its follow-up question dispatch intentionally
    // have different gate-node correlation refs. Match the immutable question
    // ids instead; they are globally unique and preserve the exact rerun even
    // when the two commits belong to different gate aggregates.
    const dispatchEvents = db
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
      .all()
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

function projectionFrames(
  db: DbClient,
  event: CollaborationCommittedV1,
): readonly CollaborationProjectionFrame[] {
  if (event.payload.projectionFrames.length > 0) return event.payload.projectionFrames
  if (event.type === 'collaboration.human-gate-opened.v1') return openFrames(db, event)
  return clarifyDecisionFrames(db, event)
}

export function createSqliteCollaborationCommittedEventProjection(
  db: DbClient,
): CollaborationCommittedEventProjection {
  return Object.freeze({
    async frames(event: CollaborationCommittedV1) {
      return projectionFrames(db, event)
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

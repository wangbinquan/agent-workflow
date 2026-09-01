import type {
  ClarifyAnswer,
  ClarifyQuestion,
  ClarifySession,
  ClarifySessionSummary,
  ClarifyTruncationWarning,
  WorkflowDefinition,
} from '@agent-workflow/shared'
import { and, asc, desc, eq, gte, isNotNull } from 'drizzle-orm'

import { clarifyRounds, committedEvents, docVersions, taskQuestions, tasks } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { CollaborationCommittedEventProjection } from '../application/ports/collaborationCommittedEventProjection'
import {
  decodeCollaborationCommittedEvent,
  type CollaborationCommittedV1,
  type CollaborationProjectionFrame,
} from '../domain/collaborationCommittedEvent'

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
    const definition = JSON.parse(snapshot) as WorkflowDefinition
    const title = definition.nodes.find((node) => node.id === nodeId)?.title?.trim()
    return title === undefined || title.length === 0 ? null : title
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
  const result: ClarifySession = {
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
  if (answers !== undefined) result.answers = answers
  const warnings = parseArray<ClarifyTruncationWarning>(round.truncationWarningsJson)
  if (warnings !== undefined && warnings.length > 0) result.truncationWarnings = warnings
  return result
}

async function openFrames(
  db: PostgresqlDatabaseClient,
  event: CollaborationCommittedV1,
): Promise<readonly CollaborationProjectionFrame[]> {
  const gate = event.payload.gate
  if (event.family === 'review') {
    const documents = await db
      .select()
      .from(docVersions)
      .where(
        and(eq(docVersions.reviewNodeRunId, gate.nodeRunId), eq(docVersions.decision, 'pending')),
      )
      .orderBy(asc(docVersions.itemIndex), asc(docVersions.versionIndex))
      .limit(1)
    const document = documents[0]
    return document === undefined
      ? []
      : [
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
  const rounds = await db
    .select()
    .from(clarifyRounds)
    .where(eq(clarifyRounds.id, gate.roundId ?? gate.gateId))
    .limit(1)
  const round = rounds[0]
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
  const taskRows = await db
    .select({ name: tasks.name, workflowSnapshot: tasks.workflowSnapshot })
    .from(tasks)
    .where(eq(tasks.id, round.taskId))
    .limit(1)
  return taskRows[0] === undefined
    ? []
    : [
        {
          id: -1,
          type: 'clarify.created',
          nodeRunId: round.intermediaryNodeRunId,
          clarifyNodeId: round.intermediaryNodeId,
          sourceShardKey: round.askingShardKey,
          iterationIndex: round.iteration,
          session: selfSummary(round, taskRows[0]),
        },
      ]
}

async function decisionFrames(
  db: PostgresqlDatabaseClient,
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
  const rounds = await db
    .select()
    .from(clarifyRounds)
    .where(eq(clarifyRounds.id, gate.roundId ?? gate.gateId))
    .limit(1)
  const round = rounds[0]
  if (round === undefined || round.status !== 'answered') return []
  const triggers = await db
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
  const entries = await db
    .select({ id: taskQuestions.id })
    .from(taskQuestions)
    .where(eq(taskQuestions.originNodeRunId, round.intermediaryNodeRunId))
  const entryIds = new Set(entries.map((entry) => entry.id))
  let committedRerunNodeRunId: string | null = null
  if (entryIds.size > 0) {
    const events = await db
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
    for (const stored of events) {
      try {
        const dispatched = decodeCollaborationCommittedEvent(JSON.parse(stored.payloadJson))
        if (dispatched.type !== 'collaboration.question-dispatch-committed.v1') continue
        const rerun = dispatched.payload.reruns.find((candidate) =>
          candidate.entryIds.some((entryId) => entryIds.has(entryId)),
        )
        if (rerun !== undefined) {
          committedRerunNodeRunId = rerun.nodeRunId
          break
        }
      } catch {
        // Durable delivery owns malformed immutable events; projection falls
        // back to the current question read model.
      }
    }
  }
  const rerunNodeRunId = committedRerunNodeRunId ?? triggers[0]?.triggerRunId ?? ''
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

export function createPostgresqlCollaborationCommittedEventProjection(
  db: PostgresqlDatabaseClient,
): CollaborationCommittedEventProjection {
  return Object.freeze({
    async frames(event: CollaborationCommittedV1) {
      if (event.payload.projectionFrames.length > 0) return event.payload.projectionFrames
      return event.type === 'collaboration.human-gate-opened.v1'
        ? await openFrames(db, event)
        : await decisionFrames(db, event)
    },
  })
}

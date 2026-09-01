import {
  ClarifyAnswerSchema,
  ReviewAuthorRoleSchema,
  TERMINAL_TASK_STATUSES,
  TaskActorRoleSchema,
  canReassign,
  deriveQuestionPhase,
  extractDocTitle,
  isTerminalTaskStatus,
  isTurnEngineWorkgroupTask,
  mergeSealedAnswers,
  reconcileDesiredEntries,
  resolveHandlerRun,
  selectCurrentReviewRound,
  terminatedAsForStatus,
  wgClarifyAskerKey,
  type ClarifyAnswer,
  type ClarifyAnswerAttributions,
  type ClarifyDirective,
  type ClarifyDraftValue,
  type ClarifyQuestion,
  type ClarifyRound,
  type ClarifyRoundSummary,
  type ClarifyTruncationWarning,
  type DocVersion,
  type DocVersionDecision,
  type HandlerRunView,
  type ReviewComment,
  type ReviewCommentAnchor,
  type ReviewDetail,
  type ReviewDocumentSummary,
  type ReviewRoundMember,
  type ReviewRoundSummary,
  type ReviewSummary,
  type RunLineageView,
  type TaskActorRole,
  type TaskQuestionPhase,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import { and, asc, desc, eq, inArray, isNull, notInArray, or, sql } from 'drizzle-orm'
import { ulid } from 'ulid'

import {
  clarifyRounds,
  docVersions,
  nodeRunOutputs,
  nodeRuns,
  reviewComments,
  reviewNodeReviewers,
  taskQuestions,
  taskNodeClarifyDirectives,
  tasks,
  workflows,
} from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { publishCommittedEventsAfterCommit } from '@/platform/events/committed/runtime'
import {
  appendPostgresqlCommittedEventTx,
  type PostgresqlCommittedEventTransaction,
} from '@/platform/events/committed/postgresqlPersistence'
import { committedEventGroupId, type CommittedEventRef } from '@/platform/events/committed/types'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/util/errors'
import { TASK_QUESTION_CONFLICT } from '@/services/taskQuestionConflicts'
import type { NodeRunLifecycleParticipantInTx } from '@/modules/task-execution/public/commands'
import type {
  AddedReviewComment,
  CollaborationClarifyDraftEventPublisher,
  CollaborationRouteActor,
  CollaborationRoutePersistenceOperations,
  CollaborationTaskQuestionView,
  ListClarifySummariesInput,
  ListReviewSummariesInput,
  ReassignTaskQuestionAction,
  ReviewCommentWriteAuthority,
  SaveClarifyDraftInput,
  SealClarifyQuestionsInput,
  SealClarifyQuestionsResult,
} from '../application/ports/collaborationRouteOperations'
import type { CollaborationTaskAccessPort } from '../application/ports/collaborationTaskAccess'
import {
  collaborationDurableConsumers,
  type CollaborationGateRefV1,
  type CollaborationProjectionFrame,
} from '../domain/collaborationCommittedEvent'
import { buildReviewAnchorDocument, resolveReviewAnchor } from '../domain/reviewAnchor'
import { PostgresqlCommittedReviewArtifactReader } from './postgresqlCommittedReviewArtifactReader'
import { PostgresqlManualQuestionOpenWriter } from './postgresqlManualQuestionOpenWriter'

type PgTx = Parameters<Parameters<PostgresqlDatabaseClient['transaction']>[0]>[0]
type DocVersionRow = typeof docVersions.$inferSelect
type NodeRunRow = typeof nodeRuns.$inferSelect
type TaskQuestionRow = typeof taskQuestions.$inferSelect
type ClarifyRoundRow = typeof clarifyRounds.$inferSelect

const LOCAL_DECIDER = 'local'

function isRetryablePostgresqlError(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth += 1) {
    const code = Reflect.get(current, 'code')
    if (code === '40001' || code === '40P01') return true
    current = Reflect.get(current, 'cause')
  }
  return false
}

async function serializable<T>(db: PostgresqlDatabaseClient, body: (tx: PgTx) => Promise<T>) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await db.transaction(async (tx) => {
        await tx.run(sql.raw('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE'))
        return await body(tx)
      })
    } catch (error) {
      if (attempt < 2 && isRetryablePostgresqlError(error)) continue
      throw error
    }
  }
}

function parseJsonArray<T>(raw: string | null): T[] {
  if (raw === null) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

function parseJsonRecord<T>(raw: string | null): T | null {
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as T)
      : null
  } catch {
    return null
  }
}

function rowToDocVersion(row: DocVersionRow): DocVersion {
  return {
    id: row.id,
    taskId: row.taskId,
    reviewNodeId: row.reviewNodeId,
    reviewNodeRunId: row.reviewNodeRunId,
    sourceNodeId: row.sourceNodeId,
    sourcePortName: row.sourcePortName,
    versionIndex: row.versionIndex,
    reviewIteration: row.reviewIteration,
    bodyPath: row.bodyPath,
    commentsJson: row.commentsJson,
    decision: row.decision,
    decisionReason: row.decisionReason,
    promptSnapshot: row.promptSnapshot,
    sourceFilePath: row.sourceFilePath,
    itemIndex: row.itemIndex,
    selection: row.selection,
    itemPath: row.itemPath,
    selectionStale: row.selectionStale ?? null,
    createdAt: row.createdAt,
    decidedAt: row.decidedAt,
    decidedBy: row.decidedBy,
    decidedByRole: row.decidedByRole === null ? null : TaskActorRoleSchema.parse(row.decidedByRole),
  }
}

function rowToReviewComment(row: typeof reviewComments.$inferSelect): ReviewComment {
  return {
    id: row.id,
    docVersionId: row.docVersionId,
    anchor: {
      sectionPath: row.anchorSectionPath,
      paragraphIdx: row.anchorParagraphIdx,
      offsetStart: row.anchorOffsetStart,
      offsetEnd: row.anchorOffsetEnd,
      selectedText: row.selectedText,
      contextBefore: row.contextBefore,
      contextAfter: row.contextAfter,
      occurrenceIndex: row.occurrenceIndex,
    },
    commentText: row.commentText,
    author: row.author,
    authorRole: row.authorRole === null ? null : ReviewAuthorRoleSchema.parse(row.authorRole),
    createdAt: row.createdAt,
  }
}

function resolveReviewRoundMode(
  rows: ReadonlyArray<{ readonly itemIndex?: number | null; readonly itemPath?: string | null }>,
): 'single' | 'multi-inline' | 'multi-path' {
  if (!rows.some((row) => row.itemIndex !== null && row.itemIndex !== undefined)) return 'single'
  return rows.every((row) => (row.itemPath ?? null) === null) ? 'multi-inline' : 'multi-path'
}

function parseReviewNodeMeta(
  workflowSnapshot: string,
): Map<string, { title: string; description: string }> {
  const result = new Map<string, { title: string; description: string }>()
  try {
    const definition = JSON.parse(workflowSnapshot) as WorkflowDefinition
    for (const node of definition.nodes ?? []) {
      if (node.kind !== 'review') continue
      result.set(node.id, {
        title: typeof node.title === 'string' ? node.title : '',
        description: typeof node.description === 'string' ? node.description : '',
      })
    }
  } catch {
    // Corrupt frozen snapshots retain the historical id/empty fallback.
  }
  return result
}

function reviewSummary(
  version: DocVersionRow,
  run: Pick<NodeRunRow, 'status' | 'reviewIteration' | 'shardKey'>,
  task: Pick<typeof tasks.$inferSelect, 'id' | 'name' | 'workflowId' | 'status'>,
  workflow: Pick<typeof workflows.$inferSelect, 'name'>,
  nodeMeta: { readonly title: string; readonly description: string } | undefined,
): ReviewSummary {
  const title = nodeMeta?.title.trim() ?? ''
  return {
    nodeRunId: version.reviewNodeRunId,
    taskId: version.taskId,
    taskName: task.name,
    workflowId: task.workflowId,
    workflowName: workflow.name,
    reviewNodeId: version.reviewNodeId,
    title: title.length > 0 ? nodeMeta!.title : version.reviewNodeId,
    description: nodeMeta?.description ?? '',
    currentVersionIndex: version.versionIndex,
    reviewIteration: run.reviewIteration,
    decision: version.decision,
    awaitingReview: run.status === 'awaiting_review' && version.decision === 'pending',
    shardKey: run.shardKey,
    isMultiDoc: resolveReviewRoundMode([version]) !== 'single',
    createdAt: version.createdAt,
    decidedAt: version.decidedAt,
  }
}

async function listPostgresqlReviewSummaries(
  db: PostgresqlDatabaseClient,
  filter: ListReviewSummariesInput,
): Promise<ReviewSummary[]> {
  const pending = filter.status === 'pending'
  const base = db
    .select()
    .from(docVersions)
    .where(pending ? eq(docVersions.decision, 'pending') : undefined)
    .orderBy(desc(docVersions.createdAt))
  const versions =
    pending || filter.unbounded === true ? await base : await base.limit(filter.limit ?? 100)
  if (versions.length === 0) return []

  const runIds = [...new Set(versions.map((row) => row.reviewNodeRunId))]
  const runRows = await db
    .select({
      id: nodeRuns.id,
      status: nodeRuns.status,
      reviewIteration: nodeRuns.reviewIteration,
      shardKey: nodeRuns.shardKey,
    })
    .from(nodeRuns)
    .where(inArray(nodeRuns.id, runIds))
  const runs = new Map(runRows.map((row) => [row.id, row]))
  const taskIds = [...new Set(versions.map((row) => row.taskId))]
  const taskRows = await db
    .select({
      id: tasks.id,
      name: tasks.name,
      workflowId: tasks.workflowId,
      status: tasks.status,
      workflowSnapshot: tasks.workflowSnapshot,
    })
    .from(tasks)
    .where(inArray(tasks.id, taskIds))
  const taskById = new Map(taskRows.map((row) => [row.id, row]))
  const workflowIds = [...new Set(taskRows.map((row) => row.workflowId))]
  const workflowRows =
    workflowIds.length === 0
      ? []
      : await db
          .select({ id: workflows.id, name: workflows.name })
          .from(workflows)
          .where(inArray(workflows.id, workflowIds))
  const workflowsById = new Map(workflowRows.map((row) => [row.id, row]))
  const nodeMetaByTask = new Map(
    taskRows.map((row) => [row.id, parseReviewNodeMeta(row.workflowSnapshot)]),
  )
  const latestPerPort = new Map<string, DocVersionRow>()
  for (const version of versions) {
    const key = `${version.reviewNodeRunId}:${version.sourcePortName}`
    const current = latestPerPort.get(key)
    if (current === undefined || version.versionIndex > current.versionIndex) {
      latestPerPort.set(key, version)
    }
  }

  const result: ReviewSummary[] = []
  for (const version of latestPerPort.values()) {
    const run = runs.get(version.reviewNodeRunId)
    const task = taskById.get(version.taskId)
    const workflow = task === undefined ? undefined : workflowsById.get(task.workflowId)
    if (run === undefined || task === undefined || workflow === undefined) continue
    const awaiting = run.status === 'awaiting_review' && version.decision === 'pending'
    if (pending && isTerminalTaskStatus(task.status)) continue
    if (filter.status !== undefined && filter.status !== 'all') {
      if (filter.status === 'pending' && !awaiting) continue
      if (filter.status !== 'pending' && version.decision !== filter.status) continue
    }
    if (filter.taskId !== undefined && filter.taskId !== task.id) continue
    if (filter.workflowId !== undefined && filter.workflowId !== task.workflowId) continue
    result.push(
      reviewSummary(
        version,
        run,
        task,
        workflow,
        nodeMetaByTask.get(task.id)?.get(version.reviewNodeId),
      ),
    )
  }
  return pending && filter.unbounded !== true ? result.slice(0, filter.limit ?? 100) : result
}

async function countPostgresqlPendingReviews(
  db: PostgresqlDatabaseClient,
  taskAccess: Pick<CollaborationTaskAccessPort, 'visibleTaskIds'>,
  actor: CollaborationRouteActor,
): Promise<number> {
  const rows = await listPostgresqlReviewSummaries(db, {
    status: 'pending',
    unbounded: true,
  })
  if (rows.length === 0) return 0
  const taskIds = [...new Set(rows.map((row) => row.taskId))]
  const visible = await taskAccess.visibleTaskIds(actor, taskIds)
  const assignments = await db
    .select({
      taskId: reviewNodeReviewers.taskId,
      reviewNodeId: reviewNodeReviewers.reviewNodeId,
    })
    .from(reviewNodeReviewers)
    .where(
      and(
        eq(reviewNodeReviewers.reviewerUserId, actor.user.id),
        inArray(reviewNodeReviewers.taskId, taskIds),
      ),
    )
  const assigned = new Set(assignments.map((row) => `${row.taskId}:${row.reviewNodeId}`))
  return rows.filter(
    (row) => visible.has(row.taskId) || assigned.has(`${row.taskId}:${row.reviewNodeId}`),
  ).length
}

async function commentsForVersion(
  db: PostgresqlDatabaseClient,
  version: Pick<DocVersionRow, 'id' | 'decision' | 'commentsJson'>,
): Promise<ReviewComment[]> {
  if (version.decision === 'pending') {
    const rows = await db
      .select()
      .from(reviewComments)
      .where(eq(reviewComments.docVersionId, version.id))
      .orderBy(asc(reviewComments.anchorParagraphIdx), asc(reviewComments.anchorOffsetStart))
    return rows.map(rowToReviewComment)
  }
  const archived = parseJsonArray<ReviewComment>(version.commentsJson)
  return archived.sort((left, right) =>
    left.anchor.paragraphIdx === right.anchor.paragraphIdx
      ? left.anchor.offsetStart - right.anchor.offsetStart
      : left.anchor.paragraphIdx - right.anchor.paragraphIdx,
  )
}

async function buildReviewMember(
  db: PostgresqlDatabaseClient,
  reader: PostgresqlCommittedReviewArtifactReader,
  row: DocVersionRow,
): Promise<{ summary: ReviewDocumentSummary; decision: DocVersionDecision }> {
  let body = ''
  try {
    body = await reader.read(row.bodyPath)
  } catch {
    // The navigation/detail contract tolerates a pruned review artifact.
  }
  return {
    summary: {
      docVersionId: row.id,
      itemIndex: row.itemIndex ?? 0,
      itemPath: row.itemPath ?? '',
      title: extractDocTitle(body, row.itemPath ?? row.id),
      selection: row.selection ?? 'unselected',
      commentCount: (await commentsForVersion(db, row)).length,
      stale: row.selectionStale === true,
    },
    decision: row.decision,
  }
}

interface GroupedReviewRound {
  roundKey: string
  reviewIteration: number
  roundGeneration: number | null
  decision: DocVersionDecision
  decisionReason: string | null
  decidedAt: number | null
  decidedBy: string | null
  decidedByRole: TaskActorRole | null
  createdAt: number
  isCurrent: boolean
  members: DocVersionRow[]
}

function groupReviewRounds(rows: readonly DocVersionRow[]): GroupedReviewRound[] {
  const groups = new Map<string, DocVersionRow[]>()
  for (const row of rows) {
    if (row.itemIndex === null) continue
    const key =
      row.roundGeneration === null ? `i${row.reviewIteration}-legacy` : `g${row.roundGeneration}`
    const existing = groups.get(key)
    if (existing === undefined) groups.set(key, [row])
    else existing.push(row)
  }
  const result: GroupedReviewRound[] = [...groups.entries()].map(
    ([roundKey, members]): GroupedReviewRound => {
      members.sort((left, right) => (left.itemIndex ?? 0) - (right.itemIndex ?? 0))
      const decision = members.find((row) => row.decision !== 'pending')?.decision ?? 'pending'
      const decided = members
        .filter((row) => row.decidedAt !== null)
        .sort((left, right) => (right.decidedAt ?? 0) - (left.decidedAt ?? 0))[0]
      const first = members[0]!
      return {
        roundKey,
        reviewIteration: first.reviewIteration,
        roundGeneration: first.roundGeneration,
        decision,
        decisionReason:
          decision === 'rejected' || decision === 'superseded'
            ? (members.find((row) => row.decisionReason)?.decisionReason ?? null)
            : null,
        decidedAt: decided?.decidedAt ?? null,
        decidedBy: decided?.decidedBy ?? null,
        decidedByRole:
          decided?.decidedByRole == null ? null : TaskActorRoleSchema.parse(decided.decidedByRole),
        createdAt: Math.min(...members.map((row) => row.createdAt)),
        isCurrent: false,
        members,
      }
    },
  )
  result.sort((left, right) => {
    if ((left.roundGeneration === null) !== (right.roundGeneration === null)) {
      return left.roundGeneration === null ? -1 : 1
    }
    return left.roundGeneration === null
      ? left.reviewIteration - right.reviewIteration
      : left.roundGeneration! - right.roundGeneration!
  })
  if (result.length > 0) {
    const current = result.find((round) => round.decision === 'pending') ?? result.at(-1)!
    current.isCurrent = true
  }
  return result
}

async function listPostgresqlReviewRounds(
  db: PostgresqlDatabaseClient,
  appHome: string,
  nodeRunId: string,
): Promise<ReviewRoundSummary[]> {
  const rows = await db.select().from(docVersions).where(eq(docVersions.reviewNodeRunId, nodeRunId))
  const reader = new PostgresqlCommittedReviewArtifactReader(db, appHome)
  const result: ReviewRoundSummary[] = []
  for (const round of groupReviewRounds(rows)) {
    const members: ReviewRoundMember[] = []
    for (const row of round.members) {
      const built = await buildReviewMember(db, reader, row)
      members.push({ ...built.summary, decision: built.decision })
    }
    result.push({
      roundKey: round.roundKey,
      reviewIteration: round.reviewIteration,
      roundGeneration: round.roundGeneration,
      decision: round.decision,
      decisionReason: round.decisionReason,
      decidedAt: round.decidedAt,
      decidedBy: round.decidedBy,
      decidedByRole: round.decidedByRole,
      createdAt: round.createdAt,
      isCurrent: round.isCurrent,
      members,
    })
  }
  return result
}

async function getPostgresqlReviewDetail(
  db: PostgresqlDatabaseClient,
  appHome: string,
  nodeRunId: string,
): Promise<Omit<ReviewDetail, 'capabilities'>> {
  const versions = await db
    .select()
    .from(docVersions)
    .where(eq(docVersions.reviewNodeRunId, nodeRunId))
  if (versions.length === 0) {
    throw new NotFoundError('review-not-found', `no doc_versions for ${nodeRunId}`)
  }
  const run = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)).limit(1))[0]
  if (run === undefined) {
    throw new NotFoundError('review-not-found', `node run ${nodeRunId} not found`)
  }
  const task = (await db.select().from(tasks).where(eq(tasks.id, run.taskId)).limit(1))[0]
  if (task === undefined)
    throw new NotFoundError('review-not-found', `task ${run.taskId} not found`)
  const workflow = (
    await db.select().from(workflows).where(eq(workflows.id, task.workflowId)).limit(1)
  )[0]
  if (workflow === undefined) {
    throw new NotFoundError('review-not-found', `workflow ${task.workflowId} not found`)
  }
  const newest = versions.slice().sort((left, right) => right.versionIndex - left.versionIndex)[0]!
  const summary = reviewSummary(
    newest,
    run,
    task,
    workflow,
    parseReviewNodeMeta(task.workflowSnapshot).get(newest.reviewNodeId),
  )
  const current = selectCurrentReviewRound(versions)!
  const currentVersion = rowToDocVersion(current.representative)
  const reader = new PostgresqlCommittedReviewArtifactReader(db, appHome)
  let currentBody = ''
  try {
    currentBody = await reader.read(currentVersion.bodyPath)
  } catch {
    // Current detail intentionally remains navigable after artifact pruning.
  }
  const comments = await commentsForVersion(db, current.representative)
  let documents: ReviewDocumentSummary[] | undefined
  if (resolveReviewRoundMode(versions) !== 'single') {
    documents = []
    for (const row of current.members) {
      documents.push((await buildReviewMember(db, reader, row)).summary)
    }
  }
  let rerunnableOnReject: string[] = []
  let rerunnableOnIterate: string[] = []
  try {
    const definition = JSON.parse(task.workflowSnapshot) as WorkflowDefinition
    const node = definition.nodes.find((candidate) => candidate.id === summary.reviewNodeId)
    if (node !== undefined) {
      const reject = Reflect.get(node, 'rerunnableOnReject')
      const iterate = Reflect.get(node, 'rerunnableOnIterate')
      if (Array.isArray(reject)) {
        rerunnableOnReject = reject.filter((value): value is string => typeof value === 'string')
      }
      if (Array.isArray(iterate)) {
        rerunnableOnIterate = iterate.filter((value): value is string => typeof value === 'string')
      }
    }
  } catch {
    // Corrupt workflow snapshots retain the empty-list fallback.
  }
  return {
    summary,
    currentVersion,
    currentBody,
    comments,
    rerunnableOnReject,
    rerunnableOnIterate,
    ...(documents === undefined ? {} : { documents }),
  }
}

async function getPostgresqlVersionDetail(
  db: PostgresqlDatabaseClient,
  appHome: string,
  nodeRunId: string,
  versionId: string,
) {
  const row = (await db.select().from(docVersions).where(eq(docVersions.id, versionId)).limit(1))[0]
  if (row === undefined || row.reviewNodeRunId !== nodeRunId) return null
  const body = await new PostgresqlCommittedReviewArtifactReader(db, appHome).read(row.bodyPath)
  return { ...rowToDocVersion(row), body, comments: await commentsForVersion(db, row) }
}

export interface CreatePostgresqlCollaborationRouteOperationsInput {
  readonly db: PostgresqlDatabaseClient
  readonly taskAccess: Pick<CollaborationTaskAccessPort, 'visibleTaskIds'>
  readonly clarifyDraftEvents: CollaborationClarifyDraftEventPublisher
  /** Task-execution owns both the node lifecycle CAS and its committed event.
   * Collaboration invokes it inside the provider transaction that seals the round. */
  readonly taskNodeLifecycle: PostgresqlCollaborationRouteNodeLifecycleParticipantFactory
}

export interface PostgresqlCollaborationRouteNodeLifecycleParticipantFactory {
  inTransaction(transaction: PostgresqlCommittedEventTransaction): NodeRunLifecycleParticipantInTx
}

async function appendCollaborationProjectionEvent(
  tx: PostgresqlCommittedEventTransaction,
  input: Readonly<{
    type:
      | 'collaboration.review-comments-changed.v1'
      | 'collaboration.review-selection-changed.v1'
      | 'collaboration.human-gate-decision-committed.v1'
    family: 'review' | 'clarify'
    gate: CollaborationGateRefV1
    projectionFrames: readonly CollaborationProjectionFrame[]
    occurredAt: number
    operationRef: string
    eventGroupId?: string
    eventGroupOrdinal?: number
    decision?: Readonly<{ gateKind: 'clarify'; kind: ClarifyDirective }>
  }>,
): Promise<CommittedEventRef | null> {
  const payload =
    input.type === 'collaboration.human-gate-decision-committed.v1'
      ? {
          gate: input.gate,
          decision: input.decision!,
          gateStatus: 'deferred' as const,
          continuationRef: null,
          distillSourceEventId: null,
          projectionFrames: input.projectionFrames,
        }
      : { gate: input.gate, projectionFrames: input.projectionFrames }
  const receipt = await appendPostgresqlCommittedEventTx(tx, {
    producer: 'collaboration',
    family: input.family,
    type: input.type,
    aggregate: {
      kind: input.family === 'review' ? 'review-round' : 'clarify-round',
      id: input.gate.roundId ?? input.gate.gateId,
    },
    operationRef: input.operationRef,
    eventGroupId: input.eventGroupId ?? committedEventGroupId('collaboration', input.operationRef),
    eventGroupOrdinal: input.eventGroupOrdinal ?? 0,
    correlationRef: `human-gate-node-run:${input.gate.nodeRunId}`,
    causationRef: null,
    occurredAt: input.occurredAt,
    payload,
    consumers: collaborationDurableConsumers(input.family, input.type),
  })
  return receipt.eventRef
}

async function assertPostgresqlReviewWritable(tx: PgTx, nodeRunId: string): Promise<NodeRunRow> {
  const run = (await tx.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)).limit(1))[0]
  if (run === undefined) {
    throw new NotFoundError('node-run-not-found', `node run '${nodeRunId}' not found`)
  }
  const task = (
    await tx.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, run.taskId)).limit(1)
  )[0]
  if (task === undefined) {
    throw new NotFoundError('task-not-found', `task '${run.taskId}' not found`)
  }
  if (task.status === 'done' || task.status === 'canceled') {
    throw new ConflictError(
      'task-terminal',
      `task ${run.taskId} is '${task.status}'; this review round is closed`,
    )
  }
  if (run.status !== 'awaiting_review') {
    throw new ConflictError(
      'review-not-awaiting',
      `review ${nodeRunId} is not awaiting_review (status=${run.status})`,
    )
  }
  return run
}

function reviewAnchorFailure(error: Exclude<ReturnType<typeof resolveReviewAnchor>, { ok: true }>) {
  return new ValidationError(error.code, error.message, {
    candidates: error.candidates,
    total: error.total,
    truncated: error.truncated,
    suggestions: error.suggestions,
  })
}

function canonicalizePostedAnchor(body: string, anchor: ReviewCommentAnchor): ReviewCommentAnchor {
  if (anchor.selectedText.length === 0) {
    throw new ValidationError('anchor-empty-selection', 'anchor.selectedText must be non-empty')
  }
  const offsets: number[] = []
  let cursor = 0
  while (cursor <= body.length - anchor.selectedText.length) {
    const found = body.indexOf(anchor.selectedText, cursor)
    if (found < 0) break
    offsets.push(found)
    cursor = found + Math.max(1, anchor.selectedText.length)
  }
  if (offsets.length === 0) {
    throw new ValidationError(
      'anchor-selection-not-found',
      'anchor.selectedText is not present in the review document',
    )
  }
  const exact = offsets.indexOf(anchor.offsetStart)
  const requested =
    exact >= 0
      ? exact
      : Number.isInteger(anchor.occurrenceIndex) &&
          anchor.occurrenceIndex >= 1 &&
          anchor.occurrenceIndex <= offsets.length
        ? anchor.occurrenceIndex - 1
        : 0
  const offsetStart = offsets[requested]!
  return {
    ...anchor,
    occurrenceIndex: requested + 1,
    offsetStart,
    offsetEnd: offsetStart + anchor.selectedText.length,
  }
}

function resolvePostgresqlCommentAnchor(
  body: string,
  input: Pick<AddedReviewComment, never> & {
    readonly anchor?: ReviewCommentAnchor
    readonly anchorRequest?: Parameters<typeof resolveReviewAnchor>[1]
  },
): { anchor: ReviewCommentAnchor; warnings: AddedReviewComment['warnings'] } {
  if ((input.anchor === undefined) === (input.anchorRequest === undefined)) {
    throw new Error('addReviewComment: pass exactly one of `anchor` / `anchorRequest`')
  }
  if (input.anchorRequest !== undefined) {
    const resolved = resolveReviewAnchor(buildReviewAnchorDocument(body), input.anchorRequest)
    if (!resolved.ok) throw reviewAnchorFailure(resolved)
    if (
      body.slice(resolved.anchor.offsetStart, resolved.anchor.offsetEnd) !==
      resolved.anchor.selectedText
    ) {
      throw new Error('resolved review anchor is inconsistent with the review document')
    }
    return { anchor: resolved.anchor, warnings: resolved.warnings }
  }
  return { anchor: canonicalizePostedAnchor(body, input.anchor!), warnings: [] }
}

function assertReviewCommentWriteAllowed(
  author: string,
  authority: ReviewCommentWriteAuthority,
): void {
  if (authority.role === 'owner' || authority.resourceAclBypass === true) return
  if (author !== authority.actorUserId) {
    throw new ForbiddenError(
      'review-comment-not-author',
      'only the comment author (or the task owner / an actor with resource-acl:bypass) may modify this comment',
    )
  }
}

async function selectPendingPostgresqlDocVersion(
  tx: PgTx,
  nodeRunId: string,
  docVersionId?: string,
): Promise<DocVersionRow> {
  const rows = await tx
    .select()
    .from(docVersions)
    .where(and(eq(docVersions.reviewNodeRunId, nodeRunId), eq(docVersions.decision, 'pending')))
  if (rows.length === 0) {
    throw new ConflictError('review-not-awaiting', `review ${nodeRunId} has no pending doc_version`)
  }
  if (docVersionId !== undefined) {
    const selected = rows.find((row) => row.id === docVersionId)
    if (selected === undefined) {
      throw new NotFoundError(
        'doc-version-not-found',
        `doc_version ${docVersionId} is not a pending document of review ${nodeRunId}`,
      )
    }
    return selected
  }
  if (resolveReviewRoundMode(rows) !== 'single') {
    throw new ValidationError(
      'review-doc-version-required',
      `review ${nodeRunId} is a multi-document round; pass docVersionId`,
    )
  }
  return rows[0]!
}

async function setPostgresqlDocumentSelection(
  db: PostgresqlDatabaseClient,
  input: Parameters<CollaborationRoutePersistenceOperations['reviews']['setSelection']>[0],
) {
  const now = Date.now()
  const committed = await serializable(db, async (tx) => {
    await assertPostgresqlReviewWritable(tx, input.nodeRunId)
    const row = (
      await tx.select().from(docVersions).where(eq(docVersions.id, input.docVersionId)).limit(1)
    )[0]
    if (row === undefined || row.reviewNodeRunId !== input.nodeRunId) {
      throw new NotFoundError(
        'doc-version-not-found',
        `doc_version ${input.docVersionId} not found on review ${input.nodeRunId}`,
      )
    }
    if (row.itemIndex === null) {
      throw new ConflictError(
        'review-not-multi-doc',
        `doc_version ${input.docVersionId} is not a multi-document item`,
      )
    }
    if (row.decision !== 'pending') {
      throw new ConflictError(
        'review-doc-decided',
        `doc_version ${input.docVersionId} already decided (${row.decision})`,
      )
    }
    await tx
      .update(docVersions)
      .set({ selection: input.selection, selectionStale: false })
      .where(and(eq(docVersions.id, input.docVersionId), eq(docVersions.decision, 'pending')))
      .run()
    const operationRef = `review-selection:${input.docVersionId}:${ulid(now)}`
    const eventRef = await appendCollaborationProjectionEvent(tx, {
      type: 'collaboration.review-selection-changed.v1',
      family: 'review',
      gate: {
        taskId: row.taskId,
        nodeRunId: input.nodeRunId,
        gateKind: 'review',
        gateId: `review:${input.nodeRunId}`,
        roundId: input.nodeRunId,
      },
      projectionFrames: [
        {
          id: -1,
          type: 'review.selection_changed',
          nodeRunId: input.nodeRunId,
          docVersionId: input.docVersionId,
          selection: input.selection,
        },
      ],
      occurredAt: now,
      operationRef,
    })
    return {
      result: {
        taskId: row.taskId,
        docVersionId: input.docVersionId,
        selection: input.selection,
      },
      eventRefs: eventRef === null ? [] : [eventRef],
    }
  })
  await publishCommittedEventsAfterCommit(committed.eventRefs)
  return committed.result
}

async function addPostgresqlReviewComment(
  db: PostgresqlDatabaseClient,
  input: Parameters<CollaborationRoutePersistenceOperations['reviews']['addComment']>[0],
): Promise<AddedReviewComment> {
  const now = Date.now()
  const id = ulid(now)
  const prepared = await serializable(db, async (tx) => {
    await assertPostgresqlReviewWritable(tx, input.nodeRunId)
    const version = await selectPendingPostgresqlDocVersion(tx, input.nodeRunId, input.docVersionId)
    const body = await new PostgresqlCommittedReviewArtifactReader(db, input.appHome).read(
      version.bodyPath,
    )
    const resolved = resolvePostgresqlCommentAnchor(body, input)
    const comment: ReviewComment = {
      id,
      docVersionId: version.id,
      anchor: resolved.anchor,
      commentText: input.commentText,
      author: input.author || LOCAL_DECIDER,
      authorRole: input.authorRole,
      createdAt: now,
    }
    await tx
      .insert(reviewComments)
      .values({
        id,
        docVersionId: version.id,
        anchorSectionPath: resolved.anchor.sectionPath,
        anchorParagraphIdx: resolved.anchor.paragraphIdx,
        anchorOffsetStart: resolved.anchor.offsetStart,
        anchorOffsetEnd: resolved.anchor.offsetEnd,
        selectedText: resolved.anchor.selectedText,
        contextBefore: resolved.anchor.contextBefore,
        contextAfter: resolved.anchor.contextAfter,
        occurrenceIndex: resolved.anchor.occurrenceIndex,
        commentText: input.commentText,
        author: input.author || LOCAL_DECIDER,
        authorRole: input.authorRole,
        createdAt: now,
      })
      .run()
    const eventRef = await appendCollaborationProjectionEvent(tx, {
      type: 'collaboration.review-comments-changed.v1',
      family: 'review',
      gate: {
        taskId: version.taskId,
        nodeRunId: input.nodeRunId,
        gateKind: 'review',
        gateId: `review:${input.nodeRunId}`,
        roundId: input.nodeRunId,
      },
      projectionFrames: [
        {
          id: -1,
          type: 'review.comment_added',
          nodeRunId: input.nodeRunId,
          docVersionId: version.id,
          comment,
        },
      ],
      occurredAt: now,
      operationRef: `review-comment:add:${id}`,
    })
    return {
      result: { ...comment, warnings: resolved.warnings },
      eventRefs: eventRef === null ? [] : [eventRef],
    }
  })
  await publishCommittedEventsAfterCommit(prepared.eventRefs)
  return prepared.result
}

async function updatePostgresqlReviewComment(
  db: PostgresqlDatabaseClient,
  input: Parameters<CollaborationRoutePersistenceOperations['reviews']['updateComment']>[0],
): Promise<ReviewComment> {
  const now = Date.now()
  const committed = await serializable(db, async (tx) => {
    await assertPostgresqlReviewWritable(tx, input.nodeRunId)
    const row = (
      await tx.select().from(reviewComments).where(eq(reviewComments.id, input.commentId)).limit(1)
    )[0]
    if (row === undefined) {
      throw new NotFoundError(
        'review-comment-not-found',
        `review_comment ${input.commentId} not found`,
      )
    }
    const version = (
      await tx.select().from(docVersions).where(eq(docVersions.id, row.docVersionId)).limit(1)
    )[0]
    if (version === undefined || version.reviewNodeRunId !== input.nodeRunId) {
      throw new NotFoundError(
        'review-comment-not-found',
        `review_comment ${input.commentId} does not belong to review ${input.nodeRunId}`,
      )
    }
    if (version.decision !== 'pending') {
      throw new ConflictError(
        'review-not-awaiting',
        `review ${input.nodeRunId} is not awaiting a decision; comments are immutable`,
      )
    }
    assertReviewCommentWriteAllowed(row.author, input.authority)
    await tx
      .update(reviewComments)
      .set({ commentText: input.commentText })
      .where(eq(reviewComments.id, input.commentId))
      .run()
    const result = rowToReviewComment({ ...row, commentText: input.commentText })
    const operationRef = `review-comment:update:${input.commentId}:${ulid(now)}`
    const eventRef = await appendCollaborationProjectionEvent(tx, {
      type: 'collaboration.review-comments-changed.v1',
      family: 'review',
      gate: {
        taskId: version.taskId,
        nodeRunId: input.nodeRunId,
        gateKind: 'review',
        gateId: `review:${input.nodeRunId}`,
        roundId: input.nodeRunId,
      },
      projectionFrames: [
        {
          id: -1,
          type: 'review.comment_updated',
          nodeRunId: input.nodeRunId,
          docVersionId: version.id,
          comment: result,
        },
      ],
      occurredAt: now,
      operationRef,
    })
    return { result, eventRefs: eventRef === null ? [] : [eventRef] }
  })
  await publishCommittedEventsAfterCommit(committed.eventRefs)
  return committed.result
}

async function deletePostgresqlReviewComment(
  db: PostgresqlDatabaseClient,
  input: Parameters<CollaborationRoutePersistenceOperations['reviews']['deleteComment']>[0],
): Promise<void> {
  const now = Date.now()
  const eventRefs = await serializable(db, async (tx) => {
    await assertPostgresqlReviewWritable(tx, input.nodeRunId)
    const row = (
      await tx.select().from(reviewComments).where(eq(reviewComments.id, input.commentId)).limit(1)
    )[0]
    if (row === undefined) {
      throw new NotFoundError(
        'review-comment-not-found',
        `review_comment ${input.commentId} not found`,
      )
    }
    const version = (
      await tx.select().from(docVersions).where(eq(docVersions.id, row.docVersionId)).limit(1)
    )[0]
    if (version === undefined || version.reviewNodeRunId !== input.nodeRunId) {
      throw new NotFoundError(
        'review-comment-not-found',
        `review_comment ${input.commentId} does not belong to review ${input.nodeRunId}`,
      )
    }
    if (version.decision !== 'pending') {
      throw new ConflictError(
        'review-not-awaiting',
        `review ${input.nodeRunId} is not awaiting a decision; comments are immutable`,
      )
    }
    if (input.authority.role === 'reviewer' && input.authority.resourceAclBypass !== true) {
      throw new ForbiddenError(
        'review-comment-delete-not-allowed',
        'review-node reviewers cannot delete comments',
      )
    }
    assertReviewCommentWriteAllowed(row.author, input.authority)
    await tx.delete(reviewComments).where(eq(reviewComments.id, input.commentId)).run()
    const eventRef = await appendCollaborationProjectionEvent(tx, {
      type: 'collaboration.review-comments-changed.v1',
      family: 'review',
      gate: {
        taskId: version.taskId,
        nodeRunId: input.nodeRunId,
        gateKind: 'review',
        gateId: `review:${input.nodeRunId}`,
        roundId: input.nodeRunId,
      },
      projectionFrames: [
        {
          id: -1,
          type: 'review.comment_deleted',
          nodeRunId: input.nodeRunId,
          docVersionId: row.docVersionId,
          commentId: input.commentId,
        },
      ],
      occurredAt: now,
      operationRef: `review-comment:delete:${input.commentId}:${ulid(now)}`,
    })
    return eventRef === null ? [] : [eventRef]
  })
  await publishCommittedEventsAfterCommit(eventRefs)
}

function parseClarifyQuestions(raw: string): ClarifyQuestion[] {
  try {
    const value: unknown = JSON.parse(raw)
    return Array.isArray(value) ? (value as ClarifyQuestion[]) : []
  } catch {
    return []
  }
}

function parseClarifyAnswers(raw: string | null): ClarifyAnswer[] {
  if (raw === null) return []
  try {
    const value: unknown = JSON.parse(raw)
    return Array.isArray(value) ? (value as ClarifyAnswer[]) : []
  } catch {
    return []
  }
}

function roundGraph(round: ClarifyRoundRow) {
  return {
    askingNodeId: round.kind === 'self' ? round.askingNodeId : null,
    questionerNodeId: round.kind === 'cross' ? round.askingNodeId : null,
  }
}

async function reconcilePostgresqlRoundEntries(tx: PgTx, round: ClarifyRoundRow): Promise<void> {
  if (round.status === 'canceled' || round.status === 'abandoned') return
  const desired = reconcileDesiredEntries({
    kind: round.kind,
    questions: parseClarifyQuestions(round.questionsJson),
    graph: roundGraph(round),
  })
  const now = Date.now()
  for (const entry of desired) {
    await tx
      .insert(taskQuestions)
      .values({
        id: ulid(),
        taskId: round.taskId,
        originNodeRunId: round.intermediaryNodeRunId,
        questionId: entry.questionId,
        questionTitle: entry.questionTitle,
        sourceKind: entry.sourceKind,
        roleKind: entry.roleKind,
        iteration: round.iteration,
        loopIter: round.loopIter,
        defaultTargetNodeId: entry.defaultTargetNodeId,
        sealedAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [taskQuestions.originNodeRunId, taskQuestions.questionId, taskQuestions.roleKind],
        set: {
          defaultTargetNodeId: entry.defaultTargetNodeId,
          questionTitle: entry.questionTitle,
          updatedAt: now,
        },
      })
      .run()
  }
}

async function runOutputIds(
  db: PostgresqlDatabaseClient,
  runIds: readonly string[],
): Promise<Set<string>> {
  if (runIds.length === 0) return new Set()
  const rows = await db
    .select({ nodeRunId: nodeRunOutputs.nodeRunId })
    .from(nodeRunOutputs)
    .where(inArray(nodeRunOutputs.nodeRunId, [...runIds]))
  return new Set(rows.map((row) => row.nodeRunId))
}

function resolveQuestionHandler(
  entry: TaskQuestionRow,
  runs: readonly NodeRunRow[],
  outputIds: ReadonlySet<string>,
): { handlerRun: HandlerRunView | null; dispatchedInFlight: boolean } {
  if (entry.dispatchedAt === null) return { handlerRun: null, dispatchedInFlight: false }
  if (entry.triggerRunId === null) return { handlerRun: null, dispatchedInFlight: true }
  const anchor = runs.find((run) => run.id === entry.triggerRunId)
  if (anchor === undefined) return { handlerRun: null, dispatchedInFlight: true }
  const handlerRun = resolveHandlerRun({
    effectiveTargetNodeId: anchor.nodeId,
    iteration: anchor.iteration,
    loopIter: 0,
    triggerRunId: entry.triggerRunId,
    runs: runs.map(
      (run): RunLineageView => ({
        id: run.id,
        nodeId: run.nodeId,
        iteration: run.iteration,
        loopIter: 0,
        rerunCause: run.rerunCause,
        status: run.status,
        startedAt: run.startedAt,
        hasOutput: outputIds.has(run.id),
        parentNodeRunId: run.parentNodeRunId,
        shardKey: run.shardKey ?? null,
      }),
    ),
    ...(anchor.shardKey === null ? {} : { shardKey: anchor.shardKey }),
  })
  return { handlerRun, dispatchedInFlight: handlerRun === null }
}

function summarizeQuestionAnswer(
  round: ClarifyRoundRow,
  questionId: string,
  sealed: boolean,
): string | null {
  if (!sealed) return null
  const answer = parseClarifyAnswers(round.answersJson).find(
    (candidate) => candidate.questionId === questionId,
  )
  if (answer === undefined) return null
  const parts: string[] = []
  if (answer.selectedOptionLabels.length > 0) parts.push(answer.selectedOptionLabels.join(', '))
  if (answer.customText.trim().length > 0) parts.push(answer.customText.trim())
  const summary = parts.join(' · ')
  return summary.length > 200 ? `${summary.slice(0, 200)}…` : summary || null
}

async function listPostgresqlTaskQuestions(
  db: PostgresqlDatabaseClient,
  input: Parameters<CollaborationRoutePersistenceOperations['questions']['list']>[0],
): Promise<CollaborationTaskQuestionView[]> {
  const rounds = await db.select().from(clarifyRounds).where(eq(clarifyRounds.taskId, input.taskId))
  for (const round of rounds) {
    await serializable(db, async (tx) => await reconcilePostgresqlRoundEntries(tx, round))
  }
  const task = (
    await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, input.taskId)).limit(1)
  )[0]
  if (task !== undefined && isTerminalTaskStatus(task.status)) return []
  const entries = await db
    .select()
    .from(taskQuestions)
    .where(eq(taskQuestions.taskId, input.taskId))
  if (entries.length === 0) return []
  const runs = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, input.taskId))
  const outputIds = await runOutputIds(
    db,
    runs.map((run) => run.id),
  )
  const roundsByOrigin = new Map(rounds.map((round) => [round.intermediaryNodeRunId, round]))
  const result: CollaborationTaskQuestionView[] = []
  for (const entry of entries) {
    if (entry.sourceKind === 'manual') {
      if (input.sourceNodeId !== undefined) continue
      const handler = resolveQuestionHandler(entry, runs, outputIds)
      const phase = deriveQuestionPhase({
        roundStatus: 'answered',
        confirmation: entry.confirmation,
        isStaged: entry.stagedAt !== null,
        ...handler,
      })
      if (input.phase !== undefined && phase !== input.phase) continue
      result.push({
        id: entry.id,
        taskId: entry.taskId,
        originNodeRunId: null,
        questionId: entry.questionId,
        questionTitle: entry.questionTitle,
        sourceKind: 'manual',
        roleKind: entry.roleKind,
        sourceNodeId: null,
        defaultTargetNodeId: entry.defaultTargetNodeId,
        overrideTargetNodeId: entry.overrideTargetNodeId,
        effectiveTargetNodeId: entry.overrideTargetNodeId ?? entry.defaultTargetNodeId,
        phase,
        confirmation: entry.confirmation,
        confirmedBy: entry.confirmedBy,
        staged: entry.stagedAt !== null,
        autoDispatchDeferred:
          entry.autoDispatchDeferredAt !== null &&
          entry.dispatchedAt === null &&
          entry.stagedAt !== null,
        sealed: true,
        reopenCount: 0,
        answerSummary: entry.manualBody,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      })
      continue
    }
    const round = roundsByOrigin.get(entry.originNodeRunId)
    if (round === undefined) continue
    if (input.sourceNodeId !== undefined && round.askingNodeId !== input.sourceNodeId) continue
    const handler = resolveQuestionHandler(entry, runs, outputIds)
    const phase = deriveQuestionPhase({
      roundStatus: round.status,
      confirmation: entry.confirmation,
      isStaged: entry.stagedAt !== null,
      ...handler,
    })
    if (input.phase !== undefined && phase !== input.phase) continue
    const sealed = round.status === 'answered' || entry.sealedAt !== null
    result.push({
      id: entry.id,
      taskId: entry.taskId,
      originNodeRunId: entry.originNodeRunId,
      questionId: entry.questionId,
      questionTitle: entry.questionTitle,
      sourceKind: entry.sourceKind,
      roleKind: entry.roleKind,
      sourceNodeId: round.askingNodeId,
      defaultTargetNodeId: entry.defaultTargetNodeId,
      overrideTargetNodeId: entry.overrideTargetNodeId,
      effectiveTargetNodeId: entry.overrideTargetNodeId ?? entry.defaultTargetNodeId,
      phase,
      confirmation: entry.confirmation,
      confirmedBy: entry.confirmedBy,
      staged: entry.stagedAt !== null,
      autoDispatchDeferred:
        entry.autoDispatchDeferredAt !== null &&
        entry.dispatchedAt === null &&
        entry.stagedAt !== null,
      sealed,
      reopenCount: 0,
      answerSummary: summarizeQuestionAnswer(round, entry.questionId, sealed),
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    })
  }
  return result
}

async function loadQuestionEntry(
  db: PostgresqlDatabaseClient,
  entryId: string,
): Promise<TaskQuestionRow> {
  const entry = (
    await db.select().from(taskQuestions).where(eq(taskQuestions.id, entryId)).limit(1)
  )[0]
  if (entry === undefined) {
    throw new NotFoundError(TASK_QUESTION_CONFLICT.notFound, `task question ${entryId} not found`)
  }
  return entry
}

async function derivePostgresqlQuestionPhase(
  db: PostgresqlDatabaseClient,
  entry: TaskQuestionRow,
): Promise<TaskQuestionPhase> {
  const runs = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, entry.taskId))
  const outputIds = await runOutputIds(
    db,
    runs.map((run) => run.id),
  )
  const handler = resolveQuestionHandler(entry, runs, outputIds)
  if (entry.sourceKind === 'manual') {
    return deriveQuestionPhase({
      roundStatus: 'answered',
      confirmation: entry.confirmation,
      isStaged: entry.stagedAt !== null,
      ...handler,
    })
  }
  const round = (
    await db
      .select({ status: clarifyRounds.status })
      .from(clarifyRounds)
      .where(eq(clarifyRounds.intermediaryNodeRunId, entry.originNodeRunId))
      .limit(1)
  )[0]
  if (round === undefined) return entry.stagedAt === null ? 'pending' : 'staged'
  return deriveQuestionPhase({
    roundStatus: round.status,
    confirmation: entry.confirmation,
    isStaged: entry.stagedAt !== null,
    ...handler,
  })
}

async function postgresqlAgentNodeIds(
  db: PostgresqlDatabaseClient,
  taskId: string,
): Promise<Set<string>> {
  const task = (
    await db
      .select({ snapshot: tasks.workflowSnapshot })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1)
  )[0]
  if (task === undefined) return new Set()
  try {
    const definition = JSON.parse(task.snapshot) as WorkflowDefinition
    return new Set(
      definition.nodes.filter((node) => node.kind.startsWith('agent')).map((node) => node.id),
    )
  } catch {
    return new Set()
  }
}

async function assertPostgresqlManualTarget(
  db: PostgresqlDatabaseClient,
  taskId: string,
  targetNodeId: string,
): Promise<void> {
  if (!canReassign(targetNodeId, await postgresqlAgentNodeIds(db, taskId))) {
    throw new ValidationError(
      'manual-question-target-invalid',
      `target node '${targetNodeId}' is not an agent node in this task's workflow`,
    )
  }
  const priorRun = (
    await db
      .select({ id: nodeRuns.id })
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, targetNodeId)))
      .limit(1)
  )[0]
  if (priorRun === undefined) {
    throw new ValidationError(
      'manual-question-target-never-run',
      `target node '${targetNodeId}' has no prior node_run`,
    )
  }
  if (targetNodeId !== '__wg_member__') return
  const task = (
    await db
      .select({ workgroupId: tasks.workgroupId, workgroupConfigJson: tasks.workgroupConfigJson })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1)
  )[0]
  if (task !== undefined && isTurnEngineWorkgroupTask(task)) {
    throw new ValidationError(
      'manual-question-workgroup-member-target',
      `cannot target '${targetNodeId}': it is the shared workgroup member host node`,
    )
  }
}

async function createPostgresqlManualQuestion(
  db: PostgresqlDatabaseClient,
  input: Parameters<CollaborationRoutePersistenceOperations['questions']['createManual']>[0],
) {
  const task = (
    await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, input.taskId)).limit(1)
  )[0]
  if (task === undefined)
    throw new ConflictError('task-not-found', `task ${input.taskId} not found`)
  if (task.status === 'done' || task.status === 'canceled') {
    throw new ConflictError(
      'task-terminal',
      `task ${input.taskId} is ${task.status}; questions cannot be created`,
    )
  }
  const title = input.title.trim()
  const body = input.body.trim()
  if (title.length === 0) {
    throw new ValidationError('manual-question-title-required', 'title is required')
  }
  if (title.length > 512) {
    throw new ValidationError('manual-question-title-too-long', 'title exceeds 512 characters')
  }
  if (body.length === 0) {
    throw new ValidationError('manual-question-body-required', 'body is required')
  }
  if (body.length > 20_000) {
    throw new ValidationError('manual-question-body-too-long', 'body exceeds 20000 characters')
  }
  if (input.targetNodeId === null || input.targetNodeId.length === 0) {
    throw new ValidationError(
      'manual-question-target-required',
      'targetNodeId is required (a manual question must be assigned to an agent node)',
    )
  }
  await assertPostgresqlManualTarget(db, input.taskId, input.targetNodeId)
  const created = await new PostgresqlManualQuestionOpenWriter(db).create({
    taskId: input.taskId,
    title,
    body,
    targetNodeId: input.targetNodeId,
    actorUserId: input.actor.userId,
  })
  return { id: created.id }
}

async function confirmPostgresqlTaskQuestion(
  db: PostgresqlDatabaseClient,
  input: Parameters<CollaborationRoutePersistenceOperations['questions']['confirm']>[0],
): Promise<void> {
  const entry = await loadQuestionEntry(db, input.entryId)
  const phase = await derivePostgresqlQuestionPhase(db, entry)
  if (phase !== 'awaiting_confirm') {
    throw new ConflictError(
      TASK_QUESTION_CONFLICT.notAwaitingConfirm,
      `task question is '${phase}', not awaiting_confirm`,
    )
  }
  const now = Date.now()
  const changed = await db
    .update(taskQuestions)
    .set({
      confirmation: 'confirmed',
      confirmedBy: input.actor.userId,
      confirmedByRole: input.actor.role,
      confirmedAt: now,
      updatedAt: now,
    })
    .where(and(eq(taskQuestions.id, input.entryId), eq(taskQuestions.confirmation, 'open')))
    .returning({ id: taskQuestions.id })
  if (changed.length !== 1) {
    throw new ConflictError(
      TASK_QUESTION_CONFLICT.notAwaitingConfirm,
      'task question changed before confirmation',
    )
  }
}

async function reassignPostgresqlTaskQuestion(
  db: PostgresqlDatabaseClient,
  input: Parameters<CollaborationRoutePersistenceOperations['questions']['reassign']>[0],
): Promise<ReassignTaskQuestionAction> {
  const entry = await loadQuestionEntry(db, input.entryId)
  if (!canReassign(input.targetNodeId, await postgresqlAgentNodeIds(db, entry.taskId))) {
    throw new ValidationError(
      TASK_QUESTION_CONFLICT.reassignInvalid,
      `cannot reassign '${entry.roleKind}' entry to '${input.targetNodeId}'`,
    )
  }
  if ((await derivePostgresqlQuestionPhase(db, entry)) === 'done') {
    throw new ConflictError(TASK_QUESTION_CONFLICT.terminal, "cannot reassign a 'done' question")
  }
  if (entry.sourceKind === 'manual') {
    await assertPostgresqlManualTarget(db, entry.taskId, input.targetNodeId)
    const now = Date.now()
    const changed = await db
      .update(taskQuestions)
      .set({
        overrideTargetNodeId: input.targetNodeId,
        lastReassignedBy: input.actor.userId,
        lastReassignedAt: now,
        updatedAt: now,
      })
      .where(and(eq(taskQuestions.id, input.entryId), isNull(taskQuestions.dispatchedAt)))
      .returning({ id: taskQuestions.id })
    if (changed.length !== 1) {
      throw new ConflictError(
        TASK_QUESTION_CONFLICT.alreadyDispatched,
        'cannot reassign a dispatched question',
      )
    }
    return 'moved-manual'
  }
  const round = (
    await db
      .select()
      .from(clarifyRounds)
      .where(eq(clarifyRounds.intermediaryNodeRunId, entry.originNodeRunId))
      .limit(1)
  )[0]
  if (round === undefined) {
    throw new ConflictError(
      TASK_QUESTION_CONFLICT.roundMissing,
      `cannot reassign question ${input.entryId}: its clarify round is gone`,
    )
  }
  if (input.targetNodeId === round.askingNodeId) {
    await serializable(db, async (tx) => {
      const existing = (
        await tx
          .select({ id: taskQuestions.id, dispatchedAt: taskQuestions.dispatchedAt })
          .from(taskQuestions)
          .where(
            and(
              eq(taskQuestions.originNodeRunId, entry.originNodeRunId),
              eq(taskQuestions.questionId, entry.questionId),
              eq(taskQuestions.roleKind, 'designer'),
            ),
          )
          .limit(1)
      )[0]
      if (existing === undefined) return
      if (existing.dispatchedAt !== null) {
        throw new ConflictError(
          TASK_QUESTION_CONFLICT.alreadyDispatched,
          'cannot remove a dispatched designer handler',
        )
      }
      await tx.delete(taskQuestions).where(eq(taskQuestions.id, existing.id)).run()
    })
    return 'removed-designer'
  }
  const now = Date.now()
  await serializable(db, async (tx) => {
    const existing = (
      await tx
        .select()
        .from(taskQuestions)
        .where(
          and(
            eq(taskQuestions.originNodeRunId, entry.originNodeRunId),
            eq(taskQuestions.questionId, entry.questionId),
            eq(taskQuestions.roleKind, 'designer'),
          ),
        )
        .limit(1)
    )[0]
    if (existing !== undefined) {
      if (existing.dispatchedAt !== null) {
        throw new ConflictError(
          TASK_QUESTION_CONFLICT.alreadyDispatched,
          'cannot re-target a dispatched designer handler',
        )
      }
      await tx
        .update(taskQuestions)
        .set({
          defaultTargetNodeId: input.targetNodeId,
          overrideTargetNodeId: null,
          lastReassignedBy: input.actor.userId,
          lastReassignedAt: now,
          updatedAt: now,
        })
        .where(eq(taskQuestions.id, existing.id))
        .run()
      return
    }
    await tx
      .insert(taskQuestions)
      .values({
        id: ulid(),
        taskId: entry.taskId,
        originNodeRunId: entry.originNodeRunId,
        questionId: entry.questionId,
        questionTitle: entry.questionTitle,
        sourceKind: entry.sourceKind,
        roleKind: 'designer',
        iteration: round.iteration,
        loopIter: round.loopIter,
        defaultTargetNodeId: input.targetNodeId,
        sealedAt:
          entry.sealedAt ?? (round.status === 'answered' ? (round.answeredAt ?? now) : null),
        stagedAt: entry.stagedAt,
        stagedBy: entry.stagedBy,
        lastReassignedBy: input.actor.userId,
        lastReassignedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: [taskQuestions.originNodeRunId, taskQuestions.questionId, taskQuestions.roleKind],
      })
      .run()
  })
  return 'added-designer'
}

async function stagePostgresqlTaskQuestion(
  db: PostgresqlDatabaseClient,
  input: Parameters<CollaborationRoutePersistenceOperations['questions']['stage']>[0],
): Promise<void> {
  const entry = await loadQuestionEntry(db, input.entryId)
  if (input.staged) {
    let sealed = entry.sourceKind === 'manual' || entry.sealedAt !== null
    if (!sealed) {
      const round = (
        await db
          .select({ status: clarifyRounds.status })
          .from(clarifyRounds)
          .where(eq(clarifyRounds.intermediaryNodeRunId, entry.originNodeRunId))
          .limit(1)
      )[0]
      sealed = round?.status === 'answered'
    }
    if (!sealed) {
      throw new ConflictError(
        TASK_QUESTION_CONFLICT.notSealed,
        `task question ${input.entryId} is not yet sealed`,
      )
    }
    const now = Date.now()
    const changed = await db
      .update(taskQuestions)
      .set({
        stagedAt: now,
        stagedBy: input.actor.userId,
        autoDispatchDeferredAt: null,
        updatedAt: now,
      })
      .where(and(eq(taskQuestions.id, input.entryId), isNull(taskQuestions.dispatchedAt)))
      .returning({ id: taskQuestions.id })
    if (changed.length !== 1) {
      throw new ConflictError(
        TASK_QUESTION_CONFLICT.alreadyDispatched,
        'cannot stage a dispatched question',
      )
    }
    return
  }
  await db
    .update(taskQuestions)
    .set({
      stagedAt: null,
      stagedBy: null,
      autoDispatchDeferredAt: null,
      updatedAt: Date.now(),
    })
    .where(
      and(
        eq(taskQuestions.originNodeRunId, entry.originNodeRunId),
        eq(taskQuestions.questionId, entry.questionId),
        isNull(taskQuestions.dispatchedAt),
      ),
    )
    .run()
}

function clarifyNodeTitles(snapshot: string): Map<string, string> {
  const result = new Map<string, string>()
  try {
    const definition = JSON.parse(snapshot) as WorkflowDefinition
    for (const node of definition.nodes ?? []) {
      const title = node.title?.trim() ?? ''
      if (title.length > 0) result.set(node.id, title)
    }
  } catch {
    // Corrupt frozen workflow snapshots keep the id/null fallback.
  }
  return result
}

function clarifySummary(
  row: ClarifyRoundRow,
  taskName: string,
  titles: ReadonlyMap<string, string>,
): ClarifyRoundSummary {
  return {
    id: row.id,
    taskId: row.taskId,
    taskName,
    kind: row.kind,
    terminatedAs: terminatedAsForStatus(row.status),
    askingNodeId: row.askingNodeId,
    askingNodeTitle: titles.get(row.askingNodeId) ?? null,
    askingShardKey: row.askingShardKey,
    intermediaryNodeId: row.intermediaryNodeId,
    intermediaryNodeTitle: titles.get(row.intermediaryNodeId) ?? null,
    intermediaryNodeRunId: row.intermediaryNodeRunId,
    targetConsumerNodeId: row.targetConsumerNodeId,
    loopIter: row.loopIter,
    iteration: row.iteration,
    questionCount: parseClarifyQuestions(row.questionsJson).length,
    status: row.status,
    directive: row.directive,
    createdAt: row.createdAt,
    answeredAt: row.answeredAt,
  }
}

async function listPostgresqlClarifySummaries(
  db: PostgresqlDatabaseClient,
  input: ListClarifySummariesInput,
): Promise<ClarifyRoundSummary[]> {
  const status = input.status ?? 'awaiting_human'
  const rows = await db
    .select()
    .from(clarifyRounds)
    .where(
      and(
        input.taskId === undefined ? undefined : eq(clarifyRounds.taskId, input.taskId),
        input.kind === undefined || input.kind === 'all'
          ? undefined
          : eq(clarifyRounds.kind, input.kind),
        status === 'all' ? undefined : eq(clarifyRounds.status, status),
      ),
    )
    .orderBy(desc(clarifyRounds.createdAt), desc(clarifyRounds.id))
  let visible = rows
  if (status === 'awaiting_human' && rows.length > 0) {
    const taskRows = await db
      .select({ id: tasks.id, status: tasks.status })
      .from(tasks)
      .where(inArray(tasks.id, [...new Set(rows.map((row) => row.taskId))]))
    const statuses = new Map(taskRows.map((row) => [row.id, row.status]))
    visible = rows.filter((row) => {
      const taskStatus = statuses.get(row.taskId)
      return taskStatus === undefined || !isTerminalTaskStatus(taskStatus)
    })
  }
  const sliced = visible.slice(0, input.limit ?? 100)
  if (sliced.length === 0) return []
  const taskRows = await db
    .select({ id: tasks.id, name: tasks.name, workflowSnapshot: tasks.workflowSnapshot })
    .from(tasks)
    .where(inArray(tasks.id, [...new Set(sliced.map((row) => row.taskId))]))
  const byId = new Map(taskRows.map((row) => [row.id, row]))
  return sliced.map((row) => {
    const task = byId.get(row.taskId)
    return clarifySummary(
      row,
      task?.name ?? '',
      task === undefined ? new Map() : clarifyNodeTitles(task.workflowSnapshot),
    )
  })
}

async function countPostgresqlPendingClarifyRounds(
  db: PostgresqlDatabaseClient,
  taskAccess: Pick<CollaborationTaskAccessPort, 'visibleTaskIds'>,
  actor: CollaborationRouteActor,
): Promise<number> {
  const rows = await db
    .select({ taskId: clarifyRounds.taskId })
    .from(clarifyRounds)
    .leftJoin(tasks, eq(tasks.id, clarifyRounds.taskId))
    .where(
      and(
        eq(clarifyRounds.status, 'awaiting_human'),
        or(isNull(tasks.id), notInArray(tasks.status, [...TERMINAL_TASK_STATUSES])),
      ),
    )
  if (actor.permissions.has('tasks:read:all')) return rows.length
  const taskIds = [...new Set(rows.map((row) => row.taskId))]
  if (taskIds.length === 0) return 0
  const visible = await taskAccess.visibleTaskIds(actor, taskIds)
  return rows.reduce((total, row) => total + (visible.has(row.taskId) ? 1 : 0), 0)
}

function clarifyDetail(row: ClarifyRoundRow, titles: ReadonlyMap<string, string>): ClarifyRound {
  const answers = row.answersJson === null ? undefined : parseClarifyAnswers(row.answersJson)
  const warnings = parseJsonArray<ClarifyTruncationWarning>(row.truncationWarningsJson)
  return {
    id: row.id,
    taskId: row.taskId,
    kind: row.kind,
    terminatedAs: terminatedAsForStatus(row.status),
    askingNodeId: row.askingNodeId,
    askingNodeRunId: row.askingNodeRunId,
    askingShardKey: row.askingShardKey,
    intermediaryNodeId: row.intermediaryNodeId,
    intermediaryNodeRunId: row.intermediaryNodeRunId,
    intermediaryNodeTitle: titles.get(row.intermediaryNodeId) ?? null,
    targetConsumerNodeId: row.targetConsumerNodeId,
    loopIter: row.loopIter,
    iteration: row.iteration,
    questions: parseClarifyQuestions(row.questionsJson),
    ...(answers === undefined ? {} : { answers }),
    directive: row.directive,
    status: row.status,
    ...(warnings.length === 0 ? {} : { truncationWarnings: warnings }),
    sessionMode: null,
    designerRunTriggeredAt: row.designerRunTriggeredAt,
    abandonedAt: row.abandonedAt,
    createdAt: row.createdAt,
    answeredAt: row.answeredAt,
    answeredBy: row.answeredBy,
    submittedByRole:
      row.submittedByRole === null ? null : TaskActorRoleSchema.parse(row.submittedByRole),
    answerAttributions: parseJsonRecord<ClarifyAnswerAttributions>(row.answerAttributionsJson),
    draftAnswers: parseJsonRecord<Record<string, ClarifyDraftValue>>(row.draftAnswersJson),
  }
}

async function getPostgresqlClarifyDetail(
  db: PostgresqlDatabaseClient,
  intermediaryNodeRunId: string,
): Promise<ClarifyRound> {
  const row = (
    await db
      .select()
      .from(clarifyRounds)
      .where(eq(clarifyRounds.intermediaryNodeRunId, intermediaryNodeRunId))
      .orderBy(desc(clarifyRounds.createdAt))
      .limit(1)
  )[0]
  if (row === undefined) {
    throw new NotFoundError(
      'clarify-round-not-found',
      `no clarify_round for intermediary node_run ${intermediaryNodeRunId}`,
    )
  }
  const task = (
    await db
      .select({ snapshot: tasks.workflowSnapshot })
      .from(tasks)
      .where(eq(tasks.id, row.taskId))
      .limit(1)
  )[0]
  const result = clarifyDetail(
    row,
    task === undefined ? new Map() : clarifyNodeTitles(task.snapshot),
  )
  if (row.status === 'canceled' || row.status === 'abandoned') {
    const run = (
      await db
        .select({ errorMessage: nodeRuns.errorMessage })
        .from(nodeRuns)
        .where(eq(nodeRuns.id, intermediaryNodeRunId))
        .limit(1)
    )[0]
    if (run?.errorMessage !== null && run?.errorMessage !== undefined && run.errorMessage !== '') {
      result.sealedCause = run.errorMessage
    }
  }
  return result
}

async function savePostgresqlClarifyDraft(
  composition: Pick<CreatePostgresqlCollaborationRouteOperationsInput, 'db' | 'clarifyDraftEvents'>,
  input: SaveClarifyDraftInput,
) {
  const db = composition.db
  const now = Date.now()
  const taskId = await serializable(db, async (tx) => {
    const row = (
      await tx.select().from(clarifyRounds).where(eq(clarifyRounds.id, input.roundId)).limit(1)
    )[0]
    if (row === undefined || row.intermediaryNodeRunId !== input.intermediaryNodeRunId) {
      throw new NotFoundError(
        'clarify-round-not-found',
        `clarify round '${input.roundId}' not found`,
      )
    }
    if (row.status !== 'awaiting_human') {
      throw new ConflictError(
        'clarify-round-not-awaiting',
        `clarify round '${input.roundId}' is '${row.status}'`,
      )
    }
    if (
      !parseClarifyQuestions(row.questionsJson).some((question) => question.id === input.questionId)
    ) {
      throw new NotFoundError(
        'clarify-question-not-found',
        `question '${input.questionId}' not in round '${input.roundId}'`,
      )
    }
    const drafts = parseJsonRecord<Record<string, ClarifyDraftValue>>(row.draftAnswersJson) ?? {}
    const attrs = parseJsonRecord<ClarifyAnswerAttributions>(row.answerAttributionsJson) ?? {}
    drafts[input.questionId] = input.value
    attrs[input.questionId] = {
      userId: input.editor.userId,
      role: input.editor.role,
      updatedAt: now,
    }
    const changed = await tx
      .update(clarifyRounds)
      .set({
        draftAnswersJson: JSON.stringify(drafts),
        answerAttributionsJson: JSON.stringify(attrs),
      })
      .where(and(eq(clarifyRounds.id, input.roundId), eq(clarifyRounds.status, 'awaiting_human')))
      .returning({ id: clarifyRounds.id })
    if (changed.length !== 1) {
      throw new ConflictError(
        'clarify-round-not-awaiting',
        `clarify round '${input.roundId}' is no longer awaiting_human`,
      )
    }
    return row.taskId
  })
  await composition.clarifyDraftEvents.publish({
    taskId,
    nodeRunId: input.intermediaryNodeRunId,
    roundId: input.roundId,
    questionId: input.questionId,
    editor: input.editor,
    occurredAt: now,
  })
  return { roundId: input.roundId, questionId: input.questionId, updatedAt: now }
}

function sealAnswers(
  questions: readonly ClarifyQuestion[],
  input: readonly ClarifyAnswer[],
): ClarifyAnswer[] {
  const questionsById = new Map(questions.map((question) => [question.id, question]))
  const result: ClarifyAnswer[] = []
  for (const raw of input) {
    const parsed = ClarifyAnswerSchema.safeParse(raw)
    if (!parsed.success) {
      throw new ValidationError(
        'clarify-answer-malformed',
        `answer for question '${raw.questionId}' is invalid`,
      )
    }
    const question = questionsById.get(parsed.data.questionId)
    if (question === undefined) continue
    const selectedOptionIndices = parsed.data.selectedOptionIndices.filter(
      (index) => index >= 0 && index < question.options.length,
    )
    result.push({
      questionId: parsed.data.questionId,
      selectedOptionIndices,
      selectedOptionLabels: selectedOptionIndices
        .map((index) => question.options[index]?.label ?? '')
        .filter((label) => label.length > 0),
      customText: parsed.data.customText,
    })
  }
  return result
}

function draftMatchesAnswer(draft: ClarifyDraftValue | undefined, answer: ClarifyAnswer): boolean {
  if (draft === undefined) return false
  const draftIndices = [...(draft.selectedOptionIndices ?? [])].sort((left, right) => left - right)
  const answerIndices = [...answer.selectedOptionIndices].sort((left, right) => left - right)
  return (
    draftIndices.length === answerIndices.length &&
    draftIndices.every((value, index) => value === answerIndices[index]) &&
    (draft.customText ?? '') === answer.customText
  )
}

function freezeAttributions(input: {
  readonly answers: readonly ClarifyAnswer[]
  readonly drafts: Readonly<Record<string, ClarifyDraftValue>> | null
  readonly attributions: ClarifyAnswerAttributions | null
  readonly submitter: Readonly<{ userId: string; role: TaskActorRole }>
  readonly now: number
}): ClarifyAnswerAttributions {
  const result: ClarifyAnswerAttributions = {}
  for (const answer of input.answers) {
    const prior = input.attributions?.[answer.questionId]
    result[answer.questionId] =
      prior !== undefined && draftMatchesAnswer(input.drafts?.[answer.questionId], answer)
        ? prior
        : { userId: input.submitter.userId, role: input.submitter.role, updatedAt: input.now }
  }
  return result
}

function clarifyDirectiveShardKey(round: ClarifyRoundRow): string {
  if (round.askingNodeId === '__wg_leader__' || round.askingNodeId === '__wg_member__') {
    return wgClarifyAskerKey(round.askingNodeId, round.askingShardKey, '__wg_leader__')
  }
  return round.askingShardKey ?? ''
}

async function sealPostgresqlClarifyQuestions(
  input: CreatePostgresqlCollaborationRouteOperationsInput,
  request: SealClarifyQuestionsInput,
): Promise<SealClarifyQuestionsResult> {
  const now = Date.now()
  const committed = await serializable(input.db, async (tx) => {
    const round = (
      await tx
        .select()
        .from(clarifyRounds)
        .where(eq(clarifyRounds.intermediaryNodeRunId, request.originNodeRunId))
        .limit(1)
    )[0]
    if (round === undefined) {
      throw new NotFoundError(
        'clarify-round-not-found',
        `no clarify_round for origin node_run ${request.originNodeRunId}`,
      )
    }
    if (round.status === 'canceled' || round.status === 'abandoned') {
      throw new ConflictError(
        'clarify-round-terminal',
        `clarify_round ${round.id} is '${round.status}'`,
      )
    }
    const task = (
      await tx
        .select({ status: tasks.status })
        .from(tasks)
        .where(eq(tasks.id, round.taskId))
        .limit(1)
    )[0]
    if (task?.status === 'done' || task?.status === 'canceled') {
      throw new ConflictError(
        'task-terminal',
        `task ${round.taskId} is '${task.status}'; this clarify round no longer accepts answers`,
      )
    }
    const questions = parseClarifyQuestions(round.questionsJson)
    const sealedSubset = sealAnswers(questions, request.answers)
    const sealingSet = new Set(sealedSubset.map((answer) => answer.questionId))
    if (sealingSet.size === 0) {
      throw new ValidationError(
        'clarify-seal-empty',
        'no sealable answers reference a known question of this round',
      )
    }
    await reconcilePostgresqlRoundEntries(tx, round)
    const entries = await tx
      .select()
      .from(taskQuestions)
      .where(eq(taskQuestions.originNodeRunId, request.originNodeRunId))
    const alreadySealed = new Set<string>()
    if (round.status === 'answered') {
      for (const question of questions) alreadySealed.add(question.id)
    }
    for (const entry of entries) {
      if (entry.sealedAt !== null) alreadySealed.add(entry.questionId)
    }
    const declaredReseal = new Set(request.allowResealFor ?? [])
    const resealed = new Set<string>()
    for (const questionId of sealingSet) {
      if (!alreadySealed.has(questionId)) continue
      const matching = entries.filter((entry) => entry.questionId === questionId)
      if (
        !declaredReseal.has(questionId) ||
        matching.length === 0 ||
        !matching.every((entry) => entry.dispatchedAt === null && entry.stagedAt === null)
      ) {
        throw new ConflictError(
          'clarify-question-already-sealed',
          `question '${questionId}' is already sealed`,
        )
      }
      resealed.add(questionId)
    }
    const fresh = [...sealingSet].filter((questionId) => !resealed.has(questionId))
    const merged = mergeSealedAnswers(parseClarifyAnswers(round.answersJson), sealedSubset)
    const newlySealed = new Set([...alreadySealed, ...sealingSet])
    const fullySealed = questions.every((question) => newlySealed.has(question.id))
    const flipNow = fullySealed && round.status !== 'answered'
    const directive: ClarifyDirective =
      round.status === 'answered'
        ? (round.directive ?? 'continue')
        : (request.directive ?? round.directive ?? 'continue')
    const attributions =
      flipNow && request.sealedBy !== undefined && request.sealedByRole !== undefined
        ? freezeAttributions({
            answers: merged,
            drafts: parseJsonRecord<Record<string, ClarifyDraftValue>>(round.draftAnswersJson),
            attributions: parseJsonRecord<ClarifyAnswerAttributions>(round.answerAttributionsJson),
            submitter: { userId: request.sealedBy, role: request.sealedByRole },
            now,
          })
        : null
    await tx
      .update(clarifyRounds)
      .set({
        answersJson: JSON.stringify(merged),
        ...(flipNow
          ? {
              status: 'answered' as const,
              directive,
              answeredAt: now,
              answeredBy: request.sealedBy ?? null,
              ...(request.sealedByRole === undefined
                ? {}
                : { submittedByRole: request.sealedByRole }),
              ...(attributions === null
                ? {}
                : {
                    answerAttributionsJson: JSON.stringify(attributions),
                    draftAnswersJson: null,
                  }),
            }
          : {}),
      })
      .where(eq(clarifyRounds.id, round.id))
      .run()
    await tx
      .update(taskQuestions)
      .set({ sealedAt: now, sealedBy: request.sealedBy ?? null, updatedAt: now })
      .where(
        and(
          eq(taskQuestions.originNodeRunId, request.originNodeRunId),
          inArray(taskQuestions.questionId, [...sealingSet]),
        ),
      )
      .run()
    if (request.autoStage === true) {
      await tx
        .update(taskQuestions)
        .set({ stagedAt: now, stagedBy: request.sealedBy ?? null, updatedAt: now })
        .where(
          and(
            eq(taskQuestions.originNodeRunId, request.originNodeRunId),
            inArray(taskQuestions.questionId, [...sealingSet]),
            isNull(taskQuestions.stagedAt),
          ),
        )
        .run()
    }
    if (flipNow && directive === 'stop') {
      await tx
        .insert(taskNodeClarifyDirectives)
        .values({
          taskId: round.taskId,
          nodeId: round.askingNodeId,
          shardKey: clarifyDirectiveShardKey(round),
          directive: 'stop',
          setBy: request.sealedBy ?? LOCAL_DECIDER,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            taskNodeClarifyDirectives.taskId,
            taskNodeClarifyDirectives.nodeId,
            taskNodeClarifyDirectives.shardKey,
          ],
          set: {
            directive: 'stop',
            setBy: request.sealedBy ?? LOCAL_DECIDER,
            updatedAt: now,
          },
        })
        .run()
    }
    const eventRefs: CommittedEventRef[] = []
    if (flipNow) {
      const operationRef = `clarify-seal:${round.id}:${ulid(now)}`
      const eventGroupId = committedEventGroupId('collaboration', operationRef)
      const taskEvent = await input.taskNodeLifecycle.inTransaction(tx).completeClarifyNode({
        taskId: round.taskId,
        nodeRunId: request.originNodeRunId,
        nodeId: round.intermediaryNodeId,
        expectedStatus: 'awaiting_human',
        status: 'done',
        cause: 'clarify-deferred-answer',
        finishedAt: now,
        occurredAt: now,
        identity: {
          operationRef,
          eventGroupId,
          eventGroupOrdinal: 0,
          correlationRef: `human-gate-node-run:${request.originNodeRunId}`,
        },
      })
      if (taskEvent !== null) eventRefs.push(taskEvent)
      const collaborationEvent = await appendCollaborationProjectionEvent(tx, {
        type: 'collaboration.human-gate-decision-committed.v1',
        family: 'clarify',
        gate: {
          taskId: round.taskId,
          nodeRunId: request.originNodeRunId,
          gateKind: 'clarify',
          gateId: `clarify:${request.originNodeRunId}`,
          roundId: round.id,
        },
        projectionFrames: [],
        decision: { gateKind: 'clarify', kind: directive },
        occurredAt: now,
        operationRef,
        eventGroupId,
        eventGroupOrdinal: 1,
      })
      if (collaborationEvent !== null) eventRefs.push(collaborationEvent)
    }
    return {
      result: {
        sealedQuestionIds: fresh,
        resealedQuestionIds: [...resealed],
        roundFullySealed: fullySealed,
      },
      eventRefs,
    }
  })
  await publishCommittedEventsAfterCommit(committed.eventRefs)
  return committed.result
}

export function createPostgresqlCollaborationRouteOperations(
  input: CreatePostgresqlCollaborationRouteOperationsInput,
): CollaborationRoutePersistenceOperations {
  const reviews: CollaborationRoutePersistenceOperations['reviews'] = Object.freeze({
    list: async (filter) => await listPostgresqlReviewSummaries(input.db, filter),
    countPending: async (actor) =>
      await countPostgresqlPendingReviews(input.db, input.taskAccess, actor),
    detail: async (request) =>
      await getPostgresqlReviewDetail(input.db, request.appHome, request.nodeRunId),
    listVersions: async (nodeRunId) =>
      (
        await input.db
          .select()
          .from(docVersions)
          .where(eq(docVersions.reviewNodeRunId, nodeRunId))
          .orderBy(desc(docVersions.versionIndex))
      ).map(rowToDocVersion),
    versionDetail: async (request) =>
      await getPostgresqlVersionDetail(
        input.db,
        request.appHome,
        request.nodeRunId,
        request.versionId,
      ),
    listRounds: async (request) =>
      await listPostgresqlReviewRounds(input.db, request.appHome, request.nodeRunId),
    setSelection: async (request) => await setPostgresqlDocumentSelection(input.db, request),
    addComment: async (request) => await addPostgresqlReviewComment(input.db, request),
    updateComment: async (request) => await updatePostgresqlReviewComment(input.db, request),
    deleteComment: async (request) => await deletePostgresqlReviewComment(input.db, request),
  })
  const questions: CollaborationRoutePersistenceOperations['questions'] = Object.freeze({
    list: async (request) => await listPostgresqlTaskQuestions(input.db, request),
    createManual: async (request) => await createPostgresqlManualQuestion(input.db, request),
    confirm: async (request) => await confirmPostgresqlTaskQuestion(input.db, request),
    reassign: async (request) => await reassignPostgresqlTaskQuestion(input.db, request),
    stage: async (request) => await stagePostgresqlTaskQuestion(input.db, request),
  })
  const clarify: CollaborationRoutePersistenceOperations['clarify'] = Object.freeze({
    list: async (request) => await listPostgresqlClarifySummaries(input.db, request),
    countPending: async (actor) =>
      await countPostgresqlPendingClarifyRounds(input.db, input.taskAccess, actor),
    detail: async (nodeRunId) => await getPostgresqlClarifyDetail(input.db, nodeRunId),
    seal: async (request) => await sealPostgresqlClarifyQuestions(input, request),
    saveDraft: async (request) => await savePostgresqlClarifyDraft(input, request),
  })
  return Object.freeze({ reviews, questions, clarify })
}

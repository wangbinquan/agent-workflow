import { and, asc, eq, inArray, lte } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import {
  cachedRepos,
  clarifyRounds,
  docVersions,
  memories,
  memoryDistillJobs,
  nodeRunEvents,
  nodeRuns,
  reviewComments,
  taskFeedback,
  tasks,
} from '@/db/schema'
import type {
  MemoryDistillCaptureInput,
  MemoryDistillWorkStore,
} from '../application/ports/distillWorkStore'

export type SqliteMemoryDistillSessionCapture = (input: MemoryDistillCaptureInput) => Promise<void>

export class SqliteMemoryDistillWorkStore implements MemoryDistillWorkStore {
  constructor(
    private readonly db: DbClient,
    private readonly capture: SqliteMemoryDistillSessionCapture,
  ) {}

  async findTaskScope(taskId: string) {
    const row = this.db
      .select({
        workflowSnapshot: tasks.workflowSnapshot,
        workgroupConfigJson: tasks.workgroupConfigJson,
        workflowId: tasks.workflowId,
        cachedRepoId: tasks.cachedRepoId,
        cachedRepoMatch: cachedRepos.id,
      })
      .from(tasks)
      .leftJoin(cachedRepos, eq(cachedRepos.id, tasks.cachedRepoId))
      .where(eq(tasks.id, taskId))
      .limit(1)
      .get()
    return row === undefined
      ? null
      : {
          workflowSnapshot: row.workflowSnapshot,
          workgroupConfigJson: row.workgroupConfigJson,
          workflowId: row.workflowId,
          cachedRepoId: row.cachedRepoId,
          cachedRepoExists: row.cachedRepoMatch !== null,
        }
  }

  async enqueue(input: Parameters<MemoryDistillWorkStore['enqueue']>[0]): Promise<void> {
    this.db
      .insert(memoryDistillJobs)
      .values({
        id: input.id,
        debounceKey: input.debounceKey,
        sourceKind: input.sourceKind,
        sourceEventId: input.sourceEventId,
        taskId: input.taskId,
        scopeResolvedJson: JSON.stringify(input.scope),
        status: 'pending',
        attempts: 0,
        nextRunAt: input.nextRunAt,
        createdAt: input.createdAt,
        outputLang: input.outputLang,
      })
      .run()
  }

  async listDue(now: number, limit: number) {
    return this.db
      .select()
      .from(memoryDistillJobs)
      .where(and(eq(memoryDistillJobs.status, 'pending'), lte(memoryDistillJobs.nextRunAt, now)))
      .orderBy(asc(memoryDistillJobs.nextRunAt))
      .limit(limit)
      .all()
  }

  async listPendingSiblings(debounceKey: string) {
    return this.db
      .select()
      .from(memoryDistillJobs)
      .where(
        and(
          eq(memoryDistillJobs.debounceKey, debounceKey),
          eq(memoryDistillJobs.status, 'pending'),
        ),
      )
      .orderBy(asc(memoryDistillJobs.createdAt))
      .all()
  }

  async markRunning(ids: readonly string[], startedAt: number): Promise<void> {
    if (ids.length === 0) return
    this.db
      .update(memoryDistillJobs)
      .set({ status: 'running', startedAt })
      .where(and(inArray(memoryDistillJobs.id, [...ids]), eq(memoryDistillJobs.status, 'pending')))
      .run()
  }

  async markDone(ids: readonly string[], finishedAt: number): Promise<void> {
    if (ids.length === 0) return
    this.db
      .update(memoryDistillJobs)
      .set({ status: 'done', finishedAt })
      .where(inArray(memoryDistillJobs.id, [...ids]))
      .run()
  }

  async markFailed(input: Parameters<MemoryDistillWorkStore['markFailed']>[0]): Promise<void> {
    if (input.ids.length === 0) return
    const patch =
      input.retryAt === null
        ? {
            status: 'failed' as const,
            attempts: input.attempts,
            lastError: input.error,
            finishedAt: input.now,
          }
        : {
            status: 'pending' as const,
            attempts: input.attempts,
            lastError: input.error,
            nextRunAt: input.retryAt,
            startedAt: null,
          }
    this.db
      .update(memoryDistillJobs)
      .set(patch)
      .where(inArray(memoryDistillJobs.id, [...input.ids]))
      .run()
  }

  async recoverRunning(): Promise<number> {
    return this.db
      .update(memoryDistillJobs)
      .set({ status: 'pending', startedAt: null })
      .where(eq(memoryDistillJobs.status, 'running'))
      .returning({ id: memoryDistillJobs.id })
      .all().length
  }

  async retryFailed(jobId: string, now: number) {
    return (
      this.db
        .update(memoryDistillJobs)
        .set({
          status: 'pending',
          attempts: 0,
          lastError: null,
          nextRunAt: now,
          startedAt: null,
          finishedAt: null,
        })
        .where(and(eq(memoryDistillJobs.id, jobId), eq(memoryDistillJobs.status, 'failed')))
        .returning()
        .get() ?? null
    )
  }

  async cancelPending(jobId: string, now: number): Promise<boolean> {
    return (
      this.db
        .update(memoryDistillJobs)
        .set({ status: 'canceled', finishedAt: now })
        .where(and(eq(memoryDistillJobs.id, jobId), eq(memoryDistillJobs.status, 'pending')))
        .returning({ id: memoryDistillJobs.id })
        .get() !== undefined
    )
  }

  async listJobs(status?: string) {
    const query = this.db.select().from(memoryDistillJobs)
    return status === undefined
      ? query.orderBy(asc(memoryDistillJobs.createdAt)).all()
      : query
          .where(eq(memoryDistillJobs.status, status as 'pending'))
          .orderBy(asc(memoryDistillJobs.createdAt))
          .all()
  }

  async listClarifySources(ids: readonly string[]) {
    if (ids.length === 0) return []
    return this.db
      .select({
        id: clarifyRounds.id,
        taskId: clarifyRounds.taskId,
        intermediaryNodeId: clarifyRounds.intermediaryNodeId,
        askingNodeRunId: clarifyRounds.askingNodeRunId,
        questionsJson: clarifyRounds.questionsJson,
        answersJson: clarifyRounds.answersJson,
      })
      .from(clarifyRounds)
      .where(and(eq(clarifyRounds.kind, 'self'), inArray(clarifyRounds.id, [...ids])))
      .all()
  }

  async listReviewSources(ids: readonly string[]) {
    if (ids.length === 0) return []
    return this.db
      .select({
        id: docVersions.id,
        taskId: docVersions.taskId,
        reviewNodeId: docVersions.reviewNodeId,
        decision: docVersions.decision,
        bodyPath: docVersions.bodyPath,
      })
      .from(docVersions)
      .where(inArray(docVersions.id, [...ids]))
      .all()
  }

  async listReviewComments(ids: readonly string[]) {
    if (ids.length === 0) return []
    return this.db
      .select({
        docVersionId: reviewComments.docVersionId,
        body: reviewComments.commentText,
        anchorParagraphIdx: reviewComments.anchorParagraphIdx,
        selectedText: reviewComments.selectedText,
      })
      .from(reviewComments)
      .where(inArray(reviewComments.docVersionId, [...ids]))
      .orderBy(asc(reviewComments.anchorParagraphIdx), asc(reviewComments.anchorOffsetStart))
      .all()
  }

  async listFeedbackSources(ids: readonly string[]) {
    if (ids.length === 0) return []
    return this.db
      .select({
        id: taskFeedback.id,
        taskId: taskFeedback.taskId,
        bodyMd: taskFeedback.bodyMd,
        createdAt: taskFeedback.createdAt,
      })
      .from(taskFeedback)
      .where(inArray(taskFeedback.id, [...ids]))
      .all()
  }

  async listNodeRuns(ids: readonly string[]) {
    if (ids.length === 0) return []
    return this.db
      .select({
        id: nodeRuns.id,
        promptText: nodeRuns.promptText,
        promptPath: nodeRuns.promptPath,
        startedAt: nodeRuns.startedAt,
        opencodeSessionId: nodeRuns.opencodeSessionId,
      })
      .from(nodeRuns)
      .where(inArray(nodeRuns.id, [...ids]))
      .all()
  }

  async listNodeRunEvents(ids: readonly string[]) {
    if (ids.length === 0) return []
    return this.db
      .select({
        id: nodeRunEvents.id,
        nodeRunId: nodeRunEvents.nodeRunId,
        ts: nodeRunEvents.ts,
        kind: nodeRunEvents.kind,
        payload: nodeRunEvents.payload,
        sessionId: nodeRunEvents.sessionId,
        parentSessionId: nodeRunEvents.parentSessionId,
      })
      .from(nodeRunEvents)
      .where(inArray(nodeRunEvents.nodeRunId, [...ids]))
      .orderBy(asc(nodeRunEvents.ts), asc(nodeRunEvents.id))
      .all()
  }

  async listApprovedMemories(
    scopeType: 'agent' | 'workflow' | 'repo' | 'global',
    scopeId: string | null,
  ) {
    const where =
      scopeId === null
        ? and(eq(memories.scopeType, scopeType), eq(memories.status, 'approved'))
        : and(
            eq(memories.scopeType, scopeType),
            eq(memories.scopeId, scopeId),
            eq(memories.status, 'approved'),
          )
    return this.db
      .select({
        id: memories.id,
        title: memories.title,
        bodyMd: memories.bodyMd,
        tagsJson: memories.tags,
      })
      .from(memories)
      .where(where)
      .orderBy(asc(memories.createdAt))
      .all()
  }

  async savePrompt(
    jobId: string,
    userPromptMd: string,
    dedupSnapshotIdsJson: string,
  ): Promise<void> {
    this.db
      .update(memoryDistillJobs)
      .set({ userPromptMd, dedupSnapshotIdsJson })
      .where(eq(memoryDistillJobs.id, jobId))
      .run()
  }

  async saveSpawnResult(
    jobId: string,
    input: Parameters<MemoryDistillWorkStore['saveSpawnResult']>[1],
  ): Promise<void> {
    this.db
      .update(memoryDistillJobs)
      .set({
        opencodeSessionId: input.sessionId,
        exitCode: input.exitCode,
        stderrExcerpt: input.stderrExcerpt,
      })
      .where(eq(memoryDistillJobs.id, jobId))
      .run()
  }

  async captureSession(input: MemoryDistillCaptureInput): Promise<void> {
    await this.capture(input)
  }

  async insertCandidate(input: Parameters<MemoryDistillWorkStore['insertCandidate']>[0]) {
    const memory = input.memory
    this.db
      .insert(memories)
      .values({
        id: memory.id,
        scopeType: memory.scopeType,
        scopeId: memory.scopeId,
        title: memory.title,
        bodyMd: memory.bodyMd,
        tags: JSON.stringify(memory.tags),
        status: 'candidate',
        sourceKind: memory.sourceKind,
        sourceEventId: memory.sourceEventId,
        sourceTaskId: memory.sourceTaskId,
        distillJobId: memory.distillJobId,
        distillAction: memory.distillAction,
        supersedesId: null,
        supersededById: null,
        approvedByUserId: null,
        approvedAt: null,
        createdAt: memory.createdAt,
        version: 1,
      })
      .run()
  }
}

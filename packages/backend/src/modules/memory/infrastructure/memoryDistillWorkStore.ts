// RFC-359 W4-B4 —— 记忆蒸馏工作存储：一份实现，两个 provider 共用。

import { and, asc, desc, eq, inArray, lte } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  cachedRepos,
  clarifyRounds,
  docVersions,
  memories,
  memoryDistillJobs,
  nodeRunEvents,
  nodeRunOutputs,
  nodeRuns,
  reviewComments,
  taskFeedback,
  tasks,
} from '@/db/schema'
import type {
  MemoryDistillSessionSinkInput,
  MemoryDistillWorkStore,
} from '../application/ports/distillWorkStore'
import type { SystemAgentEventSinkV1 } from '@/services/sessionEventSink'
import { createMemoryDistillSessionEventSink } from './memoryDistillSessionEventSink'
import { listMemoryDistillJobs } from './memoryDistillReadStore'

export class DrizzleMemoryDistillWorkStore implements MemoryDistillWorkStore {
  private readonly sinkFactory: (input: MemoryDistillSessionSinkInput) => SystemAgentEventSinkV1

  constructor(
    private readonly db: ProviderNeutralDatabase,
    /**
     * RFC-367 test seam; production omits it and gets the real
     * `memory_distill_events` writer. (It replaces the old `capture` argument,
     * which injected the post-run opencode SQLite walk.)
     */
    sinkFactory?: (input: MemoryDistillSessionSinkInput) => SystemAgentEventSinkV1,
  ) {
    this.sinkFactory = sinkFactory ?? createMemoryDistillSessionEventSink(db)
  }

  async findTaskScope(taskId: string) {
    const row = (
      await this.db
        .select({
          workflowSnapshot: tasks.workflowSnapshot,
          workgroupConfigJson: tasks.workgroupConfigJson,
          workflowId: tasks.workflowId,
          cachedRepoId: tasks.cachedRepoId,
          cachedRepoMatch: cachedRepos.id,
          // RFC-366 admission facts — same row, no extra query.
          launchOrigin: tasks.launchOrigin,
          catalogVisibility: tasks.catalogVisibility,
          spaceKind: tasks.spaceKind,
        })
        .from(tasks)
        .leftJoin(cachedRepos, eq(cachedRepos.id, tasks.cachedRepoId))
        .where(eq(tasks.id, taskId))
        .limit(1)
    )[0]
    return row === undefined
      ? null
      : {
          workflowSnapshot: row.workflowSnapshot,
          workgroupConfigJson: row.workgroupConfigJson,
          workflowId: row.workflowId,
          cachedRepoId: row.cachedRepoId,
          cachedRepoExists: row.cachedRepoMatch !== null,
          launchOrigin: row.launchOrigin,
          catalogVisibility: row.catalogVisibility,
          spaceKind: row.spaceKind,
        }
  }

  async enqueue(input: Parameters<MemoryDistillWorkStore['enqueue']>[0]): Promise<void> {
    await this.db.insert(memoryDistillJobs).values({
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
  }

  async listDue(now: number, limit: number) {
    return await this.db
      .select()
      .from(memoryDistillJobs)
      .where(and(eq(memoryDistillJobs.status, 'pending'), lte(memoryDistillJobs.nextRunAt, now)))
      .orderBy(asc(memoryDistillJobs.nextRunAt))
      .limit(limit)
  }

  async listPendingSiblings(debounceKey: string) {
    return await this.db
      .select()
      .from(memoryDistillJobs)
      .where(
        and(
          eq(memoryDistillJobs.debounceKey, debounceKey),
          eq(memoryDistillJobs.status, 'pending'),
        ),
      )
      .orderBy(asc(memoryDistillJobs.createdAt))
  }

  async markRunning(ids: readonly string[], startedAt: number): Promise<void> {
    if (ids.length === 0) return
    await this.db
      .update(memoryDistillJobs)
      .set({ status: 'running', startedAt })
      .where(and(inArray(memoryDistillJobs.id, [...ids]), eq(memoryDistillJobs.status, 'pending')))
  }

  async markDone(ids: readonly string[], finishedAt: number): Promise<void> {
    if (ids.length === 0) return
    await this.db
      .update(memoryDistillJobs)
      .set({ status: 'done', finishedAt })
      .where(inArray(memoryDistillJobs.id, [...ids]))
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
    await this.db
      .update(memoryDistillJobs)
      .set(patch)
      .where(inArray(memoryDistillJobs.id, [...input.ids]))
  }

  async recoverRunning(): Promise<number> {
    const rows = await this.db
      .update(memoryDistillJobs)
      .set({ status: 'pending', startedAt: null })
      .where(eq(memoryDistillJobs.status, 'running'))
      .returning({ id: memoryDistillJobs.id })
    return rows.length
  }

  async retryFailed(jobId: string, now: number) {
    const rows = await this.db
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
    return rows[0] ?? null
  }

  async cancelPending(jobId: string, now: number): Promise<boolean> {
    const rows = await this.db
      .update(memoryDistillJobs)
      .set({ status: 'canceled', finishedAt: now })
      .where(and(eq(memoryDistillJobs.id, jobId), eq(memoryDistillJobs.status, 'pending')))
      .returning({ id: memoryDistillJobs.id })
    return rows.length > 0
  }

  async listJobs(status?: string) {
    return await listMemoryDistillJobs(this.db, status)
  }

  async listClarifySources(ids: readonly string[]) {
    if (ids.length === 0) return []
    return await this.db
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
  }

  async listReviewSources(ids: readonly string[]) {
    if (ids.length === 0) return []
    return await this.db
      .select({
        id: docVersions.id,
        taskId: docVersions.taskId,
        reviewNodeId: docVersions.reviewNodeId,
        decision: docVersions.decision,
        bodyPath: docVersions.bodyPath,
      })
      .from(docVersions)
      .where(inArray(docVersions.id, [...ids]))
  }

  async listReviewComments(ids: readonly string[]) {
    if (ids.length === 0) return []
    return await this.db
      .select({
        docVersionId: reviewComments.docVersionId,
        body: reviewComments.commentText,
        anchorParagraphIdx: reviewComments.anchorParagraphIdx,
        selectedText: reviewComments.selectedText,
      })
      .from(reviewComments)
      .where(inArray(reviewComments.docVersionId, [...ids]))
      .orderBy(asc(reviewComments.anchorParagraphIdx), asc(reviewComments.anchorOffsetStart))
  }

  async listFeedbackSources(ids: readonly string[]) {
    if (ids.length === 0) return []
    return await this.db
      .select({
        id: taskFeedback.id,
        taskId: taskFeedback.taskId,
        bodyMd: taskFeedback.bodyMd,
        createdAt: taskFeedback.createdAt,
      })
      .from(taskFeedback)
      .where(inArray(taskFeedback.id, [...ids]))
  }

  // RFC-366 agent-run 源：结算的那一行 node_run 本身。
  async listAgentRunSources(ids: readonly string[]) {
    if (ids.length === 0) return []
    return await this.db
      .select({
        id: nodeRuns.id,
        taskId: nodeRuns.taskId,
        nodeId: nodeRuns.nodeId,
        status: nodeRuns.status,
        startedAt: nodeRuns.startedAt,
        finishedAt: nodeRuns.finishedAt,
        errorMessage: nodeRuns.errorMessage,
        failureCode: nodeRuns.failureCode,
        promptText: nodeRuns.promptText,
        promptPath: nodeRuns.promptPath,
        opencodeSessionId: nodeRuns.opencodeSessionId,
        injectedMemoriesJson: nodeRuns.injectedMemoriesJson,
      })
      .from(nodeRuns)
      .where(inArray(nodeRuns.id, [...ids]))
  }

  // RFC-366：`active=false` 的端口行是被后续写覆盖掉的历史值，喂给蒸馏器只会制造
  // 「这个 agent 前后说了两套」的假象，所以只取活的。
  async listNodeRunOutputs(ids: readonly string[]) {
    if (ids.length === 0) return []
    return await this.db
      .select({
        nodeRunId: nodeRunOutputs.nodeRunId,
        portName: nodeRunOutputs.portName,
        content: nodeRunOutputs.content,
        kind: nodeRunOutputs.kind,
      })
      .from(nodeRunOutputs)
      .where(and(inArray(nodeRunOutputs.nodeRunId, [...ids]), eq(nodeRunOutputs.active, true)))
      .orderBy(asc(nodeRunOutputs.nodeRunId), asc(nodeRunOutputs.portName))
  }

  // RFC-366 task-run 源：任务本身的收尾快照。
  async listTaskRunSources(ids: readonly string[]) {
    if (ids.length === 0) return []
    return await this.db
      .select({
        id: tasks.id,
        name: tasks.name,
        status: tasks.status,
        startedAt: tasks.startedAt,
        finishedAt: tasks.finishedAt,
        runningMs: tasks.runningMs,
        errorSummary: tasks.errorSummary,
        errorMessage: tasks.errorMessage,
        failedNodeId: tasks.failedNodeId,
        inputs: tasks.inputs,
        workflowSnapshot: tasks.workflowSnapshot,
      })
      .from(tasks)
      .where(inArray(tasks.id, [...ids]))
  }

  /**
   * RFC-366：任务里每个节点的终态一览。
   *
   * 一个节点在一个任务里可能有很多行（重试 / loop 每轮 / fanout 每分片），这里按
   * id 逆序取每个 (task, node) 的**最新一行**——node_run id 是 ULID，id 序即时间序
   * （`isFresherNodeRun` 用的也是这条判据），所以不需要再按 finishedAt 排序，后者
   * 在未结算的行上还是 null。
   */
  async listTaskNodeStatuses(taskIds: readonly string[]) {
    if (taskIds.length === 0) return []
    const rows = await this.db
      .select({
        taskId: nodeRuns.taskId,
        nodeId: nodeRuns.nodeId,
        status: nodeRuns.status,
        retryIndex: nodeRuns.retryIndex,
        finishedAt: nodeRuns.finishedAt,
        id: nodeRuns.id,
      })
      .from(nodeRuns)
      .where(inArray(nodeRuns.taskId, [...taskIds]))
      .orderBy(desc(nodeRuns.id))
    const seen = new Set<string>()
    const latest: {
      taskId: string
      nodeId: string
      nodeRunId: string
      status: string
      retryIndex: number
      finishedAt: number | null
    }[] = []
    for (const row of rows) {
      const key = `${row.taskId}\u0000${row.nodeId}`
      if (seen.has(key)) continue
      seen.add(key)
      latest.push({
        taskId: row.taskId,
        nodeId: row.nodeId,
        nodeRunId: row.id,
        status: row.status,
        retryIndex: row.retryIndex,
        finishedAt: row.finishedAt,
      })
    }
    return latest.reverse()
  }

  async listNodeRuns(ids: readonly string[]) {
    if (ids.length === 0) return []
    return await this.db
      .select({
        id: nodeRuns.id,
        promptText: nodeRuns.promptText,
        promptPath: nodeRuns.promptPath,
        startedAt: nodeRuns.startedAt,
        opencodeSessionId: nodeRuns.opencodeSessionId,
      })
      .from(nodeRuns)
      .where(inArray(nodeRuns.id, [...ids]))
  }

  async listNodeRunEvents(ids: readonly string[]) {
    if (ids.length === 0) return []
    return await this.db
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
    return await this.db
      .select({
        id: memories.id,
        title: memories.title,
        bodyMd: memories.bodyMd,
        tagsJson: memories.tags,
      })
      .from(memories)
      .where(where)
      .orderBy(asc(memories.createdAt))
  }

  async savePrompt(
    jobId: string,
    userPromptMd: string,
    dedupSnapshotIdsJson: string,
  ): Promise<void> {
    await this.db
      .update(memoryDistillJobs)
      .set({ userPromptMd, dedupSnapshotIdsJson })
      .where(eq(memoryDistillJobs.id, jobId))
  }

  async saveSpawnResult(
    jobId: string,
    input: Parameters<MemoryDistillWorkStore['saveSpawnResult']>[1],
  ): Promise<void> {
    await this.db
      .update(memoryDistillJobs)
      .set({
        opencodeSessionId: input.sessionId,
        exitCode: input.exitCode,
        stderrExcerpt: input.stderrExcerpt,
      })
      .where(eq(memoryDistillJobs.id, jobId))
  }

  eventSinkFor(input: MemoryDistillSessionSinkInput): SystemAgentEventSinkV1 {
    return this.sinkFactory(input)
  }

  async insertCandidate(input: Parameters<MemoryDistillWorkStore['insertCandidate']>[0]) {
    const memory = input.memory
    await this.db.insert(memories).values({
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
  }
}

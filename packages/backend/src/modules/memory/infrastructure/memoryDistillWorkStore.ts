// RFC-359 W4-B4 —— 记忆蒸馏工作存储：一份实现，两个 provider 共用。

import { listNodeEventContents } from '@/modules/task-execution/public/queries'
import { createTaskKnowledgeQueries } from '@/modules/task-execution/public/queries'
import { createNodeOutputQueries } from '@/modules/task-execution/public/queries'
import { createNodeRunQueries } from '@/modules/task-execution/public/queries'
import { insertOne } from '@/platform/persistence/singleInsert'
import type { ClarifyAnswerQueries } from '@/modules/collaboration/public/queries'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { and, asc, eq, inArray, lte } from 'drizzle-orm'

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
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
    private readonly db: PersistenceDb,
    private readonly clarifyAnswers: ClarifyAnswerQueries,
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
    return createTaskKnowledgeQueries(this.db).distillationScope(taskId)
  }

  async enqueue(input: Parameters<MemoryDistillWorkStore['enqueue']>[0]): Promise<void> {
    const { memoryDistillJobs } = tablesOf(this.db)
    await insertOne(this.db, memoryDistillJobs, {
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
    const { memoryDistillJobs } = tablesOf(this.db)
    return await this.db
      .select()
      .from(memoryDistillJobs)
      .where(and(eq(memoryDistillJobs.status, 'pending'), lte(memoryDistillJobs.nextRunAt, now)))
      .orderBy(asc(memoryDistillJobs.nextRunAt))
      .limit(limit)
  }

  async listPendingSiblings(debounceKey: string) {
    const { memoryDistillJobs } = tablesOf(this.db)
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
    const { memoryDistillJobs } = tablesOf(this.db)
    await this.db
      .update(memoryDistillJobs)
      .set({ status: 'running', startedAt })
      .where(and(inArray(memoryDistillJobs.id, [...ids]), eq(memoryDistillJobs.status, 'pending')))
  }

  async markDone(ids: readonly string[], finishedAt: number): Promise<void> {
    if (ids.length === 0) return
    const { memoryDistillJobs } = tablesOf(this.db)
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
    const { memoryDistillJobs } = tablesOf(this.db)
    await this.db
      .update(memoryDistillJobs)
      .set(patch)
      .where(inArray(memoryDistillJobs.id, [...input.ids]))
  }

  async recoverRunning(): Promise<number> {
    const { memoryDistillJobs } = tablesOf(this.db)
    const rows = await this.db
      .update(memoryDistillJobs)
      .set({ status: 'pending', startedAt: null })
      .where(eq(memoryDistillJobs.status, 'running'))
      .returning({ id: memoryDistillJobs.id })
    return rows.length
  }

  async retryFailed(jobId: string, now: number) {
    const { memoryDistillJobs } = tablesOf(this.db)
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
    const { memoryDistillJobs } = tablesOf(this.db)
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
    return this.clarifyAnswers.listSelfSources(ids)
  }

  async listReviewSources(ids: readonly string[]) {
    if (ids.length === 0) return []
    const { docVersions } = tablesOf(this.db)
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
    const { reviewComments } = tablesOf(this.db)
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
    const { taskFeedback } = tablesOf(this.db)
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
    return createNodeRunQueries(this.db).listFields({ runIds: ids }, [
      'id',
      'taskId',
      'nodeId',
      'status',
      'startedAt',
      'finishedAt',
      'errorMessage',
      'failureCode',
      'promptText',
      'promptPath',
      'opencodeSessionId',
      'injectedMemoriesJson',
    ])
  }

  // RFC-366：`active=false` 的端口行是被后续写覆盖掉的历史值，喂给蒸馏器只会制造
  // 「这个 agent 前后说了两套」的假象，所以只取活的。
  async listNodeRunOutputs(ids: readonly string[]) {
    if (ids.length === 0) return []

    return await createNodeOutputQueries(this.db)
      .listActiveContents([...ids])
      .then((rows) =>
        rows.map((row) => ({
          nodeRunId: row.nodeRunId,
          portName: row.portName,
          content: row.content,
          kind: row.kind,
        })),
      )
  }

  // RFC-366 task-run 源：任务本身的收尾快照。
  async listTaskRunSources(ids: readonly string[]) {
    return createTaskKnowledgeQueries(this.db).distillationSources(ids)
  }

  /**
   * RFC-366：任务里每个节点的终态一览。
   *
   * 一个节点在一个任务里可能有很多行（重试 / loop 每轮 / fanout 每分片），这里按
   * seq 逆序取每个 (task, node) 的**最新一行**（RFC-374；NULL 行保留 id 回退），
   * 与 `isFresherNodeRun` 使用同一铸造顺序，所以不需要再按 finishedAt 排序，后者
   * 在未结算的行上还是 null。
   */
  async listTaskNodeStatuses(taskIds: readonly string[]) {
    return (await createNodeRunQueries(this.db).latestPerNode(taskIds)).map((row) => ({
      taskId: row.taskId,
      nodeId: row.nodeId,
      nodeRunId: row.id,
      status: row.status,
      retryIndex: row.retryIndex,
      finishedAt: row.finishedAt,
    }))
  }

  async listNodeRuns(ids: readonly string[]) {
    return createNodeRunQueries(this.db).listFields({ runIds: ids }, [
      'id',
      'promptText',
      'promptPath',
      'startedAt',
      'opencodeSessionId',
    ])
  }

  async listNodeRunEvents(ids: readonly string[]) {
    return listNodeEventContents(this.db, ids)
  }

  async listApprovedMemories(
    scopeType: 'agent' | 'workflow' | 'repo' | 'global',
    scopeId: string | null,
  ) {
    const { memories } = tablesOf(this.db)
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
    const { memoryDistillJobs } = tablesOf(this.db)
    await this.db
      .update(memoryDistillJobs)
      .set({ userPromptMd, dedupSnapshotIdsJson })
      .where(eq(memoryDistillJobs.id, jobId))
  }

  async saveSpawnResult(
    jobId: string,
    input: Parameters<MemoryDistillWorkStore['saveSpawnResult']>[1],
  ): Promise<void> {
    const { memoryDistillJobs } = tablesOf(this.db)
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
    const { memories } = tablesOf(this.db)
    await insertOne(this.db, memories, {
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

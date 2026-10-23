// RFC-359 W4-B4 —— 记忆蒸馏读存储：一份实现，两个 provider 共用。

import type { ClarifyAnswerQueries } from '@/modules/collaboration/public/queries'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { and, asc, eq, inArray } from 'drizzle-orm'

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { MemoryDistillReadStore } from '../application/ports/distillReadStore'

/**
 * 蒸馏作业列表（可选按状态过滤，按创建时间升序）。
 *
 * RFC-359 W57：读存储与写存储（`memoryDistillWorkStore.ts`）此前各有一份**逐字相同**的
 * `listJobs` 方法。它是「蒸馏队列现在有什么」的唯一投影，两份实现意味着两条入口可能在
 * 排序或状态过滤上漂。
 */
export async function listMemoryDistillJobs(db: PersistenceDb, status?: string) {
  const { memoryDistillJobs } = tablesOf(db)
  const query = db.select().from(memoryDistillJobs)
  return status === undefined
    ? await query.orderBy(asc(memoryDistillJobs.createdAt))
    : await query
        .where(eq(memoryDistillJobs.status, status as 'pending'))
        .orderBy(asc(memoryDistillJobs.createdAt))
}

export class DrizzleMemoryDistillReadStore implements MemoryDistillReadStore {
  constructor(
    private readonly db: PersistenceDb,
    private readonly clarifyAnswers: ClarifyAnswerQueries,
  ) {}

  async findJob(jobId: string) {
    const { memoryDistillJobs } = tablesOf(this.db)
    const rows = await this.db
      .select()
      .from(memoryDistillJobs)
      .where(eq(memoryDistillJobs.id, jobId))
      .limit(1)
    return rows[0] ?? null
  }

  async listSiblingJobs(debounceKey: string) {
    const { memoryDistillJobs } = tablesOf(this.db)
    return await this.db
      .select()
      .from(memoryDistillJobs)
      .where(eq(memoryDistillJobs.debounceKey, debounceKey))
      .orderBy(asc(memoryDistillJobs.createdAt))
  }

  async listEvents(jobId: string) {
    const { memoryDistillEvents } = tablesOf(this.db)
    return await this.db
      .select({
        id: memoryDistillEvents.id,
        attemptIndex: memoryDistillEvents.attemptIndex,
        sessionId: memoryDistillEvents.sessionId,
        parentSessionId: memoryDistillEvents.parentSessionId,
        ts: memoryDistillEvents.ts,
        kind: memoryDistillEvents.kind,
        payload: memoryDistillEvents.payload,
      })
      .from(memoryDistillEvents)
      .where(eq(memoryDistillEvents.distillJobId, jobId))
      .orderBy(
        asc(memoryDistillEvents.attemptIndex),
        asc(memoryDistillEvents.ts),
        asc(memoryDistillEvents.id),
      )
  }

  async listClarifySources(ids: readonly string[]) {
    return this.clarifyAnswers.listSelfQuestions(ids)
  }

  async listReviewSources(ids: readonly string[]) {
    if (ids.length === 0) return []
    const { docVersions } = tablesOf(this.db)
    return await this.db
      .select({
        id: docVersions.id,
        taskId: docVersions.taskId,
        decision: docVersions.decision,
        versionIndex: docVersions.versionIndex,
      })
      .from(docVersions)
      .where(inArray(docVersions.id, [...ids]))
  }

  async listFeedbackSources(ids: readonly string[]) {
    if (ids.length === 0) return []
    const { taskFeedback } = tablesOf(this.db)
    return await this.db
      .select({ id: taskFeedback.id, taskId: taskFeedback.taskId, bodyMd: taskFeedback.bodyMd })
      .from(taskFeedback)
      .where(inArray(taskFeedback.id, [...ids]))
  }

  async listCandidates(jobId: string) {
    const { memories } = tablesOf(this.db)
    return await this.db
      .select({
        id: memories.id,
        title: memories.title,
        bodyMd: memories.bodyMd,
        scopeType: memories.scopeType,
        scopeId: memories.scopeId,
        distillAction: memories.distillAction,
        status: memories.status,
        supersedesId: memories.supersedesId,
        createdAt: memories.createdAt,
      })
      .from(memories)
      .where(and(eq(memories.distillJobId, jobId)))
      .orderBy(asc(memories.createdAt))
  }

  async listJobs(status?: string) {
    return await listMemoryDistillJobs(this.db, status)
  }
}

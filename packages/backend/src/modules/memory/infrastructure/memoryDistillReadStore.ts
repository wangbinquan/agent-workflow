// RFC-359 W4-B4 —— 记忆蒸馏读存储：一份实现，两个 provider 共用。

import { and, asc, eq, inArray } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  clarifyRounds,
  docVersions,
  memories,
  memoryDistillEvents,
  memoryDistillJobs,
  taskFeedback,
} from '@/db/schema'
import type { MemoryDistillReadStore } from '../application/ports/distillReadStore'

/**
 * 蒸馏作业列表（可选按状态过滤，按创建时间升序）。
 *
 * RFC-359 W57：读存储与写存储（`memoryDistillWorkStore.ts`）此前各有一份**逐字相同**的
 * `listJobs` 方法。它是「蒸馏队列现在有什么」的唯一投影，两份实现意味着两条入口可能在
 * 排序或状态过滤上漂。
 */
export async function listMemoryDistillJobs(db: ProviderNeutralDatabase, status?: string) {
  const query = db.select().from(memoryDistillJobs)
  return status === undefined
    ? await query.orderBy(asc(memoryDistillJobs.createdAt))
    : await query
        .where(eq(memoryDistillJobs.status, status as 'pending'))
        .orderBy(asc(memoryDistillJobs.createdAt))
}

export class DrizzleMemoryDistillReadStore implements MemoryDistillReadStore {
  constructor(private readonly db: ProviderNeutralDatabase) {}

  async findJob(jobId: string) {
    const rows = await this.db
      .select()
      .from(memoryDistillJobs)
      .where(eq(memoryDistillJobs.id, jobId))
      .limit(1)
    return rows[0] ?? null
  }

  async listSiblingJobs(debounceKey: string) {
    return await this.db
      .select()
      .from(memoryDistillJobs)
      .where(eq(memoryDistillJobs.debounceKey, debounceKey))
      .orderBy(asc(memoryDistillJobs.createdAt))
  }

  async listEvents(jobId: string) {
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
    if (ids.length === 0) return []
    return await this.db
      .select({
        id: clarifyRounds.id,
        taskId: clarifyRounds.taskId,
        questionsJson: clarifyRounds.questionsJson,
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
        decision: docVersions.decision,
        versionIndex: docVersions.versionIndex,
      })
      .from(docVersions)
      .where(inArray(docVersions.id, [...ids]))
  }

  async listFeedbackSources(ids: readonly string[]) {
    if (ids.length === 0) return []
    return await this.db
      .select({ id: taskFeedback.id, taskId: taskFeedback.taskId, bodyMd: taskFeedback.bodyMd })
      .from(taskFeedback)
      .where(inArray(taskFeedback.id, [...ids]))
  }

  async listCandidates(jobId: string) {
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

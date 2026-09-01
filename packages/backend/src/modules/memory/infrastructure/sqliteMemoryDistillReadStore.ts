import { and, asc, eq, inArray } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import {
  clarifyRounds,
  docVersions,
  memories,
  memoryDistillEvents,
  memoryDistillJobs,
  taskFeedback,
} from '@/db/schema'
import type { MemoryDistillReadStore } from '../application/ports/distillReadStore'

export class SqliteMemoryDistillReadStore implements MemoryDistillReadStore {
  constructor(private readonly db: DbClient) {}

  async findJob(jobId: string) {
    return (
      this.db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId)).get() ?? null
    )
  }

  async listSiblingJobs(debounceKey: string) {
    return this.db
      .select()
      .from(memoryDistillJobs)
      .where(eq(memoryDistillJobs.debounceKey, debounceKey))
      .orderBy(asc(memoryDistillJobs.createdAt))
      .all()
  }

  async listEvents(jobId: string) {
    return this.db
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
      .all()
  }

  async listClarifySources(ids: readonly string[]) {
    if (ids.length === 0) return []
    return this.db
      .select({
        id: clarifyRounds.id,
        taskId: clarifyRounds.taskId,
        questionsJson: clarifyRounds.questionsJson,
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
        decision: docVersions.decision,
        versionIndex: docVersions.versionIndex,
      })
      .from(docVersions)
      .where(inArray(docVersions.id, [...ids]))
      .all()
  }

  async listFeedbackSources(ids: readonly string[]) {
    if (ids.length === 0) return []
    return this.db
      .select({ id: taskFeedback.id, taskId: taskFeedback.taskId, bodyMd: taskFeedback.bodyMd })
      .from(taskFeedback)
      .where(inArray(taskFeedback.id, [...ids]))
      .all()
  }

  async listCandidates(jobId: string) {
    return this.db
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
      .all()
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
}

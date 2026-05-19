// RFC-041 — per-task "dear future me" notes service (PR2 scope).
//
// Pure CRUD plus a side-effect on create: enqueue a distill job so the
// distiller can turn the note into one or more memory candidates. Feedback
// rows survive task deletion (no ON DELETE CASCADE on task_id) so the
// historical note remains visible after worktree GC.

import { asc, desc, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { TaskFeedback } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { taskFeedback } from '@/db/schema'
import { enqueueDistillJob } from '@/services/memoryDistillScheduler'

interface TaskFeedbackRow {
  id: string
  taskId: string
  authorUserId: string | null
  bodyMd: string
  createdAt: number
  distilled: number
  distillJobId: string | null
}

function rowToFeedback(row: TaskFeedbackRow): TaskFeedback {
  return {
    id: row.id,
    taskId: row.taskId,
    authorUserId: row.authorUserId,
    bodyMd: row.bodyMd,
    createdAt: row.createdAt,
    distilled: row.distilled === 1,
    distillJobId: row.distillJobId,
  }
}

export interface CreateTaskFeedbackInput {
  taskId: string
  authorUserId: string | null
  bodyMd: string
}

export interface CreateTaskFeedbackResult {
  feedback: TaskFeedback
  distillJobId: string
}

export async function createTaskFeedback(
  db: DbClient,
  input: CreateTaskFeedbackInput,
): Promise<CreateTaskFeedbackResult> {
  const id = ulid()
  const createdAt = Date.now()
  await db.insert(taskFeedback).values({
    id,
    taskId: input.taskId,
    authorUserId: input.authorUserId,
    bodyMd: input.bodyMd,
    createdAt,
    distilled: 0,
  })
  const enq = await enqueueDistillJob(db, {
    sourceKind: 'feedback',
    sourceEventId: id,
    taskId: input.taskId,
  })
  await db
    .update(taskFeedback)
    .set({ distilled: 1, distillJobId: enq.jobId })
    .where(eq(taskFeedback.id, id))
  const row = (await db.select().from(taskFeedback).where(eq(taskFeedback.id, id)).limit(1))[0] as
    | TaskFeedbackRow
    | undefined
  if (row === undefined) {
    throw new Error('task_feedback row vanished immediately after insert')
  }
  return { feedback: rowToFeedback(row), distillJobId: enq.jobId }
}

export async function listTaskFeedback(db: DbClient, taskId: string): Promise<TaskFeedback[]> {
  const rows = (await db
    .select()
    .from(taskFeedback)
    .where(eq(taskFeedback.taskId, taskId))
    .orderBy(asc(taskFeedback.createdAt))) as TaskFeedbackRow[]
  return rows.map(rowToFeedback)
}

export async function listRecentTaskFeedback(db: DbClient, limit = 20): Promise<TaskFeedback[]> {
  const rows = (await db
    .select()
    .from(taskFeedback)
    .orderBy(desc(taskFeedback.createdAt))
    .limit(limit)) as TaskFeedbackRow[]
  return rows.map(rowToFeedback)
}

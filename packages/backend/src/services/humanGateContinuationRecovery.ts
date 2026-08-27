// RFC-333 T11 — a human-gate decision commits its exact continuation before
// the post-commit wake. If the daemon exits in that window, boot replays only
// those already-admitted refs; it never mints a replacement intent.

import { and, asc, eq } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { taskExecutionIntents } from '@/db/schema'

export type PendingHumanGateContinuation = Readonly<{
  taskId: string
  continuationRef: string
}>

export type HumanGateContinuationRecoveryResult = Readonly<{
  attempted: readonly PendingHumanGateContinuation[]
  woken: readonly PendingHumanGateContinuation[]
  failed: readonly Readonly<
    PendingHumanGateContinuation & {
      error: string
    }
  >[]
}>

export async function recoverPendingHumanGateContinuations(input: {
  db: DbClient
  wake: (continuation: PendingHumanGateContinuation) => Promise<void>
}): Promise<HumanGateContinuationRecoveryResult> {
  const pending = input.db
    .select({
      taskId: taskExecutionIntents.taskId,
      continuationRef: taskExecutionIntents.id,
    })
    .from(taskExecutionIntents)
    .where(
      and(
        eq(taskExecutionIntents.kind, 'gate-continuation'),
        eq(taskExecutionIntents.state, 'pending'),
      ),
    )
    .orderBy(asc(taskExecutionIntents.createdAt), asc(taskExecutionIntents.id))
    .all()

  const woken: PendingHumanGateContinuation[] = []
  const failed: Array<PendingHumanGateContinuation & { error: string }> = []
  for (const continuation of pending) {
    try {
      await input.wake(continuation)
      woken.push(continuation)
    } catch (error) {
      failed.push({
        ...continuation,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return { attempted: pending, woken, failed }
}

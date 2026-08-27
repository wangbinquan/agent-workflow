// RFC-333 — infrastructure binding for the exact human-gate lifecycle port.

import { eq } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { tasks } from '@/db/schema'
import type { DbTxSync } from '@/db/txSync'
import { notifyHumanGateTaskParkAfterCommit, transitionHumanGateTaskTx } from '@/services/lifecycle'
import type { HumanGateTaskLifecycle } from '../application/ports/humanGateTaskLifecycle'

export class LegacyHumanGateTaskLifecycle implements HumanGateTaskLifecycle {
  readManualParkCandidateTx(
    tx: DbTxSync,
    taskId: string,
  ): Readonly<{ taskRevision: number }> | null {
    const task = tx
      .select({
        status: tasks.status,
        lifecycleEventRevision: tasks.lifecycleEventRevision,
      })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .get()
    if (
      task === undefined ||
      (task.status !== 'pending' && task.status !== 'running' && task.status !== 'awaiting_human')
    ) {
      return null
    }
    return { taskRevision: task.lifecycleEventRevision }
  }

  transitionTx(input: Parameters<HumanGateTaskLifecycle['transitionTx']>[0]): {
    readonly taskRevision: number
  } {
    const transitioned = transitionHumanGateTaskTx(input)
    return { taskRevision: transitioned.taskRevision }
  }

  notifyParkAfterCommit(
    db: DbClient,
    taskId: string,
    status: 'awaiting_review' | 'awaiting_human',
  ): void {
    notifyHumanGateTaskParkAfterCommit(db, taskId, status)
  }
}

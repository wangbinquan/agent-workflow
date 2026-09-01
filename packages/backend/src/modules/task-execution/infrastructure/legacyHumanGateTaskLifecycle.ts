// RFC-333 — infrastructure binding for the exact human-gate lifecycle port.

import { eq } from 'drizzle-orm'
import { tasks } from '@/db/schema'
import type { DbTxSync } from '@/db/txSync'
import { transitionHumanGateTaskTx } from '@/services/lifecycle'
import { publishCommittedEventsAfterCommit } from '@/platform/events/committed/runtime'
import type { CommittedEventRef } from '@/platform/events/committed/types'
import type { HumanGateTaskLifecycle } from './humanGateTaskLifecycleTransaction'

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
    readonly eventRefs: readonly CommittedEventRef[]
  } {
    const transitioned = transitionHumanGateTaskTx(input)
    return { taskRevision: transitioned.taskRevision, eventRefs: transitioned.eventRefs }
  }

  async publishAfterCommit(eventRefs: readonly CommittedEventRef[]): Promise<void> {
    await publishCommittedEventsAfterCommit(eventRefs)
  }
}

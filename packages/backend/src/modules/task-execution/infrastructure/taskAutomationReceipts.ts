// RFC-486: moved out of the former `taskRouteLaunchOperations.ts` unchanged (the Event Center work-start provider's lookup).

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { first } from '@/platform/persistence/queryHelpers'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { eq } from 'drizzle-orm'

/** Owner-local receipt lookup used by the Event Center target provider. */
export async function findTaskAutomationReceipt(
  db: PersistenceDb,
  eventDeliveryId: string,
): Promise<string | null> {
  const { taskLaunchContexts: launch } = tablesOf(db)
  return (
    (
      await first(
        db
          .select({ taskId: launch.taskId })
          .from(launch)
          .where(eq(launch.eventDeliveryId, eventDeliveryId)),
      )
    )?.taskId ?? null
  )
}

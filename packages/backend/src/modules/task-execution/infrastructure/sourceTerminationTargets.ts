import { tablesOf } from '@/platform/persistence/sessionTables'
import { and, asc, eq, lt } from 'drizzle-orm'

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { TaskSourceTerminationEffectInput } from '../application/applySourceTerminationEffect'

export async function listSourceTerminationTargets(
  db: PersistenceDb,
  input: TaskSourceTerminationEffectInput,
): Promise<readonly { readonly id: string }[]> {
  const { tasks, taskLaunchContexts: launch } = tablesOf(db)
  return await db
    .select({ id: tasks.id })
    .from(launch)
    .innerJoin(tasks, eq(tasks.id, launch.taskId))
    .where(
      and(
        eq(launch.sourceTerminationBinding, input.binding),
        lt(launch.sourceTerminationLaunchRev, input.streamRevision),
      ),
    )
    .orderBy(asc(tasks.invocationDepth), asc(tasks.id))
}

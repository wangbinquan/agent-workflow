import { tablesOf } from '@/platform/persistence/sessionTables'
import { and, asc, eq, lt } from 'drizzle-orm'

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { TaskSourceTerminationEffectInput } from '../application/applySourceTerminationEffect'

export async function listSourceTerminationTargets(
  db: PersistenceDb,
  input: TaskSourceTerminationEffectInput,
): Promise<readonly { readonly id: string }[]> {
  const { tasks } = tablesOf(db)
  return await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.sourceTerminationBinding, input.binding),
        lt(tasks.sourceTerminationLaunchRev, input.streamRevision),
      ),
    )
    .orderBy(asc(tasks.invocationDepth), asc(tasks.id))
}

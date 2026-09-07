import { and, asc, eq, lt } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { tasks } from '@/db/schema'
import type { TaskSourceTerminationEffectInput } from '../application/applySourceTerminationEffect'

export async function listSourceTerminationTargets(
  db: ProviderNeutralDatabase,
  input: TaskSourceTerminationEffectInput,
): Promise<readonly { readonly id: string }[]> {
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

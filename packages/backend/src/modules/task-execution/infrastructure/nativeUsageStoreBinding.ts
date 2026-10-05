import { eq } from 'drizzle-orm'
import type { ObservationNativeBeforeSpawnAck } from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import { nativeUsageStoreBindings } from '@/db/schema'
import type { DatabaseTransaction } from '@/platform/persistence/databaseTransaction'
import type { TaskExecutionTransaction } from './ownedTaskExecution'

type Reader = ProviderNeutralDatabase | DatabaseTransaction

async function originalBinding(reader: Reader, before: ObservationNativeBeforeSpawnAck) {
  const row = (
    await reader
      .select()
      .from(nativeUsageStoreBindings)
      .where(eq(nativeUsageStoreBindings.invocationId, before.invocationId))
      .limit(1)
  )[0]
  if (
    row &&
    (row.beforeOwnerReceiptId !== before.ownerReceiptId ||
      row.sourceGeneration.length === 0 ||
      (before.sourceGeneration !== null && row.sourceGeneration !== before.sourceGeneration))
  )
    throw new Error('Original native store binding changed its before-spawn receipt')
  return row
}

/** Legacy nonempty before remains authoritative; absent before requires its admitted receipt. */
export async function originalNativeUsageStoreGeneration(
  reader: Reader,
  before: ObservationNativeBeforeSpawnAck,
): Promise<string | null> {
  return (await originalBinding(reader, before))?.sourceGeneration ?? before.sourceGeneration
}

/** Called only in the original fenced Task transaction; a rejected admission rolls it back. */
export async function bindOriginalNativeUsageStore(
  tx: TaskExecutionTransaction,
  before: ObservationNativeBeforeSpawnAck,
  sourceGeneration: string,
): Promise<void> {
  if (
    !sourceGeneration ||
    (before.sourceGeneration !== null && sourceGeneration !== before.sourceGeneration)
  )
    throw new Error('Original native store generation changed')
  await tx
    .insert(nativeUsageStoreBindings)
    .values({
      invocationId: before.invocationId,
      beforeOwnerReceiptId: before.ownerReceiptId,
      sourceGeneration,
    })
    .onConflictDoNothing()
  const actual = await originalBinding(tx, before)
  if (!actual || actual.sourceGeneration !== sourceGeneration)
    throw new Error('Original native store generation changed after admission')
}

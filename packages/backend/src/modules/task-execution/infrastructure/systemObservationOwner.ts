import { eq } from 'drizzle-orm'
import { AcceptedObservationInvocationSchema } from '@agent-workflow/shared'
import { observationInvocations } from '@/db/schema'
import { systemAgentObservationOwners } from '@/db/observationSystem'
import type { ProviderNeutralDatabase } from '@/db/query'
import { databaseSessionFor, engineOf } from '@/platform/persistence/databaseTransaction'
import type { SystemObservationOwnerRef } from '../application/ports/systemAgentObservation'
import type { SystemNativeUsageOwnerBinding } from '../application/ports/nativeUsagePersistence'
import type { NativeUsageOwnerFacts } from './nativeUsageOwnerTransaction'
import type { TaskExecutionTransaction } from './ownedTaskExecution'

type Owner = typeof systemAgentObservationOwners.$inferSelect
const owners = new WeakMap<SystemObservationOwnerRef, Readonly<Owner>>()

/** The composition root issues this only after the original System call is persisted. */
export function issueSystemObservationOwner(row: Owner): SystemObservationOwnerRef {
  const ref = Object.freeze({})
  owners.set(ref, Object.freeze({ ...row }))
  return ref
}

/** System pages use their own execution receipt and transaction, never a Task claim. */
export async function withSystemNativeUsageOwner<T>(
  db: ProviderNeutralDatabase,
  binding: SystemNativeUsageOwnerBinding,
  run: (tx: TaskExecutionTransaction, facts: NativeUsageOwnerFacts) => Promise<T>,
): Promise<T> {
  const selected = owners.get(binding.systemOwner)
  if (
    !selected ||
    selected.id !== binding.invocationId ||
    selected.groupId !== binding.taskId ||
    binding.nodeRunId !== selected.id
  )
    throw new Error('Original System invocation owner is unavailable')
  return databaseSessionFor(db).transaction(async (tx) => {
    await engineOf(tx).lockAggregateRoot(
      tx,
      systemAgentObservationOwners,
      systemAgentObservationOwners.id,
      selected.id,
    )
    const owner = await tx
      .select()
      .from(systemAgentObservationOwners)
      .where(eq(systemAgentObservationOwners.id, selected.id))
      .get()
    const original = await tx
      .select()
      .from(observationInvocations)
      .where(eq(observationInvocations.id, selected.id))
      .get()
    if (
      !owner ||
      !original ||
      owner.ownerNonce !== selected.ownerNonce ||
      owner.groupId !== selected.groupId ||
      owner.originalAttempt !== selected.originalAttempt
    )
      throw new Error('Original System invocation receipt changed')
    const accepted = AcceptedObservationInvocationSchema.parse(JSON.parse(original.document))
    if (
      accepted.taskId !== binding.taskId ||
      accepted.nodeRunId !== binding.nodeRunId ||
      accepted.authority.kind !== 'local' ||
      !accepted.nativeCaptureSource ||
      (accepted.nativeCaptureContract !== 'opencode-child-pages-v2' &&
        accepted.nativeCaptureContract !== 'opencode-child-root-pages-v3')
    )
      throw new Error('Original System native invocation acceptance changed')
    return run(tx, {
      contract: accepted.nativeCaptureContract,
      nativeSource: accepted.nativeCaptureSource,
      lineage: selected.groupId,
      epoch: '1',
      fence: systemObservationFence(selected),
    })
  })
}

export const systemObservationFence = (
  row: Pick<Owner, 'id' | 'groupId' | 'ownerNonce' | 'originalAttempt'>,
) => JSON.stringify(['system-agent', row.id, row.groupId, row.ownerNonce, row.originalAttempt])

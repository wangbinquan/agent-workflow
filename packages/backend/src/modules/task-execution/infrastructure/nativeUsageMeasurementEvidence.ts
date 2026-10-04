import { and, eq } from 'drizzle-orm'
import { isDeepStrictEqual } from 'node:util'
import type { ObservationNativeMeasurement } from '@agent-workflow/shared'
import { ObservationNativePassPageSchema } from '@agent-workflow/shared'
import { nativeUsageStepMembers } from '@/db/schema'
import type { NativeUsageOwnerBinding } from '../application/ports/nativeUsagePersistence'
import type { TaskExecutionTransaction } from './ownedTaskExecution'
import { verifyNativeUsageScope } from './nativeUsageScopeReference'

/** The numeric record must be the original step in the referenced persisted page. */
export async function verifyNativeUsageMeasurementEvidence(
  tx: TaskExecutionTransaction,
  binding: NativeUsageOwnerBinding,
  measurement: ObservationNativeMeasurement,
): Promise<void> {
  await verifyNativeUsageScope(tx, binding, measurement.scope)
  const prefix = 'opencode:step:'
  if (!measurement.recordId.startsWith(prefix) || measurement.recordId.length === prefix.length)
    throw new Error('Native measurement has no original step identity')
  const member = (
    await tx
      .select()
      .from(nativeUsageStepMembers)
      .where(
        and(
          eq(nativeUsageStepMembers.passId, measurement.scope.ancestry.identity.passId),
          eq(nativeUsageStepMembers.stepId, measurement.recordId.slice(prefix.length)),
        ),
      )
      .limit(1)
  )[0]
  if (
    !member ||
    member.sessionId !== measurement.scope.session ||
    BigInt(member.ordinal) > BigInt(measurement.scope.ancestry.pageOrdinal)
  )
    throw new Error('Native measurement step is absent or outside its original page')
  const original = ObservationNativePassPageSchema.innerType().shape.steps.element.parse(
    JSON.parse(member.document),
  )
  if (
    measurement.scope.level !== 'request' ||
    measurement.reporting !== 'delta' ||
    measurement.inclusion !== 'self' ||
    measurement.basis.kind !== 'invocation' ||
    measurement.occurredAt !== original.occurredAt ||
    !isDeepStrictEqual(measurement.usage, original.usage) ||
    !isDeepStrictEqual(measurement.model, original.model)
  )
    throw new Error('Native measurement changed its original step numbers or scope')
}

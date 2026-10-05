import { and, eq, inArray } from 'drizzle-orm'
import { isDeepStrictEqual } from 'node:util'
import type { ObservationNativeMeasurement } from '@agent-workflow/shared'
import { ObservationNativePassPageSchema } from '@agent-workflow/shared'
import { nativeUsageStepMembers } from '@/db/schema'
import { chunkedAll } from '@/util/sqlChunk'
import type { NativeUsageOwnerBinding } from '../application/ports/nativeUsagePersistence'
import type { TaskExecutionTransaction } from './ownedTaskExecution'
import { verifyNativeUsageScope } from './nativeUsageScopeReference'

/** The numeric record must be the original step in the referenced persisted page. */
export async function verifyNativeUsageMeasurementEvidence(
  tx: TaskExecutionTransaction,
  binding: NativeUsageOwnerBinding,
  measurements: readonly ObservationNativeMeasurement[],
): Promise<void> {
  const prefix = 'opencode:step:'
  // One source packet bounds both caches. A deep shared path is verified once, not per step.
  const scopes = new Map<string, ObservationNativeMeasurement['scope']>()
  const byPass = new Map<string, ObservationNativeMeasurement[]>()
  for (const measurement of measurements) {
    if (!measurement.recordId.startsWith(prefix) || measurement.recordId.length === prefix.length)
      throw new Error('Native measurement has no original step identity')
    scopes.set(JSON.stringify(measurement.scope), measurement.scope)
    const passId = measurement.scope.ancestry.identity.passId
    const group = byPass.get(passId) ?? []
    group.push(measurement)
    byPass.set(passId, group)
  }
  for (const scope of scopes.values()) await verifyNativeUsageScope(tx, binding, scope)
  for (const [passId, group] of byPass) {
    const members = new Map(
      (
        await chunkedAll(
          [...new Set(group.map((measurement) => measurement.recordId.slice(prefix.length)))],
          (ids) =>
            tx
              .select()
              .from(nativeUsageStepMembers)
              .where(
                and(
                  eq(nativeUsageStepMembers.passId, passId),
                  inArray(nativeUsageStepMembers.stepId, ids),
                ),
              ),
        )
      ).map((member) => [member.stepId, member]),
    )
    for (const measurement of group) {
      const member = members.get(measurement.recordId.slice(prefix.length))
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
  }
}

import { and, asc, eq, gt, inArray } from 'drizzle-orm'
import { isDeepStrictEqual } from 'node:util'
import {
  ObservationNativeEmissionSchema,
  ObservationNativeMeasurementSchema,
  type ObservationNativeCompletion,
  type ObservationNativeEmission,
} from '@agent-workflow/shared'
import {
  nativeUsageStepMembers,
  nativeUsageRevisionHeads,
  taskExecutionObservationSources,
} from '@/db/schema'
import { chunkedAll } from '@/util/sqlChunk'
import type { NativeUsageOwnerBinding } from '../application/ports/nativeUsagePersistence'
import type { TaskExecutionTransaction } from './ownedTaskExecution'
import { nativeUsageRecordSourceKey } from './nativeUsageRevisionAllocation'

/** Confirm one actual latest original numeric source for every new final step, through EOF. */
export async function verifyNativeUsageNumericCoverage(
  tx: TaskExecutionTransaction,
  binding: Pick<NativeUsageOwnerBinding, 'invocationId' | 'taskId' | 'nodeRunId'>,
  proof: ObservationNativeCompletion,
): Promise<{
  readonly records: string
  readonly missing: boolean
  readonly unknownTokens: boolean
  readonly incompleteCoverage: boolean
}> {
  const final = proof.final?.ack ?? proof.finalProgress
  if (!final)
    return { records: '0', missing: true, unknownTokens: false, incompleteCoverage: false }
  const baseline = proof.baseline.kind === 'resume' ? proof.baseline.pass?.ack : undefined
  if (proof.baseline.kind === 'resume' && !baseline)
    return { records: '0', missing: true, unknownTokens: false, incompleteCoverage: false }
  let after: string | undefined
  let records = 0n,
    missing = false,
    unknownTokens = false,
    incompleteCoverage = false
  for (;;) {
    const members = await tx
      .select()
      .from(nativeUsageStepMembers)
      .where(
        and(
          eq(nativeUsageStepMembers.passId, final.identity.passId),
          after === undefined ? undefined : gt(nativeUsageStepMembers.stepId, after),
        ),
      )
      .orderBy(asc(nativeUsageStepMembers.stepId))
      .limit(400)
    if (members.length === 0) break
    const prior = baseline
      ? new Set(
          (
            await chunkedAll(
              members.map((member) => member.stepId),
              (ids) =>
                tx
                  .select({ stepId: nativeUsageStepMembers.stepId })
                  .from(nativeUsageStepMembers)
                  .where(
                    and(
                      eq(nativeUsageStepMembers.passId, baseline.identity.passId),
                      inArray(nativeUsageStepMembers.stepId, ids),
                    ),
                  ),
            )
          ).map((member) => member.stepId),
        )
      : new Set<string>()
    const fresh = members.filter((member) => !prior.has(member.stepId))
    const heads = new Map(
      (
        await chunkedAll(
          fresh.map((member) => nativeUsageRecordSourceKey('opencode:step:' + member.stepId)),
          (ids) =>
            tx
              .select()
              .from(nativeUsageRevisionHeads)
              .where(
                and(
                  eq(nativeUsageRevisionHeads.invocationId, binding.invocationId),
                  inArray(nativeUsageRevisionHeads.recordId, ids),
                ),
              ),
        )
      ).map((head) => [head.recordId, head.revision]),
    )
    const sourceIds = [...new Set(heads.values())]
    const sources = new Map(
      (
        await chunkedAll(sourceIds, (ids) =>
          tx
            .select()
            .from(taskExecutionObservationSources)
            .where(inArray(taskExecutionObservationSources.id, ids)),
        )
      ).map((source) => [
        source.id,
        {
          source,
          evidence: ObservationNativeEmissionSchema.parse(JSON.parse(source.evidenceJson)),
        },
      ]),
    )
    for (const member of fresh) {
      records++
      const id = 'opencode:step:' + member.stepId
      const sourceId = heads.get(nativeUsageRecordSourceKey(id))
      const found = sourceId === undefined ? undefined : sources.get(sourceId)
      const candidate = found?.evidence.measurements.reduce<
        ObservationNativeEmission['measurements'][number] | undefined
      >(
        (latest, measurement) =>
          measurement.recordId === id && (!latest || measurement.revision > latest.revision)
            ? measurement
            : latest,
        undefined,
      )
      if (!found || !candidate) {
        missing = true
        continue
      }
      const measured = ObservationNativeMeasurementSchema.parse(candidate)
      const original = JSON.parse(member.document)
      if (
        found.source.taskId !== binding.taskId ||
        found.source.nodeRunId !== binding.nodeRunId ||
        found.evidence.invocationId !== binding.invocationId ||
        measured.invocationId !== binding.invocationId ||
        measured.taskId !== binding.taskId ||
        measured.nodeRunId !== binding.nodeRunId ||
        measured.scope.ancestry.identity.passId !== final.identity.passId ||
        BigInt(member.ordinal) > BigInt(measured.scope.ancestry.pageOrdinal) ||
        measured.scope.session !== member.sessionId ||
        measured.recordId !== id ||
        measured.scope.parentSession !== original.parentSessionId ||
        !isDeepStrictEqual(measured.usage, original.usage) ||
        !isDeepStrictEqual(measured.model, original.model) ||
        measured.occurredAt !== original.occurredAt ||
        measured.reporting !== 'delta' ||
        measured.inclusion !== 'self' ||
        measured.scope.level !== 'request' ||
        measured.validity !== 'valid'
      )
        throw new Error('Native numeric coverage changed its actual original step or source')
      unknownTokens ||= Object.values(measured.usage).some((value) => value === null)
      incompleteCoverage ||= measured.coverage !== 'complete'
    }
    const next = members.at(-1)!.stepId
    if (next === after) throw new Error('Native numeric coverage did not advance to original EOF')
    after = next
  }
  return { records: String(records), missing, unknownTokens, incompleteCoverage }
}

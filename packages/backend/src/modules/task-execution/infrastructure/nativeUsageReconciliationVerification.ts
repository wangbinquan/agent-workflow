import { and, asc, eq, gt, inArray } from 'drizzle-orm'
import { isDeepStrictEqual } from 'node:util'
import {
  ObservationMeasurementSchema,
  ObservationNativeMeasurementSchema,
  type ObservationMeasurement,
  type ObservationNativeMeasurement,
  type ObservationNativeCompletion,
} from '@agent-workflow/shared'
import {
  observationUsageCurrent,
  observationUsageNativeRecords,
  observationUsageCaptures,
} from '@/db/schema'
import { chunkedAll } from '@/util/sqlChunk'
import { sha256Hex } from '@/util/hash'
import type { NativeUsageReadBinding } from '../application/ports/nativeUsagePersistence'
import type { TaskExecutionTransaction } from './ownedTaskExecution'
import { verifyNativeUsageScope } from './nativeUsageScopeReference'
import { nativeUsageEvidenceStorage } from './nativeUsageEvidenceStorage'

type Meter = {
  sourceId: string
  nativeWatermark?: number
  measurement: ObservationMeasurement | ObservationNativeMeasurement
  complete: boolean
  issues: readonly string[]
}
async function scopePath(tx: TaskExecutionTransaction, meter: Meter) {
  const scope = meter.measurement.scope
  if (!scope) return null
  if ('ancestry' in scope) {
    if (meter.measurement.nodeRunId === null) return null
    const sourceKind = meter.sourceId.startsWith('system-agent:') ? 'system' : 'task'
    const { nativeUsageSessionParents } = nativeUsageEvidenceStorage(sourceKind)
    await verifyNativeUsageScope(
      tx,
      { invocationId: meter.measurement.invocationId, sourceKind },
      scope,
    )
    const parent = (
      await tx
        .select()
        .from(nativeUsageSessionParents)
        .where(
          and(
            eq(nativeUsageSessionParents.passId, scope.ancestry.identity.passId),
            eq(nativeUsageSessionParents.sessionId, scope.session),
          ),
        )
        .limit(1)
    )[0]
    return parent?.pathDigest ?? null
  }
  const path = [...scope.ancestors, scope.session]
  if (
    new Set(path).size !== path.length ||
    path[0] !== scope.root ||
    (scope.ancestors.at(-1) ?? null) !== scope.parentSession
  )
    return null
  let digest: string | null = null
  for (const session of path) digest = sha256Hex(JSON.stringify([digest, session]))
  return digest
}
/** Recheck every before step against the final snapshot and its actual unique historical meter. */
export async function verifyNativeUsageReconciliation(
  tx: TaskExecutionTransaction,
  binding: NativeUsageReadBinding,
  proof: ObservationNativeCompletion,
): Promise<ObservationNativeCompletion['reconciliation']> {
  const { nativeUsageStepMembers, nativeUsageSessionParents } = nativeUsageEvidenceStorage(
    binding.sourceKind,
  )
  let digest = sha256Hex(JSON.stringify(['native-reconciliation-v2', binding.invocationId]))
  if (proof.baseline.kind === 'fresh')
    return { examined: '0', resolved: '0', unresolved: '0', digest }
  const baseline = proof.baseline.pass?.ack
  if (!baseline) return { examined: '0', resolved: '0', unresolved: '0', digest }
  const final = proof.final?.ack ?? proof.finalProgress
  let examined = 0n,
    resolved = 0n,
    unresolved = 0n
  let after: string | undefined
  for (;;) {
    const before = await tx
      .select()
      .from(nativeUsageStepMembers)
      .where(
        and(
          eq(nativeUsageStepMembers.passId, baseline.identity.passId),
          after === undefined ? undefined : gt(nativeUsageStepMembers.stepId, after),
        ),
      )
      .orderBy(asc(nativeUsageStepMembers.stepId))
      .limit(400)
    if (before.length === 0) break
    const finalMembers = final
      ? new Map(
          (
            await chunkedAll(
              before.map((member) => member.stepId),
              (ids) =>
                tx
                  .select()
                  .from(nativeUsageStepMembers)
                  .where(
                    and(
                      eq(nativeUsageStepMembers.passId, final.identity.passId),
                      inArray(nativeUsageStepMembers.stepId, ids),
                    ),
                  ),
            )
          ).map((member) => [member.stepId, member]),
        )
      : new Map<string, typeof nativeUsageStepMembers.$inferSelect>()
    const sessionIds = [...new Set(before.map((member) => member.sessionId))]
    const beforeParents = new Map(
      (
        await chunkedAll(sessionIds, (ids) =>
          tx
            .select()
            .from(nativeUsageSessionParents)
            .where(
              and(
                eq(nativeUsageSessionParents.passId, baseline.identity.passId),
                inArray(nativeUsageSessionParents.sessionId, ids),
              ),
            ),
        )
      ).map((parent) => [parent.sessionId, parent]),
    )
    const finalParents = final
      ? new Map(
          (
            await chunkedAll(sessionIds, (ids) =>
              tx
                .select()
                .from(nativeUsageSessionParents)
                .where(
                  and(
                    eq(nativeUsageSessionParents.passId, final.identity.passId),
                    inArray(nativeUsageSessionParents.sessionId, ids),
                  ),
                ),
            )
          ).map((parent) => [parent.sessionId, parent]),
        )
      : new Map<string, typeof nativeUsageSessionParents.$inferSelect>()
    const candidates = new Map<
      string,
      { count: bigint; row: { id: string; document: string } | null }
    >()
    let afterOwner: string | undefined
    for (;;) {
      const owners = await tx
        .select({
          id: observationUsageCurrent.id,
          document: observationUsageCurrent.document,
          recordId: observationUsageNativeRecords.recordId,
        })
        .from(observationUsageCurrent)
        .innerJoin(
          observationUsageNativeRecords,
          eq(observationUsageCurrent.id, observationUsageNativeRecords.id),
        )
        .where(
          and(
            eq(observationUsageNativeRecords.nativeSource, proof.nativeSource),
            eq(observationUsageNativeRecords.nativeRoot, baseline.identity.rootSessionId),
            inArray(
              observationUsageNativeRecords.recordId,
              before.map((member) => 'opencode:step:' + member.stepId),
            ),
            afterOwner === undefined ? undefined : gt(observationUsageCurrent.id, afterOwner),
          ),
        )
        .orderBy(asc(observationUsageCurrent.id))
        .limit(500)
      if (owners.length === 0) break
      for (const owner of owners) {
        const document = JSON.parse(owner.document) as Meter
        if (document.measurement.invocationId === binding.invocationId) continue
        const previous = candidates.get(owner.recordId),
          count = (previous?.count ?? 0n) + 1n
        candidates.set(owner.recordId, { count, row: count === 1n ? owner : null })
      }
      const next = owners.at(-1)!.id
      if (next === afterOwner)
        throw new Error('Native reconciliation owner scan did not advance to EOF')
      afterOwner = next
    }
    const captureIds = [
      ...new Set(
        [...candidates.values()].flatMap((candidate) =>
          candidate.count === 1n && candidate.row
            ? [(JSON.parse(candidate.row.document) as Meter).measurement.invocationId]
            : [],
        ),
      ),
    ]
    const captures = new Map(
      (
        await chunkedAll(captureIds, (ids) =>
          tx
            .select()
            .from(observationUsageCaptures)
            .where(inArray(observationUsageCaptures.invocationId, ids)),
        )
      ).map((capture) => [capture.invocationId, capture]),
    )
    // At most one current packet's scope references; never retain the whole before population.
    const paths = new Map<string, Promise<string | null>>()
    for (const member of before) {
      examined++
      const old = JSON.parse(member.document)
      const latest = finalMembers.get(member.stepId)
      const currentStep = latest && JSON.parse(latest.document)
      const ownership = candidates.get('opencode:step:' + member.stepId)
      let status = 'unresolved'
      let reason =
        final?.eof === null || final === undefined ? 'native-after-unseen' : 'native-step-removed'
      let ownerId: string | null = null,
        watermark: number | null = null
      if (latest && ownership?.count === 1n && ownership.row) {
        const meter = JSON.parse(ownership.row.document) as Meter
        const measurement = ObservationNativeMeasurementSchema.safeParse(meter.measurement)
        const measured = measurement.success
          ? measurement.data
          : ObservationMeasurementSchema.parse(meter.measurement)
        meter.measurement = measured
        ownerId = measured.invocationId
        watermark = meter.nativeWatermark ?? null
        const captured = captures.get(measured.invocationId)
        const originalCapture = captured && JSON.parse(captured.document).evidence
        const scope = measured.scope
        const pathKey = JSON.stringify([measured.invocationId, measured.nodeRunId, scope])
        const path = () => {
          let original = paths.get(pathKey)
          if (!original) {
            original = scopePath(tx, meter)
            paths.set(pathKey, original)
          }
          return original
        }
        const scopeCorrect =
          scope &&
          scope.root === baseline.identity.rootSessionId &&
          scope.session === member.sessionId &&
          latest.sessionId === member.sessionId &&
          scope.parentSession === old.parentSessionId &&
          currentStep.parentSessionId === old.parentSessionId &&
          scope.level === 'request' &&
          measured.reporting === 'delta' &&
          measured.inclusion === 'self' &&
          beforeParents.get(member.sessionId)?.pathDigest ===
            finalParents.get(member.sessionId)?.pathDigest &&
          (await path()) === beforeParents.get(member.sessionId)?.pathDigest
        const captureCorrect =
          captured &&
          captured.sourceId === meter.sourceId &&
          originalCapture?.invocationId === measured.invocationId &&
          originalCapture?.capture.nativeSource === proof.nativeSource &&
          (originalCapture?.capture.contract === 'opencode-child-root-pages-v3'
            ? originalCapture.capture.beforeSpawn.invocationId === measured.invocationId &&
              scope &&
              'ancestry' in scope &&
              originalCapture.capture.sourceGeneration === scope.ancestry.identity.sourceGeneration
            : originalCapture?.capture.rootSessionId === baseline.identity.rootSessionId)
        const modelCorrect =
          measured.model === null ||
          currentStep.model === null ||
          (measured.model.id === currentStep.model.id &&
            (measured.model.provider === null ||
              measured.model.provider === currentStep.model.provider))
        const superseded =
          watermark !== null && BigInt(watermark) > BigInt(proof.emissions.sourceWatermark)
        if (
          scopeCorrect &&
          captureCorrect &&
          watermark !== null &&
          (superseded ||
            (isDeepStrictEqual(measured.usage, currentStep.usage) &&
              modelCorrect &&
              meter.complete &&
              meter.issues.length === 0))
        ) {
          status = 'resolved'
          reason = superseded ? 'superseded' : 'confirmed'
        } else
          reason = !captureCorrect
            ? 'native-owner-pending'
            : !scopeCorrect
              ? 'native-scope-changed'
              : 'native-original-revision-unresolved'
      } else if (latest) reason = 'native-owner-unproven'
      if (status === 'resolved') resolved++
      else unresolved++
      digest = sha256Hex(
        JSON.stringify([
          digest,
          member.stepId,
          member.sessionId,
          status,
          reason,
          ownerId,
          watermark,
          sha256Hex(member.document),
          latest ? sha256Hex(latest.document) : null,
        ]),
      )
    }
    const next = before.at(-1)!.stepId
    if (next === after) throw new Error('Native reconciliation before scan did not advance to EOF')
    after = next
  }
  if (examined !== BigInt(baseline.counts.steps))
    throw new Error('Native reconciliation omitted original before members')
  return {
    examined: String(examined),
    resolved: String(resolved),
    unresolved: String(unresolved),
    digest,
  }
}

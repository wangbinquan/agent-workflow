import type {
  ObservationUsageCaptureCommit,
  ObservationNativeBaselineStep,
  ObservationIngest,
} from '@agent-workflow/shared'
import type { UsageLedgerRecord } from '../domain/usageLedger'
import { sha256Hex } from '@/util/hash'
import type { NativeRevisionResolution, UsageLedgerScope } from '../ports/usageLedger'
import { isNativeUsageScope } from '../domain/nativeUsageScope'

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
function compatibleModel(
  old: UsageLedgerRecord['measurement']['model'],
  next: ObservationNativeBaselineStep['after'],
) {
  return (
    next !== null &&
    (old === null ||
      next.model === null ||
      (old.id === next.model.id && (old.provider === null || old.provider === next.model.provider)))
  )
}

/** The native store + root + stable part ID and full ancestry prove the original invocation. */
export async function reconcileNativeUsageRevisions(input: {
  readonly value: ObservationUsageCaptureCommit
  readonly watermark: number | undefined
  readonly scope: UsageLedgerScope
  readonly append: (
    sourceId: string,
    event: ObservationIngest['events'][number],
    scope: UsageLedgerScope,
    nativeSource: string,
    nativeWatermark: number,
  ) => Promise<'applied' | 'diagnostic' | 'stale' | 'duplicate'>
}): Promise<NativeRevisionResolution[]> {
  const { value, scope, watermark } = input,
    proof = value.capture
  // Page histories are repaired from original bounded source frames, never a legacy array.
  if (
    proof.contract === 'opencode-child-pages-v2' ||
    proof.contract === 'opencode-child-root-pages-v3'
  )
    return []
  const references =
    proof.baselineSteps ??
    proof.priorRevisions.map((row) => ({
      ...row,
      parentSessionId: null,
      ancestors: [],
      scopeChanged: true,
      afterObserved: true,
    }))
  const resolutions: NativeRevisionResolution[] = []
  const prior = await scope.capture(value.invocationId)
  const priorResolutions = new Map(prior?.resolutions.map((row) => [row.stepId, row]) ?? [])
  if (!references.length) return resolutions
  if (proof.rootSessionId === null || watermark === undefined)
    return references.map((row) => ({
      stepId: row.stepId,
      sessionId: row.sessionId,
      status: 'unresolved',
      invocationId: null,
      reason: 'native-owner-unproven',
    }))
  await scope.lockNativeRoot(proof.nativeSource, proof.rootSessionId)
  for (let start = 0; start < references.length; start += 400) {
    const page = references.slice(start, start + 400)
    const candidates = await scope.nativeOwners(
      proof.nativeSource,
      proof.rootSessionId,
      page.map((row) => 'opencode:step:' + row.stepId),
      value.invocationId,
    )
    for (const reference of page) {
      if (reference.afterObserved === false) continue
      const unresolved = (reason: string) =>
        resolutions.push({
          stepId: reference.stepId,
          sessionId: reference.sessionId,
          status: 'unresolved',
          invocationId: null,
          reason,
        })
      if (reference.scopeChanged) {
        unresolved('native-scope-changed')
        continue
      }
      if (!reference.after) {
        unresolved('native-step-removed')
        continue
      }
      const ownership = candidates.get('opencode:step:' + reference.stepId)
      if (!ownership || ownership.owners !== '1' || !ownership.candidate) {
        unresolved(
          (!ownership || ownership.owners === '0') && same(reference.before, reference.after)
            ? 'native-owner-unseen'
            : 'native-owner-unproven',
        )
        continue
      }
      const candidate = ownership.candidate,
        original = await scope.nativeScope(candidate.sourceId)
      // A live source may still have durable final revisions waiting to project. Never allocate
      // corrections in its sequence until its completion marker proves those frames committed.
      const ownerCapture = await original.capture(candidate.measurement.invocationId)
      if (!ownerCapture) {
        unresolved('native-owner-pending')
        continue
      }
      if (
        ownerCapture.sourceId !== candidate.sourceId ||
        ownerCapture.capture.nativeSource !== proof.nativeSource ||
        ownerCapture.capture.rootSessionId !== proof.rootSessionId
      ) {
        unresolved('native-owner-unproven')
        continue
      }
      const current = await original.current(
        candidate.measurement.invocationId,
        candidate.measurement.recordId,
      )
      const nativeScope = current?.measurement.scope
      if (
        !current ||
        !nativeScope ||
        isNativeUsageScope(nativeScope) ||
        nativeScope.root !== proof.rootSessionId ||
        nativeScope.session !== reference.sessionId ||
        nativeScope.parentSession !== reference.parentSessionId ||
        !same(nativeScope.ancestors, reference.ancestors) ||
        nativeScope.level !== 'request' ||
        current.measurement.reporting !== 'delta' ||
        current.measurement.inclusion !== 'self'
      ) {
        unresolved('native-owner-unproven')
        continue
      }
      const resolution = {
        stepId: reference.stepId,
        sessionId: reference.sessionId,
        status: 'resolved' as const,
        invocationId: current.measurement.invocationId,
        reason: null,
      }
      if ((current.nativeWatermark ?? 0) > watermark) {
        resolutions.push({ ...resolution, reason: 'superseded' })
        continue
      }
      const eventId =
        'native-repair:' +
        sha256Hex(JSON.stringify([value.invocationId, watermark, reference.stepId]))
      if (await original.event(eventId)) {
        resolutions.push(
          priorResolutions.get(reference.stepId) ?? { ...resolution, reason: 'confirmed' },
        )
        continue
      }
      if (!compatibleModel(current.measurement.model, reference.after)) {
        unresolved('native-model-conflict')
        continue
      }
      const previous = { usage: current.measurement.usage, model: current.measurement.model }
      const unchanged = same(previous, reference.after)
      if (unchanged && current.nativeWatermark === watermark) {
        resolutions.push(resolution)
        continue
      }
      if (current.observedRevision >= Number.MAX_SAFE_INTEGER) {
        unresolved('native-revision-budget')
        continue
      }
      const outcome = await input.append(
        current.sourceId,
        {
          eventId,
          measurement: {
            ...current.measurement,
            revision: current.observedRevision + 1,
            observedAt: proof.observedAt,
            usage: reference.after.usage,
            model: reference.after.model,
            validity: 'correction',
            coverage: Object.values(reference.after.usage).every((n) => n !== null)
              ? 'complete'
              : 'partial',
          },
        },
        original,
        proof.nativeSource,
        watermark,
      )
      if (outcome !== 'applied' && outcome !== 'duplicate') {
        unresolved('native-repair-rejected')
        continue
      }
      resolutions.push({
        ...resolution,
        reason: unchanged ? 'confirmed' : 'revised',
        ...(!unchanged
          ? {
              previous: {
                ...previous,
                model: previous.model?.provider
                  ? { provider: previous.model.provider, id: previous.model.id }
                  : null,
              },
              current: reference.after,
            }
          : {}),
      })
    }
  }
  return resolutions
}

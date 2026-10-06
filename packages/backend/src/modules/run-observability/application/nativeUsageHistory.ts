import { sha256Hex } from '@/util/hash'
import type { ObservationIngest } from '@agent-workflow/shared'
import { isNativeUsageScope } from '../domain/nativeUsageScope'
import {
  nativeHistoryFingerprint,
  nativeHistorySeed,
  NativeHistoryProgressSchema,
  type NativeHistoryProgress,
  type NativeHistoryStep,
} from '../domain/nativeUsageHistory'
import type {
  UsageCaptureReceipt,
  UsageLedgerScope,
  UsageLedgerStore,
  NativeUsageOwnership,
} from '../ports/usageLedger'
import type {
  ObservationNativeHistorySource,
  ObservationNativeScopeSource,
} from '../public/participants'

type Append = (
  sourceId: string,
  event: ObservationIngest['events'][number],
  scope: UsageLedgerScope,
  nativeSource: string,
  nativeWatermark: number,
) => Promise<'applied' | 'diagnostic' | 'stale' | 'duplicate'>
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Corrections keep the original invocation/Task/Agent/time/rate authority and its actual scope. */
async function repairStep(input: {
  readonly receipt: UsageCaptureReceipt
  readonly step: NativeHistoryStep
  readonly scope: UsageLedgerScope
  readonly nativeScopes?: ObservationNativeScopeSource
  readonly append: Append
  readonly watermark: number
  readonly candidate: NativeUsageOwnership | undefined
}) {
  const { receipt, step, scope, watermark } = input
  const proof = receipt.capture
  if (
    (proof.contract !== 'opencode-child-pages-v2' &&
      proof.contract !== 'opencode-child-root-pages-v3') ||
    proof.rootSessionId === null
  )
    throw new Error('Native history writer requires its original page completion')
  const unresolved = (reason: string, owner: string | null = null) => ({
    status: 'unresolved' as const,
    reason,
    owner,
  })
  if (!step.final) return unresolved('native-step-removed')
  if (
    step.final.id !== step.before.id ||
    step.beforePath !== step.finalPath ||
    step.final.parentSessionId !== step.before.parentSessionId
  )
    return unresolved('native-scope-changed')
  const recordId = 'opencode:step:' + step.before.stepId
  const candidate = input.candidate
  if (!candidate || candidate.owners !== '1' || !candidate.candidate)
    return unresolved('native-owner-unproven')
  const original = await scope.nativeScope(candidate.candidate.sourceId)
  const current = await original.current(candidate.candidate.measurement.invocationId, recordId)
  if (!current) return unresolved('native-owner-unproven')
  const meter = current.measurement,
    owner = meter.invocationId,
    originalScope = meter.scope
  const captured = await original.capture(owner)
  if (!captured) return unresolved('native-owner-pending', owner)
  if (
    captured.sourceId !== current.sourceId ||
    captured.capture.nativeSource !== proof.nativeSource ||
    (captured.capture.contract === 'opencode-child-root-pages-v3'
      ? captured.capture.beforeSpawn.invocationId !== owner ||
        !isNativeUsageScope(originalScope) ||
        captured.capture.sourceGeneration !== originalScope.ancestry.identity.sourceGeneration
      : captured.capture.rootSessionId !== proof.rootSessionId) ||
    !originalScope ||
    meter.reporting !== 'delta' ||
    meter.inclusion !== 'self' ||
    originalScope.root !== proof.rootSessionId ||
    originalScope.session !== step.before.id ||
    originalScope.parentSession !== step.before.parentSessionId ||
    originalScope.level !== 'request'
  )
    return unresolved('native-owner-unproven', owner)
  const compatibleModel =
    meter.model === null ||
    step.final.model === null ||
    (meter.model.id === step.final.model.id &&
      (meter.model.provider === null || meter.model.provider === step.final.model.provider))
  if (!compatibleModel) return unresolved('native-model-conflict', owner)
  if (!isNativeUsageScope(originalScope)) {
    // Legacy ancestry proves only its original path. It cannot supply a missing file generation.
    let path: string | null = null
    const ancestry = [...originalScope.ancestors, originalScope.session]
    if (
      new Set(ancestry).size !== ancestry.length ||
      ancestry[0] !== originalScope.root ||
      (originalScope.ancestors.at(-1) ?? null) !== originalScope.parentSession
    )
      return unresolved('native-owner-unproven', owner)
    for (const session of ancestry) path = sha256Hex(JSON.stringify([path, session]))
    return path === step.beforePath &&
      same(meter.usage, step.final.usage) &&
      current.complete &&
      current.issues.length === 0
      ? { status: 'resolved' as const, reason: 'confirmed-legacy', owner }
      : unresolved('native-generation-unproven', owner)
  }
  if (meter.nodeRunId === null || !input.nativeScopes)
    return unresolved('native-owner-unproven', owner)
  const facts = await input.nativeScopes.resolve(meter, originalScope)
  if (
    facts.pathDigest !== step.beforePath ||
    facts.nativeSource !== proof.nativeSource ||
    facts.sourceGeneration !==
      (proof.contract === 'opencode-child-pages-v2'
        ? proof.final!.ack.identity.sourceGeneration
        : proof.sourceGeneration)
  )
    return unresolved('native-scope-changed', owner)
  if ((current.nativeWatermark ?? 0) > watermark)
    return { status: 'resolved' as const, reason: 'superseded', owner }
  const fullyObserved = Object.values(step.final.usage).every((n) => n !== null)
  const confirmed =
    same(meter.usage, step.final.usage) && current.complete && current.issues.length === 0
  const eventId =
    'native-repair:' +
    sha256Hex(JSON.stringify([receipt.invocationId, watermark, step.before.stepId]))
  if (
    (await original.event(eventId)) !== undefined ||
    (confirmed && current.nativeWatermark === watermark)
  )
    return confirmed && fullyObserved
      ? { status: 'resolved' as const, reason: 'confirmed', owner }
      : unresolved('native-original-revision-unresolved', owner)
  if (current.observedRevision >= Number.MAX_SAFE_INTEGER)
    return unresolved('native-revision-budget', owner)
  const result = await input.append(
    current.sourceId,
    {
      eventId,
      measurement: {
        ...meter,
        revision: current.observedRevision + 1,
        observedAt: proof.observedAt,
        usage: step.final.usage,
        model: step.final.model,
        validity: 'correction',
        coverage: fullyObserved ? 'complete' : 'partial',
      },
    },
    original,
    proof.nativeSource,
    watermark,
  )
  if (result !== 'applied' && result !== 'duplicate')
    return unresolved('native-repair-rejected', owner)
  const revised = await original.current(owner, recordId)
  return fullyObserved &&
    revised?.complete &&
    revised.issues.length === 0 &&
    same(revised.measurement.usage, step.final.usage)
    ? { status: 'resolved' as const, reason: 'revised', owner }
    : unresolved('native-original-revision-unresolved', owner)
}

/** One real writer packet; initial full verification closes before obtaining the writer connection. */
export async function repairNativeUsageHistory(input: {
  readonly receipt: UsageCaptureReceipt
  readonly store: UsageLedgerStore
  readonly nativeHistory: ObservationNativeHistorySource
  readonly nativeScopes?: ObservationNativeScopeSource
  readonly append: Append
}): Promise<NativeHistoryProgress | undefined> {
  const receipt = input.receipt
  if (
    receipt.capture.contract !== 'opencode-child-pages-v2' &&
    receipt.capture.contract !== 'opencode-child-root-pages-v3'
  )
    return undefined
  const value = {
    invocationId: receipt.invocationId,
    taskId: receipt.taskId,
    capture: receipt.capture,
    sourceId: receipt.sourceId,
    sourceCursor: receipt.sourceCursor,
  }
  const fingerprint = nativeHistoryFingerprint(value)
  const prior = receipt.history
  // A truncated membership index must be fully verified again before a new scan, even if
  // its immutable completion references have not changed. Valid unresolved scans can retry
  // late owner/capture facts without retaining or reopening the previous snapshot.
  const invalidPopulation =
    prior?.state === 'pending' && prior.lastCompleted?.examined !== prior.preparation.expectedSteps
  const prepared =
    prior?.preparation.valueFingerprint === fingerprint && !invalidPopulation
      ? prior.preparation
      : await input.nativeHistory.prepare(value)
  if (!prepared) return undefined
  return input.store.change(receipt.sourceId, async (scope) => {
    const current = await scope.capture(receipt.invocationId)
    if (
      !current ||
      current.sourceCursor !== receipt.sourceCursor ||
      nativeHistoryFingerprint({ ...value, capture: current.capture }) !== fingerprint
    )
      return undefined
    const historySource = scope.bindNativeHistory?.(input.nativeHistory)
    if (!historySource) throw new Error('Original native history transaction binding is missing')
    const nativeScopes = input.nativeScopes
      ? scope.bindNativeScopes?.(input.nativeScopes)
      : undefined
    const previous = current.history
    if (previous?.state === 'resolved') return previous
    const restart = previous?.state === 'pending'
    let progress: NativeHistoryProgress =
      previous && !restart
        ? previous
        : {
            preparation: prepared,
            scanCycle: previous ? String(BigInt(previous.scanCycle) + 1n) : '0',
            after: null,
            examined: '0',
            resolved: '0',
            unresolved: '0',
            digest: nativeHistorySeed(prepared),
            state: 'walking',
            lastCompleted: previous?.lastCompleted ?? null,
          }
    const match = /^node-event:([1-9]\d*)$/.exec(current.sourceCursor)
    const watermark = match ? Number(match[1]) : NaN
    if (!Number.isSafeInteger(watermark))
      throw new Error('Original native history watermark is unavailable')
    if (current.capture.rootSessionId !== null)
      await scope.lockNativeRoot(current.capture.nativeSource, current.capture.rootSessionId)
    const packet = await historySource.page(progress.preparation, progress.after)
    if (packet.length > 400) throw new Error('Native history source exceeded one transport packet')
    if (!packet.length) {
      progress = {
        ...progress,
        state:
          progress.examined === prepared.expectedSteps && progress.unresolved === '0'
            ? 'resolved'
            : 'pending',
        lastCompleted: {
          examined: progress.examined,
          resolved: progress.resolved,
          unresolved: progress.unresolved,
          digest: progress.digest,
        },
      }
    } else {
      if (
        new Set(packet.map((row) => row.before.stepId)).size !== packet.length ||
        packet.at(-1)!.before.stepId === progress.after
      )
        throw new Error('Native history packet did not advance its original members')
      let examined = BigInt(progress.examined),
        resolved = BigInt(progress.resolved),
        unresolved = BigInt(progress.unresolved),
        digest = progress.digest
      const candidates = await scope.nativeOwners(
        current.capture.nativeSource,
        current.capture.rootSessionId!,
        packet.map((step) => 'opencode:step:' + step.before.stepId),
        current.invocationId,
      )
      for (const step of packet) {
        const result = await repairStep({
          receipt: current,
          step,
          scope,
          nativeScopes,
          append: input.append,
          watermark,
          candidate: candidates.get('opencode:step:' + step.before.stepId),
        })
        examined++
        if (result.status === 'resolved') resolved++
        else unresolved++
        digest = sha256Hex(
          JSON.stringify([
            digest,
            step.before.stepId,
            sha256Hex(JSON.stringify(step.before)),
            step.final ? sha256Hex(JSON.stringify(step.final)) : null,
            result.status,
            result.reason,
            result.owner,
          ]),
        )
      }
      progress = {
        ...progress,
        after: packet.at(-1)!.before.stepId,
        examined: String(examined),
        resolved: String(resolved),
        unresolved: String(unresolved),
        digest,
      }
    }
    NativeHistoryProgressSchema.parse(progress)
    // The same actual transaction owns correction events and this continuation. Lost ACKs replay it.
    await scope.commitCapture(
      { invocationId: current.invocationId, taskId: current.taskId, capture: current.capture },
      current.sourceCursor,
      current.resolutions,
      progress,
    )
    return progress
  })
}

import { and, eq } from 'drizzle-orm'
import { isDeepStrictEqual } from 'node:util'
import {
  ObservationNativeBeforeSpawnAckSchema,
  ObservationNativeSourceAckSchema,
  parseObservationCapturedUsage,
} from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  nativeUsagePreparations,
  nativeUsageEmissions,
  taskExecutionObservationSources,
} from '@/db/schema'
import { sha256Hex } from '@/util/hash'
import type { ObservationNativeScopeSource } from '@/modules/run-observability/public/participants'
import { verifyNativeUsagePass } from './nativeUsagePassVerification'
import { verifyNativeUsageNumericCoverage } from './nativeUsageNumericCoverage'
import { originalNativeUsageStoreGeneration } from './nativeUsageStoreBinding'
import {
  qualifyOriginalNativeRoots,
  readRetainedNativeRootResult,
} from './observationNativeRootQualification'

/** Original source/preparation/ACK binding, shared by qualification and bounded history reads. */
export async function readOriginalNativeCaptureSource(
  db: ProviderNeutralDatabase,
  value: Parameters<ObservationNativeScopeSource['qualify']>[0],
) {
  const proof = value.capture
  if (
    proof.contract !== 'opencode-child-pages-v2' &&
    proof.contract !== 'opencode-child-root-pages-v3'
  )
    throw new Error('Original page qualification received a different native contract')
  const match = /^node-event:([1-9]\d*)$/.exec(value.sourceCursor)
  const watermark = match ? Number(match[1]) : NaN
  if (!Number.isSafeInteger(watermark))
    throw new Error('Native completion lost its source watermark')
  const source = (
    await db
      .select()
      .from(taskExecutionObservationSources)
      .where(eq(taskExecutionObservationSources.id, watermark))
      .limit(1)
  )[0]
  const prepared = (
    await db
      .select()
      .from(nativeUsagePreparations)
      .where(eq(nativeUsagePreparations.invocationId, value.invocationId))
      .limit(1)
  )[0]
  if (
    !source ||
    !prepared ||
    source.taskId !== value.taskId ||
    prepared.taskId !== value.taskId ||
    source.nodeRunId !== prepared.nodeRunId ||
    value.sourceId !== 'local-node:' + source.nodeRunId
  )
    throw new Error('Native completion changed its original Task or source owner')
  const evidence = parseObservationCapturedUsage(JSON.parse(source.evidenceJson))
  const emission = (
    await db
      .select()
      .from(nativeUsageEmissions)
      .where(
        and(
          eq(nativeUsageEmissions.invocationId, value.invocationId),
          eq(nativeUsageEmissions.sourceRowId, source.id),
        ),
      )
      .limit(1)
  )[0]
  if (
    !emission ||
    evidence.invocationId !== value.invocationId ||
    !isDeepStrictEqual(evidence.nativeCompletion, proof) ||
    evidence.measurements.length !== 0
  )
    throw new Error('Native completion lost its original frozen source')
  const saved = JSON.parse(emission.document) as { request: string; evidence: string }
  const ack = ObservationNativeSourceAckSchema.parse(JSON.parse(emission.ack))
  if (
    saved.evidence !== source.evidenceJson ||
    saved.request !== saved.evidence ||
    sha256Hex(saved.request) !== emission.fingerprint ||
    emission.eventId !== 'native-completion:' + emission.fingerprint ||
    ack.fingerprint !== emission.fingerprint ||
    ack.eventId !== emission.eventId ||
    ack.invocationId !== value.invocationId ||
    ack.sourceWatermark !== String(source.id) ||
    ack.measurements.length !== 0 ||
    (proof.state === 'complete' && prepared.state !== 'sealed')
  )
    throw new Error('Native completion changed its actual committed ACK')
  const before = ObservationNativeBeforeSpawnAckSchema.parse(JSON.parse(prepared.document))
  if (
    before.invocationId !== value.invocationId ||
    before.nativeSource !== proof.nativeSource ||
    (proof.contract === 'opencode-child-pages-v2'
      ? before.mode !== proof.baseline.kind
      : !isDeepStrictEqual(before, proof.beforeSpawn)) ||
    (before.mode === 'resume' && before.rootSessionId !== proof.rootSessionId)
  )
    throw new Error('Native completion changed its actual before-spawn admission')
  const binding = {
    invocationId: value.invocationId,
    taskId: value.taskId,
    nodeRunId: prepared.nodeRunId,
  }
  return {
    proof,
    binding,
    before,
    sourceFingerprint: emission.fingerprint,
    beforeSpawnFingerprint: sha256Hex(prepared.document),
    fence: prepared.fence,
  }
}

/** History only needs the original initial root; all roots are qualified separately to EOF. */
export async function readOriginalNativeCaptureBinding(
  db: ProviderNeutralDatabase,
  value: Parameters<ObservationNativeScopeSource['qualify']>[0],
) {
  const facts = await readOriginalNativeCaptureSource(db, value)
  if (facts.proof.contract === 'opencode-child-pages-v2') return { ...facts, proof: facts.proof }
  if (facts.proof.rootSessionId === null)
    throw new Error('Original native root history has no initial root')
  const original = await readRetainedNativeRootResult(
    db,
    facts.binding.invocationId,
    facts.proof.roots.resultId,
    facts.proof.rootSessionId,
  )
  if (!original) throw new Error('Original native root history lost its retained initial result')
  return { ...facts, proof: original.value.proof }
}

/** Same original report snapshot; never a new claim, mutable supplier scan or caller count. */
export async function qualifyOriginalNativeUsage(
  db: ProviderNeutralDatabase,
  value: Parameters<ObservationNativeScopeSource['qualify']>[0],
): Promise<Awaited<ReturnType<ObservationNativeScopeSource['qualify']>>> {
  if (value.capture.contract === 'opencode-child-root-pages-v3') {
    const facts = await readOriginalNativeCaptureSource(db, value)
    if (facts.proof.contract !== 'opencode-child-root-pages-v3')
      throw new Error('Original native root contract changed')
    return qualifyOriginalNativeRoots(db, { ...facts, proof: facts.proof })
  }
  const { proof, binding, before } = await readOriginalNativeCaptureBinding(db, value)
  const final = proof.final
  if (!final) return { records: null, complete: false }
  const sourceGeneration = await originalNativeUsageStoreGeneration(db, before)
  if (sourceGeneration === null)
    throw new Error('Native completion has no original admitted store generation')
  for (const reference of [final, proof.baseline.kind === 'resume' ? proof.baseline.pass : null]) {
    if (!reference) continue
    const identity = reference.ack.identity
    if (
      identity.invocationId !== value.invocationId ||
      identity.nativeSource !== before.nativeSource ||
      identity.sourceGeneration !== sourceGeneration ||
      identity.lineage !== before.lineage ||
      identity.epoch !== before.epoch ||
      identity.rootSessionId !== proof.rootSessionId
    )
      throw new Error('Native completion changed an original pass binding')
    const verified = await verifyNativeUsagePass(db, binding, reference, true)
    if (verified.hasPopulationIssues) return { records: null, complete: false }
    if (
      reference === final &&
      proof.baseline.kind === 'fresh' &&
      (proof.baseline.beforeSpawnReceiptId !== before.ownerReceiptId ||
        proof.baseline.preparedAt !== before.preparedAt ||
        proof.baseline.rootCreatedAt !== verified.rootCreatedAt)
    )
      throw new Error('Native completion changed its original root birth')
  }
  if (proof.baseline.kind === 'resume' && !proof.baseline.pass)
    return { records: null, complete: false }
  const numeric = await verifyNativeUsageNumericCoverage(db, binding, proof)
  return {
    records: numeric.records,
    complete:
      proof.state === 'complete' &&
      !numeric.missing &&
      !numeric.unknownTokens &&
      !numeric.incompleteCoverage &&
      proof.reconciliation.unresolved === '0' &&
      proof.issues.length === 0,
  }
}

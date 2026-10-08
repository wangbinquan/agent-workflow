import { nativeUsageEvidenceStorage } from './nativeUsageEvidenceStorage'
import { and, asc, eq, gt } from 'drizzle-orm'
import { isDeepStrictEqual } from 'node:util'
import {
  ObservationNativeBeforeSpawnAckSchema,
  ObservationNativeCompletionSchema,
  ObservationNativePassAckSchema,
  ObservationNativePassIdentitySchema,
  ObservationNativeSourceAckSchema,
  type ObservationNativeCompletion,
  type ObservationNativePassCompletion,
} from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import type { nativeUsagePasses } from '@/db/schema'
import { sha256Hex } from '@/util/hash'
import type {
  NativeUsageExecutionOwnerBinding as NativeUsageOwnerBinding,
  NativeUsagePersistence,
  NativeUsageReadBinding,
} from '../application/ports/nativeUsagePersistence'
import type { TaskExecutionTransaction } from './ownedTaskExecution'
import { withNativeUsageOwner, type NativeUsageOwnerFacts } from './nativeUsageOwnerTransaction'
import { verifyNativeUsagePass } from './nativeUsagePassVerification'
import { verifyNativeUsageEmissions } from './nativeUsageEmissionVerification'
import { verifyNativeUsageNumericCoverage } from './nativeUsageNumericCoverage'
import { verifyNativeUsageReconciliation } from './nativeUsageReconciliationVerification'
import { originalNativeUsageStoreGeneration } from './nativeUsageStoreBinding'

type SealPort = Pick<NativeUsagePersistence, 'seal'>
type Pass = typeof nativeUsagePasses.$inferSelect

async function head(
  tx: TaskExecutionTransaction,
  binding: NativeUsageReadBinding,
  phase: 'baseline' | 'final',
): Promise<Pass | undefined> {
  const { nativeUsagePassHeads, nativeUsagePasses } = nativeUsageEvidenceStorage(binding.sourceKind)

  let after: string | undefined
  let found: Pass | undefined
  for (;;) {
    const rows = await tx
      .select({ key: nativeUsagePassHeads.key, pass: nativeUsagePasses })
      .from(nativeUsagePassHeads)
      .innerJoin(nativeUsagePasses, eq(nativeUsagePasses.passId, nativeUsagePassHeads.passId))
      .where(
        and(
          eq(nativeUsagePasses.invocationId, binding.invocationId),
          after === undefined ? undefined : gt(nativeUsagePassHeads.key, after),
        ),
      )
      .orderBy(asc(nativeUsagePassHeads.key))
      .limit(40)
    if (rows.length === 0) break
    for (const { key, pass } of rows) {
      if (key !== pass.headKey)
        throw new Error('Native completion changed its original current pass reference')
      const identity = ObservationNativePassIdentitySchema.parse(JSON.parse(pass.identity))
      if (identity.phase !== phase) continue
      if (found) throw new Error('Native completion has ambiguous original pass roots')
      found = pass
    }
    const next = rows.at(-1)!.key
    if (next === after) throw new Error('Native completion head scan did not reach original EOF')
    after = next
  }
  return found
}

/** Derive small completion references from the actual original relations, never caller totals. */
export async function describeNativeUsageSingleRoot(
  tx: TaskExecutionTransaction,
  facts: NativeUsageOwnerFacts,
  binding: NativeUsageReadBinding,
  observedAt: number,
  context?: {
    readonly rootSessionId: string
    readonly beforeSpawn: ReturnType<typeof ObservationNativeBeforeSpawnAckSchema.parse>
    readonly sourceGeneration: string | null
    readonly emitted: Awaited<ReturnType<typeof verifyNativeUsageEmissions>>
  },
): Promise<ObservationNativeCompletion> {
  const { nativeUsagePreparations, nativeUsagePassHeads, nativeUsagePasses } =
    nativeUsageEvidenceStorage(binding.sourceKind)

  const prepared = (
    await tx
      .select()
      .from(nativeUsagePreparations)
      .where(eq(nativeUsagePreparations.invocationId, binding.invocationId))
  )[0]
  if (
    !prepared ||
    prepared.taskId !== binding.taskId ||
    prepared.nodeRunId !== binding.nodeRunId ||
    prepared.fence !== facts.fence
  )
    throw new Error('Native completion has no actual original preparation')
  const beforeSpawn =
    context?.beforeSpawn ??
    ObservationNativeBeforeSpawnAckSchema.parse(JSON.parse(prepared.document))
  const sourceGeneration = context
    ? context.sourceGeneration
    : await originalNativeUsageStoreGeneration(tx, beforeSpawn, binding.sourceKind)
  const issues = new Set<string>()
  const effectiveResume =
    beforeSpawn.mode === 'resume' &&
    (!context || context.rootSessionId === beforeSpawn.rootSessionId)
  const current = async (phase: 'baseline' | 'final') => {
    if (!context) return head(tx, binding, phase)
    if (sourceGeneration === null) return undefined
    const key = JSON.stringify([
      binding.invocationId,
      beforeSpawn.nativeSource,
      sourceGeneration,
      context.rootSessionId,
      beforeSpawn.lineage,
      beforeSpawn.epoch,
      phase,
    ])
    const row = (
      await tx
        .select({ key: nativeUsagePassHeads.key, pass: nativeUsagePasses })
        .from(nativeUsagePassHeads)
        .innerJoin(nativeUsagePasses, eq(nativeUsagePasses.passId, nativeUsagePassHeads.passId))
        .where(eq(nativeUsagePassHeads.key, key))
        .limit(1)
    )[0]
    if (row && (row.key !== row.pass.headKey || row.pass.invocationId !== binding.invocationId))
      throw new Error('Native root changed its original pass head')
    return row?.pass
  }
  const finalRow = await current('final')
  const beforeRow = effectiveResume ? await current('baseline') : undefined
  const checkBinding = (row: Pass) => {
    const identity = ObservationNativePassIdentitySchema.parse(JSON.parse(row.identity))
    if (
      identity.invocationId !== binding.invocationId ||
      identity.nativeSource !== facts.nativeSource ||
      sourceGeneration === null ||
      identity.sourceGeneration !== sourceGeneration ||
      identity.lineage !== facts.lineage ||
      identity.epoch !== facts.epoch ||
      (context
        ? identity.rootSessionId !== context.rootSessionId
        : beforeSpawn.mode === 'resume' && identity.rootSessionId !== beforeSpawn.rootSessionId)
    )
      throw new Error('Native completion changed its original source or execution binding')
    return identity
  }
  let baselinePass: ObservationNativePassCompletion | null = null
  if (beforeRow) {
    checkBinding(beforeRow)
    if (beforeRow.lastAck && beforeRow.state === 'eof') {
      const reference = {
        ack: ObservationNativePassAckSchema.parse(JSON.parse(beforeRow.lastAck)),
        pageCount: beforeRow.nextOrdinal,
      }
      const verified = await verifyNativeUsagePass(tx, binding, reference, true)
      if (!verified.hasPopulationIssues) baselinePass = reference
      else issues.add('native-baseline-population-incomplete')
    }
  }
  if (effectiveResume && !baselinePass) issues.add('native-baseline-unavailable')
  let final: ObservationNativePassCompletion | null = null
  let finalProgress: ObservationNativeCompletion['finalProgress']
  let rootSessionId = context?.rootSessionId ?? beforeSpawn.rootSessionId
  let rootCreatedAt: number | null = null
  if (finalRow) {
    rootSessionId = checkBinding(finalRow).rootSessionId
    rootCreatedAt = finalRow.rootCreatedAt
    if (finalRow.lastAck) {
      const ack = ObservationNativePassAckSchema.parse(JSON.parse(finalRow.lastAck))
      const reference = { ack, pageCount: finalRow.nextOrdinal }
      const eof = finalRow.state === 'eof'
      const verified = await verifyNativeUsagePass(tx, binding, reference, eof)
      if (eof) final = reference
      else finalProgress = ack
      if (verified.hasPopulationIssues) issues.add('native-final-population-incomplete')
    }
  }
  if (!final) issues.add('native-final-unavailable')
  const emitted = context?.emitted ?? (await verifyNativeUsageEmissions(tx, binding))
  if (observedAt < emitted.observedAtFloor || observedAt < beforeSpawn.preparedAt)
    throw new Error('Native completion observation precedes its actual original evidence')
  if (emitted.hasProcessIssues) issues.add('native-process-incomplete')
  if (!effectiveResume && rootCreatedAt === null) issues.add('native-root-birth-unavailable')
  const partial: ObservationNativeCompletion = {
    contract: 'opencode-child-pages-v2',
    nativeSource: facts.nativeSource,
    rootSessionId,
    state: 'partial',
    baseline: !effectiveResume
      ? {
          kind: 'fresh',
          beforeSpawnReceiptId: beforeSpawn.ownerReceiptId,
          preparedAt: beforeSpawn.preparedAt,
          rootCreatedAt,
        }
      : { kind: 'resume', pass: baselinePass },
    final,
    ...(finalProgress === undefined ? {} : { finalProgress }),
    observedAt,
    process: emitted.process,
    emissions: emitted.emissions,
    reconciliation: {
      examined: '0',
      resolved: '0',
      unresolved: '0',
      digest: sha256Hex(JSON.stringify(['native-reconciliation-v2', binding.invocationId])),
    },
    issues: [],
  }
  partial.reconciliation = await verifyNativeUsageReconciliation(tx, binding, partial)
  if (partial.reconciliation.unresolved !== '0') issues.add('native-prior-revision-unresolved')
  const numeric = await verifyNativeUsageNumericCoverage(tx, binding, partial)
  if (numeric.missing) issues.add('native-numeric-source-incomplete')
  if (numeric.unknownTokens) issues.add('native-token-bucket-unknown')
  if (numeric.incompleteCoverage) issues.add('native-numeric-coverage-incomplete')
  if (
    context &&
    !effectiveResume &&
    rootCreatedAt !== null &&
    (emitted.process.spawnedAt === null ||
      rootCreatedAt < emitted.process.spawnedAt ||
      rootCreatedAt > observedAt)
  )
    issues.add('native-root-birth-outside-original-process')
  if (
    context &&
    (emitted.process.spawnedAt === null || beforeSpawn.preparedAt > emitted.process.spawnedAt)
  )
    issues.add('native-before-spawn-unavailable')
  const described: ObservationNativeCompletion = {
    ...partial,
    state: issues.size === 0 ? 'complete' : 'partial',
    issues: [...issues],
  }
  // v3 retains the actual per-root failure facts in its original result digest. The old strict
  // single-root wire schema and every already accepted v2 event remain unchanged.
  return context ? described : ObservationNativeCompletionSchema.parse(described)
}

/** Original completion source and frozen ACK commit together. Producer composition is separate. */
export class DrizzleNativeUsageCompletion implements SealPort {
  constructor(private readonly db: ProviderNeutralDatabase) {}

  async describeCompletion(input: {
    readonly binding: NativeUsageOwnerBinding
    readonly observedAt: number
  }): Promise<ObservationNativeCompletion> {
    return withNativeUsageOwner(this.db, input.binding, (tx, facts) =>
      describeNativeUsageSingleRoot(tx, facts, input.binding, input.observedAt),
    )
  }

  async seal(input: Parameters<SealPort['seal']>[0]) {
    const { nativeUsageEmissions, taskExecutionObservationSources, nativeUsagePreparations } =
      nativeUsageEvidenceStorage(input.binding.sourceKind)

    const completion = ObservationNativeCompletionSchema.parse(input.completion)
    const evidence = {
      invocationId: input.binding.invocationId,
      measurements: [],
      diagnostics: completion.issues,
      nativeCompletion: completion,
    }
    const request = JSON.stringify(evidence)
    const fingerprint = sha256Hex(request)
    const eventId = 'native-completion:' + fingerprint
    return withNativeUsageOwner(this.db, input.binding, async (tx, facts) => {
      const frozen = (
        await tx
          .select()
          .from(nativeUsageEmissions)
          .where(
            and(
              eq(nativeUsageEmissions.invocationId, input.binding.invocationId),
              eq(nativeUsageEmissions.eventId, eventId),
            ),
          )
      )[0]
      if (frozen) {
        const document = JSON.parse(frozen.document) as { request: string; evidence: string }
        const original = (
          await tx
            .select()
            .from(taskExecutionObservationSources)
            .where(eq(taskExecutionObservationSources.id, frozen.sourceRowId))
        )[0]
        const ack = ObservationNativeSourceAckSchema.parse(JSON.parse(frozen.ack))
        if (
          document.request !== request ||
          document.evidence !== request ||
          frozen.fingerprint !== fingerprint ||
          !original ||
          original.taskId !== input.binding.taskId ||
          original.nodeRunId !== input.binding.nodeRunId ||
          original.evidenceJson !== request ||
          ack.invocationId !== input.binding.invocationId ||
          ack.eventId !== eventId ||
          ack.fingerprint !== fingerprint ||
          ack.sourceWatermark !== String(original.id) ||
          ack.measurements.length !== 0
        )
          throw new Error('Native completion replay changed its original source or ACK')
        return ack
      }
      const actual = await describeNativeUsageSingleRoot(
        tx,
        facts,
        input.binding,
        completion.observedAt,
      )
      if (!isDeepStrictEqual(actual, completion))
        throw new Error('Native completion differs from its complete original evidence')
      const prepared = (
        await tx
          .select({ state: nativeUsagePreparations.state })
          .from(nativeUsagePreparations)
          .where(eq(nativeUsagePreparations.invocationId, input.binding.invocationId))
      )[0]
      if (prepared?.state !== 'open') throw new Error('Original native invocation already sealed')
      const original = (
        await tx
          .insert(taskExecutionObservationSources)
          .values({
            taskId: input.binding.taskId,
            nodeRunId: input.binding.nodeRunId,
            evidenceJson: request,
          })
          .returning({ id: taskExecutionObservationSources.id })
          .all()
      )[0]
      if (!original || !Number.isSafeInteger(original.id) || original.id < 1)
        throw new Error('Native completion did not retain its actual original source')
      const ack = ObservationNativeSourceAckSchema.parse({
        contract: 'native-usage-source-ack-v2',
        invocationId: input.binding.invocationId,
        eventId,
        fingerprint,
        sourceWatermark: String(original.id),
        measurements: [],
      })
      await tx.insert(nativeUsageEmissions).values({
        invocationId: input.binding.invocationId,
        eventId,
        fingerprint,
        sourceRowId: original.id,
        document: JSON.stringify({ request, evidence: request }),
        ack: JSON.stringify(ack),
      })
      if (completion.state === 'complete')
        await tx
          .update(nativeUsagePreparations)
          .set({ state: 'sealed' })
          .where(eq(nativeUsagePreparations.invocationId, input.binding.invocationId))
      return ack
    })
  }
}

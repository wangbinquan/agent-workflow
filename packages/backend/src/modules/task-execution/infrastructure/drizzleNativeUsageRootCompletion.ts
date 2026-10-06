import { and, desc, eq, sql } from 'drizzle-orm'
import { isDeepStrictEqual } from 'node:util'
import {
  ObservationNativeRootCompletionSchema,
  ObservationNativeSourceAckSchema,
  ObservationNativeBeforeSpawnAckSchema,
} from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  nativeUsagePreparations,
  nativeUsageEmissions,
  taskExecutionObservationSources,
} from '@/db/schema'
import { sha256Hex } from '@/util/hash'
import type {
  NativeUsageOwnerBinding,
  NativeUsagePersistence,
} from '../application/ports/nativeUsagePersistence'
import { withNativeUsageOwner } from './nativeUsageOwnerTransaction'
import { describeNativeUsageRootCompletion } from './nativeUsageRootCompletion'
import { qualifyOriginalNativeRoots } from './observationNativeRootQualification'

/** No source receipt was committed for this candidate; a retry may derive current history. */
export class NativeRootCompletionCandidateChanged extends Error {}

/** v3 uses the existing original source and ACK relations, never a second numeric ledger. */
export class DrizzleNativeUsageRootCompletion implements Pick<NativeUsagePersistence, 'seal'> {
  constructor(private readonly db: ProviderNeutralDatabase) {}
  async describeCompletion(input: {
    readonly binding: NativeUsageOwnerBinding
    readonly observedAt: number
  }) {
    return withNativeUsageOwner(this.db, input.binding, async (tx, facts) => {
      const prepared = (
        await tx
          .select()
          .from(nativeUsagePreparations)
          .where(eq(nativeUsagePreparations.invocationId, input.binding.invocationId))
          .limit(1)
      )[0]
      if (prepared?.state === 'sealed') {
        // A producer rebuilt after a lost ACK reuses the original committed proof.
        // Its pre-seal watermark cannot advance to the seal's own source row.
        const original = (
          await tx
            .select()
            .from(nativeUsageEmissions)
            .where(
              and(
                eq(nativeUsageEmissions.invocationId, input.binding.invocationId),
                eq(
                  sql<string>`substr(${nativeUsageEmissions.eventId}, 1, ${'native-completion:'.length})`,
                  'native-completion:',
                ),
              ),
            )
            .orderBy(desc(nativeUsageEmissions.sourceRowId))
            .limit(1)
        )[0]
        if (!original) throw new Error('Sealed native roots lost their original completion')
        const saved = JSON.parse(original.document) as { evidence: string }
        const proof = ObservationNativeRootCompletionSchema.parse(
          JSON.parse(saved.evidence).nativeCompletion,
        )
        const qualified = await qualifyOriginalNativeRoots(tx, {
          proof,
          binding: input.binding,
          fence: facts.fence,
          before: ObservationNativeBeforeSpawnAckSchema.parse(JSON.parse(prepared.document)),
        })
        if (proof.state !== 'complete' || !qualified.complete)
          throw new Error('Sealed native roots lost their original complete result')
        return proof
      }
      return (await describeNativeUsageRootCompletion(tx, facts, input.binding, input.observedAt))
        .proof
    })
  }
  async seal(input: Parameters<NativeUsagePersistence['seal']>[0]) {
    const completion = ObservationNativeRootCompletionSchema.parse(input.completion)
    const evidence = {
      invocationId: input.binding.invocationId,
      measurements: [],
      diagnostics: completion.issues,
      nativeCompletion: completion,
    }
    const request = JSON.stringify(evidence),
      fingerprint = sha256Hex(request),
      eventId = 'native-completion:' + fingerprint
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
          .limit(1)
      )[0]
      if (frozen) {
        const document = JSON.parse(frozen.document) as { request: string; evidence: string }
        const original = (
          await tx
            .select()
            .from(taskExecutionObservationSources)
            .where(eq(taskExecutionObservationSources.id, frozen.sourceRowId))
            .limit(1)
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
          throw new Error('Native root completion replay changed its original source or ACK')
        return ack
      }
      const actual = (
        await describeNativeUsageRootCompletion(
          tx,
          facts,
          input.binding,
          completion.observedAt,
          completion.roots.resultId,
        )
      ).proof
      if (!isDeepStrictEqual(actual, completion))
        throw new NativeRootCompletionCandidateChanged(
          'Native root completion differs from every original root',
        )
      const prepared = (
        await tx
          .select({ state: nativeUsagePreparations.state })
          .from(nativeUsagePreparations)
          .where(eq(nativeUsagePreparations.invocationId, input.binding.invocationId))
          .limit(1)
      )[0]
      if (prepared?.state !== 'open')
        throw new Error('Original native root invocation already sealed')
      const original = (
        await tx
          .insert(taskExecutionObservationSources)
          .values({
            taskId: input.binding.taskId,
            nodeRunId: input.binding.nodeRunId,
            evidenceJson: request,
          })
          .returning({ id: taskExecutionObservationSources.id })
      )[0]
      if (!original || !Number.isSafeInteger(original.id) || original.id < 1)
        throw new Error('Native roots did not retain their actual original source')
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

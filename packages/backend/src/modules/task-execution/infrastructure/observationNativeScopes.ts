import { and, eq } from 'drizzle-orm'
import { isDeepStrictEqual } from 'node:util'
import {
  ObservationNativeScopeReferenceSchema,
  ObservationNativeSourceAckSchema,
  ObservationNativeBeforeSpawnAckSchema,
  parseObservationCapturedUsage,
} from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  nativeUsagePreparations,
  nativeUsageSessionParents,
  nativeUsageEmissions,
  taskExecutionObservationSources,
} from '@/db/schema'
import { sha256Hex } from '@/util/hash'
import type { ObservationNativeScopeSource } from '@/modules/run-observability/public/participants'
import { verifyNativeUsageScope } from './nativeUsageScopeReference'
import { qualifyOriginalNativeUsage } from './observationNativeQualification'
import { originalNativeUsageStoreGeneration } from './nativeUsageStoreBinding'

/** No second connection or claims are synthesized; bootstrap supplies the original reader. */
export function createObservationNativeScopes(
  db: ProviderNeutralDatabase,
): ObservationNativeScopeSource {
  const checked = new Map<string, ReturnType<typeof ObservationNativeScopeReferenceSchema.parse>>()
  const parents = new Map<string, typeof nativeUsageSessionParents.$inferSelect>()
  const retain = <T>(cache: Map<string, T>, key: string, value: T) => {
    cache.delete(key)
    cache.set(key, value)
    if (cache.size > 4096) cache.delete(cache.keys().next().value!)
    return value
  }
  const check = async (
    binding: Parameters<ObservationNativeScopeSource['resolve']>[0],
    value: Parameters<ObservationNativeScopeSource['resolve']>[1],
  ) => {
    const scope = ObservationNativeScopeReferenceSchema.parse(value)
    const key = JSON.stringify([binding.invocationId, binding.taskId, binding.nodeRunId, scope])
    const cached = checked.get(key)
    if (cached) return retain(checked, key, cached)
    const original = (
      await db
        .select()
        .from(nativeUsagePreparations)
        .where(eq(nativeUsagePreparations.invocationId, binding.invocationId))
        .limit(1)
    )[0]
    if (!original || original.taskId !== binding.taskId || original.nodeRunId !== binding.nodeRunId)
      throw new Error('Original native scope changed its accepted Task or attempt')
    const preparation = ObservationNativeBeforeSpawnAckSchema.parse(JSON.parse(original.document))
    const sourceGeneration = await originalNativeUsageStoreGeneration(db, preparation)
    if (
      preparation.nativeSource !== scope.ancestry.identity.nativeSource ||
      sourceGeneration === null ||
      sourceGeneration !== scope.ancestry.identity.sourceGeneration ||
      preparation.lineage !== scope.ancestry.identity.lineage ||
      preparation.epoch !== scope.ancestry.identity.epoch
    )
      throw new Error('Original native scope changed its accepted source generation')
    await verifyNativeUsageScope(db, binding, scope)
    return retain(checked, key, scope)
  }
  const link = async (passId: string, session: string) => {
    const key = JSON.stringify([passId, session]),
      cached = parents.get(key)
    if (cached) return retain(parents, key, cached)
    const actual = (
      await db
        .select()
        .from(nativeUsageSessionParents)
        .where(
          and(
            eq(nativeUsageSessionParents.passId, passId),
            eq(nativeUsageSessionParents.sessionId, session),
          ),
        )
        .limit(1)
    )[0]
    if (!actual) throw new Error('Original native scope parent evidence is missing')
    return retain(parents, key, actual)
  }
  return {
    onReader: (reader) => {
      if (!('select' in reader) || typeof reader.select !== 'function')
        throw new Error('Original native scope reader is unavailable')
      return createObservationNativeScopes(reader as ProviderNeutralDatabase)
    },
    qualify: (value) => qualifyOriginalNativeUsage(db, value),
    async verify(input) {
      checked.clear()
      parents.clear()
      if (
        input.nativeWatermark === undefined ||
        input.nextCursor !== 'node-event:' + input.nativeWatermark
      )
        throw new Error('Native ledger page has no actual original source watermark')
      const previous =
        input.expectedCursor === null
          ? 0n
          : (() => {
              const match = /^node-event:([1-9]\d*)$/.exec(input.expectedCursor)
              if (!match) throw new Error('Native ledger page lost its original previous cursor')
              return BigInt(match[1]!)
            })()
      if (BigInt(input.nativeWatermark) <= previous)
        throw new Error('Native ledger page did not advance its original source watermark')
      const source = (
        await db
          .select()
          .from(taskExecutionObservationSources)
          .where(eq(taskExecutionObservationSources.id, input.nativeWatermark))
          .limit(1)
      )[0]
      if (!source || input.sourceId !== 'local-node:' + source.nodeRunId)
        throw new Error('Native ledger page changed its original source owner')
      const evidence = parseObservationCapturedUsage(JSON.parse(source.evidenceJson))
      const frozen = (
        await db
          .select()
          .from(nativeUsageEmissions)
          .where(
            and(
              eq(nativeUsageEmissions.invocationId, evidence.invocationId),
              eq(nativeUsageEmissions.sourceRowId, source.id),
            ),
          )
          .limit(1)
      )[0]
      if (!frozen) throw new Error('Native source has no original durable ACK')
      const saved = JSON.parse(frozen.document) as { request: string; evidence: string }
      const ack = ObservationNativeSourceAckSchema.parse(JSON.parse(frozen.ack))
      if (
        saved.evidence !== source.evidenceJson ||
        sha256Hex(saved.request) !== frozen.fingerprint ||
        ack.fingerprint !== frozen.fingerprint ||
        ack.eventId !== frozen.eventId ||
        ack.invocationId !== evidence.invocationId ||
        ack.sourceWatermark !== String(source.id) ||
        !isDeepStrictEqual(ack.measurements, evidence.measurements) ||
        !isDeepStrictEqual(
          input.events,
          evidence.measurements.map((measurement, index) => ({
            eventId: `${source.id}:${index}`,
            measurement,
          })),
        ) ||
        !isDeepStrictEqual(input.nativeProcess, evidence.nativeProcess) ||
        !isDeepStrictEqual(
          input.capture,
          evidence.nativeCompletion
            ? {
                invocationId: evidence.invocationId,
                taskId: source.taskId,
                capture: evidence.nativeCompletion,
              }
            : undefined,
        )
      )
        throw new Error('Native ledger page changed its frozen original source or ACK')
      const prepared = (
        await db
          .select()
          .from(nativeUsagePreparations)
          .where(eq(nativeUsagePreparations.invocationId, evidence.invocationId))
          .limit(1)
      )[0]
      if (
        !prepared ||
        prepared.taskId !== source.taskId ||
        prepared.nodeRunId !== source.nodeRunId ||
        ObservationNativeBeforeSpawnAckSchema.parse(JSON.parse(prepared.document)).nativeSource !==
          input.nativeSource
      )
        throw new Error('Native ledger page changed its original admission')
    },
    async resolve(binding, value) {
      const scope = await check(binding, value)
      const actual = await link(scope.ancestry.identity.passId, scope.session)
      return {
        invocationId: binding.invocationId,
        taskId: binding.taskId,
        nodeRunId: binding.nodeRunId!,
        depth: actual.depth,
        pathDigest: actual.pathDigest,
        nativeSource: scope.ancestry.identity.nativeSource,
        sourceGeneration: scope.ancestry.identity.sourceGeneration,
      }
    },
    path: async function* (binding, value) {
      const scope = await check(binding, value)
      let session: string | null = scope.session
      while (session !== null) {
        const actual = await link(scope.ancestry.identity.passId, session)
        if (BigInt(actual.ordinal) > BigInt(scope.ancestry.pageOrdinal))
          throw new Error('Original native scope parent is outside the referenced page')
        yield {
          session: actual.sessionId,
          parentSession: actual.parentSessionId,
          depth: actual.depth,
          pathDigest: actual.pathDigest,
        }
        session = actual.parentSessionId
      }
    },
  }
}

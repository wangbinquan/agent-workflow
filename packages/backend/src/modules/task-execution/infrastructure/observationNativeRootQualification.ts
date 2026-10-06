import { and, eq, sql } from 'drizzle-orm'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import {
  ObservationNativeCompletionSchema,
  type ObservationNativeBeforeSpawnAck,
  type ObservationNativeRootCompletion,
} from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import { nativeUsageRootSets, nativeUsageRootResults } from '@/db/schema'
import { sha256Hex } from '@/util/hash'
import type { NativeUsageReadBinding } from '../application/ports/nativeUsagePersistence'
import { verifyNativeRootSource, originalNativeRootPage } from './nativeUsageRootSource'
import { verifyNativeUsageEmissions } from './nativeUsageEmissionVerification'
import { verifyNativeUsagePass } from './nativeUsagePassVerification'
import { verifyNativeUsageNumericCoverage } from './nativeUsageNumericCoverage'
import { originalNativeUsageStoreGeneration } from './nativeUsageStoreBinding'

const decimal = z.string().regex(/^(0|[1-9]\d*)$/)
const resultSchema = z
  .object({
    contract: z.literal('native-usage-root-result-v3'),
    rootSessionId: z.string().min(1),
    // A partial result retains actual failure facts, including a root born before spawn.
    // The explicit outer v3 contract never changes an accepted single-root v2 event.
    proof: ObservationNativeCompletionSchema.innerType(),
    numeric: z
      .object({
        records: decimal,
        missing: z.boolean(),
        unknownTokens: z.boolean(),
        incompleteCoverage: z.boolean(),
      })
      .strict(),
  })
  .strict()

export async function readRetainedNativeRootResult(
  db: ProviderNeutralDatabase,
  invocationId: string,
  resultId: string,
  rootSessionId: string,
) {
  const row = (
    await db
      .select()
      .from(nativeUsageRootResults)
      .where(
        and(
          eq(nativeUsageRootResults.invocationId, invocationId),
          eq(nativeUsageRootResults.resultId, resultId),
          eq(nativeUsageRootResults.rootSessionId, rootSessionId),
        ),
      )
      .limit(1)
  )[0]
  if (!row) return null
  const value = resultSchema.parse(JSON.parse(row.document))
  if (value.rootSessionId !== row.rootSessionId || value.proof.rootSessionId !== row.rootSessionId)
    throw new Error('Original native root result changed its retained identity')
  if (value.proof.state === 'complete') ObservationNativeCompletionSchema.parse(value.proof)
  return { value, document: row.document }
}

/** All original transitions, distinct roots, retained results, pages and numbers reach EOF. */
export async function qualifyOriginalNativeRoots(
  db: ProviderNeutralDatabase,
  facts: {
    readonly proof: ObservationNativeRootCompletion
    readonly binding: NativeUsageReadBinding
    readonly before: ObservationNativeBeforeSpawnAck
    readonly fence: string
  },
) {
  const { proof, binding, before } = facts
  const source = await verifyNativeRootSource(db, binding, facts)
  const frozen = (
    await db
      .select()
      .from(nativeUsageRootSets)
      .where(eq(nativeUsageRootSets.invocationId, binding.invocationId))
      .limit(1)
  )[0]
  const generation = await originalNativeUsageStoreGeneration(db, before)
  if (
    !frozen ||
    frozen.nextOrdinal !== source.nextOrdinal ||
    frozen.rootDigest !== source.digest ||
    proof.roots.transitions !== source.nextOrdinal ||
    proof.roots.sourceDigest !== source.digest ||
    proof.roots.frozenAt !== frozen.observedAt ||
    proof.roots.processWatermark !== frozen.processWatermark ||
    proof.rootSessionId !== source.firstRoot ||
    (source.initialMode !== null && before.mode !== source.initialMode) ||
    generation !== proof.sourceGeneration
  )
    throw new Error('Native root completion changed its original frozen population')
  const emitted = await verifyNativeUsageEmissions(db, binding, proof.emissions.sourceWatermark)
  const frozenProcess = await verifyNativeUsageEmissions(db, binding, frozen.processWatermark)
  if (
    !isDeepStrictEqual(proof.emissions, emitted.emissions) ||
    !isDeepStrictEqual(proof.process, emitted.process)
  )
    throw new Error('Native root completion changed its original process or numeric source')
  let after: string | null = null,
    count = 0n,
    records = 0n,
    examined = 0n,
    resolved = 0n,
    unresolved = 0n
  let resultDigest = sha256Hex(JSON.stringify(['native-root-results-v3', binding.invocationId]))
  let reconciliationDigest = sha256Hex(
    JSON.stringify(['native-root-reconciliation-v3', binding.invocationId]),
  )
  let complete =
    proof.state === 'complete' &&
    !emitted.hasProcessIssues &&
    !frozenProcess.hasProcessIssues &&
    isDeepStrictEqual(frozenProcess.process, emitted.process) &&
    proof.issues.length === 0
  let hasFinal = true
  for (;;) {
    const roots = await originalNativeRootPage(db, binding.invocationId, after)
    if (!roots.length) break
    for (const rootSessionId of roots) {
      const retained = await readRetainedNativeRootResult(
        db,
        binding.invocationId,
        proof.roots.resultId,
        rootSessionId,
      )
      if (!retained) return { records: null, complete: false }
      const single = retained.value.proof
      const resume = before.mode === 'resume' && rootSessionId === before.rootSessionId
      if (
        single.nativeSource !== before.nativeSource ||
        single.observedAt !== proof.observedAt ||
        single.baseline.kind !== (resume ? 'resume' : 'fresh') ||
        !isDeepStrictEqual(single.process, proof.process) ||
        !isDeepStrictEqual(single.emissions, proof.emissions)
      )
        throw new Error('Native root result changed its original invocation references')
      const final = single.final
      if (!final || (resume && single.baseline.kind === 'resume' && !single.baseline.pass)) {
        hasFinal = false
        complete = false
      }
      for (const reference of [
        final,
        single.baseline.kind === 'resume' ? single.baseline.pass : null,
      ]) {
        if (!reference) continue
        const identity = reference.ack.identity
        if (
          identity.invocationId !== binding.invocationId ||
          identity.nativeSource !== before.nativeSource ||
          identity.sourceGeneration !== generation ||
          identity.rootSessionId !== rootSessionId ||
          identity.lineage !== before.lineage ||
          identity.epoch !== before.epoch
        )
          throw new Error('Native root completion changed an original pass binding')
        const checked = await verifyNativeUsagePass(db, binding, reference, true)
        complete &&= !checked.hasPopulationIssues
        if (
          reference === final &&
          single.baseline.kind === 'fresh' &&
          (single.baseline.beforeSpawnReceiptId !== before.ownerReceiptId ||
            single.baseline.preparedAt !== before.preparedAt ||
            single.baseline.rootCreatedAt !== checked.rootCreatedAt)
        )
          throw new Error('Native root result changed its original birth receipt')
      }
      const numeric = await verifyNativeUsageNumericCoverage(db, binding, single)
      complete &&=
        single.state === 'complete' &&
        single.issues.length === 0 &&
        !numeric.missing &&
        !numeric.unknownTokens &&
        !numeric.incompleteCoverage &&
        isDeepStrictEqual(numeric, retained.value.numeric)
      records += BigInt(numeric.records)
      count++
      examined += BigInt(single.reconciliation.examined)
      resolved += BigInt(single.reconciliation.resolved)
      unresolved += BigInt(single.reconciliation.unresolved)
      resultDigest = sha256Hex(JSON.stringify([resultDigest, retained.document]))
      reconciliationDigest = sha256Hex(
        JSON.stringify([reconciliationDigest, rootSessionId, single.reconciliation]),
      )
    }
    const next = roots.at(-1)!
    if (next === after) throw new Error('Native root qualification did not reach original EOF')
    after = next
  }
  const population = (
    await db
      .select({ count: sql<string>`CAST(count(*) AS TEXT)` })
      .from(nativeUsageRootResults)
      .where(
        and(
          eq(nativeUsageRootResults.invocationId, binding.invocationId),
          eq(nativeUsageRootResults.resultId, proof.roots.resultId),
        ),
      )
  )[0]
  const resultId = sha256Hex(
    JSON.stringify([
      'native-root-results-v3',
      binding.invocationId,
      proof.observedAt,
      generation,
      source.nextOrdinal,
      source.digest,
      proof.emissions,
      resultDigest,
    ]),
  )
  if (
    !population ||
    population.count !== String(count) ||
    proof.roots.count !== String(count) ||
    proof.roots.resultDigest !== resultDigest ||
    proof.roots.resultId !== resultId ||
    !isDeepStrictEqual(proof.reconciliation, {
      examined: String(examined),
      resolved: String(resolved),
      unresolved: String(unresolved),
      digest: reconciliationDigest,
    })
  )
    throw new Error('Native root completion omitted or changed an original retained result')
  return {
    records: hasFinal ? String(records) : null,
    complete: complete && count > 0n && unresolved === 0n,
  }
}

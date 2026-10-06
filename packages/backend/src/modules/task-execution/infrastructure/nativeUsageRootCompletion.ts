import { and, eq } from 'drizzle-orm'
import { isDeepStrictEqual } from 'node:util'
import {
  ObservationNativeBeforeSpawnAckSchema,
  ObservationNativeRootCompletionSchema,
  type ObservationNativeRootCompletion,
} from '@agent-workflow/shared'
import { nativeUsagePreparations, nativeUsageRootSets, nativeUsageRootResults } from '@/db/schema'
import { sha256Hex } from '@/util/hash'
import type { NativeUsageReadBinding } from '../application/ports/nativeUsagePersistence'
import type { NativeUsageOwnerFacts } from './nativeUsageOwnerTransaction'
import type { TaskExecutionTransaction } from './ownedTaskExecution'
import { originalNativeRootPage, verifyNativeRootSource } from './nativeUsageRootSource'
import { verifyNativeUsageEmissions } from './nativeUsageEmissionVerification'
import { verifyNativeUsageNumericCoverage } from './nativeUsageNumericCoverage'
import { originalNativeUsageStoreGeneration } from './nativeUsageStoreBinding'
import { describeNativeUsageSingleRoot } from './drizzleNativeUsageCompletion'

/** The full original relation is streamed to EOF. No caller-supplied root list or total. */
export async function describeNativeUsageRootCompletion(
  tx: TaskExecutionTransaction,
  facts: NativeUsageOwnerFacts,
  binding: NativeUsageReadBinding,
  observedAt: number,
  retainOriginalResultId?: string,
): Promise<{ readonly proof: ObservationNativeRootCompletion; readonly records: string }> {
  const prepared = (
    await tx
      .select()
      .from(nativeUsagePreparations)
      .where(eq(nativeUsagePreparations.invocationId, binding.invocationId))
      .limit(1)
  )[0]
  if (
    !prepared ||
    prepared.taskId !== binding.taskId ||
    prepared.nodeRunId !== binding.nodeRunId ||
    prepared.fence !== facts.fence ||
    facts.contract !== 'opencode-child-root-pages-v3'
  )
    throw new Error('Native root completion has no actual original before-spawn owner')
  const beforeSpawn = ObservationNativeBeforeSpawnAckSchema.parse(JSON.parse(prepared.document))
  const sourceGeneration = await originalNativeUsageStoreGeneration(tx, beforeSpawn)
  const source = await verifyNativeRootSource(tx, binding, facts)
  const frozen = (
    await tx
      .select()
      .from(nativeUsageRootSets)
      .where(eq(nativeUsageRootSets.invocationId, binding.invocationId))
      .limit(1)
  )[0]
  if (!frozen || source.nextOrdinal !== frozen.nextOrdinal || source.digest !== frozen.rootDigest)
    throw new Error('Native root completion lost its original frozen source population')
  const emitted = await verifyNativeUsageEmissions(tx, binding)
  const frozenProcess = await verifyNativeUsageEmissions(tx, binding, frozen.processWatermark)
  const issues = new Set<string>()
  if (source.firstRoot === null) issues.add('native-root-source-unavailable')
  if (
    source.initialMode !== beforeSpawn.mode ||
    (beforeSpawn.mode === 'resume' && source.firstRoot !== beforeSpawn.rootSessionId)
  )
    issues.add('native-root-before-binding-incomplete')
  if (sourceGeneration === null) issues.add('native-root-generation-unavailable')
  if (emitted.hasProcessIssues) issues.add('native-process-incomplete')
  if (frozenProcess.hasProcessIssues || !isDeepStrictEqual(frozenProcess.process, emitted.process))
    issues.add('native-root-process-incomplete-at-freeze')
  let count = 0n,
    records = 0n,
    examined = 0n,
    resolved = 0n,
    unresolved = 0n
  let resultDigest = sha256Hex(JSON.stringify(['native-root-results-v3', binding.invocationId]))
  let reconciliationDigest = sha256Hex(
    JSON.stringify(['native-root-reconciliation-v3', binding.invocationId]),
  )
  let after: string | null = null
  for (;;) {
    const roots = await originalNativeRootPage(tx, binding.invocationId, after)
    if (roots.length === 0) break
    for (const rootSessionId of roots) {
      const proof = await describeNativeUsageSingleRoot(tx, facts, binding, observedAt, {
        rootSessionId,
        beforeSpawn,
        sourceGeneration,
        emitted,
      })
      const numeric = await verifyNativeUsageNumericCoverage(tx, binding, proof)
      const document = JSON.stringify({
        contract: 'native-usage-root-result-v3',
        rootSessionId,
        proof,
        numeric,
      })
      if (retainOriginalResultId) {
        const existing = (
          await tx
            .select()
            .from(nativeUsageRootResults)
            .where(
              and(
                eq(nativeUsageRootResults.invocationId, binding.invocationId),
                eq(nativeUsageRootResults.resultId, retainOriginalResultId),
                eq(nativeUsageRootResults.rootSessionId, rootSessionId),
              ),
            )
            .limit(1)
        )[0]
        if (existing && existing.document !== document)
          throw new Error('Original native root result changed on replay')
        if (!existing)
          await tx.insert(nativeUsageRootResults).values({
            invocationId: binding.invocationId,
            resultId: retainOriginalResultId,
            rootSessionId,
            document,
          })
      }
      count++
      records += BigInt(numeric.records)
      examined += BigInt(proof.reconciliation.examined)
      resolved += BigInt(proof.reconciliation.resolved)
      unresolved += BigInt(proof.reconciliation.unresolved)
      for (const issue of proof.issues) issues.add(issue)
      resultDigest = sha256Hex(JSON.stringify([resultDigest, document]))
      reconciliationDigest = sha256Hex(
        JSON.stringify([reconciliationDigest, rootSessionId, proof.reconciliation]),
      )
    }
    const next = roots.at(-1)!
    if (next === after)
      throw new Error('Native root completion did not reach distinct original EOF')
    after = next
  }
  const resultId = sha256Hex(
    JSON.stringify([
      'native-root-results-v3',
      binding.invocationId,
      observedAt,
      sourceGeneration,
      source.nextOrdinal,
      source.digest,
      emitted.emissions,
      resultDigest,
    ]),
  )
  return {
    records: String(records),
    proof: ObservationNativeRootCompletionSchema.parse({
      contract: 'opencode-child-root-pages-v3',
      nativeSource: facts.nativeSource,
      rootSessionId: source.firstRoot,
      beforeSpawn,
      sourceGeneration,
      roots: {
        transitions: source.nextOrdinal,
        count: String(count),
        sourceDigest: source.digest,
        resultDigest,
        resultId,
        frozenAt: frozen.observedAt,
        processWatermark: frozen.processWatermark,
      },
      observedAt,
      process: emitted.process,
      emissions: emitted.emissions,
      reconciliation: {
        examined: String(examined),
        resolved: String(resolved),
        unresolved: String(unresolved),
        digest: reconciliationDigest,
      },
      state: issues.size === 0 ? 'complete' : 'partial',
      issues: [...issues],
    }),
  }
}

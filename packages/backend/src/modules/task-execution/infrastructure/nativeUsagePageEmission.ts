import { and, eq, inArray } from 'drizzle-orm'
import {
  AcceptedObservationInvocationSchema,
  ObservationNativePassAckSchema,
  ObservationNativePassIdentitySchema,
  type ObservationNativeBeforeSpawnAck,
  type ObservationNativePassPage,
  type ObservationNativeMeasurement,
} from '@agent-workflow/shared'
import {
  nativeUsagePassHeads,
  nativeUsagePasses,
  nativeUsageStepMembers,
  observationInvocations,
  nativeUsageRootSets,
} from '@/db/schema'
import { sha256Hex } from '@/util/hash'
import { chunkedAll } from '@/util/sqlChunk'
import type { NativeUsageOwnerBinding } from '../application/ports/nativeUsagePersistence'
import type { TaskExecutionTransaction } from './ownedTaskExecution'
import type { NativeUsageOwnerFacts } from './nativeUsageOwnerTransaction'
import { emitNativeUsageEvidence } from './drizzleNativeUsageEmission'
import { verifyNativeUsagePass } from './nativeUsagePassVerification'
import type { NativeUsageBaselineReadView } from '../application/ports/nativeUsageBaseline'
import { verifyNativeUsageEmissions } from './nativeUsageEmissionVerification'

/** Emit only this invocation's new original steps, in the page owner's same transaction. */
export async function emitNativeUsagePage(
  tx: TaskExecutionTransaction,
  facts: NativeUsageOwnerFacts,
  binding: NativeUsageOwnerBinding,
  page: ObservationNativePassPage,
  before: ObservationNativeBeforeSpawnAck,
  ownerReceiptId: string,
  originalBeforeIndex?: NativeUsageBaselineReadView | null,
): Promise<void> {
  if (page.identity.phase !== 'final' || page.steps.length === 0) return
  if (
    facts.contract === 'opencode-child-root-pages-v3' &&
    !(before.mode === 'resume' && page.identity.rootSessionId === before.rootSessionId)
  ) {
    const frozen = (
      await tx
        .select()
        .from(nativeUsageRootSets)
        .where(eq(nativeUsageRootSets.invocationId, binding.invocationId))
        .limit(1)
    )[0]
    const pass = (
      await tx
        .select({ birth: nativeUsagePasses.rootCreatedAt })
        .from(nativeUsagePasses)
        .where(eq(nativeUsagePasses.passId, page.identity.passId))
        .limit(1)
    )[0]
    if (!frozen || !pass) throw new Error('Native numeric root lost its original final admission')
    const process = (await verifyNativeUsageEmissions(tx, binding, frozen.processWatermark)).process
    // Without an actual birth after spawn, these may be another invocation's old steps.
    // Retain the original pages, but never assign those old numbers to this invocation.
    if (process.spawnedAt === null || pass.birth === null || pass.birth < process.spawnedAt) return
  }
  let prior = new Set<string>()
  if (
    before.mode === 'resume' &&
    (facts.contract !== 'opencode-child-root-pages-v3' ||
      page.identity.rootSessionId === before.rootSessionId)
  ) {
    if (originalBeforeIndex === null) return
    if (originalBeforeIndex) {
      const original = originalBeforeIndex.original.ack.identity
      if (
        original.invocationId !== binding.invocationId ||
        original.nativeSource !== before.nativeSource ||
        original.sourceGeneration !== before.sourceGeneration ||
        original.rootSessionId !== before.rootSessionId ||
        original.lineage !== before.lineage ||
        original.epoch !== before.epoch ||
        original.phase !== 'baseline'
      )
        throw new Error('Original native before index changed its accepted invocation')
      prior = new Set(await originalBeforeIndex.members(page.steps.map((step) => step.stepId)))
    } else {
      const key = JSON.stringify([
        page.identity.invocationId,
        page.identity.nativeSource,
        page.identity.sourceGeneration,
        page.identity.rootSessionId,
        page.identity.lineage,
        page.identity.epoch,
        'baseline',
      ])
      const head = (
        await tx
          .select()
          .from(nativeUsagePassHeads)
          .where(eq(nativeUsagePassHeads.key, key))
          .limit(1)
      )[0]
      const baseline =
        head &&
        (
          await tx
            .select()
            .from(nativeUsagePasses)
            .where(eq(nativeUsagePasses.passId, head.passId))
            .limit(1)
        )[0]
      // An absent before scan cannot turn pre-existing steps into this invocation's numbers.
      if (!baseline || baseline.state !== 'eof' || baseline.lastAck === null) return
      const identity = ObservationNativePassIdentitySchema.parse(JSON.parse(baseline.identity))
      const ack = ObservationNativePassAckSchema.parse(JSON.parse(baseline.lastAck))
      if (identity.phase !== 'baseline' || ack.eof === null || ack.nextCursor !== null)
        throw new Error('Original native numeric page changed its baseline EOF')
      const verified = await verifyNativeUsagePass(
        tx,
        binding,
        { ack, pageCount: baseline.nextOrdinal },
        true,
      )
      if (verified.hasPopulationIssues) return
      prior = new Set(
        (
          await chunkedAll(
            page.steps.map((step) => step.stepId),
            (ids) =>
              tx
                .select({ stepId: nativeUsageStepMembers.stepId })
                .from(nativeUsageStepMembers)
                .where(
                  and(
                    eq(nativeUsageStepMembers.passId, baseline.passId),
                    inArray(nativeUsageStepMembers.stepId, ids),
                  ),
                ),
          )
        ).map((member) => member.stepId),
      )
    }
  }
  const row = (
    await tx
      .select({ document: observationInvocations.document })
      .from(observationInvocations)
      .where(eq(observationInvocations.id, binding.invocationId))
      .limit(1)
  )[0]
  if (!row) throw new Error('Original native numeric page has no accepted invocation')
  const accepted = AcceptedObservationInvocationSchema.parse(JSON.parse(row.document))
  const observedAt = Date.now()
  const measurements: ObservationNativeMeasurement[] = page.steps
    .filter((step) => !prior.has(step.stepId))
    .map((step) => ({
      schemaVersion: 1,
      invocationId: binding.invocationId,
      recordId: 'opencode:step:' + step.stepId,
      revision: 1,
      taskId: binding.taskId,
      nodeRunId: binding.nodeRunId,
      agentId: accepted.agentId,
      occurredAt: step.occurredAt,
      observedAt,
      model: step.model,
      adapterVersion: 'opencode-native-child-pages/v2',
      reporting: 'delta',
      inclusion: 'self',
      coverage: Object.values(step.usage).every((value) => value !== null) ? 'complete' : 'partial',
      validity: 'valid',
      basis: { kind: 'invocation' },
      usage: step.usage,
      scope: {
        root: page.identity.rootSessionId,
        session: step.id,
        parentSession: step.parentSessionId,
        ancestry: {
          kind: 'native-pass-v2',
          identity: page.identity,
          ownerReceiptId,
          pageOrdinal: page.ordinal,
          cumulativeDigest: page.cumulativeDigest,
        },
        turn: binding.invocationId,
        turnIndex: 0,
        level: 'request',
      },
    }))
  for (let start = 0; start < measurements.length; start += 500)
    await emitNativeUsageEvidence(tx, facts, {
      binding,
      eventId:
        'native-page:' +
        sha256Hex(JSON.stringify([page.identity.passId, page.ordinal, page.payloadDigest, start])),
      evidence: {
        invocationId: binding.invocationId,
        measurements: measurements.slice(start, start + 500),
        diagnostics: [],
      },
    })
}

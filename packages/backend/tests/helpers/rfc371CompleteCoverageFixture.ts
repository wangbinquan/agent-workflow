import { eq } from 'drizzle-orm'
import { AcceptedObservationInvocationSchema } from '@agent-workflow/shared'
import nativeFixture from '../../../shared/tests/fixtures/crewstation-native-capture-v2.json'
import {
  observationInvocations,
  observationUsageCaptures,
  observationUsageCurrent,
} from '@/db/schema'
import { PlatformObservationPageSchema } from '@/modules/run-observability/domain/platformObservation'
import { createPlatformObservationStore } from '@/modules/run-observability/infrastructure/platformObservationPersistence'
import { sha256Hex } from '@/util/hash'
import type { ProviderHarness } from './eachProvider'
import {
  COMPLETE_NOW,
  completeFixtureId,
  completeTaskRecord,
  seedCompleteTask,
} from './rfc371CompleteTaskFixture'

export async function seedCompleteCoveredUsage(
  harness: ProviderHarness,
  authority: 'local' | 'platform',
  partial: boolean,
) {
  await seedCompleteTask(harness, 1, 2)
  const parent = { ...completeTaskRecord(0, 1) },
    child = { ...completeTaskRecord(1, 1) }
  const root = nativeFixture.capture.proof.root,
    turn = nativeFixture.capture.proof.turn
  parent.measurement = {
    ...parent.measurement,
    inclusion: 'includes-descendants',
    scope: {
      root,
      session: root,
      parentSession: null,
      ancestors: [],
      turn,
      turnIndex: 0,
      level: 'tree-total',
    },
    coveredThroughTurn: 0,
  }
  child.measurement = {
    ...child.measurement,
    scope: {
      root,
      session: 'child',
      parentSession: root,
      ancestors: [root],
      turn,
      turnIndex: 0,
      level: 'request',
    },
  }
  parent.contribution = {
    input: '100',
    cacheRead: partial ? null : '300',
    cacheWrite: partial ? null : '500',
    output: partial ? null : '700',
  }
  parent.measurement = { ...parent.measurement, usage: parent.contribution }
  parent.complete = !partial
  parent.issues = partial ? ['baseline-unknown'] : []
  child.contribution = {
    input: partial ? '10' : null,
    cacheRead: '6',
    cacheWrite: '10',
    output: '14',
  }
  child.measurement = { ...child.measurement, usage: child.contribution }
  child.complete = partial
  child.issues = partial ? [] : ['baseline-unknown']
  const records = [parent, child]
  if (authority === 'local') {
    for (const row of records)
      await harness.db
        .update(observationUsageCurrent)
        .set({ document: JSON.stringify(row) })
        .where(
          eq(
            observationUsageCurrent.id,
            sha256Hex(
              JSON.stringify([
                row.sourceId,
                row.measurement.invocationId,
                row.measurement.recordId,
              ]),
            ),
          ),
        )
        .run()
    return
  }
  await harness.db.delete(observationUsageCurrent).run()
  await harness.db.delete(observationUsageCaptures).run()
  const acceptedRow = await harness.db.select().from(observationInvocations).get()
  const previous = AcceptedObservationInvocationSchema.parse(JSON.parse(acceptedRow!.document))
  const { projectId, taskId, subtaskId, executionId, executionGeneration } = nativeFixture.identity
  const accepted = AcceptedObservationInvocationSchema.parse({
    ...previous,
    authority: {
      kind: 'crewstation',
      sourceId: 'cs-installation',
      projectId,
      taskId,
      subtaskId,
      executionResourceId: executionId,
      executionGeneration,
    },
    priceBookRevision: null,
  })
  await harness.db
    .update(observationInvocations)
    .set({
      document: JSON.stringify(accepted),
      canonicalExecution: sha256Hex(
        JSON.stringify([
          'crewstation',
          'cs-installation',
          projectId,
          executionId,
          executionGeneration,
        ]),
      ),
    })
    .where(eq(observationInvocations.id, completeFixtureId('invocation', 0)))
    .run()
  const observedAt = new Date(COMPLETE_NOW).toISOString()
  const usage = records.map((row) => ({
    kind: 'usage',
    identity: nativeFixture.identity,
    sourceId: 'runner',
    recordId: row.measurement.recordId,
    revision: 1,
    occurredAt: observedAt,
    observedAt,
    adapterVersion: 'original-fixture',
    modelRef: 'actual-platform-model',
    reporting: 'delta',
    inclusion: row.measurement.inclusion,
    coverage: 'complete',
    validity: 'valid',
    scope: row.measurement.scope,
    coveredThroughTurn: row.measurement.coveredThroughTurn ?? null,
    usage: row.measurement.usage,
    basis: { kind: 'invocation' },
    projection: {
      projectionRevision: 1,
      observedRevision: 1,
      contribution: row.contribution,
      coveredThrough: {
        input: row.contribution.input === null ? null : 0,
        cacheRead: row.contribution.cacheRead === null ? null : 0,
        cacheWrite: row.contribution.cacheWrite === null ? null : 0,
        output: row.contribution.output === null ? null : 0,
      },
      complete: row.complete,
      issues: row.issues,
    },
  }))
  const value = {
    kind: 'valuation',
    valuationId: 'original-platform-valuation',
    identity: nativeFixture.identity,
    sourceId: 'runner',
    recordId: parent.measurement.recordId,
    revision: 1,
    occurredAt: observedAt,
    observedAt,
    usageRevision: 1,
    valuationRevision: 1,
    currency: 'CNY',
    availability: 'priced',
    priceVersionRef: 'original-platform-price',
    amountDecimal: '0.005',
    completeness: partial ? 'partial' : 'complete',
  }
  const capture = {
    ...nativeFixture,
    observedAt,
    capture: {
      ...nativeFixture.capture,
      proof: { ...nativeFixture.capture.proof, observedAt, steps: 2, emitted: 2 },
      receivedSteps: 2,
    },
  }
  const page = PlatformObservationPageSchema.parse({
    schemaVersion: 2,
    capability: 'executionObservationsV2',
    mode: 'incremental',
    projectId,
    taskId,
    items: [...usage, value, capture],
    nextCursor: null,
    persistedThrough: 'original-through',
    firstAvailableCursor: 'original-first',
    asOf: observedAt,
    visibilityRevision: 1,
    costVisibility: 'project-members-and-services',
    gaps: [],
  })
  const binding = { sourceId: 'cs-installation', projectId, taskId },
    store = createPlatformObservationStore(harness.db)
  await store.change(binding, async (tx) => {
    for (const item of page.items) await tx.put('original-platform-generation', item)
    await tx.save({
      ...tx.state,
      revision: tx.state.revision + 1,
      cursor: 'original-through',
      generation: 'original-platform-generation',
      schemaVersion: 2,
      visibilityRevision: 1,
      costVisibility: 'project-members-and-services',
      costsReady: true,
      status: 'ready',
      checkedAt: COMPLETE_NOW,
      asOf: observedAt,
    })
  })
}

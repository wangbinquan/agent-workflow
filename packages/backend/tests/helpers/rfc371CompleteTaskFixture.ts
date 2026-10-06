import { sql } from 'drizzle-orm'
import {
  AcceptedObservationInvocationSchema,
  ObservationPriceVersionSchema,
} from '@agent-workflow/shared'
import { buildActor } from '@/auth/actor'
import {
  nodeRuns,
  observationInvocations,
  observationUsageCaptures,
  observationUsageCurrent,
  tasks,
  users,
} from '@/db/schema'
import { sha256Hex } from '@/util/hash'
import { originalReportSnapshotSession } from '@/platform/persistence/reportSnapshot'
import { buildCompleteObservationTask } from '@/modules/run-observability/application/completeObservationTask'
import { completeWorkingTraversal } from '@/modules/run-observability/application/completeWorkingTraversal'
import { createCompleteObservationSources } from '@/modules/run-observability/infrastructure/completeObservationSources'
import { completeObservationValuation } from '@/modules/run-observability/infrastructure/completeObservationValuation'
import { completeUsageWorkspace } from '@/modules/run-observability/infrastructure/completeUsageWorkspace'
import { createObservationPriceStore } from '@/modules/run-observability/infrastructure/pricingPersistence'
import { createTaskObservationFacts } from '@/modules/task-execution/composition/taskObservationFacts'
import type {
  CompleteObservationAllocation,
  CompleteObservationAttempt,
} from '@agent-workflow/shared'
import type { UsageLedgerRecord } from '@/modules/run-observability/domain/usageLedger'
import type { ProviderHarness } from './eachProvider'

export const COMPLETE_NOW = Date.parse('2026-10-03T00:00:00Z')
export const completeFixtureId = (prefix: string, n: number) =>
  `${prefix}-${String(n).padStart(6, '0')}`
const user = {
  id: 'complete-task-reader',
  username: 'complete-task-reader',
  displayName: 'Complete reader',
  role: 'admin' as const,
  status: 'active' as const,
}
const actor = buildActor({ user, source: 'session' })
export const completeTaskRecord = (n: number, attempts: number): UsageLedgerRecord => {
  const run = n % attempts
  const contribution = {
    input: String(n + 1),
    cacheRead: String((n + 1) * 3),
    cacheWrite: String((n + 1) * 5),
    output: String((n + 1) * 7),
  }
  return {
    sourceId: 'complete-native-source',
    measurement: {
      schemaVersion: 1,
      taskId: 'complete-original-task',
      invocationId: completeFixtureId('invocation', run),
      nodeRunId: completeFixtureId('run', run),
      agentId: 'original-agent',
      recordId: completeFixtureId('meter', n),
      revision: 1,
      occurredAt: COMPLETE_NOW + n,
      observedAt: COMPLETE_NOW + n,
      model: { provider: 'native', id: 'actual' },
      adapterVersion: 'original-fixture',
      reporting: 'delta',
      inclusion: 'self',
      coverage: 'complete',
      validity: 'valid',
      basis: { kind: 'invocation' },
      usage: contribution,
    },
    observedRevision: 1,
    contribution,
    complete: true,
    issues: [],
  }
}

export async function seedCompleteTask(
  harness: Pick<ProviderHarness, 'db'>,
  attempts = 1001,
  records = 10001,
  transform?: (record: UsageLedgerRecord) => UsageLedgerRecord,
) {
  await harness.db
    .insert(users)
    .values({
      ...user,
      passwordHash: 'fixture',
      forcePasswordChange: false,
      createdAt: COMPLETE_NOW,
      updatedAt: COMPLETE_NOW,
    })
    .run()
  await harness.db
    .insert(tasks)
    .values({
      id: 'complete-original-task',
      name: 'Original complete task',
      workflowId: 'workflow',
      workflowSnapshot: JSON.stringify({
        nodes: Array.from({ length: attempts }, (_, n) => ({
          id: completeFixtureId('node', n),
          kind: 'agent-single',
        })),
      }),
      inputs: '{}',
      repoPath: '/original',
      worktreePath: '/original',
      baseBranch: 'main',
      branch: 'task/original',
      branchStartedAt: COMPLETE_NOW,
      startedAt: COMPLETE_NOW,
      finishedAt: COMPLETE_NOW + records + 1,
      runningMs: records + 1,
      runningSince: null,
      status: 'done',
      rootTaskId: 'complete-original-task',
      ownerUserId: user.id,
    })
    .run()
  const prices = createObservationPriceStore(harness.db)
  await prices.change('complete-runtime', async (scope) => {
    await scope.append(
      ObservationPriceVersionSchema.parse({
        id: 'original-price',
        registrationId: 'complete-runtime',
        revision: 1,
        configurationRevision: 0,
        protocol: 'opencode',
        provider: 'native',
        model: 'actual',
        condition: null,
        currency: 'CNY',
        rates: { input: '1', cacheRead: '2', cacheWrite: '3', output: '4' },
        effectiveFrom: new Date(COMPLETE_NOW - 1).toISOString(),
        sourceNote: 'Acceptance validation only, not a supplier invoice',
        createdAt: new Date(COMPLETE_NOW - 1).toISOString(),
        createdBy: user.id,
      }),
      'original-price-request',
      'original-price-fingerprint',
    )
  })
  for (let start = 0; start < attempts; start += 50) {
    const numbers = Array.from({ length: Math.min(50, attempts - start) }, (_, i) => start + i)
    await harness.db
      .insert(nodeRuns)
      .values(
        numbers.map((n) => ({
          id: completeFixtureId('run', n),
          taskId: 'complete-original-task',
          nodeId: completeFixtureId('node', n),
          status: 'done' as const,
          startedAt: COMPLETE_NOW + n,
          finishedAt: COMPLETE_NOW + n + 10,
        })),
      )
      .run()
    await harness.db
      .insert(observationInvocations)
      .values(
        numbers.map((n) => {
          const document = AcceptedObservationInvocationSchema.parse({
            invocationId: completeFixtureId('invocation', n),
            taskId: 'complete-original-task',
            nodeRunId: completeFixtureId('run', n),
            agentId: 'original-agent',
            agentRevision: 1,
            purpose: 'task',
            nativeCaptureContract: 'opencode-child-steps-v1',
            nativeCaptureSource: 'complete-native',
            authority: {
              kind: 'local',
              runtime: {
                registrationId: 'complete-runtime',
                acceptedName: 'Validation runtime',
                configurationRevision: 0,
                protocol: 'opencode',
              },
            },
            acceptedAt: COMPLETE_NOW,
            priceBookRevision: 1,
          })
          return {
            id: document.invocationId,
            taskId: document.taskId,
            canonicalExecution: sha256Hex(JSON.stringify(['local', document.invocationId])),
            fingerprint: JSON.stringify(document),
            document: JSON.stringify(document),
          }
        }),
      )
      .run()
    await harness.db
      .insert(observationUsageCaptures)
      .values(
        numbers.map((n) => {
          const evidence = {
            invocationId: completeFixtureId('invocation', n),
            taskId: 'complete-original-task',
            capture: {
              contract: 'opencode-child-steps-v1',
              nativeSource: 'complete-native',
              rootSessionId: completeFixtureId('root', n),
              state: 'complete',
              baseline: { kind: 'fresh', fingerprint: null },
              snapshotFingerprint: 'original-proof',
              observedAt: COMPLETE_NOW + records,
              scannedSessions: 1,
              scannedSteps: n < records ? Math.floor((records - 1 - n) / attempts) + 1 : 0,
              issues: [],
              priorRevisions: [],
              baselineSteps: [],
            },
          }
          return {
            invocationId: evidence.invocationId,
            taskId: evidence.taskId,
            sourceId: 'complete-native-source',
            sourceCursor: completeFixtureId('cursor', n),
            nativeRootKey: null,
            priorRevisionGap: 0,
            repairPending: 0,
            document: JSON.stringify({ evidence, resolutions: [] }),
            summary: JSON.stringify({ evidence, resolutions: [] }),
          }
        }),
      )
      .run()
  }
  for (let start = 0; start < records; start += 50)
    await harness.db
      .insert(observationUsageCurrent)
      .values(
        Array.from({ length: Math.min(50, records - start) }, (_, i) => {
          const original = completeTaskRecord(start + i, attempts)
          const row = transform ? transform(original) : original
          return {
            id: sha256Hex(
              JSON.stringify([
                row.sourceId,
                row.measurement.invocationId,
                row.measurement.recordId,
              ]),
            ),
            taskId: row.measurement.taskId,
            sourceId: row.sourceId,
            document: JSON.stringify(row),
          }
        }),
      )
      .run()
}

export async function buildOriginalCompleteTask(harness: ProviderHarness, records = 10001) {
  const binding = harness.applicationBinding
  const session = originalReportSnapshotSession(
    binding.provider === 'sqlite'
      ? { ...binding, generationId: 'complete-task-original-generation' }
      : { provider: 'postgresql', runtime: binding.runtime },
  )
  return session.run(async ({ executor, workspace, snapshotId }) => {
    const owner = createTaskObservationFacts(executor),
      task = await owner.get(actor, 'complete-original-task')
    if (!task) throw new Error('Original fixture task missing')
    const value = completeObservationValuation({
      db: executor,
      rows: workspace,
      namespace: 'original-value',
    })
    const result = await buildCompleteObservationTask({
      task,
      sources: createCompleteObservationSources({
        db: executor,
        tasks: owner,
        snapshotId,
        pageSize: 61,
      }),
      asOf: COMPLETE_NOW + records + 1,
      rows: workspace,
      namespace: 'original-task',
      keyOf: sha256Hex,
      usageWorkspace: completeUsageWorkspace,
      value: value.value,
    })
    await value.flush()
    const attempts: CompleteObservationAttempt[] = [],
      allocations: CompleteObservationAllocation[] = []
    for await (const row of completeWorkingTraversal<CompleteObservationAttempt>(
      workspace,
      result.attemptsNamespace,
    ))
      attempts.push(row.document)
    for await (const row of completeWorkingTraversal<CompleteObservationAllocation>(
      workspace,
      result.allocationsNamespace,
    ))
      allocations.push(row.document)
    const originals = await executor.all<{ records: number | string }>(
      sql`SELECT count(*) AS records FROM observation_usage_current WHERE task_id='complete-original-task'`,
    )
    return { ...result, attempts, allocations, originals }
  })
}

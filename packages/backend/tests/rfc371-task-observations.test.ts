// RFC-371: task/agent/attempt totals share one snapshot and one frozen execution authority.
import { expect, test } from 'bun:test'
import { Hono, type MiddlewareHandler } from 'hono'
import type {
  AcceptObservationInvocation,
  ObservationMeasurement,
  ObservationOverview,
  ObservationTaskPage,
  ObservationTaskPageQuery,
} from '@agent-workflow/shared'
import { buildActor } from '../src/auth/actor'
import {
  nodeRuns,
  observationInvocations,
  taskCollaborators,
  taskRepos,
  taskExecutionObservationSources,
  tasks,
  users,
} from '../src/db/schema'
import { composeTaskObservations } from '../src/modules/run-observability/composition/taskObservations'
import { createTaskObservationFacts } from '../src/modules/task-execution/composition/taskObservationFacts'
import { createObservationPricing } from '../src/modules/run-observability/application/pricing'
import { createObservationPriceStore } from '../src/modules/run-observability/infrastructure/pricingPersistence'
import { createObservationInvocationStore } from '../src/modules/run-observability/infrastructure/invocationPersistence'
import { createUsageLedgerStore } from '../src/modules/run-observability/infrastructure/usageLedgerPersistence'
import { createUsageIngestion } from '../src/modules/run-observability/application/usageIngestion'
import { createPlatformObservationSync } from '../src/modules/run-observability/application/platformObservationSync'
import { createPlatformObservationStore } from '../src/modules/run-observability/infrastructure/platformObservationPersistence'
import {
  PlatformObservationPageSchema,
  PlatformObservationSourceError,
  type PlatformObservation,
  type PlatformObservationPage,
} from '../src/modules/run-observability/domain/platformObservation'
import { mountObservationRoutes } from '../src/modules/run-observability/composition/observationRoutes'
import { errorHandler } from '../src/util/errors'
import { describeEachProvider } from './helpers/eachProvider'
import nativeCapture from '../../shared/tests/fixtures/crewstation-native-capture-v2.json'

const NOW = Date.parse('2026-09-28T00:00:00.000Z')
const admin = buildActor({
  user: {
    id: 'reader',
    username: 'reader',
    displayName: 'Reader',
    role: 'admin',
    status: 'active',
  },
  source: 'session',
})
const query: ObservationTaskPageQuery = {
  from: NOW,
  to: NOW + 20_000,
  timezone: 'Asia/Shanghai',
  limit: 20,
}
const buckets = (input: string | null, output = '0') => ({
  input,
  output,
  cacheRead: '0',
  cacheWrite: '0',
})
const binding = {
  sourceId: 'cs-installation',
  projectId: '01a0bf5d-8f4b-7793-867c-efd7527b3861',
  taskId: '01a0bf5d-8f4b-7793-867c-efd7527b3862',
}
const identity = {
  projectId: binding.projectId,
  taskId: binding.taskId,
  subtaskId: '01a0bf5d-8f4b-7793-867c-efd7527b3863',
  executionId: '01a0bf5d-8f4b-7793-867c-efd7527b3864',
  executionGeneration: 1,
}
const platformAuthority: AcceptObservationInvocation['authority'] = {
  kind: 'crewstation',
  ...binding,
  subtaskId: identity.subtaskId,
  executionResourceId: identity.executionId,
  executionGeneration: 1,
}
const csUsage = (
  patch: Partial<Extract<PlatformObservation, { kind: 'usage' }>> = {},
): Extract<PlatformObservation, { kind: 'usage' }> => ({
  kind: 'usage',
  identity,
  sourceId: 'runner',
  recordId: 'meter',
  revision: 1,
  occurredAt: null,
  observedAt: new Date(NOW).toISOString(),
  adapterVersion: 'test/1',
  modelRef: 'opaque-model-ref',
  reporting: 'cumulative',
  inclusion: 'self',
  coverage: 'complete',
  validity: 'valid',
  scope: null,
  coveredThroughTurn: null,
  usage: buckets('130'),
  basis: { kind: 'native-session', lineageKey: 'native', baseline: buckets('100') },
  projection: {
    projectionRevision: 1,
    observedRevision: 1,
    contribution: buckets('30'),
    coveredThrough: null,
    complete: true,
    issues: [],
  },
  ...patch,
})
const csValue = (): Extract<
  PlatformObservation,
  { kind: 'valuation'; availability: 'priced' }
> => ({
  kind: 'valuation',
  identity,
  sourceId: 'runner',
  recordId: 'meter',
  revision: 1,
  occurredAt: null,
  observedAt: new Date(NOW).toISOString(),
  valuationId: 'value',
  valuationRevision: 1,
  usageRevision: 1,
  currency: 'CNY',
  availability: 'priced',
  amountDecimal: '7.25',
  completeness: 'complete',
  priceVersionRef: 'cs-price-7',
})

describeEachProvider('RFC-371 mounted task observation snapshot', (harness) => {
  async function fixture() {
    for (const id of ['reader', 'other'])
      await harness.db
        .insert(users)
        .values({
          id,
          username: id,
          displayName: id,
          role: 'admin',
          status: 'active',
          passwordHash: 'fixture',
          createdAt: NOW,
          updatedAt: NOW,
        })
        .run()
    const invocations = createObservationInvocationStore(harness.db, () => NOW + 2000)
    const ledger = createUsageLedgerStore(harness.db),
      platform = createPlatformObservationStore(harness.db)
    const prices = createObservationPriceStore(harness.db)
    let serial = 0,
      syncSerial = 0
    const pricing = createObservationPricing({
      store: prices,
      now: () => NOW,
      newId: () => 'price-' + ++serial,
      runtimes: {
        directory: async () => ({
          runtimes: [
            {
              registrationId: 'runtime',
              configurationRevision: 0,
              name: 'runtime',
              protocol: 'opencode',
              model: 'model',
              enabled: true,
            },
          ],
        }),
      },
    })
    const queries = composeTaskObservations({
      db: harness.db,
      taskSource: createTaskObservationFacts,
      now: () => NOW + 10_000,
    })
    return {
      queries,
      invocations,
      pricing,
      async task(id = 'task', patch: Partial<typeof tasks.$inferInsert> = {}) {
        await harness.db
          .insert(tasks)
          .values({
            id,
            name: id,
            workflowId: 'workflow',
            workflowSnapshot: '{}',
            inputs: '{}',
            repoPath: '/fixture',
            worktreePath: '/fixture',
            baseBranch: 'main',
            branch: 'task/' + id,
            branchStartedAt: NOW,
            startedAt: NOW,
            status: 'running',
            rootTaskId: id,
            ownerUserId: 'reader',
            runningMs: 2000,
            runningSince: NOW + 7000,
            ...patch,
          })
          .run()
      },
      async attempt(
        id: string,
        start: number,
        end: number | null,
        patch: Partial<typeof nodeRuns.$inferInsert> = {},
      ) {
        await harness.db
          .insert(nodeRuns)
          .values({
            id,
            taskId: 'task',
            nodeId: 'node-' + id,
            status: end === null ? 'running' : 'done',
            startedAt: NOW + start,
            finishedAt: end === null ? null : NOW + end,
            ...patch,
          })
          .run()
      },
      async accept(id: string, patch: Partial<AcceptObservationInvocation> = {}) {
        return invocations.accept({
          invocationId: id,
          taskId: 'task',
          nodeRunId: 'run-' + id,
          agentId: 'agent-' + id,
          agentRevision: 2,
          purpose: 'task',
          nativeCaptureContract: 'opencode-child-steps-v1',
          authority: {
            kind: 'local',
            runtime: { registrationId: 'runtime', configurationRevision: 0, protocol: 'opencode' },
          },
          ...patch,
        })
      },
      async usage(
        id: string,
        counts = buckets('1000000'),
        patch: Partial<ObservationMeasurement> = {},
        capture = true,
      ) {
        const accepted = await invocations.get(id)
        const measurement: ObservationMeasurement = {
          schemaVersion: 1,
          invocationId: id,
          taskId: 'task',
          nodeRunId: accepted!.nodeRunId,
          agentId: accepted!.agentId,
          recordId: 'meter',
          revision: 1,
          occurredAt: NOW + 4000,
          observedAt: NOW + 4000,
          model: { provider: 'gateway', id: 'model' },
          adapterVersion: 'test/1',
          reporting: 'delta',
          inclusion: 'self',
          coverage: 'complete',
          validity: 'valid',
          basis: { kind: 'invocation' },
          usage: counts,
          ...patch,
        }
        await createUsageIngestion(ledger).ingest({
          sourceId: id,
          expectedCursor: await ledger.cursor(id),
          nextCursor: String(measurement.revision),
          events: [{ eventId: 'event-' + measurement.revision, measurement }],
          ...(capture && accepted!.nativeCaptureContract
            ? {
                capture: {
                  invocationId: id,
                  taskId: accepted!.taskId,
                  capture: {
                    contract: 'opencode-child-steps-v1' as const,
                    nativeSource: 'fixture-db-' + id,
                    rootSessionId: 'root-' + id,
                    state: 'complete' as const,
                    baseline: { kind: 'fresh' as const, fingerprint: null },
                    snapshotFingerprint: 'fixture-scan',
                    observedAt: NOW + 4000,
                    scannedSessions: 1,
                    scannedSteps: 1,
                    issues: [],
                    priorRevisions: [],
                  },
                },
              }
            : {}),
        })
      },
      async price(rate = '1', expectedRevision = 0) {
        return pricing.commands.save(
          'runtime',
          {
            expectedRevision,
            requestKey: 'price-request-' + expectedRevision,
            configurationRevision: 0,
            protocol: 'opencode',
            provider: 'gateway',
            model: 'model',
            condition: null,
            currency: 'CNY',
            rates: { input: rate, output: '2', cacheRead: '0', cacheWrite: '0' },
            // Both versions are effective before acceptance; the frozen catalogue
            // must still exclude the subsequently published version.
            effectiveFrom: new Date(NOW + 1000 + expectedRevision).toISOString(),
            sourceNote: 'CNY fixture',
          },
          'reader',
        )
      },
      async sync(
        items: PlatformObservation[],
        patch: Partial<
          Pick<PlatformObservationPage, 'costVisibility' | 'visibilityRevision' | 'schemaVersion'>
        > = {},
        selectedBinding = binding,
      ) {
        const response = PlatformObservationPageSchema.parse({
          schemaVersion: patch.schemaVersion ?? 1,
          capability:
            patch.schemaVersion === 2 ? 'executionObservationsV2' : 'executionObservationsV1',
          projectId: selectedBinding.projectId,
          taskId: selectedBinding.taskId,
          mode: 'snapshot',
          items,
          nextCursor: null,
          persistedThrough: 'through-' + ++syncSerial,
          firstAvailableCursor: 'first',
          asOf: new Date(NOW + 5000).toISOString(),
          visibilityRevision: 0,
          costVisibility: 'project-members-and-services',
          gaps: [],
          snapshotId: 'snapshot-' + syncSerial,
          snapshotThrough: 'through-' + syncSerial,
          expiresAt: new Date(NOW + 600_000).toISOString(),
          ...patch,
        })
        const sync = createPlatformObservationSync({
          store: platform,
          now: () => NOW + 6000,
          source: {
            read: async (request) => {
              if (request.mode === 'snapshot') return response
              return PlatformObservationPageSchema.parse({
                schemaVersion: response.schemaVersion,
                capability: response.capability,
                projectId: response.projectId,
                taskId: response.taskId,
                mode: 'incremental' as const,
                items: response.items,
                nextCursor: response.nextCursor,
                persistedThrough: response.persistedThrough,
                firstAvailableCursor: response.firstAvailableCursor,
                asOf: response.asOf,
                visibilityRevision: response.visibilityRevision,
                costVisibility: response.costVisibility,
                gaps: response.gaps,
              })
            },
          },
        })
        await sync(selectedBinding)
        if ((await platform.state(selectedBinding)).mode === 'snapshot') await sync(selectedBinding)
      },
      async offline(selectedBinding = binding) {
        const sync = createPlatformObservationSync({
          store: platform,
          now: () => NOW + 9000,
          source: {
            read: async () => {
              throw new PlatformObservationSourceError('unavailable', 'offline')
            },
          },
        })
        await sync(selectedBinding)
      },
    }
  }
  test('parallel agents, retry and frozen local rates give disjoint exact totals and distinct clocks', async () => {
    const f = await fixture()
    await f.task()
    await f.price()
    await f.attempt('run-a', 1000, 6000)
    await f.attempt('run-b', 3000, 8000, { retryIndex: 1, wgRound: 4, reviewIteration: 2 })
    await f.accept('a')
    await f.accept('b')
    await f.price('999', 1)
    await f.usage('a')
    await f.usage('b', buckets('0', '500000'))
    const result = (await f.queries.detail(admin, 'task'))!
    expect(result.metrics.tokens.totalKnown).toBe('1500000')
    expect(result.metrics.cost.knownAmount).toBe('2')
    expect(result.metrics.cost.priceVersionIds).toEqual(['price-1'])
    expect(result.agents.map((a) => a.metrics.tokens.totalKnown)).toEqual(['1000000', '500000'])
    expect(result.wallMs).toBe(10000)
    expect(result.runningMs).toBe(5000)
    expect(result.intervals).toEqual({
      cumulativeMs: 10000,
      activeUnionMs: 7000,
      knownAttempts: 2,
      unknownAttempts: 0,
      unlinkedInvocations: 0,
    })
    expect(result.attempts[1]!.attempt).toMatchObject({
      retryIndex: 1,
      wgRound: 4,
      reviewIteration: 2,
    })
    const page = await f.queries.list(admin, query)
    expect(page.items[0]!.metrics).toEqual(result.metrics)
    expect(page.asOf).toBe(result.asOf)
  })

  test('complete root counts stay partial until a required native child completion proof is projected', async () => {
    const f = await fixture()
    await f.task()
    await f.price()
    await f.accept('capture')
    await f.usage('capture', buckets('10'), {}, false)
    const pending = (await f.queries.detail(admin, 'task'))!
    expect(pending.metrics.tokens).toMatchObject({ totalKnown: '10', complete: false })
    expect(pending.metrics.cost.reasons).toContain('native-capture-pending')
    expect(pending.nativeCaptures).toMatchObject([
      { invocationId: 'capture', state: 'pending', proof: null },
    ])
    await f.usage('capture', buckets('10'), { revision: 2 })
    const complete = (await f.queries.detail(admin, 'task'))!
    expect(complete.metrics.tokens).toMatchObject({ totalKnown: '10', complete: true })
    expect(complete.nativeCaptures).toMatchObject([
      { state: 'complete', proof: { scannedSessions: 1 } },
    ])
  })

  test('historical root-only invocations do not claim native child completeness', async () => {
    const f = await fixture()
    await f.task()
    await f.accept('legacy', { nativeCaptureContract: undefined })
    await f.usage('legacy', buckets('10'))
    const value = (await f.queries.detail(admin, 'task'))!
    expect(value.metrics.tokens).toMatchObject({ totalKnown: '10', complete: false })
    expect(value.metrics.cost.reasons).toContain('native-capture-unobserved')
    expect(value.nativeCaptures).toMatchObject([{ state: 'unobserved', proof: null }])
  })
  test('native coverage depends on the accepted contract even when runtime metadata is absent', async () => {
    const f = await fixture()
    await f.task()
    await f.accept('legacy-unknown', {
      nativeCaptureContract: undefined,
      authority: { kind: 'local', runtime: null },
    })
    await f.usage('legacy-unknown', buckets('10'))
    const value = (await f.queries.detail(admin, 'task'))!
    expect(value.metrics.tokens).toMatchObject({ totalKnown: '10', complete: false })
    expect(value.nativeCaptures).toMatchObject([
      { invocationId: 'legacy-unknown', state: 'unobserved', proof: null },
    ])
  })
  test('task-owned failure reasons survive list, overview and detail snapshots without guessing an interruption cause', async () => {
    const f = await fixture()
    await f.task('failed', { status: 'failed', errorSummary: 'daemon-restart' })
    await f.task('interrupted', { status: 'interrupted', errorSummary: null })
    for (const rows of [
      (await f.queries.list(admin, query)).items,
      (await f.queries.overview(admin, query)).tasks,
    ]) {
      expect(rows.find((row) => row.task.id === 'failed')?.task).toMatchObject({
        status: 'failed',
        errorSummary: 'daemon-restart',
      })
      expect(rows.find((row) => row.task.id === 'interrupted')?.task).toMatchObject({
        status: 'interrupted',
        errorSummary: null,
      })
    }
    expect((await f.queries.detail(admin, 'failed'))?.task.errorSummary).toBe('daemon-restart')
  })
  test('task, state, workflow and secondary repository filters select one consistent cohort before aggregation', async () => {
    const f = await fixture()
    await f.task('task', {
      name: 'Alpha 100%_done',
      status: 'done',
      workflowId: 'selected-workflow',
    })
    await f.task('different-state', {
      name: 'Alpha 100%_done',
      status: 'running',
      workflowId: 'selected-workflow',
    })
    await f.task('different-workflow', {
      name: 'Alpha 100%_done',
      status: 'done',
      workflowId: 'other-workflow',
    })
    await f.task('wildcards-are-literal', {
      name: 'Alpha 100XXdone',
      status: 'done',
      workflowId: 'selected-workflow',
    })
    await f.price()
    await f.accept('filtered')
    await f.usage('filtered', buckets('1000000'))
    for (const taskId of [
      'task',
      'different-state',
      'different-workflow',
      'wildcards-are-literal',
    ]) {
      await harness.db
        .insert(taskRepos)
        .values(
          [0, 1].map((repoIndex) => ({
            taskId,
            repoIndex,
            repoPath: `/extra/${repoIndex}`,
            repoUrl: 'https://example.test/team/secondary.git',
            branch: 'main',
            worktreePath: `/work/${taskId}/${repoIndex}`,
          })),
        )
        .run()
    }
    const selection = {
      ...query,
      q: 'alpha 100%_',
      status: 'done' as const,
      workflow: 'selected-workflow',
      repository: 'https://example.test/team/secondary.git',
    }
    const page = await f.queries.list(admin, selection)
    expect(page.items.map((row) => row.task.id)).toEqual(['task'])
    const overview = await f.queries.overview(admin, selection)
    expect(overview.tasks.map((row) => row.task.id)).toEqual(['task'])
    expect(overview.metrics.tokens.totalKnown).toBe('1000000')
    expect(overview.metrics.cost.knownAmount).toBe('1')
    expect(overview.trend.reduce((sum, row) => sum + row.taskCount, 0)).toBe(1)
    expect(overview.agents[0]?.tasks.map((row) => row.taskId)).toEqual(['task'])
    expect(overview.filtersEcho).toMatchObject(selection)
    expect(
      (await f.queries.list(admin, { ...query, q: 'different-workflow' })).items.map(
        (row) => row.task.id,
      ),
    ).toEqual(['different-workflow'])
    expect(
      (await f.queries.list(admin, { ...selection, repository: '/extra/1' })).items,
    ).toHaveLength(1)
    expect(
      (await f.queries.list(admin, { ...selection, repository: '/fixture' })).items,
    ).toHaveLength(1)
    expect(
      (await f.queries.overview(admin, { ...selection, repository: '/extra' })).tasks,
    ).toHaveLength(0)
  })
  test('collection backlog and observation times share the visible filtered task snapshot', async () => {
    const f = await fixture()
    await f.task()
    await f.task('hidden', { ownerUserId: 'other' })
    await f.task('older', { startedAt: NOW - 1 })
    for (const taskId of ['task', 'hidden', 'older']) {
      await f.attempt('run-' + taskId, 0, 5000, { taskId })
      await harness.db
        .insert(taskExecutionObservationSources)
        .values({
          taskId,
          nodeRunId: 'run-' + taskId,
          pending: true,
          evidenceJson: JSON.stringify({
            invocationId: taskId,
            measurements: [],
            diagnostics: ['native-session-unavailable'],
          }),
        })
        .run()
    }
    await harness.db
      .insert(taskExecutionObservationSources)
      .values({
        taskId: 'task',
        nodeRunId: 'run-task',
        pending: false,
        evidenceJson: JSON.stringify({ invocationId: 'task', measurements: [], diagnostics: [] }),
      })
      .run()
    await f.accept('task', { nodeRunId: 'run-task' })
    await f.usage('task')
    const actor = { ...admin, permissions: new Set(['tasks:read', 'tasks:read:own'] as const) }
    const result = await f.queries.overview(actor, query)
    expect(result.collection).toEqual({
      retainedRecords: 2,
      pendingRecords: 1,
      firstObservedAt: NOW + 4000,
      lastObservedAt: NOW + 4000,
      tasks: [
        {
          taskId: 'task',
          retainedRecords: 2,
          pendingRecords: 1,
          firstObservedAt: NOW + 4000,
          lastObservedAt: NOW + 4000,
        },
      ],
      platforms: [],
    })
    const empty = await f.queries.overview(actor, { ...query, q: 'absent' })
    expect(empty.collection).toEqual({
      retainedRecords: 0,
      pendingRecords: 0,
      firstObservedAt: null,
      lastObservedAt: null,
      tasks: [],
      platforms: [],
    })
    await harness.db.update(taskExecutionObservationSources).set({ pending: false }).run()
    expect((await f.queries.overview(actor, query)).collection).toMatchObject({
      retainedRecords: 2,
      pendingRecords: 0,
    })
  })
  test('task search preserves non-ASCII literal names on both providers', async () => {
    const f = await fixture()
    await f.task('unicode', { name: 'Ärger 与观测' })
    await f.task('other', { name: 'Different task' })
    for (const q of ['Ärger', '观测']) {
      const result = await f.queries.overview(admin, { ...query, q })
      expect(result.tasks.map((row) => row.task.id)).toEqual(['unicode'])
    }
  })
  test('continuation is bound to every observation selector and unchanged filters page without repeats', async () => {
    const f = await fixture()
    await f.task('a', { name: 'alpha' })
    await f.task('b', { name: 'alpha' })
    const selected = {
      ...query,
      q: 'alpha',
      status: 'running' as const,
      repository: '/fixture',
      workflow: 'workflow',
      limit: 1,
    }
    const first = await f.queries.list(admin, selected)
    expect(first.items.map((row) => row.task.id)).toEqual(['b'])
    const after = first.nextCursor!
    expect(after).not.toBeNull()
    expect(
      (await f.queries.list(admin, { ...selected, after })).items.map((row) => row.task.id),
    ).toEqual(['a'])
    for (const patch of [
      { q: 'beta' },
      { status: 'done' as const },
      { repository: '/different' },
      { workflow: 'different' },
    ])
      await expect(f.queries.list(admin, { ...selected, ...patch, after })).rejects.toThrow(
        'cursor changed window',
      )
  })
  test('unobserved and true zero stay different, including a terminal attempt with no end', async () => {
    const f = await fixture()
    await f.task()
    await f.price()
    await f.accept('zero')
    await f.accept('missing')
    await f.attempt('run-zero', 1000, null, { status: 'interrupted' })
    await f.usage('zero', buckets('0'))
    const result = (await f.queries.detail(admin, 'task'))!
    expect(result.metrics.tokens).toMatchObject({
      totalKnown: '0',
      hasKnown: true,
      complete: false,
    })
    expect(result.metrics.cost.knownAmount).toBe('0')
    expect(result.metrics.observedInvocations).toBe(1)
    expect(result.metrics.invocations).toBe(2)
    expect(result.attempts[0]!.interval).toBeNull()
    expect(result.intervals).toEqual({
      cumulativeMs: 0,
      activeUnionMs: 0,
      knownAttempts: 0,
      unknownAttempts: 1,
      unlinkedInvocations: 1,
    })
    expect(result.agents.find((a) => a.agentId === 'agent-missing')!.metrics.tokens.hasKnown).toBe(
      false,
    )
  })
  test('owner-filtered list uses a stable keyset, window-exclusive end and direct child rows', async () => {
    const f = await fixture()
    await f.task('a')
    await f.task('b', { parentTaskId: 'a', rootTaskId: 'a' })
    await f.task('foreign', { ownerUserId: 'other' })
    await f.task('at-end', { startedAt: query.to })
    await f.task('deleted', { deletedAt: NOW + 1 })
    const actor = { ...admin, permissions: new Set(['tasks:read', 'tasks:read:own'] as const) }
    const first = await f.queries.list(actor, { ...query, limit: 1 })
    expect(first.items.map((r) => r.task.id)).toEqual(['b'])
    const second = await f.queries.list(actor, { ...query, limit: 1, after: first.nextCursor! })
    expect(second.items.map((r) => r.task.id)).toEqual(['a'])
    expect(second.nextCursor).toBeNull()
    expect(await f.queries.detail(actor, 'foreign')).toBeNull()
    await harness.db
      .insert(taskCollaborators)
      .values({
        taskId: 'foreign',
        userId: 'reader',
        role: 'observer',
        addedBy: 'other',
        addedAt: NOW,
      })
      .run()
    expect((await f.queries.detail(actor, 'foreign'))?.task.id).toBe('foreign')
    await expect(
      f.queries.list(actor, { ...query, from: NOW + 1, after: first.nextCursor! }),
    ).rejects.toThrow('changed window')
  })
  test('hosted canonical amounts survive offline without local counters or repeated baseline subtraction', async () => {
    const f = await fixture()
    await f.task()
    await f.price('999')
    await f.accept('hosted', { authority: platformAuthority })
    await f.usage('hosted', buckets('9000000'))
    await f.sync([csUsage(), csValue()])
    await f.offline()
    const result = (await f.queries.detail(admin, 'task'))!
    expect(result.metrics.tokens.totalKnown).toBe('30')
    expect(result.metrics.cost.knownAmount).toBe('7.25')
    expect(result.metrics.cost.priceVersionIds).toEqual(['cs-price-7'])
    expect(result.metrics.authorities).toEqual(['crewstation'])
    expect(result.sources[0]).toMatchObject({
      status: 'failed',
      asOf: new Date(NOW + 5000).toISOString(),
    })
  })
  test('only complete v2 empty proofs establish zero; late usage and hidden CNY remain separate', async () => {
    const f = await fixture()
    await f.task()
    await f.price('999')
    await f.accept('hosted', { authority: platformAuthority })
    await f.sync([])
    expect((await f.queries.detail(admin, 'task'))!.metrics.tokens.hasKnown).toBe(false)
    const capture: PlatformObservation = {
      ...nativeCapture,
      kind: 'capture',
      identity,
      capture: { ...nativeCapture.capture, identity },
    } as PlatformObservation
    await f.sync([capture], { schemaVersion: 2 })
    let result = (await f.queries.detail(admin, 'task'))!
    expect(result.metrics.tokens).toMatchObject({ hasKnown: true, totalKnown: '0', complete: true })
    expect(result.metrics).toMatchObject({ records: 0, observedInvocations: 1 })
    expect(result.metrics.cost).toMatchObject({
      knownAmount: '0',
      complete: true,
      priceVersionIds: [],
    })
    expect(result.platformCaptures).toHaveLength(1)
    expect(result.platformCaptures![0]!.capture?.id).toBe('native-empty')
    await f.sync([capture], { schemaVersion: 2, costVisibility: 'hidden', visibilityRevision: 1 })
    result = (await f.queries.detail(admin, 'task'))!
    expect(result.metrics.tokens).toMatchObject({ hasKnown: true, complete: true })
    expect(result.metrics.cost).toMatchObject({ knownAmount: null, complete: false })
    await f.sync([capture, csUsage()], {
      schemaVersion: 2,
      costVisibility: 'hidden',
      visibilityRevision: 1,
    })
    result = (await f.queries.detail(admin, 'task'))!
    expect(result.metrics.tokens).toMatchObject({ totalKnown: '30', complete: false })
    expect(result.metrics.cost.knownAmount).toBeNull()
    expect(result.metrics.cost.reasons).toContain('native-capture-unobserved')
    await f.offline()
    expect((await f.queries.detail(admin, 'task'))!.metrics.tokens.complete).toBe(false)
  })
  test('one AW task preserves independent platform bindings from the same installation', async () => {
    const f = await fixture()
    await f.task()
    const secondBinding = { ...binding, taskId: '01a0bf5d-8f4b-7793-867c-efd7527b3865' }
    await f.accept('hosted-a', { authority: platformAuthority })
    await f.accept('hosted-b', {
      authority: {
        ...platformAuthority,
        ...secondBinding,
        subtaskId: '01a0bf5d-8f4b-7793-867c-efd7527b3866',
        executionResourceId: '01a0bf5d-8f4b-7793-867c-efd7527b3867',
      },
    })
    await f.sync([], {}, binding)
    await f.sync([], {}, secondBinding)
    await f.offline(secondBinding)
    const sources = [
      {
        sourceId: binding.sourceId,
        platformProjectId: binding.projectId,
        platformTaskId: binding.taskId,
        status: 'ready',
      },
      {
        sourceId: binding.sourceId,
        platformProjectId: binding.projectId,
        platformTaskId: secondBinding.taskId,
        status: 'failed',
      },
    ]
    const detail = (await f.queries.detail(admin, 'task'))!
    expect(detail.sources).toHaveLength(2)
    for (const source of sources)
      expect(detail.sources).toContainEqual(expect.objectContaining(source))
    const overview = await f.queries.overview(admin, query)
    expect(overview.collection.platforms).toHaveLength(2)
    for (const source of sources)
      expect(overview.collection.platforms).toContainEqual(
        expect.objectContaining({ ...source, taskId: 'task' }),
      )
  })
  test('hosted initial and pending estimates stay unknown and hidden cost never falls back to AW', async () => {
    const f = await fixture()
    await f.task()
    await f.price()
    await f.accept('hosted', { authority: platformAuthority })
    let result = (await f.queries.detail(admin, 'task'))!
    expect(result.metrics.tokens.hasKnown).toBe(false)
    expect(result.metrics.cost.knownAmount).toBeNull()
    await f.sync([csUsage()])
    result = (await f.queries.detail(admin, 'task'))!
    expect(result.metrics.tokens.totalKnown).toBe('30')
    expect(result.metrics.cost.reasons).toContain('pending')
    const hidden: PlatformObservation = {
      ...csValue(),
      availability: 'not-authorized',
      amountDecimal: null,
      priceVersionRef: null,
    }
    await f.sync([csUsage(), hidden], { costVisibility: 'hidden', visibilityRevision: 1 })
    result = (await f.queries.detail(admin, 'task'))!
    expect(result.metrics.cost.knownAmount).toBeNull()
    expect(result.metrics.cost.reasons).toContain('not-authorized')
  })
  test('HTTP pagination keeps a maximum-length repository selector within the cursor contract', async () => {
    const f = await fixture()
    const repository = '/' + 'r'.repeat(4095)
    await f.task('a', { repoPath: repository })
    await f.task('b', { repoPath: repository })
    const app = new Hono()
    const injectActor: MiddlewareHandler = async (c, next) => {
      c.set('actor', admin)
      await next()
    }
    app.use('*', injectActor)
    app.onError(errorHandler)
    mountObservationRoutes(app, { ...f.pricing, tasks: f.queries })
    const parameters = new URLSearchParams({
      from: String(NOW),
      to: String(NOW + 20000),
      limit: '1',
      repository,
    })
    const first = await app.request(`/api/observability/tasks?${parameters}`)
    expect(first.status).toBe(200)
    const page = (await first.json()) as ObservationTaskPage
    expect(page.items.map((row) => row.task.id)).toEqual(['b'])
    expect(page.nextCursor).not.toBeNull()
    expect(page.nextCursor!.length).toBeLessThan(2048)
    parameters.set('after', page.nextCursor!)
    const second = await app.request(`/api/observability/tasks?${parameters}`)
    expect(second.status).toBe(200)
    expect(((await second.json()) as ObservationTaskPage).items.map((row) => row.task.id)).toEqual([
      'a',
    ])
    parameters.set('repository', '/different')
    expect((await app.request(`/api/observability/tasks?${parameters}`)).status).toBe(422)
  })
  test('HTTP query validation and detail preserve the task read contract', async () => {
    const f = await fixture()
    await f.task()
    const app = new Hono()
    const injectActor: MiddlewareHandler = async (c, next) => {
      c.set('actor', admin)
      await next()
    }
    app.use('*', injectActor)
    app.onError(errorHandler)
    mountObservationRoutes(app, { ...f.pricing, tasks: f.queries })
    expect((await app.request('/api/observability/tasks?from=1&to=0')).status).toBe(422)
    expect(
      (await app.request('/api/observability/tasks?from=0&to=4102444800000&timezone=unknown'))
        .status,
    ).toBe(422)
    expect((await app.request('/api/observability/tasks/task')).status).toBe(200)
    expect((await app.request('/api/observability/tasks/missing')).status).toBe(404)
    const response = await app.request(`/api/observability/tasks?from=${NOW}&to=${NOW + 20000}`)
    expect(response.status).toBe(200)
    const result = (await response.json()) as ObservationTaskPage
    expect(result.items[0]!.metrics.cost.currency).toBe('CNY')
    const overview = await app.request(`/api/observability/overview?from=${NOW}&to=${NOW + 20000}`)
    expect(overview.status).toBe(200)
    expect(
      ((await overview.json()) as ObservationOverview).tasks.map((row) => row.task.id),
    ).toEqual(['task'])
    expect(
      (await app.request(`/api/observability/overview?from=${NOW}&to=${NOW + 20000}&after=x`))
        .status,
    ).toBe(422)
    // The user removed CSV exports from run observability, including its HTTP operation.
    expect(
      (await app.request('/api/observability/exports/snapshot', { method: 'POST' })).status,
    ).toBe(404)
  })

  test('overview quality preserves partial numeric evidence even when every bucket is priced', async () => {
    const f = await fixture()
    await f.task()
    await f.price()
    await f.accept('local')
    await f.usage('local', buckets('100'), { reporting: 'cumulative' })
    await f.usage('local', buckets('90'), { reporting: 'cumulative', revision: 2 })
    let result = await f.queries.overview(admin, query)
    expect(result.metrics.tokens.totalKnown).toBe('100')
    expect(result.metrics.tokens.complete).toBe(false)
    expect(result.metrics.cost.knownAmount).toBe('0.0001')
    expect(result.quality).toContainEqual({ reason: 'usage-partial', taskIds: ['task'] })
    await f.task('hosted')
    await f.accept('hosted', { taskId: 'hosted', authority: platformAuthority })
    const usage = csUsage()
    await f.sync([
      csUsage({
        projection: { ...usage.projection, complete: false, issues: ['unexplained-decrease'] },
      }),
      csValue(),
    ])
    result = await f.queries.overview(admin, query)
    const partial = result.quality.find((row) => row.reason === 'usage-partial')!
    expect([...partial.taskIds].sort()).toEqual(['hosted', 'task'])
    expect(result.tasks.find((row) => row.task.id === 'hosted')!.metrics.cost.knownAmount).toBe(
      '7.25',
    )
  })

  test('model and runtime dimensions preserve separate CS installation identities', async () => {
    const f = await fixture()
    for (const [id, count] of [
      ['cs-a', '10'],
      ['cs-b', '20'],
    ] as const) {
      await f.task(id)
      await f.accept(id, { taskId: id, authority: { ...platformAuthority, sourceId: id } })
      const usage = csUsage()
      await f.sync(
        [
          csUsage({
            modelRef: 'model-1',
            projection: { ...usage.projection, contribution: buckets(count) },
          }),
        ],
        {},
        { ...binding, sourceId: id },
      )
    }
    const result = await f.queries.overview(admin, query)
    expect(result.metrics.tokens.totalKnown).toBe('30')
    expect(
      result.models.map((row) => [row.sourceId, row.model, row.metrics.tokens.totalKnown]).sort(),
    ).toEqual([
      ['cs-a', 'model-1', '10'],
      ['cs-b', 'model-1', '20'],
    ])
    expect(
      result.runtimes.map((row) => [row.sourceId, row.metrics.tokens.totalKnown]).sort(),
    ).toEqual([
      ['cs-a', '10'],
      ['cs-b', '20'],
    ])
  })

  test('overview agrees across tasks, agents, models, runtimes and start-time buckets', async () => {
    const f = await fixture()
    await f.price()
    await f.task('first', { status: 'done', finishedAt: NOW + 6000, runningSince: null })
    await f.task('child', {
      parentTaskId: 'first',
      rootTaskId: 'first',
      startedAt: NOW + 1000,
      status: 'done',
      finishedAt: NOW + 9000,
      runningSince: null,
    })
    await f.task('hidden', { ownerUserId: 'other' })
    await f.task('outside', { startedAt: NOW + 20000 })
    for (const [id, count] of [
      ['first', '1000000'],
      ['child', '2000000'],
      ['hidden', '9000000'],
      ['outside', '9000000'],
    ] as const) {
      await f.accept(id, { taskId: id, agentId: 'same-agent' })
      await f.usage(id, buckets(count), { taskId: id })
    }
    const actor = { ...admin, permissions: new Set(['tasks:read', 'tasks:read:own'] as const) }
    const overview = await f.queries.overview(actor, query)
    expect(overview.partial).toBe(false)
    expect(overview.tasks.map((row) => row.task.id)).toEqual(['child', 'first'])
    expect(overview.metrics.tokens.totalKnown).toBe('3000000')
    expect(overview.metrics.cost.knownAmount).toBe('3')
    expect(overview.agents).toHaveLength(1)
    expect(overview.agents[0]!.metrics).toEqual(overview.metrics)
    expect(
      overview.agents[0]!.tasks.map((row) => [row.taskId, row.metrics.tokens.totalKnown]),
    ).toEqual([
      ['child', '2000000'],
      ['first', '1000000'],
    ])
    expect(overview.models[0]).toMatchObject({
      authority: 'local',
      provider: 'gateway',
      model: 'model',
      metrics: overview.metrics,
    })
    expect(overview.runtimes[0]).toMatchObject({
      authority: 'local',
      registrationId: 'runtime',
      configurationRevision: 0,
      protocol: 'opencode',
      metrics: overview.metrics,
    })
    expect(overview.trend[0]).toMatchObject({
      from: NOW,
      to: NOW + 20000,
      taskCount: 2,
      metrics: overview.metrics,
    })
    expect(overview.durations).toEqual({ completedTasks: 2, p50Ms: 6000, p95Ms: 8000, maxMs: 8000 })
    expect(overview.quality).toEqual([])
    expect(overview.statuses).toEqual([{ status: 'done', count: 2 }])
  })

  test('overview retains missing and zero costs, actual model identities and running samples', async () => {
    const f = await fixture()
    await f.price()
    await f.task('zero', { startedAt: NOW - 1 })
    await f.task('unpriced', { startedAt: NOW + 1000 })
    await f.task('missing', { startedAt: NOW - 1 })
    await f.accept('zero', { taskId: 'zero', agentId: 'worker', agentRevision: 1 })
    await f.usage('zero', buckets('0'), { taskId: 'zero' })
    await f.accept('unpriced', { taskId: 'unpriced', agentId: 'worker', agentRevision: 2 })
    await f.usage('unpriced', buckets('40'), {
      taskId: 'unpriced',
      model: { provider: 'other-provider', id: 'other-model' },
    })
    const overview = await f.queries.overview(admin, {
      ...query,
      from: NOW - 86400000,
      to: NOW + 86400000,
    })
    expect(overview.tasks).toHaveLength(3)
    expect(overview.metrics.tokens.totalKnown).toBe('40')
    expect(overview.metrics.cost.knownAmount).toBe('0')
    expect(overview.metrics.cost.complete).toBe(false)
    expect(overview.durations.completedTasks).toBe(0)
    expect(overview.durations.p50Ms).toBeNull()
    expect(overview.agents.map((row) => row.agentRevision).sort()).toEqual([1, 2])
    expect(overview.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          model: 'other-model',
          provider: 'other-provider',
          metrics: expect.objectContaining({
            cost: expect.objectContaining({ knownAmount: null }),
          }),
        }),
      ]),
    )
    expect(overview.trend.map((row) => row.metrics.tokens.totalKnown)).toEqual(['0', '40'])
    expect(overview.quality).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: 'not-observed', taskIds: ['missing'] }),
        expect.objectContaining({ reason: 'unpriced', taskIds: ['unpriced'] }),
      ]),
    )
  })

  test('mixed-deployment overview adds CS canonical contribution once and retains hidden-cost gaps', async () => {
    const f = await fixture()
    await f.task()
    await f.price()
    await f.accept('local')
    await f.usage('local')
    await f.accept('hosted', { authority: platformAuthority })
    await f.sync([csUsage(), csValue()])
    let result = await f.queries.overview(admin, query)
    expect(result.metrics.tokens.totalKnown).toBe('1000030')
    expect(result.metrics.cost.knownAmount).toBe('8.25')
    expect(result.models).toHaveLength(2)
    expect(result.models.find((row) => row.authority === 'crewstation')).toMatchObject({
      provider: null,
      model: 'opaque-model-ref',
      metrics: { tokens: { totalKnown: '30' }, cost: { knownAmount: '7.25' } },
    })
    expect(result.runtimes.find((row) => row.authority === 'crewstation')).toMatchObject({
      registrationId: null,
      protocol: null,
      configurationRevision: null,
    })
    await f.sync(
      [
        csUsage(),
        {
          ...csValue(),
          availability: 'not-authorized',
          amountDecimal: null,
          priceVersionRef: null,
        },
      ],
      { costVisibility: 'hidden', visibilityRevision: 1 },
    )
    result = await f.queries.overview(admin, query)
    expect(result.metrics.tokens.totalKnown).toBe('1000030')
    expect(result.metrics.cost.knownAmount).toBe('1')
    expect(result.metrics.cost.complete).toBe(false)
    expect(result.quality).toContainEqual({ reason: 'not-authorized', taskIds: ['task'] })
  })

  test('platform parent coverage allocates tokens once and never prorates a whole-record cost', async () => {
    const f = await fixture()
    await f.task()
    await f.accept('hosted', { authority: platformAuthority })
    const scope = {
      root: 'root',
      session: 'root',
      parentSession: null,
      ancestors: [],
      turn: 'turn',
      turnIndex: 0,
    }
    const parent = csUsage({
      recordId: 'parent',
      inclusion: 'includes-descendants',
      scope: { ...scope, level: 'tree-total' },
      coveredThroughTurn: 0,
      coverage: 'partial',
      projection: {
        projectionRevision: 1,
        observedRevision: 1,
        contribution: { ...buckets('10'), output: null },
        coveredThrough: { input: 0, cacheRead: 0, cacheWrite: 0, output: null },
        complete: false,
        issues: [],
      },
    })
    const child = csUsage({
      recordId: 'child',
      scope: { ...scope, level: 'request' },
      coveredThroughTurn: 0,
      projection: {
        projectionRevision: 1,
        observedRevision: 1,
        contribution: buckets('10', '20'),
        coveredThrough: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
        complete: true,
        issues: [],
      },
    })
    await f.sync([
      parent,
      child,
      { ...csValue(), recordId: 'parent', amountDecimal: '1', completeness: 'partial' },
      { ...csValue(), recordId: 'child', amountDecimal: '2' },
    ])
    const result = (await f.queries.detail(admin, 'task'))!
    expect(result.metrics.tokens.totalKnown).toBe('30')
    expect(result.metrics.cost.knownAmount).toBe('1')
    expect(result.metrics.cost.complete).toBe(false)
    expect(result.metrics.cost.reasons).toContain('partial-allocation')
  })

  test('bounded invocation reads mark a subtotal explicitly and never manufacture measured zero', async () => {
    const f = await fixture()
    await f.task()
    for (let offset = 0; offset < 1001; offset += 100) {
      const rows = Array.from({ length: Math.min(100, 1001 - offset) }, (_, index) => {
        const id = 'bounded-' + (offset + index)
        const invocation = {
          invocationId: id,
          taskId: 'task',
          nodeRunId: null,
          agentId: 'agent',
          agentRevision: 1,
          purpose: 'task',
          authority: { kind: 'local', runtime: null },
          acceptedAt: NOW,
          priceBookRevision: null,
        }
        return {
          id,
          taskId: 'task',
          canonicalExecution: id,
          fingerprint: JSON.stringify(invocation),
          document: JSON.stringify(invocation),
        }
      })
      await harness.db.insert(observationInvocations).values(rows).run()
    }
    const result = (await f.queries.detail(admin, 'task'))!
    expect(result.metrics.invocations).toBe(1000)
    expect(result.metrics.truncated).toBe(true)
    expect(result.metrics.tokens.hasKnown).toBe(false)
    expect(result.metrics.cost.knownAmount).toBeNull()
    expect(result.metrics.cost.reasons).toContain('truncated')
  })
})

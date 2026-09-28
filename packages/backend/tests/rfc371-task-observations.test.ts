// RFC-371: task/agent/attempt totals share one snapshot and one frozen execution authority.
import { expect, test } from 'bun:test'
import { Hono, type MiddlewareHandler } from 'hono'
import type {
  AcceptObservationInvocation,
  ObservationMeasurement,
  ObservationTaskPage,
  ObservationTaskPageQuery,
} from '@agent-workflow/shared'
import { buildActor } from '../src/auth/actor'
import { nodeRuns, observationInvocations, taskCollaborators, tasks, users } from '../src/db/schema'
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
  PlatformObservationSourceError,
  type PlatformObservation,
  type PlatformObservationPage,
} from '../src/modules/run-observability/domain/platformObservation'
import { mountObservationRoutes } from '../src/modules/run-observability/composition/observationRoutes'
import { errorHandler } from '../src/util/errors'
import { describeEachProvider } from './helpers/eachProvider'

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
          expectedCursor: null,
          nextCursor: '1',
          events: [{ eventId: 'event', measurement }],
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
        patch: Partial<Pick<PlatformObservationPage, 'costVisibility' | 'visibilityRevision'>> = {},
      ) {
        const response: PlatformObservationPage = {
          schemaVersion: 1,
          capability: 'executionObservationsV1',
          projectId: binding.projectId,
          taskId: binding.taskId,
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
        }
        const sync = createPlatformObservationSync({
          store: platform,
          now: () => NOW + 6000,
          source: {
            read: async (request) => {
              if (request.mode === 'snapshot') return response
              return {
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
              }
            },
          },
        })
        await sync(binding)
        if ((await platform.state(binding)).mode === 'snapshot') await sync(binding)
      },
      async offline() {
        const sync = createPlatformObservationSync({
          store: platform,
          now: () => NOW + 9000,
          source: {
            read: async () => {
              throw new PlatformObservationSourceError('unavailable', 'offline')
            },
          },
        })
        await sync(binding)
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

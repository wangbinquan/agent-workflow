// RFC-371 v2 (design/RFC-371-run-observability/redesign-v2-20261014.md §3–§5),
// on both providers: one call row per runtime process updated in place, the
// price version frozen by acceptance time, and every statistic aggregated on
// demand over the visible scope (administrators: everything; others: the tasks
// task-execution confirms plus their own task-less system calls).
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { buildActor, type Actor } from '@/auth/actor'
import {
  nodeRuns,
  observationCallModels,
  observationCalls,
  taskCollaborators,
  tasks,
  users,
  workflows,
} from '@/db/schema'
import type { ProviderNeutralDatabase } from '@/db/query'
import { composeRunObservation } from '@/modules/run-observability/composition/runObservation'
import {
  SYSTEM_PAGE_SIZE,
  TASK_PAGE_SIZE,
} from '@/modules/run-observability/application/observationQueries'
import { createTaskObservationFacts } from '@/modules/task-execution/composition/taskObservationFacts'
import { encodeLineageSlotPath } from '@/modules/task-execution/domain/executionIntent'
import type { CallObservationStart } from '@/modules/run-observability/public/participants'
import { describeEachProvider } from './helpers/eachProvider'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const T0 = Date.UTC(2026, 9, 1)
const WINDOW = { from: T0, to: T0 + 7 * DAY, tzOffset: 0 }

function actor(id: string, role: 'admin' | 'user'): Actor {
  return buildActor({
    user: { id, username: id, displayName: id, role, status: 'active' },
    source: 'session',
  })
}
const admin = actor('u-admin', 'admin')
const member = actor('u-member', 'user')

const runtimes = {
  directory: async () => ({
    runtimes: [
      {
        registrationId: 'rt-1',
        name: 'claude-main',
        configurationRevision: 1,
        protocol: 'claude-code' as const,
        model: 'sonnet',
        enabled: true,
      },
    ],
  }),
}

function compose(db: ProviderNeutralDatabase, now: { value: number }) {
  return composeRunObservation({
    db,
    tasks: createTaskObservationFacts(db),
    runtimes,
    clock: () => now.value,
  })
}

async function seedTask(
  db: ProviderNeutralDatabase,
  input: {
    readonly id: string
    readonly owner: string
    readonly startedAt: number
    readonly status: 'done' | 'failed' | 'running'
    readonly finishedAt?: number
  },
) {
  await db.insert(tasks).values({
    id: input.id,
    name: `task ${input.id}`,
    workflowId: 'wf',
    workflowSnapshot: '{}',
    repoPath: '/tmp/never-read',
    worktreePath: '/tmp/never-read',
    baseBranch: 'main',
    branch: `agent-workflow/${input.id}`,
    status: input.status,
    inputs: '{}',
    startedAt: input.startedAt,
    finishedAt: input.finishedAt ?? null,
    runningMs: 0,
    ownerUserId: input.owner,
    executionLineageId: input.id,
    lineageSlotPathJson: encodeLineageSlotPath([
      { stableNodeKey: 'task-root', frozenOccurrenceKey: input.id, workflowRevision: null },
    ]),
  })
}

async function seedBase(db: ProviderNeutralDatabase) {
  for (const id of ['u-admin', 'u-member', 'u-other'])
    await db.insert(users).values({
      id,
      username: id,
      displayName: id,
      role: id === 'u-admin' ? ('admin' as const) : ('user' as const),
      status: 'active' as const,
      createdAt: T0,
      updatedAt: T0,
    })
  await db.insert(workflows).values({ id: 'wf', name: 'wf', definition: '{}' })
  await seedTask(db, {
    id: 't-own',
    owner: 'u-member',
    startedAt: T0 + HOUR,
    status: 'done',
    finishedAt: T0 + 2 * HOUR,
  })
  await seedTask(db, {
    id: 't-collab',
    owner: 'u-other',
    startedAt: T0 + 3 * HOUR,
    status: 'failed',
    finishedAt: T0 + 5 * HOUR,
  })
  await seedTask(db, {
    id: 't-hidden',
    owner: 'u-other',
    startedAt: T0 + 4 * HOUR,
    status: 'running',
  })
  await db.insert(taskCollaborators).values({
    taskId: 't-collab',
    userId: 'u-member',
    role: 'collaborator',
    addedBy: 'u-other',
    addedAt: T0,
  })
  for (const [id, retryIndex] of [
    ['nr-own-1', 0],
    ['nr-own-2', 1],
  ] as const)
    await db
      .insert(nodeRuns)
      .values({ id, taskId: 't-own', nodeId: 'plan', status: 'done', retryIndex, iteration: 0 })
}

function call(id: string, overrides: Partial<CallObservationStart> = {}): CallObservationStart {
  return {
    id,
    purpose: 'task',
    taskId: 't-own',
    nodeRunId: null,
    agentId: 'a1',
    agentName: 'planner',
    runtimeId: 'rt-1',
    runtimeName: 'claude-main',
    protocol: 'claude-code',
    startedAt: T0 + HOUR,
    ...overrides,
  }
}

const model = (
  name: string,
  input: number,
  output: number,
  extra: Partial<Record<string, number>> = {},
) => ({
  model: name,
  input,
  cacheRead: extra.cacheRead ?? 0,
  cacheWrite: extra.cacheWrite ?? 0,
  output,
  reasoning: extra.reasoning ?? 0,
})

describeEachProvider('RFC-371 v2 observation store', (harness) => {
  test('a call is accepted, updated in place, ended once and repaired after a restart', async () => {
    const db = harness.db
    await seedBase(db)
    const now = { value: T0 + HOUR }
    const { calls } = compose(db, now)
    const row = async (id: string) =>
      (await db.select().from(observationCalls).where(eq(observationCalls.id, id)))[0]!
    const models = async (id: string) =>
      await db.select().from(observationCallModels).where(eq(observationCallModels.callId, id))

    await calls.accept(call('c1', { nodeRunId: 'nr-own-1' }))
    expect(await row('c1')).toMatchObject({
      status: 'running',
      usageState: 'pending',
      costState: 'none',
      endedAt: null,
    })

    await calls.usage('c1', { state: 'partial', models: [model('sonnet', 100, 10)] })
    expect(await row('c1')).toMatchObject({
      usageState: 'partial',
      inputTokens: 100,
      outputTokens: 10,
      costState: 'unpriced',
    })

    // The final snapshot replaces the model rows instead of adding to them.
    await calls.usage('c1', {
      state: 'complete',
      models: [model('sonnet', 200, 20, { reasoning: 5 }), model('haiku', 5, 5)],
    })
    expect(await row('c1')).toMatchObject({
      usageState: 'complete',
      inputTokens: 205,
      outputTokens: 25,
      reasoningTokens: 5,
    })
    expect((await models('c1')).map((m) => m.model).sort()).toEqual(['haiku', 'sonnet'])

    now.value = T0 + 2 * HOUR
    await calls.finish('c1', { status: 'done', endedAt: T0 + 2 * HOUR, usage: null })
    expect(await row('c1')).toMatchObject({
      status: 'done',
      endedAt: T0 + 2 * HOUR,
      usageState: 'complete',
    })
    // An ended call ignores late writes.
    await calls.usage('c1', { state: 'partial', models: [model('sonnet', 1, 1)] })
    await calls.finish('c1', { status: 'failed', endedAt: T0 + 3 * HOUR, usage: null })
    expect(await row('c1')).toMatchObject({ status: 'done', inputTokens: 205 })

    // A finish without any metered usage records the call as unreported.
    await calls.accept(call('c-silent'))
    await calls.finish('c-silent', { status: 'failed', endedAt: T0 + 2 * HOUR, usage: null })
    expect(await row('c-silent')).toMatchObject({ status: 'failed', usageState: 'none' })

    // Boot repair: only calls started before this boot.
    now.value = T0 + 5 * HOUR
    await calls.accept(call('c-stale', { startedAt: T0 + 4 * HOUR }))
    await calls.usage('c-stale', { state: 'partial', models: [model('sonnet', 7, 0)] })
    await calls.accept(call('c-fresh', { startedAt: T0 + 6 * HOUR }))
    now.value = T0 + 7 * HOUR
    expect(await calls.repairInterrupted(T0 + 5 * HOUR)).toBe(1)
    expect(await row('c-stale')).toMatchObject({
      status: 'interrupted',
      endedAt: T0 + 5 * HOUR,
      usageState: 'partial',
      inputTokens: 7,
    })
    expect(await row('c-fresh')).toMatchObject({ status: 'running' })
  })

  test('a call is priced by the version in force when it was accepted; saves use compare-and-set', async () => {
    const db = harness.db
    await seedBase(db)
    const now = { value: T0 }
    const { calls, pricing } = compose(db, now)
    const first = await pricing.save(
      'rt-1',
      {
        model: 'sonnet',
        rates: { input: '2', cacheRead: '0.5', cacheWrite: null, output: '8' },
        effectiveFrom: 0,
        note: 'acceptance rates',
        expectedLatestId: null,
      },
      'u-admin',
    )
    expect(first).toMatchObject({
      runtimeId: 'rt-1',
      model: 'sonnet',
      rates: { input: '2', cacheRead: '0.5', cacheWrite: null, output: '8' },
      createdAt: T0,
      createdBy: 'u-admin',
    })
    await expect(
      pricing.save(
        'rt-1',
        {
          model: 'sonnet',
          rates: { input: '1', cacheRead: null, cacheWrite: null, output: null },
          effectiveFrom: 0,
          note: '',
          expectedLatestId: null,
        },
        'u-admin',
      ),
    ).rejects.toMatchObject({ code: 'price-conflict' })
    await expect(
      pricing.save(
        'rt-missing',
        {
          model: 'sonnet',
          rates: { input: '1', cacheRead: null, cacheWrite: null, output: null },
          effectiveFrom: 0,
          note: '',
          expectedLatestId: null,
        },
        'u-admin',
      ),
    ).rejects.toMatchObject({ code: 'runtime-not-found' })

    // Accepted before the second version: keeps the first price for good.
    await calls.accept(call('p-early', { startedAt: T0 + 2 }))
    now.value = T0 + 5
    const second = await pricing.save(
      'rt-1',
      {
        model: 'sonnet',
        rates: { input: '4', cacheRead: '0.5', cacheWrite: '3', output: '8' },
        effectiveFrom: 0,
        note: 'raise',
        expectedLatestId: first.id,
      },
      'u-admin',
    )
    await calls.accept(call('p-late', { startedAt: T0 + 10 }))
    const million = model('sonnet', 1_000_000, 1_000_000, { cacheWrite: 10 })
    for (const id of ['p-early', 'p-late'])
      await calls.finish(id, {
        status: 'done',
        endedAt: T0 + 20,
        usage: { state: 'complete', models: [million, model('unknown-model', 5, 0)] },
      })
    const early = (
      await db.select().from(observationCalls).where(eq(observationCalls.id, 'p-early'))
    )[0]!
    const late = (
      await db.select().from(observationCalls).where(eq(observationCalls.id, 'p-late'))
    )[0]!
    // ¥2 + ¥8 known, cache write rate unknown → partial; the unknown model is unpriced.
    expect(early).toMatchObject({ costNano: 10_000_000_000, costState: 'partial' })
    // ¥4 + ¥8 + 10 × ¥3/M.
    expect(late).toMatchObject({ costNano: 12_000_030_000, costState: 'partial' })
    const lateModels = await db
      .select()
      .from(observationCallModels)
      .where(eq(observationCallModels.callId, 'p-late'))
    expect(lateModels.find((m) => m.model === 'sonnet')).toMatchObject({
      priceId: second.id,
      costNano: 12_000_030_000,
      costState: 'priced',
    })
    expect(lateModels.find((m) => m.model === 'unknown-model')).toMatchObject({
      priceId: null,
      costNano: null,
      costState: 'unpriced',
    })

    expect((await pricing.history('rt-1', 'sonnet')).items.map((v) => v.id)).toEqual([
      second.id,
      first.id,
    ])
    const directory = await pricing.directory()
    expect(directory.runtimes).toHaveLength(1)
    expect(directory.runtimes[0]).toMatchObject({
      runtimeId: 'rt-1',
      configuredModel: 'sonnet',
    })
    expect(directory.runtimes[0]!.models).toEqual([
      { model: 'sonnet', calls: 2, current: expect.objectContaining({ id: second.id }) },
      { model: 'unknown-model', calls: 2, current: null },
    ])
  })

  // Locks the 2026-10-14 verification finding: system agents configured through
  // a legacy `*Model` setting run without a runtime registration and stayed
  // unpriced forever. They now price on their protocol's built-in line.
  test('a call without a runtime registration is priced on its protocol built-in line', async () => {
    const db = harness.db
    await seedBase(db)
    const now = { value: T0 }
    const { calls, pricing, queries } = compose(db, now)
    const builtin = {
      purpose: 'system' as const,
      systemKind: 'memory-distill',
      agentId: null,
      agentName: 'aw-memory-distiller',
      runtimeId: null,
      runtimeName: null,
      protocol: 'opencode',
    }
    const usage = {
      state: 'complete' as const,
      models: [model('opencode-go/deepseek', 1_000_000, 0)],
    }
    await calls.accept(call('b-unpriced', { ...builtin, startedAt: T0 + 1 }))
    await calls.finish('b-unpriced', { status: 'done', endedAt: T0 + 2, usage })
    expect(
      (await db.select().from(observationCalls).where(eq(observationCalls.id, 'b-unpriced')))[0],
    ).toMatchObject({ runtimeId: 'builtin:opencode', costState: 'unpriced' })
    // A call recorded before built-in keys existed joins the same line.
    await db.insert(observationCalls).values({
      id: 'b-legacy',
      purpose: 'system',
      taskId: 't-own',
      nodeRunId: null,
      systemKind: 'memory-distill',
      systemLabel: null,
      ownerUserId: null,
      agentId: null,
      agentName: 'aw-memory-distiller',
      runtimeId: null,
      runtimeName: null,
      protocol: 'opencode',
      status: 'done',
      startedAt: T0 + 3,
      endedAt: T0 + 4,
      usageState: 'complete',
      inputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      costNano: 0,
      costState: 'unpriced',
      updatedAt: T0 + 4,
    })
    await db.insert(observationCallModels).values({
      callId: 'b-legacy',
      model: 'opencode-go/deepseek',
      inputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      priceId: null,
      costNano: null,
      costState: 'unpriced',
    })

    const before = await pricing.directory()
    expect(before.runtimes.map((runtime) => [runtime.runtimeId, runtime.builtin])).toEqual([
      ['rt-1', false],
      ['builtin:opencode', true],
    ])
    expect(before.runtimes[1]).toMatchObject({
      name: 'opencode',
      protocol: 'opencode',
      configuredModel: null,
      models: [{ model: 'opencode-go/deepseek', calls: 2, current: null }],
    })

    const saved = await pricing.save(
      'builtin:opencode',
      {
        model: 'opencode-go/deepseek',
        rates: { input: '2', cacheRead: '0.5', cacheWrite: '3', output: '8' },
        effectiveFrom: 0,
        note: '',
        expectedLatestId: null,
      },
      'u-admin',
    )
    expect(saved.runtimeId).toBe('builtin:opencode')
    // Only the built-in lines of known protocols exist.
    await expect(
      pricing.save(
        'builtin:unknown',
        {
          model: 'm',
          rates: { input: '1', cacheRead: null, cacheWrite: null, output: null },
          effectiveFrom: 0,
          note: '',
          expectedLatestId: null,
        },
        'u-admin',
      ),
    ).rejects.toMatchObject({ code: 'runtime-not-found' })

    now.value = T0 + 10
    await calls.accept(call('b-priced', { ...builtin, startedAt: T0 + 10 }))
    await calls.finish('b-priced', { status: 'done', endedAt: T0 + 11, usage })
    expect(
      (await db.select().from(observationCalls).where(eq(observationCalls.id, 'b-priced')))[0],
    ).toMatchObject({ costNano: 2_000_000_000, costState: 'priced' })

    const models = await queries.models(admin, WINDOW)
    expect(models.items.map((row) => [row.runtimeId, row.model, row.usage.calls])).toEqual([
      ['builtin:opencode', 'opencode-go/deepseek', 3],
    ])
    expect(models.items[0]?.usage).toMatchObject({ unpricedCalls: 2, costNano: 2_000_000_000 })
    const detail = await queries.task(admin, 't-own')
    expect(detail?.calls.map((row) => [row.id, row.runtimeId])).toEqual([
      ['b-unpriced', 'builtin:opencode'],
      ['b-legacy', 'builtin:opencode'],
      ['b-priced', 'builtin:opencode'],
    ])
  })

  // Locks the 2026-10-14 verification finding: a process stopped from outside
  // may be mid-request, and OpenCode records a request's tokens only once it
  // completes, so the summary of a canceled or interrupted call is a lower bound.
  test('a canceled or interrupted call keeps its usage as a lower bound', async () => {
    const db = harness.db
    await seedBase(db)
    const now = { value: T0 }
    const { calls } = compose(db, now)
    const complete = { state: 'complete' as const, models: [model('sonnet', 10, 1)] }
    for (const [id, status] of [
      ['k-done', 'done'],
      ['k-failed', 'failed'],
      ['k-canceled', 'canceled'],
      ['k-interrupted', 'interrupted'],
    ] as const) {
      await calls.accept(call(id))
      await calls.finish(id, { status, endedAt: T0 + 1, usage: complete })
    }
    const states = Object.fromEntries(
      (await db.select().from(observationCalls)).map((row) => [row.id, row.usageState]),
    )
    expect(states).toEqual({
      'k-done': 'complete',
      'k-failed': 'complete',
      'k-canceled': 'partial',
      'k-interrupted': 'partial',
    })
  })

  test('statistics for an administrator cover every call in the window', async () => {
    const db = harness.db
    await seedBase(db)
    const now = { value: T0 + 6 * DAY }
    const { calls, queries } = compose(db, now)
    const seedCall = async (
      input: CallObservationStart,
      usage: ReturnType<typeof model>[],
      status: 'done' | 'failed' = 'done',
    ) => {
      await calls.accept(input)
      await calls.finish(input.id, {
        status,
        endedAt: input.startedAt + 10 * 60_000,
        usage: { state: 'complete', models: usage },
      })
    }
    await seedCall(call('c-own', { nodeRunId: 'nr-own-1' }), [model('sonnet', 1000, 100)])
    await seedCall(
      call('c-own-retry', { nodeRunId: 'nr-own-2', startedAt: T0 + 2 * HOUR }),
      [model('sonnet', 500, 50)],
      'failed',
    )
    await seedCall(
      call('c-collab', {
        taskId: 't-collab',
        agentId: 'a2',
        agentName: 'coder',
        startedAt: T0 + DAY + HOUR,
      }),
      [model('haiku', 300, 30)],
    )
    await seedCall(
      call('c-hidden', {
        taskId: 't-hidden',
        agentId: 'a2',
        agentName: 'coder',
        startedAt: T0 + 2 * DAY,
      }),
      [model('haiku', 200, 20)],
    )
    await seedCall(
      call('s-merge', {
        purpose: 'system',
        systemKind: 'merge-resolve',
        agentId: null,
        agentName: 'aw-merge',
        startedAt: T0 + 3 * HOUR,
      }),
      [model('sonnet', 40, 4)],
    )
    await seedCall(
      call('s-mem', {
        purpose: 'system',
        taskId: null,
        systemKind: 'memory-distill',
        systemLabel: '记忆提取',
        ownerUserId: 'u-member',
        agentId: null,
        agentName: 'aw-memory-distiller',
        startedAt: T0 + 3 * DAY,
      }),
      [model('haiku', 10, 1)],
    )
    await seedCall(
      call('s-other', {
        purpose: 'system',
        taskId: null,
        systemKind: 'mcp-runtime-test',
        ownerUserId: 'u-other',
        agentId: null,
        agentName: 'aw-mcp-runtime-test',
        startedAt: T0 + 3 * DAY,
      }),
      [model('haiku', 1, 1)],
    )
    // Before the window: excluded from window statistics, included in task lifetime.
    await seedCall(call('c-old', { startedAt: T0 - DAY }), [model('sonnet', 9, 9)])

    const overview = await queries.overview(admin, WINDOW)
    expect(overview).toMatchObject({ asOf: T0 + 6 * DAY, partial: false })
    expect(overview.usage).toMatchObject({ calls: 7, failedCalls: 1, input: 2051, output: 206 })
    expect(overview.taskUsage).toMatchObject({ calls: 4, input: 2000 })
    expect(overview.systemUsage).toMatchObject({ calls: 3, input: 51 })
    expect(overview.daily).toHaveLength(7)
    expect(overview.daily[0]).toMatchObject({ day: '2026-10-01', calls: 3, input: 1540 })
    expect(overview.daily[1]).toMatchObject({ day: '2026-10-02', calls: 1, input: 300 })
    expect(overview.daily[6]).toMatchObject({ day: '2026-10-07', calls: 0, input: 0 })
    expect(overview.tasks).toMatchObject({
      total: 3,
      done: 1,
      failed: 1,
      running: 1,
      durationSamples: 2,
      durationP50: HOUR,
      durationP95: 2 * HOUR,
      durationMax: 2 * HOUR,
    })
    expect(overview.topTasks.map((row) => [row.taskId, row.name])).toEqual([
      ['t-own', 'task t-own'],
      ['t-collab', 'task t-collab'],
      ['t-hidden', 'task t-hidden'],
    ])
    // Locks the 2026-10-14 verification finding: a task's consumption on the
    // overview includes its system work (here the merge), like the task list.
    expect(overview.topTasks[0]?.usage).toMatchObject({ calls: 3, input: 1540, output: 154 })
    expect(overview.topAgents[0]).toMatchObject({ agentId: 'a1', agentName: 'planner', tasks: 1 })

    const page = await queries.tasks(admin, { from: WINDOW.from, to: WINDOW.to })
    expect(page.items.map((row) => row.taskId)).toEqual(['t-hidden', 't-collab', 't-own'])
    // Lifetime consumption of the task, including the call before the window.
    expect(page.items[2]).toMatchObject({ status: 'done', agents: 2 })
    expect(page.items[2]?.usage).toMatchObject({ calls: 4, input: 1549 })
    expect(page.nextCursor).toBeNull()

    const detail = await queries.task(admin, 't-own')
    expect(detail?.task).toMatchObject({ id: 't-own', status: 'done' })
    expect(detail?.calls.map((c) => [c.id, c.nodeId, c.attempt])).toEqual([
      ['c-old', null, null],
      ['c-own', 'plan', 1],
      ['c-own-retry', 'plan', 2],
      ['s-merge', null, null],
    ])
    expect(detail?.calls[1]?.models).toEqual([
      {
        model: 'sonnet',
        input: 1000,
        cacheRead: 0,
        cacheWrite: 0,
        output: 100,
        reasoning: 0,
        costNano: null,
      },
    ])
    expect(detail?.usage).toMatchObject({ calls: 4, failedCalls: 1, input: 1549 })
    expect(await queries.task(admin, 'missing')).toBeNull()

    const agents = await queries.agents(admin, WINDOW)
    expect(agents.items.map((row) => row.agentName)).toEqual([
      'planner',
      'coder',
      'aw-merge',
      'aw-memory-distiller',
      'aw-mcp-runtime-test',
    ])
    expect(agents.items[1]).toMatchObject({ agentId: 'a2', tasks: 2 })
    expect(agents.items[2]).toMatchObject({ agentId: null })

    const models = await queries.models(admin, WINDOW)
    expect(models.items.map((row) => [row.runtimeId, row.model, row.usage.calls])).toEqual([
      ['rt-1', 'sonnet', 3],
      ['rt-1', 'haiku', 4],
    ])

    const system = await queries.system(admin, { from: WINDOW.from, to: WINDOW.to })
    expect(system.kinds.map((row) => row.kind).sort()).toEqual([
      'mcp-runtime-test',
      'memory-distill',
      'merge-resolve',
    ])
    expect(system.recent.map((row) => row.id)).toEqual(['s-other', 's-mem', 's-merge'])
    expect(system.nextCursor).toBeNull()
  })

  test('a member aggregates only visible tasks and their own task-less system calls', async () => {
    const db = harness.db
    await seedBase(db)
    const now = { value: T0 + 6 * DAY }
    const { calls, queries } = compose(db, now)
    for (const input of [
      call('c-own'),
      call('c-collab', { taskId: 't-collab', startedAt: T0 + DAY }),
      call('c-hidden', { taskId: 't-hidden', startedAt: T0 + DAY }),
      call('s-merge', { purpose: 'system', systemKind: 'merge-resolve', startedAt: T0 + 2 * HOUR }),
      call('s-mem', {
        purpose: 'system',
        taskId: null,
        systemKind: 'memory-distill',
        ownerUserId: 'u-member',
        startedAt: T0 + 2 * DAY,
      }),
      call('s-other', {
        purpose: 'system',
        taskId: null,
        systemKind: 'memory-distill',
        ownerUserId: 'u-other',
        startedAt: T0 + 2 * DAY,
      }),
    ]) {
      await calls.accept(input)
      await calls.finish(input.id, {
        status: 'done',
        endedAt: input.startedAt + 1,
        usage: { state: 'complete', models: [model('sonnet', 10, 1)] },
      })
    }
    const overview = await queries.overview(member, WINDOW)
    expect(overview.usage.calls).toBe(4)
    expect(overview.taskUsage.calls).toBe(2)
    expect(overview.systemUsage.calls).toBe(2)
    expect(overview.tasks.total).toBe(2)
    expect(overview.topTasks.map((row) => row.taskId).sort()).toEqual(['t-collab', 't-own'])

    expect(
      (await queries.tasks(member, { from: WINDOW.from, to: WINDOW.to })).items.map(
        (r) => r.taskId,
      ),
    ).toEqual(['t-collab', 't-own'])
    expect(await queries.task(member, 't-hidden')).toBeNull()
    expect((await queries.task(member, 't-own'))?.calls.map((c) => c.id)).toEqual([
      'c-own',
      's-merge',
    ])
    const system = await queries.system(member, { from: WINDOW.from, to: WINDOW.to })
    expect(system.recent.map((row) => row.id)).toEqual(['s-mem', 's-merge'])
    expect((await queries.models(member, WINDOW)).items[0]?.usage.calls).toBe(4)

    // Without task read permission nothing is aggregated.
    const nobody = { ...member, permissions: new Set<string>() } as unknown as Actor
    expect((await queries.overview(nobody, WINDOW)).usage.calls).toBe(0)
  })

  test('task and system pages are stable keyset pages', async () => {
    const db = harness.db
    await seedBase(db)
    const now = { value: T0 + 6 * DAY }
    const { calls, queries } = compose(db, now)
    const tied = T0 + 5 * DAY
    for (let i = 0; i < TASK_PAGE_SIZE + 2; i++)
      await seedTask(db, {
        id: `tie-${String(i).padStart(2, '0')}`,
        owner: 'u-member',
        startedAt: tied,
        status: 'done',
      })
    const first = await queries.tasks(admin, { from: WINDOW.from, to: WINDOW.to })
    expect(first.items).toHaveLength(TASK_PAGE_SIZE)
    expect(first.nextCursor).not.toBeNull()
    const second = await queries.tasks(admin, {
      from: WINDOW.from,
      to: WINDOW.to,
      cursor: first.nextCursor!,
    })
    const seen = [...first.items, ...second.items].map((row) => row.taskId)
    expect(new Set(seen).size).toBe(seen.length)
    expect(seen).toHaveLength(TASK_PAGE_SIZE + 2 + 3)
    expect(second.nextCursor).toBeNull()
    expect(
      (await queries.tasks(admin, { from: WINDOW.from, to: WINDOW.to, q: 'tie-0', status: 'done' }))
        .items,
    ).toHaveLength(10)

    for (let i = 0; i < SYSTEM_PAGE_SIZE + 3; i++)
      await calls.accept(
        call(`s-${String(i).padStart(3, '0')}`, {
          purpose: 'system',
          taskId: null,
          systemKind: 'intent',
          ownerUserId: 'u-member',
          startedAt: T0 + DAY,
        }),
      )
    const page1 = await queries.system(admin, { from: WINDOW.from, to: WINDOW.to })
    expect(page1.recent).toHaveLength(SYSTEM_PAGE_SIZE)
    const page2 = await queries.system(admin, {
      from: WINDOW.from,
      to: WINDOW.to,
      cursor: page1.nextCursor!,
    })
    expect(page2.recent).toHaveLength(3)
    expect(page2.nextCursor).toBeNull()
    const ids = [...page1.recent, ...page2.recent].map((row) => row.id)
    expect(new Set(ids).size).toBe(SYSTEM_PAGE_SIZE + 3)
    await expect(
      queries.system(admin, { from: WINDOW.from, to: WINDOW.to, cursor: 'not-a-cursor' }),
    ).rejects.toThrow('invalid-cursor')
  })
})

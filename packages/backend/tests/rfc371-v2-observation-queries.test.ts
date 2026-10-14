// RFC-371 v2 §5 (design/RFC-371-run-observability/redesign-v2-20261014.md):
// the read side's bounds, independent of storage. A non-administrator window
// with more tasks than the visible-task budget is marked partial instead of
// growing without bound, visibility is decided in batches of at most 500 ids,
// additive aggregates of each batch merge into one total, and the agent list is
// truncated at its limit.
import { expect, test } from 'bun:test'
import { buildActor } from '@/auth/actor'
import {
  AGENT_LIMIT,
  VISIBLE_TASK_BUDGET,
  createObservationQueries,
} from '@/modules/run-observability/application/observationQueries'
import type {
  CallAggregate,
  CallGroup,
  CallScope,
  CallStore,
} from '@/modules/run-observability/application/ports/callStore'
import type { ObservationTaskFactsPort } from '@/modules/run-observability/application/ports/taskFacts'

const WINDOW = { from: 0, to: 86_400_000, tzOffset: 0 }

function person(role: 'admin' | 'user') {
  return buildActor({
    user: { id: `u-${role}`, username: role, displayName: role, role, status: 'active' },
    source: 'session',
  })
}

function row(key: string | null, input: number, label: string | null = null): CallAggregate {
  return {
    key,
    label,
    calls: 1,
    incompleteCalls: 0,
    failedCalls: 0,
    input,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    costNano: 0,
    unpricedCalls: 0,
    durationMs: 0,
    tasks: 1,
    agents: 1,
  }
}

function harness(input: {
  readonly windowTasks: number
  readonly aggregate: (scope: CallScope, group: CallGroup) => CallAggregate[]
}) {
  const scopes: { readonly group: CallGroup; readonly scope: CallScope }[] = []
  const batches: number[] = []
  const store = {
    windowTaskIds: async (_from: number, _to: number, limit: number) =>
      Array.from({ length: Math.min(input.windowTasks, limit) }, (_, i) => `t${i}`),
    aggregate: async (filter: { readonly scope: CallScope }, group: CallGroup) => {
      scopes.push({ group, scope: filter.scope })
      return input.aggregate(filter.scope, group)
    },
    aggregateModels: async () => [],
    recentCalls: async () => ({ calls: [], models: [] }),
  } as unknown as CallStore
  const tasks: ObservationTaskFactsPort = {
    // Every second task is visible to the member.
    visibleTaskIds: async (_actor, ids) => {
      batches.push(ids.length)
      return ids.filter((id) => Number(id.slice(1)) % 2 === 0)
    },
    summaries: async () => [],
    page: async () => ({ items: [], nextCursor: null }),
    counts: async () => ({ statuses: {}, durations: [] }),
    attempts: async () => [],
  }
  return {
    queries: createObservationQueries({ calls: store, tasks, clock: () => 42 }),
    scopes,
    batches,
  }
}

test('a member window over the visible-task budget is partial and decided in batches of 500', async () => {
  const { queries, scopes, batches } = harness({
    windowTasks: VISIBLE_TASK_BUDGET + 1,
    aggregate: (scope, group) =>
      group !== 'purpose' ? [] : scope.kind === 'owner' ? [row('system', 5)] : [row('task', 10)],
  })
  const overview = await queries.overview(person('user'), WINDOW)
  expect(overview.partial).toBe(true)
  expect(batches).toHaveLength(VISIBLE_TASK_BUDGET / 500)
  expect(batches.every((size) => size === 500)).toBe(true)

  const purposeScopes = scopes
    .filter((entry) => entry.group === 'purpose')
    .map((entry) => entry.scope)
  const taskScopes = purposeScopes.filter(
    (scope): scope is Extract<CallScope, { kind: 'tasks' }> => scope.kind === 'tasks',
  )
  // Half of the budgeted ids are visible: 10,000 ids in 20 batches, plus the member's own system calls.
  expect(taskScopes).toHaveLength(VISIBLE_TASK_BUDGET / 2 / 500)
  expect(taskScopes.every((scope) => scope.taskIds.length <= 500)).toBe(true)
  expect(new Set(taskScopes.flatMap((scope) => scope.taskIds)).size).toBe(VISIBLE_TASK_BUDGET / 2)
  expect(purposeScopes.filter((scope) => scope.kind === 'owner')).toEqual([
    { kind: 'owner', userId: 'u-user' },
  ])
  // Per-batch aggregates are additive.
  expect(overview.taskUsage).toMatchObject({ calls: 20, input: 200 })
  expect(overview.systemUsage).toMatchObject({ calls: 1, input: 5 })
  expect(overview.usage).toMatchObject({ calls: 21, input: 205 })
})

test('a window within the budget is complete, and an administrator never batches visibility', async () => {
  const within = harness({ windowTasks: VISIBLE_TASK_BUDGET, aggregate: () => [] })
  expect((await within.queries.overview(person('user'), WINDOW)).partial).toBe(false)

  const admin = harness({ windowTasks: VISIBLE_TASK_BUDGET + 1, aggregate: () => [] })
  const overview = await admin.queries.overview(person('admin'), WINDOW)
  expect(overview.partial).toBe(false)
  expect(admin.batches).toEqual([])
  expect(new Set(admin.scopes.map((entry) => entry.scope.kind))).toEqual(new Set(['all']))
})

test('the agent list is ordered by tokens, merged across batches and truncated at its limit', async () => {
  const { queries } = harness({
    windowTasks: 2_000,
    aggregate: (scope, group) => {
      if (group !== 'agent' || scope.kind === 'owner') return []
      return [
        row('a-shared', 1_000, 'shared'),
        ...Array.from({ length: AGENT_LIMIT }, (_, i) =>
          row(`a-${scope.kind === 'tasks' ? scope.taskIds[0] : 'all'}-${i}`, i + 1),
        ),
      ]
    },
  })
  const page = await queries.agents(person('user'), WINDOW)
  const tokens = page.items.map((item) => item.usage.input)
  expect(page.truncated).toBe(true)
  expect(page.items).toHaveLength(AGENT_LIMIT)
  // 1,000 visible ids form two batches; `a-shared` appears in both and merges into one row.
  expect(page.items[0]).toMatchObject({ agentId: 'a-shared', agentName: 'shared' })
  expect(page.items[0]?.usage.calls).toBe(2)
  expect(page.items[0]?.usage.input).toBe(2_000)
  expect([...tokens].sort((a, b) => b - a)).toEqual(tokens)
})

test('an actor without task read permission aggregates nothing', async () => {
  const { queries, scopes, batches } = harness({
    windowTasks: 10,
    aggregate: () => [row('task', 1)],
  })
  const nobody = { ...person('user'), permissions: new Set<string>() } as unknown as ReturnType<
    typeof person
  >
  const overview = await queries.overview(nobody, WINDOW)
  expect(overview.usage.calls).toBe(0)
  expect(scopes).toEqual([])
  expect(batches).toEqual([])
})

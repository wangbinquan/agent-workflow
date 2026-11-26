import { expect, test } from 'bun:test'
import { buildActor } from '@/auth/actor'
import { composeRunObservation } from '@/modules/run-observability/composition/runObservation'
import { createTaskObservationFacts } from '@/modules/task-execution/composition/taskObservationFacts'
import type {
  CallObservationStart,
  CallObservedUsage,
} from '@/modules/run-observability/public/participants'
import { describeEachProvider } from './helpers/eachProvider'

const admin = buildActor({
  user: {
    id: 'contract-admin',
    username: 'admin',
    displayName: 'Admin',
    role: 'admin',
    status: 'active',
  },
  source: 'session',
})
const window = { from: 1_000, to: 2_000 }
function call(id: string, startedAt: number, systemKind = 'intent'): CallObservationStart {
  return {
    id,
    startedAt,
    purpose: 'system',
    taskId: null,
    nodeRunId: null,
    systemKind,
    agentId: null,
    agentName: 'contract-agent',
    runtimeId: null,
    runtimeName: null,
    protocol: 'opencode',
  }
}
function usage(input: number): CallObservedUsage {
  return {
    state: 'complete',
    models: [
      { model: 'contract-model', input, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    ],
  }
}

describeEachProvider('run-observability assembled write and query contract', (harness) => {
  function compose() {
    return composeRunObservation({
      db: harness.db,
      tasks: createTaskObservationFacts(harness.db),
      runtimes: {
        async directory() {
          return { runtimes: [] }
        },
      },
      clock: () => 3_000,
    })
  }

  test('system windows are start-inclusive/end-exclusive and kind filtering preserves whole-window kind totals', async () => {
    const observation = compose()
    for (const [id, start, kind] of [
      ['before', 999, 'intent'],
      ['start', 1_000, 'intent'],
      ['inside', 1_999, 'narrative'],
      ['end', 2_000, 'intent'],
    ] as const)
      await observation.calls.accept(call(id, start, kind))
    const all = await observation.queries.system(admin, window)
    expect(all.recent.map((row) => row.id)).toEqual(['inside', 'start'])
    const filtered = await observation.queries.system(admin, { ...window, kind: 'intent' })
    expect(filtered.recent.map((row) => row.id)).toEqual(['start'])
    expect(filtered.kinds).toEqual(all.kinds)
    expect(filtered.kinds.map((row) => [row.kind, row.usage.calls]).sort()).toEqual([
      ['intent', 1],
      ['narrative', 1],
    ])
    expect(filtered.nextCursor).toBeNull()
  })

  test('concurrent finalization serializes each call and late progress cannot replace its final model snapshot', async () => {
    const { calls, queries } = compose()
    await calls.accept(call('serialized', 1_500))
    await Promise.all([
      calls.usage('serialized', usage(10)),
      calls.finish('serialized', { status: 'done', endedAt: 1_700, usage: usage(25) }),
      calls.usage('serialized', usage(999)),
      calls.finish('serialized', { status: 'failed', endedAt: 1_800, usage: usage(888) }),
    ])
    const page = await queries.system(admin, window)
    expect(page.recent).toHaveLength(1)
    expect(page.recent[0]).toMatchObject({ status: 'done', endedAt: 1_700, input: 25 })
    expect(page.kinds[0]!.usage).toMatchObject({ calls: 1, input: 25, failedCalls: 0 })
  })

  test('a full system page uses a constant query budget and a bounded lookahead', async () => {
    const { calls, queries } = compose()
    for (let index = 0; index < 63; index++) {
      await calls.accept(call(`page-${String(index).padStart(3, '0')}`, 1_500))
    }
    const recording = harness.recordStatements()
    try {
      const page = await queries.system(admin, window)
      expect(page.recent).toHaveLength(50)
      expect(page.nextCursor).not.toBeNull()
      const selects = recording.selects()
      expect(selects.length).toBeLessThanOrEqual(3)
      expect(selects.every((statement) => statement.rows <= 51)).toBe(true)
      expect(page.kinds[0]!.usage.calls).toBe(63)
    } finally {
      recording.stop()
    }
    const empty = await queries.system(admin, { from: 3_000, to: 4_000 })
    expect(empty).toMatchObject({ recent: [], kinds: [], nextCursor: null, partial: false })
  })
})

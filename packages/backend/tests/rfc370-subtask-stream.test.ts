// RFC-370 §9.2 V1/V2 — the neutral CrewStation subtask observation loop shared
// by hosted task executions and workspace commands. It makes no lifecycle
// decision: transport outages / 5xx / 429 never end it (capped backoff, resume
// from the durable cursor), 410 and other 4xx end it with a typed failure, an
// identity mismatch is never accepted as a result, and a failure of the
// caller's own consumer is surfaced unchanged instead of being retried.
import { describe, expect, test } from 'bun:test'
import type {
  BusinessEvent,
  BusinessEventPage,
  BusinessSubtask,
  CrewStationBusinessExecution,
} from '@/platform/crewstation/businessExecution'
import { CrewStationApiError } from '@/platform/crewstation/platformApi'
import {
  isTransientObservationError,
  observeSubtask,
  SubtaskObservationError,
} from '@/platform/crewstation/subtaskStream'

const target = { businessTaskId: 'parent', subtaskId: 'sub', attempt: 2 }
const event = (cursor: string, type: 'output' | 'result' = 'output'): BusinessEvent =>
  type === 'output'
    ? {
        taskId: 'parent',
        subtaskId: 'sub',
        attempt: 2,
        cursor,
        sourceEventId: cursor,
        occurredAt: new Date(0).toISOString(),
        type: 'output',
        data: { stream: 'stdout', text: cursor },
      }
    : {
        taskId: 'parent',
        subtaskId: 'sub',
        attempt: 2,
        cursor,
        sourceEventId: cursor,
        occurredAt: new Date(0).toISOString(),
        type: 'result',
        data: {
          exitCode: 0,
          reason: 'completed',
          stdout: '',
          stderr: '',
          truncated: false,
          finalCursor: cursor,
        },
      }
const apiError = (status: number) => new CrewStationApiError(status, 'test', `status ${status}`, {})

function fake(script: {
  pages?: (BusinessEventPage | Error)[]
  stream?: (signal?: AbortSignal) => AsyncGenerator<BusinessEvent>
  subtask?: () => BusinessSubtask
}) {
  const queries: unknown[] = []
  const pages = [...(script.pages ?? [])]
  const api: Pick<CrewStationBusinessExecution, 'events' | 'streamEvents'> &
    Partial<Pick<CrewStationBusinessExecution, 'getSubtask'>> = {
    ...(script.subtask === undefined ? {} : { getSubtask: async () => script.subtask!() }),
    async events(_task, query) {
      queries.push(query)
      const next = pages.shift() ?? { items: [], hasMore: false, nextCursor: null }
      if (next instanceof Error) throw next
      return next
    },
    streamEvents: (_task, _query, signal) =>
      script.stream?.(signal) ??
      (async function* () {
        yield* []
        throw new Error('disconnected')
      })(),
  }
  return { api, queries }
}
const page = (...items: BusinessEvent[]): BusinessEventPage => ({
  items,
  hasMore: false,
  nextCursor: items.at(-1)?.cursor ?? null,
})

describe('RFC-370 CrewStation subtask observation', () => {
  test('pages first, then the stream, delivering only events after the durable cursor', async () => {
    const delivered: string[] = []
    const { api, queries } = fake({
      pages: [{ ...page(event('c1'), event('c2')), hasMore: true }, page()],
      stream: async function* () {
        yield event('c2') // duplicate of the last durable cursor: skipped
        yield event('c3')
        yield event('c4', 'result')
      },
    })
    const end = await observeSubtask({
      api,
      target,
      after: 'c0',
      signal: new AbortController().signal,
      onEvent: async (e) => {
        delivered.push(e.cursor)
      },
    })
    expect(end).toMatchObject({ kind: 'result', cursor: 'c4', result: { reason: 'completed' } })
    expect(delivered).toEqual(['c1', 'c2', 'c3', 'c4'])
    expect(queries).toEqual([
      { after: 'c0', subtaskId: 'sub' },
      { after: 'c2', subtaskId: 'sub' },
    ])
  })

  test('transient failures reconnect from the last cursor with a capped backoff', async () => {
    const sleeps: number[] = []
    const failures = [
      apiError(503),
      apiError(429),
      apiError(408),
      new Error('socket hang up'),
      apiError(502),
      apiError(500),
      apiError(504),
      apiError(503),
    ]
    const { api, queries } = fake({ pages: [...failures, page(event('c9', 'result'))] })
    const reconnects: number[] = []
    const end = await observeSubtask({
      api,
      target,
      after: null,
      signal: new AbortController().signal,
      onEvent: async () => undefined,
      onReconnecting: (_error, attempt) => reconnects.push(attempt),
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    })
    expect(end.kind).toBe('result')
    expect(sleeps).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000])
    expect(reconnects).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(queries).toHaveLength(9)
    expect(isTransientObservationError(apiError(400))).toBe(false)
    expect(isTransientObservationError(new Error('transport'))).toBe(true)
  })

  test('expired history and rejected requests end the observation with a typed failure', async () => {
    for (const [status, failure] of [
      [410, 'expired'],
      [404, 'rejected'],
      [422, 'rejected'],
    ] as const) {
      const { api } = fake({ pages: [apiError(status)] })
      const observation = observeSubtask({
        api,
        target,
        after: null,
        signal: new AbortController().signal,
        onEvent: async () => undefined,
      })
      await expect(observation).rejects.toBeInstanceOf(SubtaskObservationError)
      await observation.catch((error: SubtaskObservationError) => {
        expect(error.failure).toBe(failure)
        expect(error.status).toBe(status)
      })
    }
  })

  test('events of another attempt and results with a foreign cursor are identity failures', async () => {
    const foreign = { ...event('c1'), attempt: 1 }
    const badResult = event('c2', 'result')
    if (badResult.type !== 'result') throw new Error('fixture')
    for (const item of [foreign, { ...badResult, data: { ...badResult.data, finalCursor: 'x' } }]) {
      const delivered: string[] = []
      const { api } = fake({ pages: [page(item)] })
      await expect(
        observeSubtask({
          api,
          target,
          after: null,
          signal: new AbortController().signal,
          onEvent: async (e) => {
            delivered.push(e.cursor)
          },
        }),
      ).rejects.toMatchObject({ failure: 'identity' })
      expect(delivered).toEqual([])
    }
  })

  test("a failure of the caller's consumer is surfaced unchanged and never retried", async () => {
    let calls = 0
    const crash = new Error('projection crashed')
    const { api, queries } = fake({ pages: [page(event('c1')), page(event('c1'))] })
    await expect(
      observeSubtask({
        api,
        target,
        after: null,
        signal: new AbortController().signal,
        onEvent: async () => {
          calls += 1
          throw crash
        },
      }),
    ).rejects.toBe(crash)
    expect(calls).toBe(1)
    expect(queries).toHaveLength(1)
  })

  test('the signal and the active predicate stop the observation without touching the subtask', async () => {
    const controller = new AbortController()
    const streaming = fake({
      stream: async function* (signal) {
        controller.abort('any reason')
        if (signal !== undefined && !signal.aborted)
          await new Promise((resolve) => signal.addEventListener('abort', resolve))
        yield* []
      },
    })
    expect(
      await observeSubtask({
        api: streaming.api,
        target,
        after: null,
        signal: controller.signal,
        onEvent: async () => undefined,
      }),
    ).toEqual({ kind: 'stopped' })

    let active = true
    const moving = fake({
      stream: async function* () {
        active = false
        yield* []
        throw new Error('disconnected')
      },
    })
    expect(
      await observeSubtask({
        api: moving.api,
        target,
        after: null,
        signal: new AbortController().signal,
        active: () => active,
        onEvent: async () => undefined,
        sleep: async () => undefined,
      }),
    ).toEqual({ kind: 'stopped' })
    expect(moving.queries).toHaveLength(1)
  })

  // RFC-370 hosted acceptance (2026-10-19): the platform ended a cancelled
  // Agent subtask without the result event its events must end with. The
  // owner waited for it forever, keeping `system:shared` in use; its parent
  // never paused and held a quota slot.
  describe('a subtask the platform already ended', () => {
    const cleanEnd = async function* (): AsyncGenerator<BusinessEvent> {
      yield* []
    }
    const view = (state: string, result?: BusinessEvent & { type: 'result' }): BusinessSubtask => ({
      id: 'sub',
      taskId: 'parent',
      kind: 'agent',
      attempt: 2,
      state,
      executionId: 'execution',
      ...(result === undefined ? {} : { result: result.data }),
      ...(state === 'failed'
        ? { error: { code: 'agent_environment_unavailable', message: 'x' } }
        : {}),
    })
    test('without a result event ends the observation instead of waiting forever', async () => {
      const { api, queries } = fake({ stream: cleanEnd, subtask: () => view('failed') })
      const observation = observeSubtask({
        api,
        target,
        after: 'c1',
        signal: new AbortController().signal,
        onEvent: async () => {},
      })
      await expect(observation).rejects.toMatchObject({
        name: 'SubtaskObservationError',
        failure: 'ended',
      })
      await observation.catch((error: SubtaskObservationError) => {
        expect(error.message).toContain('failed: agent_environment_unavailable')
      })
      // The page is read again before concluding, in case the result was written meanwhile.
      expect(queries).toHaveLength(2)
    })
    test('with a result in its view journals that result as its event', async () => {
      const ended = event('c9', 'result') as BusinessEvent & { type: 'result' }
      const delivered: BusinessEvent[] = []
      const { api } = fake({ stream: cleanEnd, subtask: () => view('cancelled', ended) })
      const end = await observeSubtask({
        api,
        target,
        after: 'c1',
        signal: new AbortController().signal,
        onEvent: async (e) => {
          delivered.push(e)
        },
      })
      expect(end).toEqual({ kind: 'result', result: ended.data, cursor: 'c9' })
      expect(delivered).toHaveLength(1)
      expect(delivered[0]).toMatchObject({
        type: 'result',
        cursor: 'c9',
        subtaskId: 'sub',
        attempt: 2,
      })
    })
    test('that still runs keeps being observed', async () => {
      let streams = 0
      const { api } = fake({
        stream: () =>
          streams++ === 0
            ? cleanEnd()
            : (async function* () {
                yield event('c5', 'result')
              })(),
        subtask: () => view('running'),
      })
      const end = await observeSubtask({
        api,
        target,
        after: 'c1',
        signal: new AbortController().signal,
        onEvent: async () => {},
      })
      expect(end).toMatchObject({ kind: 'result', cursor: 'c5' })
    })
  })
})

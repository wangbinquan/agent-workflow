// RFC-061 PR-B T9-extra — eventToWakeReason + wakeForEvents tests.

import { describe, expect, test } from 'bun:test'

import { eventToWakeReason, wakeForEvents } from '../src/scheduler-v2/eventApplierWakeBridge'
import { taskActorRegistry } from '../src/scheduler-v2/actorRegistry'
import type { Event } from '@agent-workflow/shared'

function evt<K extends Event['kind']>(kind: K, over: Partial<Event<K>> = {}): Event<K> {
  return {
    id: 'evt_x',
    taskId: 't1',
    ts: 1,
    kind,
    nodeId: null,
    loopIter: null,
    shardKey: null,
    iter: null,
    attemptId: null,
    parentEventId: null,
    actor: 'system',
    resolutionId: null,
    payload: {} as never,
    ...(over as object),
  } as Event<K>
}

describe('eventToWakeReason', () => {
  test('attempt-finished-success → attempt-exit success', () => {
    const r = eventToWakeReason(evt('attempt-finished-success', { attemptId: 'a1' }))
    expect(r?.kind).toBe('attempt-exit')
    if (r?.kind === 'attempt-exit') {
      expect(r.outcome).toBe('success')
      expect(r.attemptId).toBe('a1')
    }
  })

  test('attempt-finished-envelope-fail → attempt-exit with reason', () => {
    const r = eventToWakeReason(
      evt('attempt-finished-envelope-fail', {
        attemptId: 'a1',
        payload: { reason: 'no closing tag' } as never,
      }),
    )
    if (r?.kind !== 'attempt-exit') throw new Error('expected attempt-exit')
    expect(r.outcome).toBe('envelope-fail')
    expect(r.reason).toBe('no closing tag')
  })

  test('attempt-finished-crash → attempt-exit with exitCode + errorMessage', () => {
    const r = eventToWakeReason(
      evt('attempt-finished-crash', {
        attemptId: 'a1',
        payload: { exitCode: 137, errorMessage: 'OOM' } as never,
      }),
    )
    if (r?.kind !== 'attempt-exit') throw new Error('expected attempt-exit')
    expect(r.exitCode).toBe(137)
    expect(r.errorMessage).toBe('OOM')
  })

  test('attempt-finished-timeout → attempt-exit timeout', () => {
    const r = eventToWakeReason(
      evt('attempt-finished-timeout', {
        attemptId: 'a1',
        payload: { timeoutMs: 60000 } as never,
      }),
    )
    expect(r?.kind).toBe('attempt-exit')
  })

  test('attempt-canceled → attempt-exit canceled with reason', () => {
    const r = eventToWakeReason(
      evt('attempt-canceled', {
        attemptId: 'a1',
        payload: { reason: 'user-cancel' } as never,
      }),
    )
    if (r?.kind !== 'attempt-exit') throw new Error('expected attempt-exit')
    expect(r.outcome).toBe('canceled')
    expect(r.reason).toBe('user-cancel')
  })

  test('task-canceled → cancel wake', () => {
    const r = eventToWakeReason(
      evt('task-canceled', { payload: { reason: 'user-canceled' } as never }),
    )
    expect(r?.kind).toBe('cancel')
    if (r?.kind === 'cancel') {
      expect(r.reason).toBe('user-canceled')
    }
  })

  test('projection-mutating events → event-applied', () => {
    const projections = [
      'logical-run-created',
      'logical-run-iter-bumped',
      'logical-run-completed',
      'logical-run-canceled',
      'attempt-started',
      'attempt-output-captured',
      'suspension-created',
      'suspension-resolved',
      'suspension-terminated',
    ] as const
    for (const k of projections) {
      const r = eventToWakeReason(evt(k, { payload: {} as never }))
      expect(r?.kind).toBe('event-applied')
    }
  })

  test('observer-only events → null (no wake)', () => {
    const observers = [
      'task-created',
      'task-started',
      'task-paused',
      'task-completed',
      'task-failed',
      'task-resumed-after-daemon-restart',
      'attempt-subagent-tool-use',
      'attempt-subagent-output',
      'invariant-alert-detected',
      'invariant-alert-resolved',
    ] as const
    for (const k of observers) {
      const r = eventToWakeReason(evt(k, { payload: {} as never }))
      expect(r).toBeNull()
    }
  })
})

describe('wakeForEvents', () => {
  test('delivers wakes to registered actors only', () => {
    taskActorRegistry.deregisterAll('test-isolate')
    const t1 = taskActorRegistry.register('t1')
    // Note: t2 NOT registered.
    const evs = [
      evt('logical-run-created', { taskId: 't1' }),
      evt('attempt-finished-success', { taskId: 't2', attemptId: 'a1' }),
      evt('suspension-created', { taskId: 't1' }),
    ]
    const delivered = wakeForEvents(evs)
    expect(delivered).toBe(2) // t1 got 2, t2 dropped
    expect(t1.queue.bufferedCount).toBe(2)
    taskActorRegistry.deregisterAll('cleanup')
  })

  test('observer-only events do not consume wake budget', () => {
    taskActorRegistry.deregisterAll('test-isolate')
    const a = taskActorRegistry.register('t1')
    const evs = [
      evt('task-started', { taskId: 't1' }),
      evt('task-completed', { taskId: 't1' }),
      evt('invariant-alert-detected', { taskId: 't1' }),
    ]
    const delivered = wakeForEvents(evs)
    expect(delivered).toBe(0)
    expect(a.queue.bufferedCount).toBe(0)
    taskActorRegistry.deregisterAll('cleanup')
  })

  test('empty batch → 0 wakes', () => {
    expect(wakeForEvents([])).toBe(0)
  })
})

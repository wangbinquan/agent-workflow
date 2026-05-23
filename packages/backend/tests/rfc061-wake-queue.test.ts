// RFC-061 PR-B T9 — WakeQueue + TaskActorRegistry unit tests.

import { describe, expect, test } from 'bun:test'

import { WakeQueue, type WakeReason } from '../src/scheduler-v2/wakeQueue'
import { TaskActorRegistry } from '../src/scheduler-v2/actorRegistry'

describe('WakeQueue', () => {
  test('FIFO ordering for buffered events', async () => {
    const q = new WakeQueue('t1')
    q.enqueue({ kind: 'event-applied', eventId: 'e1' })
    q.enqueue({ kind: 'event-applied', eventId: 'e2' })
    q.enqueue({ kind: 'event-applied', eventId: 'e3' })

    const r1 = await q.next()
    const r2 = await q.next()
    const r3 = await q.next()

    expect((r1?.reason as { eventId: string }).eventId).toBe('e1')
    expect((r2?.reason as { eventId: string }).eventId).toBe('e2')
    expect((r3?.reason as { eventId: string }).eventId).toBe('e3')
  })

  test('monotonic seq', async () => {
    const q = new WakeQueue('t1')
    q.enqueue({ kind: 'timer', purpose: 'retry-backoff' })
    q.enqueue({ kind: 'timer', purpose: 'retry-backoff' })
    const a = await q.next()
    const b = await q.next()
    expect(b!.seq).toBe((a!.seq ?? 0) + 1)
  })

  test('producer-after-consumer pattern: pending next resolves on enqueue', async () => {
    const q = new WakeQueue('t1')
    const pending = q.next()
    // schedule enqueue after a microtask tick
    queueMicrotask(() => q.enqueue({ kind: 'cancel', reason: 'test' }))
    const ev = await pending
    expect(ev?.reason.kind).toBe('cancel')
  })

  test('close() resolves pending readers with null', async () => {
    const q = new WakeQueue('t1')
    const pending = q.next()
    queueMicrotask(() => q.close())
    const ev = await pending
    expect(ev).toBeNull()
  })

  test('enqueue after close() is silently dropped', async () => {
    const q = new WakeQueue('t1')
    q.close()
    q.enqueue({ kind: 'cancel', reason: 'too late' })
    const ev = await q.next()
    expect(ev).toBeNull()
  })

  test('bufferedCount + drainSync test helpers', () => {
    const q = new WakeQueue('t1')
    q.enqueue({ kind: 'event-applied', eventId: 'e1' })
    q.enqueue({ kind: 'event-applied', eventId: 'e2' })
    expect(q.bufferedCount).toBe(2)
    const drained = q.drainSync()
    expect(drained).toHaveLength(2)
    expect(q.bufferedCount).toBe(0)
  })
})

describe('TaskActorRegistry', () => {
  test('register is idempotent on same taskId', () => {
    const reg = new TaskActorRegistry()
    const a1 = reg.register('t1')
    const a2 = reg.register('t1')
    expect(a1).toBe(a2)
    expect(reg.size()).toBe(1)
  })

  test('wake() routes reason to the right actor', async () => {
    const reg = new TaskActorRegistry()
    reg.register('t1')
    reg.register('t2')
    const ok = reg.wake('t1', { kind: 'event-applied', eventId: 'e1' })
    expect(ok).toBe(true)
    const a1 = reg.get('t1')!
    const a2 = reg.get('t2')!
    expect(a1.queue.bufferedCount).toBe(1)
    expect(a2.queue.bufferedCount).toBe(0)
  })

  test('wake() returns false for unknown taskId', () => {
    const reg = new TaskActorRegistry()
    expect(reg.wake('unknown', { kind: 'cancel', reason: 'x' })).toBe(false)
  })

  test('wakeAll() fans out to every actor', () => {
    const reg = new TaskActorRegistry()
    reg.register('t1')
    reg.register('t2')
    reg.register('t3')
    const reason: WakeReason = { kind: 'timer', purpose: 'invariant-scan' }
    expect(reg.wakeAll(reason)).toBe(3)
    expect(reg.get('t1')!.queue.bufferedCount).toBe(1)
    expect(reg.get('t2')!.queue.bufferedCount).toBe(1)
    expect(reg.get('t3')!.queue.bufferedCount).toBe(1)
  })

  test('deregister() aborts + closes + removes', async () => {
    const reg = new TaskActorRegistry()
    const a = reg.register('t1')
    const pending = a.queue.next()
    expect(reg.deregister('t1', 'test')).toBe(true)
    const ev = await pending
    expect(ev?.reason.kind).toBe('cancel')
    expect(reg.has('t1')).toBe(false)
    expect(a.abortController.signal.aborted).toBe(true)
    expect(a.queue.isClosed).toBe(true)
  })

  test('deregister() on unknown taskId is a no-op', () => {
    const reg = new TaskActorRegistry()
    expect(reg.deregister('nope', 'test')).toBe(false)
  })

  test('deregisterAll on shutdown clears every registered task', () => {
    const reg = new TaskActorRegistry()
    reg.register('t1')
    reg.register('t2')
    reg.register('t3')
    expect(reg.deregisterAll('shutdown')).toBe(3)
    expect(reg.size()).toBe(0)
  })

  test('taskIds() enumerates active tasks', () => {
    const reg = new TaskActorRegistry()
    reg.register('alpha')
    reg.register('beta')
    expect(reg.taskIds().sort()).toEqual(['alpha', 'beta'])
  })
})

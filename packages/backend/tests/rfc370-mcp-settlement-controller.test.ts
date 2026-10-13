// RFC-370: retry original receipts without invoking original execution again.
// These control-contract cases do not stand in for provider/physical proof.
import { expect, test } from 'bun:test'
import { McpDiagnosticsExecutionController } from '@/modules/resource-catalog/application/mcps/runtimeDiagnosticsExecution'
import { deferred } from './helpers/taskHostExecution'

async function fixture() {
  const controller = new McpDiagnosticsExecutionController()
  const lifetime = { current: () => true }
  await controller.start(lifetime, async () => {})
  const frame = controller.selected!
  return { controller, lifetime, frame }
}

test('a live original settlement reports fatal failure once and its old callback cannot report against a fresh lifetime', async () => {
  const controller = new McpDiagnosticsExecutionController(),
    failures: unknown[] = []
  let current = true,
    attempts = 0
  const original = new Error('original receipt ACK missing')
  const lifetime = {
    current: () => current,
    reportFailure(error: unknown) {
      failures.push(error)
      current = false
    },
  }
  await controller.start(lifetime, async () => {})
  const frame = controller.selected!
  await expect(
    controller.settle(frame, async () => {
      if (++attempts === 1) throw original
    }),
  ).rejects.toBe(original)
  expect(failures).toEqual([original])
  expect(frame.canDispatch()).toBe(false)
  controller.quiesce(lifetime)
  await controller.awaitDrained(lifetime)
  await controller.start({ current: () => true }, async () => {})
  frame.reportFailure(new Error('late original failure'))
  expect(failures).toEqual([original])
  expect(controller.selected!.canDispatch()).toBe(true)
})

test('nested execution tracking does not duplicate a retained receipt error as a permanent failure', async () => {
  const f = await fixture(),
    original = new Error('original-receipt-ack-lost')
  let attempts = 0
  await expect(
    f.controller.track(
      f.frame,
      () =>
        f.controller.settle(f.frame, async () => {
          if (++attempts === 1) throw original
        }),
      true,
    ),
  ).rejects.toBe(original)
  expect(f.frame.canDispatch()).toBe(false)
  f.controller.quiesce(f.lifetime)
  await f.controller.awaitDrained(f.lifetime)
  expect(attempts).toBe(2)
  expect(f.frame.drained).toBe(true)
})

test('persistent receipt failure attempts once per drain and never permits the next lifetime', async () => {
  const f = await fixture(),
    original = new Error('original-write-still-unacknowledged')
  let attempts = 0
  await expect(
    f.controller.settle(f.frame, async () => {
      attempts += 1
      throw original
    }),
  ).rejects.toBe(original)
  f.controller.quiesce(f.lifetime)
  await expect(f.controller.awaitDrained(f.lifetime)).rejects.toBe(original)
  expect(attempts).toBe(2)
  await expect(f.controller.start({ current: () => true }, async () => {})).rejects.toThrow(
    'prior-lifetime-not-drained',
  )
  await expect(f.controller.awaitDrained(f.lifetime)).rejects.toBe(original)
  expect(attempts).toBe(3)
})

test('periodic retry and concurrent drain share the pending original callback', async () => {
  const f = await fixture(),
    original = new Error('original-receipt-unconfirmed')
  const entered = deferred(),
    release = deferred()
  let attempts = 0
  await expect(
    f.controller.settle(f.frame, async () => {
      attempts += 1
      if (attempts === 1) throw original
      entered.resolve()
      await release.promise
    }),
  ).rejects.toBe(original)
  const retrying = f.controller.retrySettlements(f.frame)
  await entered.promise
  f.controller.quiesce(f.lifetime)
  const first = f.controller.awaitDrained(f.lifetime),
    second = f.controller.awaitDrained(f.lifetime)
  expect(first).toBe(second)
  expect(attempts).toBe(2)
  release.resolve()
  await retrying
  await first
  expect(attempts).toBe(2)
})

test('successful active receipt retry reopens only the same lifetime dispatch', async () => {
  const f = await fixture()
  let attempts = 0
  await expect(
    f.controller.settle(f.frame, async () => {
      if (++attempts === 1) throw new Error('original-ack')
    }),
  ).rejects.toThrow('original-ack')
  expect(f.frame.canDispatch()).toBe(false)
  await f.controller.retrySettlements(f.frame)
  expect(f.frame.canDispatch()).toBe(true)
  f.controller.quiesce(f.lifetime)
  await f.controller.awaitDrained(f.lifetime)
})

test('explicit session recovery retries no other session and cannot clear its unresolved receipt', async () => {
  const f = await fixture()
  let first = 0,
    second = 0
  await expect(
    f.controller.settle(
      f.frame,
      async () => {
        if (++first === 1) throw new Error('first-session-ack')
      },
      'first-session',
    ),
  ).rejects.toThrow('first-session-ack')
  await expect(
    f.controller.settle(
      f.frame,
      async () => {
        second += 1
        throw new Error('second-session-unproven')
      },
      'second-session',
    ),
  ).rejects.toThrow('second-session-unproven')
  await f.controller.retrySettlements(f.frame, 'first-session')
  expect(first).toBe(2)
  expect(second).toBe(1)
  expect(f.frame.canDispatch()).toBe(false)
  f.controller.quiesce(f.lifetime)
  await expect(f.controller.awaitDrained(f.lifetime)).rejects.toThrow('second-session-unproven')
})

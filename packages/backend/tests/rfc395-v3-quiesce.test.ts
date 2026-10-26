import { expect, test } from 'bun:test'
import {
  createLocalEpochQuiesce,
  type EpochStopProtocol,
} from '@/modules/system-operations/infrastructure/local/epochSwitchQuiesce'
import { createHostedEpochFreeze } from '@/modules/system-operations/infrastructure/epochSwitch/hostedFreeze'

for (const initial of ['live', 'stale', 'absent'] as const)
  test(`offline quiesce handles ${initial} daemon and owns its lock`, async () => {
    let pid: number | null = initial === 'absent' ? null : 123456
    let requests = 0
    let alive = initial === 'live'
    const protocol: EpochStopProtocol = {
      pid: () => pid,
      alive: () => alive,
      async request() {
        requests++
        alive = false
        pid = null
        return true
      },
      acquire() {
        if (alive) throw new Error('held')
        pid = process.pid
        return {
          pid: process.pid,
          path: 'lock',
          release() {
            pid = null
          },
        }
      },
      async wait() {
        throw new Error('no wait needed')
      },
    }
    const port = createLocalEpochQuiesce({ lockPath: 'lock', controlPath: 'control', protocol })
    const receipt = await port.quiesce({ operationId: 'operation', drainTimeoutMs: 1000 })
    expect(receipt.kind).toBe(initial === 'live' ? 'daemon-stopped' : 'already-stopped')
    expect(requests).toBe(initial === 'live' ? 1 : 0)
    await port.assertHeld('operation')
    await expect(port.assertHeld('different')).rejects.toThrow('lock-lost')
    await port.release('operation')
    expect(pid).toBeNull()
  })

test('drain timeout is retryable and sends only a graceful request', async () => {
  let now = 0
  let requests = 0
  const port = createLocalEpochQuiesce({
    lockPath: 'lock',
    controlPath: 'control',
    now: () => now,
    protocol: {
      pid: () => 123456,
      alive: () => true,
      async request() {
        requests++
        return true
      },
      acquire() {
        throw new Error('held')
      },
      async wait(ms) {
        now += ms
      },
    },
  })
  try {
    await port.quiesce({ operationId: 'operation', drainTimeoutMs: 250 })
    throw new Error('expected timeout')
  } catch (error) {
    expect(error).toMatchObject({ category: 'drain-timeout', retryable: true })
  }
  expect(requests).toBe(1)
  expect(now).toBe(250)
})

test('a missing Windows control endpoint is a failed drain, and hosted freeze must be revalidated', async () => {
  const local = createLocalEpochQuiesce({
    lockPath: 'lock',
    controlPath: 'control',
    platform: 'win32',
    protocol: {
      pid: () => 123456,
      alive: () => true,
      async request() {
        return false
      },
      acquire() {
        throw new Error('must not acquire')
      },
      async wait() {},
    },
  })
  await expect(local.quiesce({ operationId: 'operation', drainTimeoutMs: 100 })).rejects.toThrow(
    'drain-timeout',
  )
  let frozen = true
  const hosted = createHostedEpochFreeze({
    acknowledgement: {
      operationId: 'operation',
      reference: 'freeze:1',
      sourceGenerationId: 'source',
      writersStopped: true,
    },
    async verify() {
      return frozen
    },
  })
  expect((await hosted.quiesce({ operationId: 'operation', drainTimeoutMs: 100 })).kind).toBe(
    'platform-frozen',
  )
  await hosted.release('operation')
  frozen = false
  await expect(hosted.assertHeld('operation')).rejects.toThrow('freeze-required')
})

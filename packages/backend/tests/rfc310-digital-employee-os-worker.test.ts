import { describe, expect, test } from 'bun:test'

import { runDigitalEmployeeOsCycle } from '@/modules/digital-employee/application/osWorker'
import { runEventCenterCycle } from '@/modules/event-center/application/eventCenterWorker'

describe('RFC-310 durable Digital Employee OS worker', () => {
  test('drives delivery, reaction, outbox and settlement in deterministic order', async () => {
    const calls: string[] = []
    let cycle = 0
    const result = await runDigitalEmployeeOsCycle(
      {
        runtime: {
          async publishOneChannelResult() {
            return 'idle'
          },
          async pumpOneDelivery() {
            calls.push(`delivery:${cycle}`)
            return cycle === 0
          },
          async planOneReaction() {
            calls.push(`plan:${cycle}`)
            return cycle === 0 ? 'round-1' : null
          },
          async runOneOutbox() {
            calls.push(`outbox:${cycle}`)
            return cycle === 0 ? 'completed' : 'idle'
          },
          async inspectOneExecution() {
            calls.push(`inspect:${cycle}`)
            const result = cycle === 0 ? 'completed' : 'idle'
            cycle += 1
            return result
          },
        },
      },
      8,
    )

    expect(calls).toEqual([
      'delivery:0',
      'plan:0',
      'outbox:0',
      'inspect:0',
      'delivery:1',
      'plan:1',
      'outbox:1',
      'inspect:1',
    ])
    expect(result).toEqual({
      steps: 1,
      deliveries: 1,
      plannedRounds: 1,
      outboxSettlements: 1,
      executionSettlements: 1,
      channelResults: 0,
      madeProgress: true,
    })
  })

  test('is bounded even when every durable owner continuously reports progress', async () => {
    const result = await runDigitalEmployeeOsCycle(
      {
        runtime: {
          publishOneChannelResult: async () => 'idle',
          pumpOneDelivery: async () => true,
          planOneReaction: async () => 'round',
          runOneOutbox: async () => 'completed',
          inspectOneExecution: async () => 'completed',
        },
      },
      3,
    )
    expect(result.steps).toBe(3)
    expect(result.plannedRounds).toBe(3)
  })

  test('keeps the global event worker independent from employee business processing', async () => {
    const calls: string[] = []
    let cycle = 0
    const result = await runEventCenterCycle(
      {
        async runOneDueObserver() {
          calls.push(`observer:${cycle}`)
          return cycle === 0 ? 'completed' : 'idle'
        },
        async runOneNotification() {
          calls.push(`notification:${cycle}`)
          const outcome = cycle === 0 ? 'completed' : 'idle'
          cycle += 1
          return outcome
        },
      },
      8,
    )

    expect(calls).toEqual(['observer:0', 'notification:0', 'observer:1', 'notification:1'])
    expect(result).toEqual({
      steps: 1,
      publicationRuns: 0,
      observerRuns: 1,
      notificationDeliveries: 1,
      madeProgress: true,
    })
  })
})

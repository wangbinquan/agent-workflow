import { describe, expect, test } from 'bun:test'

import { runDigitalEmployeeOsCycle } from '@/modules/digital-employee/application/osWorker'

describe('RFC-310 durable Digital Employee OS worker', () => {
  test('drives observer, delivery, reaction, outbox and settlement in deterministic order', async () => {
    const calls: string[] = []
    let cycle = 0
    const result = await runDigitalEmployeeOsCycle(
      {
        eventCenter: {
          async runOneDueObserver() {
            calls.push(`observer:${cycle}`)
            return cycle === 0 ? 'completed' : 'idle'
          },
        },
        runtime: {
          publishOneChannelResult() {
            return 'idle'
          },
          pumpOneDelivery() {
            calls.push(`delivery:${cycle}`)
            return cycle === 0
          },
          planOneReaction() {
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
      'observer:0',
      'delivery:0',
      'plan:0',
      'outbox:0',
      'inspect:0',
      'observer:1',
      'delivery:1',
      'plan:1',
      'outbox:1',
      'inspect:1',
    ])
    expect(result).toEqual({
      steps: 1,
      observerRuns: 1,
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
        eventCenter: { runOneDueObserver: async () => 'completed' },
        runtime: {
          publishOneChannelResult: () => 'idle',
          pumpOneDelivery: () => true,
          planOneReaction: () => 'round',
          runOneOutbox: async () => 'completed',
          inspectOneExecution: async () => 'completed',
        },
      },
      3,
    )
    expect(result.steps).toBe(3)
    expect(result.plannedRounds).toBe(3)
  })
})

import { expect, test } from 'bun:test'
import { createCallPersistence } from '@/modules/run-observability/infrastructure/callPersistence'
import type { NewCall } from '@/modules/run-observability/application/ports/callStore'
import { describeEachProvider } from './helpers/eachProvider'

describeEachProvider('RFC-370 stable observation call during adopt', (harness) => {
  const call: NewCall = {
    id: 'hosted-agent:run',
    purpose: 'system',
    taskId: null,
    nodeRunId: null,
    systemKind: 'review',
    systemLabel: 'review',
    ownerUserId: null,
    agentId: null,
    agentName: 'reviewer',
    runtimeId: null,
    runtimeName: 'opencode',
    protocol: 'opencode',
    startedAt: 100,
  }
  test('adopt retains accepted start time and model usage and reopens only that same identity', async () => {
    const store = createCallPersistence(harness.db)
    await store.insert(call, 100)
    const totals = { input: 12, cacheRead: 0, cacheWrite: 0, output: 4, reasoning: 0 }
    await store.writeUsage(call.id, {
      usageState: 'complete',
      totals,
      costNano: 0,
      costState: 'unpriced',
      models: [
        { ...totals, model: 'actual/model', priceId: null, costNano: null, costState: 'unpriced' },
      ],
      updatedAt: 200,
      end: { status: 'interrupted', endedAt: 200 },
    })
    await store.insert({ ...call, startedAt: 300 }, 300)
    const result = await store.recentCalls({ scope: { kind: 'all' } }, null, 10)
    expect(result.calls).toHaveLength(1)
    expect(result.calls[0]).toMatchObject({
      startedAt: 100,
      status: 'running',
      endedAt: null,
      input: 12,
      output: 4,
    })
    expect(result.models).toHaveLength(1)
    for (const change of [
      { agentName: 'other' },
      { protocol: 'claude-code' },
      { systemKind: 'memory' },
      { ownerUserId: 'other' },
    ])
      await expect(store.insert({ ...call, ...change }, 400)).rejects.toThrow(
        'observation-call-identity-mismatch',
      )
  })
})

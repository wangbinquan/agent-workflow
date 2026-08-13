import { describe, expect, test } from 'vitest'

import {
  acceptWebhookAgentResolution,
  applyWebhookAgentPending,
  initialWebhookAgentResolution,
  startWebhookAgentResolution,
  type WebhookAgentResolutionResult,
} from '../src/components/webhooks/webhookAgentResolution'

function resolved(
  agentId: string,
  requestGeneration: number,
  detailRevision: number,
  structureSignature: string,
): WebhookAgentResolutionResult<string> {
  return {
    kind: 'resolved',
    agentId,
    requestGeneration,
    detailRevision,
    structureSignature,
    value: `${agentId}:${detailRevision}:${structureSignature}`,
  }
}

describe('Webhook Agent resolution', () => {
  test('A-slow -> B-fast -> A-late 不让旧 Agent 结果污染当前 target', () => {
    let state = startWebhookAgentResolution(initialWebhookAgentResolution<string>(), 'A', 1)
    state = startWebhookAgentResolution(state, 'B', 2)
    state = acceptWebhookAgentResolution(state, resolved('B', 2, 20, 'ported:b'), false)
    const afterB = state
    state = acceptWebhookAgentResolution(state, resolved('A', 1, 10, 'zero'), false)

    expect(state).toBe(afterB)
    expect(state.current?.agentId).toBe('B')
  })

  test('刷新期间相同结构只更新 revision，不进入 pending 或 remount 状态', () => {
    let state = startWebhookAgentResolution(initialWebhookAgentResolution<string>(), 'A', 1)
    state = acceptWebhookAgentResolution(state, resolved('A', 1, 10, 'ported:a'), false)
    state = startWebhookAgentResolution(state, 'A', 2)
    state = acceptWebhookAgentResolution(state, resolved('A', 2, 11, 'ported:a'), true)

    expect(state.pending).toBeNull()
    expect(state.refreshing).toBe(false)
    expect(state.current).toMatchObject({ detailRevision: 11, structureSignature: 'ported:a' })
  })

  test('跨 generation pending latest-wins，旧 Apply 完整 CAS 失配且零副作用', () => {
    let state = startWebhookAgentResolution(initialWebhookAgentResolution<string>(), 'A', 1)
    state = acceptWebhookAgentResolution(state, resolved('A', 1, 10, 'ported:a'), false)
    state = startWebhookAgentResolution(state, 'A', 2)
    state = acceptWebhookAgentResolution(state, resolved('A', 2, 20, 'ported:b'), true)
    const oldIdentity = state.pending!.identity

    state = startWebhookAgentResolution(state, 'A', 3)
    state = acceptWebhookAgentResolution(state, resolved('A', 3, 30, 'ported:c'), true)
    const beforeStaleApply = state
    state = applyWebhookAgentPending(state, oldIdentity)

    expect(state).toBe(beforeStaleApply)
    expect(state.pending?.result).toMatchObject({ requestGeneration: 3, detailRevision: 30 })
    state = applyWebhookAgentPending(state, state.pending!.identity)
    expect(state.current).toMatchObject({ requestGeneration: 3, detailRevision: 30 })
  })

  test('同 generation A pending 被 B 替换，旧 handler 不能提前解 fence', () => {
    let state = startWebhookAgentResolution(initialWebhookAgentResolution<string>(), 'A', 1)
    state = acceptWebhookAgentResolution(state, resolved('A', 1, 10, 'zero'), false)
    state = startWebhookAgentResolution(state, 'A', 2)
    state = acceptWebhookAgentResolution(state, resolved('A', 2, 20, 'ported:a'), true)
    const stale = state.pending!.identity
    state = acceptWebhookAgentResolution(state, resolved('A', 2, 21, 'ported:b'), true)

    expect(state.pending?.identity.pendingResultSeq).not.toBe(stale.pendingResultSeq)
    const before = state
    state = applyWebhookAgentPending(state, stale)
    expect(state).toBe(before)
    expect(state.refreshing).toBe(true)
    state = applyWebhookAgentPending(state, state.pending!.identity)
    expect(state.current).toMatchObject({ detailRevision: 21, structureSignature: 'ported:b' })
    expect(state.refreshing).toBe(false)
  })
})

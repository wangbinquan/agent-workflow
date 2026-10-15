// RFC-370 v2 H7 (design/RFC-370-crewstation-hosted-deployment/redesign-v2-20261014.md):
// the wire contract of `GET /api/execution/status` and the single availability
// rule every gate shares — only an `active` instance executes work.
import { describe, expect, test } from 'bun:test'
import {
  ExecutionGroupSchema,
  ExecutionStatusSchema,
  isExecutionAvailable,
  type ExecutionStatus,
} from '../src'

describe('RFC-370 v2 execution status', () => {
  test('accepts the three states of both deployments and rejects anything else', () => {
    for (const mode of ['standalone', 'crewstation'] as const)
      for (const state of ['active', 'standby', 'frozen'] as const)
        expect(ExecutionStatusSchema.parse({ mode, state, reason: null })).toEqual({
          mode,
          state,
          reason: null,
        })
    expect(ExecutionStatusSchema.safeParse({ mode: 'native', status: null }).success).toBe(false)
    expect(
      ExecutionStatusSchema.safeParse({ mode: 'crewstation', state: 'draining', reason: null })
        .success,
    ).toBe(false)
    expect(
      ExecutionStatusSchema.safeParse({
        mode: 'standalone',
        state: 'active',
        reason: null,
        extra: true,
      }).success,
    ).toBe(false)
  })

  test('only an active instance is available', () => {
    const status = (state: ExecutionStatus['state']): ExecutionStatus => ({
      mode: 'crewstation',
      state,
      reason: state === 'active' ? null : 'lease',
    })
    expect(isExecutionAvailable(status('active'))).toBe(true)
    expect(isExecutionAvailable(status('standby'))).toBe(false)
    expect(isExecutionAvailable(status('frozen'))).toBe(false)
    expect(isExecutionAvailable({ mode: 'standalone', state: 'active', reason: null })).toBe(true)
  })

  test('keeps the route execution groups', () => {
    expect(ExecutionGroupSchema.options).toEqual([
      'task',
      'intent',
      'purpose',
      'diagnostics',
      'verification',
      'memory',
      'development',
      'digital-employee',
      'event-dispatch',
      'knowledge',
      'maintenance',
    ])
  })
})

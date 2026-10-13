// RFC-370: API presentation must distinguish native owners from selected
// readiness; resource-only and incomplete activation cannot enable execution.
import { expect, test } from 'bun:test'
import {
  HostExecutionGroupSchema,
  HostExecutionStatusSchema,
  isHostExecutionGroupReady,
  type HostExecutionStatus,
} from '../src/schemas/hostExecutionStatus'

test('native presentation has no invented host grant or ready-group receipt', () => {
  const view = HostExecutionStatusSchema.parse({ mode: 'native', status: null })
  for (const group of HostExecutionGroupSchema.options)
    expect(isHostExecutionGroupReady(view, group)).toBe(true)
  expect(
    HostExecutionStatusSchema.safeParse({ mode: 'native', status: { phase: 'active' } }).success,
  ).toBe(false)
})

test('only an active selected group is ready, even when another group is available', () => {
  for (const phase of ['standby', 'preparing', 'active', 'draining', 'closed'] as const) {
    const view: HostExecutionStatus = {
      mode: 'execution',
      status: { phase, generation: 'actual-generation', readyGroups: ['task'], reason: null },
    }
    expect(HostExecutionStatusSchema.safeParse(view).success).toBe(true)
    for (const group of HostExecutionGroupSchema.options)
      expect(isHostExecutionGroupReady(view, group)).toBe(phase === 'active' && group === 'task')
  }
})

test('resource-only never enables execution from a stale or incorrectly populated group list', () => {
  const view: HostExecutionStatus = {
    mode: 'resource-only',
    status: {
      phase: 'active',
      generation: 'resource-generation',
      readyGroups: [...HostExecutionGroupSchema.options],
      reason: null,
    },
  }
  for (const group of HostExecutionGroupSchema.options)
    expect(isHostExecutionGroupReady(view, group)).toBe(false)
})

test('unknown execution modes, phases, groups and empty generations fail the wire contract', () => {
  const view = {
    mode: 'execution',
    status: { phase: 'active', generation: 'generation', readyGroups: ['task'], reason: null },
  }
  for (const invalid of [
    { ...view, mode: 'fallback' },
    { ...view, status: { ...view.status, phase: 'ready' } },
    { ...view, status: { ...view.status, readyGroups: ['unknown-owner'] } },
    { ...view, status: { ...view.status, generation: '' } },
  ])
    expect(HostExecutionStatusSchema.safeParse(invalid).success).toBe(false)
})

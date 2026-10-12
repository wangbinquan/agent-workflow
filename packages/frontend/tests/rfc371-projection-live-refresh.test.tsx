// RFC-371: shared-cutoff period reuse, committed-version refresh, reconnect and
// quiet HTTP fallback. No browser action starts a numerical build.
import { createElement, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { WS_PATHS } from '@agent-workflow/shared'
import { observationPresetRange } from '../src/components/observability/observationPresetRange'
import { useObservationProjectionVersion } from '../src/components/observability/useObservationProjectionVersion'

const fake = vi.hoisted(() => ({ get: vi.fn(), subscription: vi.fn() }))
vi.mock('../src/api/client', () => ({ api: { get: fake.get } }))
vi.mock('../src/hooks/useWsInvalidation', () => ({ useWsInvalidation: fake.subscription }))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})
const wrapper =
  (client: QueryClient) =>
  ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children)
test('seven/thirty day switches share one cutoff and cache identity', () => {
  const cutoff = Date.parse('2026-10-12T02:03:04Z')
  const week = observationPresetRange('week', cutoff),
    month = observationPresetRange('month', cutoff)
  expect(week.to).toBe(month.to)
  expect(month.from).toBe(cutoff - 30 * 86400000)
  expect(week.from).toBe(cutoff - 7 * 86400000)
  expect(observationPresetRange('all', cutoff)).toEqual({ from: 0, to: cutoff })
})
test('commit/reconnect reconciles the small version endpoint and enables existing query refresh', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  fake.get
    .mockResolvedValueOnce({ revision: '1', asOf: 100 })
    .mockResolvedValue({ revision: '2', asOf: 200 })
  const hook = renderHook(() => useObservationProjectionVersion(true), { wrapper: wrapper(client) })
  await waitFor(() => expect(hook.result.current?.revision).toBe('1'))
  const [path, rules, , options] = fake.subscription.mock.calls.at(-1)!
  expect(path).toBe(WS_PATHS.observability)
  expect(options.coalesceMs).toBe(250)
  const keys = rules['observability.projection.changed']({
    type: 'observability.projection.changed',
    revision: '2',
    asOf: 200,
  })
  for (const queryKey of keys) await client.invalidateQueries({ queryKey })
  await waitFor(() => expect(hook.result.current?.revision).toBe('2'))
  expect(options.reconcileOnOpen()).toEqual(keys)
  expect(
    fake.get.mock.calls.every(([path]) => path === '/api/observability/projection-version'),
  ).toBe(true)
  client.clear()
})
test('a disabled surface does not subscribe or request a report', () => {
  const client = new QueryClient()
  renderHook(() => useObservationProjectionVersion(false), { wrapper: wrapper(client) })
  expect(fake.subscription.mock.calls.at(-1)![0]).toBeNull()
  expect(fake.get).not.toHaveBeenCalled()
  client.clear()
})

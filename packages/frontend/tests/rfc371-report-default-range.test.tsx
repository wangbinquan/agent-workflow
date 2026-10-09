// RFC-371: browser reload must reuse the actual default range already shown by the page.
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { ObservationSearch } from '../src/components/observability/RunObservability'

vi.mock('../src/components/observability/CompleteRunObservability', () => ({
  CompleteRunObservability: ({
    search,
    onChange,
  }: {
    search: ObservationSearch
    onChange: (search: ObservationSearch) => void
  }) => (
    <>
      <output data-testid="actual-range">{JSON.stringify(search)}</output>
      <button
        type="button"
        onClick={() =>
          onChange({ ...search, from: 1100, to: 1200, period: 'custom', tab: 'tasks' })
        }
      >
        Trend drilldown
      </button>
      <button
        type="button"
        onClick={() =>
          onChange({ ...search, from: 3000, to: 4000, period: 'custom', tab: 'overview' })
        }
      >
        Another range
      </button>
    </>
  ),
}))

import { Route, validateObservationSearch } from '../src/routes/observability'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function mountRoute(url: string) {
  const root = createRootRoute({ component: () => <Outlet /> })
  const observation = createRoute({
    getParentRoute: () => root,
    path: '/observability',
    validateSearch: validateObservationSearch,
    component: Route.options.component,
  })
  const history = createMemoryHistory({ initialEntries: [url] })
  const replace = vi.spyOn(history, 'replace')
  const router = createRouter({ routeTree: root.addChildren([observation]), history })
  render(
    // The focused route tree preserves the production /observability match and hooks.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    <RouterProvider router={router as any} />,
  )
  return { router, history, replace }
}

test('default range is replaced with the same validated values and all adjacent search fields', async () => {
  const { router, history, replace } = mountRoute(
    '/observability?tab=usage&task=task-id&attempt=attempt-id&span=span-id&agent=agent-id&quality=gap&cohort=usage&q=original',
  )
  const visible = JSON.parse(
    (await screen.findByTestId('actual-range')).textContent!,
  ) as ObservationSearch
  await waitFor(() => expect(router.state.location.searchStr).toContain('from='))
  expect(router.state.location.search).toEqual(visible)
  expect(visible.to - visible.from).toBe(7 * 86400000)
  expect(visible).toMatchObject({
    tab: 'usage',
    task: 'task-id',
    attempt: 'attempt-id',
    span: 'span-id',
    agent: 'agent-id',
    quality: 'gap',
    cohort: 'usage',
    q: 'original',
  })
  expect(history.length).toBe(1)
  // Router's initial canonicalization can call commitLocation directly before Page mounts.
  // Verify the real persisted URL and replacement, regardless of that internal entrypoint.
  await waitFor(() => expect(replace).toHaveBeenCalledTimes(1))
  expect(history.location.search).toBe(router.state.location.searchStr)
  expect(replace.mock.calls[0]![0]).toBe(router.state.location.href)
})

test('an explicit valid range keeps its original URL and browser history', async () => {
  const url = '/observability?from=1000&to=2000&period=custom&tab=tasks&task=original'
  const { router, history, replace } = mountRoute(url)
  await screen.findByTestId('actual-range')
  expect(router.state.location.searchStr).toBe(url.slice(url.indexOf('?')))
  expect(router.state.location.search).toMatchObject({ from: 1000, to: 2000, task: 'original' })
  expect(history.length).toBe(1)
  expect(history.location.href).toBe(url)
  expect(replace).not.toHaveBeenCalled()
})

test.each([
  ['Trend drilldown', { from: 1100, to: 1200, tab: 'tasks' }],
  ['Another range', { from: 3000, to: 4000, tab: 'overview' }],
] as const)(
  'a valid %s navigation is never replaced by the preceding range',
  async (name, next) => {
    const original = { from: 1000, to: 2000, period: 'custom', tab: 'overview' }
    const { router, history, replace } = mountRoute(
      '/observability?from=1000&to=2000&period=custom&tab=overview',
    )
    await screen.findByTestId('actual-range')
    fireEvent.click(screen.getByRole('button', { name }))
    await waitFor(() => expect(router.state.location.search).toMatchObject(next))
    await waitFor(() =>
      expect(JSON.parse(screen.getByTestId('actual-range').textContent!)).toMatchObject(next),
    )
    expect(history.length).toBe(2)
    expect(replace).not.toHaveBeenCalled()
    history.back()
    await waitFor(() => expect(router.state.location.search).toMatchObject(original))
    await waitFor(() =>
      expect(JSON.parse(screen.getByTestId('actual-range').textContent!)).toMatchObject(original),
    )
    expect(replace).not.toHaveBeenCalled()
    history.forward()
    await waitFor(() => expect(router.state.location.search).toMatchObject(next))
    await waitFor(() =>
      expect(JSON.parse(screen.getByTestId('actual-range').textContent!)).toMatchObject(next),
    )
    expect(replace).not.toHaveBeenCalled()
  },
)

test.each([
  'from=bad&to=2000',
  'from=2000&to=1000',
  'from=1000&to=1000',
  'from=-1&to=2000',
  'from=1.5&to=2000',
  'from=0&to=9007199254740992',
  'from=%221000%22&to=2000',
] as const)('an invalid %s URL still receives the actual validated range', async (range) => {
  const { router, history, replace } = mountRoute('/observability?' + range + '&tab=overview')
  const visible = JSON.parse(
    (await screen.findByTestId('actual-range')).textContent!,
  ) as ObservationSearch
  await waitFor(() => expect(replace).toHaveBeenCalledTimes(1))
  expect(router.state.location.search).toEqual(visible)
  expect(history.location.search).toBe(router.state.location.searchStr)
  expect(history.length).toBe(1)
  expect(visible.from).toBeGreaterThanOrEqual(0)
  expect(visible.from).toBeLessThan(visible.to)
})

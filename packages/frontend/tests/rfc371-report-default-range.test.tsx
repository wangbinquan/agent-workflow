// RFC-371: browser reload must reuse the actual default range already shown by the page.
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { ObservationSearch } from '../src/components/observability/RunObservability'

vi.mock('../src/components/observability/CompleteRunObservability', () => ({
  CompleteRunObservability: ({ search }: { search: ObservationSearch }) => (
    <output data-testid="actual-range">{JSON.stringify(search)}</output>
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

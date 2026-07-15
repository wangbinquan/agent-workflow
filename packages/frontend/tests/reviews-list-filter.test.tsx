import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { ReviewsListPage } from '../src/routes/reviews'
import { enUS } from '../src/i18n/en-US'
import { setBaseUrl, setToken } from '../src/stores/auth'
import '../src/i18n'

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function renderPage(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const reviewsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/reviews',
    component: ReviewsListPage,
  })
  const newTaskRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/tasks/new',
    component: () => null,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([reviewsRoute, newTaskRoute]),
    history: createMemoryHistory({ initialEntries: ['/reviews'] }),
  })
  render(
    <QueryClientProvider client={qc}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
}

describe('/reviews list filter semantics', () => {
  test('non-default empty filter offers one clear action and returns to pending', async () => {
    const urls: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      urls.push(input.toString())
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    renderPage()
    const initialEmpty = await screen.findByTestId('reviews-empty')
    expect(screen.getByRole('radiogroup')).toBeTruthy()
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(initialEmpty.textContent).toContain(enUS.reviews.emptyDescription)
    expect(initialEmpty.querySelector('[data-icon="review"]')).not.toBeNull()
    const startTask = within(initialEmpty).getByRole('link', { name: enUS.tasks.newButton })
    expect(startTask.getAttribute('href')).toBe('/tasks/new')
    const header = initialEmpty.closest('.page')?.querySelector('header.page__header')
    const chromePrimaries = [header, initialEmpty].flatMap((surface) =>
      Array.from(surface?.querySelectorAll('.btn--primary') ?? []),
    )
    expect(chromePrimaries).toEqual([startTask])

    fireEvent.click(screen.getByTestId('reviews-filter-rejected'))
    await waitFor(() => expect(urls.some((url) => url.includes('status=rejected'))).toBe(true))
    const filteredEmpty = await screen.findByTestId('reviews-empty')
    expect(filteredEmpty.textContent).not.toContain(enUS.reviews.emptyDescription)
    expect(filteredEmpty.querySelector('[data-icon]')).toBeNull()
    expect(within(filteredEmpty).queryByRole('link', { name: enUS.tasks.newButton })).toBeNull()
    const clear = within(filteredEmpty).getByRole('button', { name: /clear filters/i })
    fireEvent.click(clear)

    expect(screen.getByTestId('reviews-filter-pending').getAttribute('aria-checked')).toBe('true')
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId('reviews-filter-pending')),
    )
    await waitFor(() => expect(urls.filter((url) => url.includes('status=pending')).length).toBe(2))
  })
})

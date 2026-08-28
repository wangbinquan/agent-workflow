import type { ReactNode } from 'react'
import type { ReviewNodeReviewerConfig, TaskMembers } from '@agent-workflow/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  RouterProvider,
  createMemoryHistory,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type * as ApiClientModule from '../src/api/client'

vi.mock('../src/api/client', async () => {
  const actual = await vi.importActual<typeof ApiClientModule>('../src/api/client')
  return { ...actual, api: { get: vi.fn(), put: vi.fn() } }
})
vi.mock('../src/components/shell/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

import { api } from '../src/api/client'
import i18n from '../src/i18n'
import { Route as RootRoute } from '../src/routes/__root'
import { Route as ReviewersRoute } from '../src/routes/tasks.reviewers'
import { clearToken, setToken } from '../src/stores/auth'

const reviewer = {
  id: 'reviewer',
  username: 'reviewer',
  displayName: 'Review Person',
  role: 'user' as const,
  status: 'active' as const,
}

const config: ReviewNodeReviewerConfig = {
  taskId: 'task-1',
  canManage: true,
  nodes: [
    {
      reviewNodeId: 'review-a',
      title: 'Architecture review',
      description: 'Read the proposal.',
      reviewers: [reviewer],
    },
  ],
}

const members: TaskMembers = {
  taskId: 'task-1',
  ownerUserId: 'owner',
  owner: {
    id: 'owner',
    username: 'owner',
    displayName: 'Owner',
    role: 'user',
    status: 'active',
  },
  members: [],
  canManage: true,
  canOperate: true,
}

function renderPage() {
  const taskStub = createRoute({
    getParentRoute: () => RootRoute,
    path: '/tasks/$id',
    component: () => null,
  })
  const router = createRouter({
    routeTree: RootRoute.addChildren([ReviewersRoute, taskStub]),
    history: createMemoryHistory({ initialEntries: ['/tasks/task-1/reviewers'] }),
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
}

beforeEach(async () => {
  await i18n.changeLanguage('en-US')
  setToken('test-token')
  ;(api.get as ReturnType<typeof vi.fn>).mockReset()
  ;(api.put as ReturnType<typeof vi.fn>).mockReset()
  ;(api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
    if (url === '/api/tasks/task-1/reviewers') return Promise.resolve(config)
    if (url === '/api/tasks/task-1/members') return Promise.resolve(members)
    return Promise.resolve([])
  })
  ;(api.put as ReturnType<typeof vi.fn>).mockResolvedValue({
    ...config,
    nodes: [{ ...config.nodes[0], reviewers: [] }],
  })
})

afterEach(() => {
  cleanup()
  clearToken()
})

describe('RFC-340 task reviewer configuration page', () => {
  test('shows the opinion-only rule and saves a full replacement', async () => {
    renderPage()
    expect(await screen.findByText('Architecture review')).toBeTruthy()
    expect(
      screen.getByText(
        /They cannot delete comments, approve, regenerate, reject, or select documents/,
      ),
    ).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Remove Review Person' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => {
      expect(api.put).toHaveBeenCalledWith('/api/tasks/task-1/reviewers', {
        nodes: [{ reviewNodeId: 'review-a', reviewerUserIds: [] }],
      })
    })
    expect(await screen.findByText('Reviewer configuration saved.')).toBeTruthy()
  })
})

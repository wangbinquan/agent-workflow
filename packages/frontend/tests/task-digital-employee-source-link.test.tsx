// User regressions 2026-08-23: keep the digital-employee source beside Task ID,
// but identify the exact employee rather than its broad type and open the
// job template frozen into that employee Case.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { TaskDigitalEmployeeSourceLink } from '../src/components/tasks/TaskDigitalEmployeeSourceLink'
import { api } from '../src/api/client'
import i18n from '../src/i18n'

beforeEach(async () => {
  await i18n.changeLanguage('en-US')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function renderLink(input?: { caseId?: string; employeeName?: string }) {
  const caseId = input?.caseId ?? 'case-42'
  vi.spyOn(api, 'get').mockResolvedValue({
    case: {
      employeeRef: { id: 'employee-1', revision: 4 },
      typeRef: { typeId: 'development', revision: 6 },
    },
    capabilityActivation: {
      displayName: input?.employeeName ?? 'Developer One',
      jobTemplateRef: { id: 'job-template-9', revision: 3 },
    },
  })
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const hostRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <TaskDigitalEmployeeSourceLink caseId={caseId} />,
  })
  const employeeTypeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/digital-employees/$typeRef',
    validateSearch: (raw: Record<string, unknown>) => raw,
    component: () => <div data-testid="employee-type-stub" />,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([hostRoute, employeeTypeRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
}

describe('TaskDigitalEmployeeSourceLink', () => {
  test('renders the exact employee and opens its job template', async () => {
    renderLink()
    const link = await waitFor(() => screen.getByRole('link', { name: 'Developer One' }))
    const href = new URL(link.getAttribute('href') ?? '', 'http://frontend.test')
    expect(decodeURIComponent(href.pathname)).toBe('/digital-employees/development@6')
    expect(href.searchParams.get('view')).toBe('jobs')
    expect(href.searchParams.get('jobTemplateId')).toBe('job-template-9')
    expect(href.searchParams.get('employeeId')).toBeNull()
    expect(link.getAttribute('target')).toBeNull()
    expect(link.getAttribute('title')).toBeNull()
    expect(api.get).toHaveBeenCalledWith(
      '/api/employee-cases/case-42',
      undefined,
      expect.anything(),
    )
  })

  test('keeps a specific Chinese employee name instead of the broad employee type', async () => {
    await i18n.changeLanguage('zh-CN')
    renderLink({ caseId: 'case-cn', employeeName: '研发一号' })
    expect(await waitFor(() => screen.getByRole('link', { name: '研发一号' }))).toBeTruthy()
    expect(screen.queryByRole('link', { name: '开发数字员工' })).toBeNull()
  })
})

describe('task-detail digital employee source wiring', () => {
  test('the Case source is conditionally rendered after Task ID in the shared source group', () => {
    const route = readFileSync(
      resolve(import.meta.dirname, '..', 'src', 'routes', 'tasks.detail.tsx'),
      'utf8',
    )
    const code = route.indexOf('<code>{tk.id}</code>')
    const condition = route.indexOf('tk.digitalEmployeeCaseId != null', code)
    const component = route.indexOf(
      '<TaskDigitalEmployeeSourceLink caseId={tk.digitalEmployeeCaseId} />',
      code,
    )

    expect(code).toBeGreaterThan(-1)
    expect(condition).toBeGreaterThan(code)
    expect(component).toBeGreaterThan(condition)
    expect(route.slice(condition, component)).toContain(
      'data-testid="task-digital-employee-source"',
    )
    expect(route.slice(condition, component)).toContain('<span aria-hidden="true">·</span>')
  })
})

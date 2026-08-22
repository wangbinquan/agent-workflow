// RFC-310 capability-builder and runtime-outcome placement regressions.
//
// `/code` contains definitions only. Live work belongs to `/tasks`; runtime
// outcome totals are projected on the canonical digital-employee cards.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'

import '../src/i18n'
import { setBaseUrl, setToken } from '../src/stores/auth'

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
  localStorage.setItem('aw-language', 'en-US')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

test('digital-employee, task, and outcome pages do not restore the legacy mechanical back button', () => {
  const routes = [
    'code.tsx',
    'code.config.tsx',
    'code.config.detail.tsx',
    'code.executors.tsx',
    'code.assignments.tsx',
    'code.outcomes.tsx',
    'code.missions.new.tsx',
    'code.missions.$id.tsx',
    'code.policies.tsx',
    'code.policies.$id.tsx',
    'tasks.tsx',
    'tasks.preview.tsx',
  ]

  const offenders = routes.filter((file) => {
    const source = readFileSync(resolve(import.meta.dirname, `../src/routes/${file}`), 'utf8')
    return /<PageHeader[\s\S]*?\bback\s*=/.test(source)
  })

  expect(offenders).toEqual([])
})

function mission(
  id: string,
  status: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    status,
    automationMode: 'active',
    repositoryId: 'repo-1',
    sourceKind: 'direct',
    externalId: null,
    deliveryKind: 'create-merge-request',
    employeeId: 'employee-1',
    blockCode: null,
    terminalKind: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
    ...over,
  }
}

function installFetch() {
  const calls: string[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (request: RequestInfo | URL) => {
    const url = new URL(request.toString())
    calls.push(url.pathname)
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
    if (url.pathname === '/api/auth/me') {
      return json({
        user: {
          id: 'u-1',
          username: 'admin',
          displayName: 'Admin',
          role: 'admin',
          status: 'active',
        },
        source: 'session',
        linkedIdentities: [],
        pats: [],
        permissions: ['digital-employees:read', 'development-missions:launch'],
      })
    }
    if (url.pathname === '/api/code/setup-journey') {
      return json({
        schemaVersion: 1,
        journey: 'employee-setup',
        current: { key: 'launch', ordinal: 4, total: 4, detailKey: 'setupLaunchDetail' },
        next: {
          key: 'launchFirstMission',
          kind: 'navigate',
          detailKey: 'launchFirstMissionDetail',
          owner: 'current-user',
          href: '/code/missions/new?employee=employee-1',
          command: null,
          available: true,
          unavailableReason: null,
          wake: { source: null, resumeAt: null, deadlineAt: null, descriptionKey: null },
        },
        steps: [
          { key: 'define', state: 'done', owner: 'current-user', href: null },
          { key: 'publish', state: 'done', owner: 'current-user', href: null },
          { key: 'assign', state: 'done', owner: 'current-user', href: null },
          { key: 'launch', state: 'current', owner: 'current-user', href: null },
        ],
        reasonRefs: [],
        projectionRevision: 'setup-ready',
      })
    }
    if (url.pathname === '/api/code/digital-employees') {
      return json({
        items: [
          { id: 'employee-1', name: 'Java employee', publishedRevision: 2 },
          { id: 'employee-2', name: 'C++ employee', publishedRevision: 1 },
        ],
      })
    }
    if (url.pathname === '/api/code/automation-policies') {
      return json({ items: [{ id: 'policy-1', publishedRevision: 4 }] })
    }
    if (url.pathname === '/api/code/repository-assignments') {
      return json({ items: [{ scopeKind: 'repository', scopeRef: 'repo-1' }] })
    }
    if (url.pathname === '/api/cached-repos') {
      return json({ items: [{ id: 'repo-1', urlRedacted: 'team/service' }] })
    }
    if (url.pathname === '/api/code/missions') {
      // RFC-311：过滤已经下推到服务端，所以这个假服务端必须**照真契约过滤**——
      // 返回固定全量等于让测试验证一段已经不存在的前端行为。
      const employeeId = url.searchParams.get('employeeId')
      const missionStatuses = url.searchParams.get('missionStatuses')?.split(',') ?? null
      const rows = [
        mission('mission-admitting', 'admitting'),
        mission('mission-ready', 'ready-to-merge'),
        mission('mission-blocked', 'blocked', { blockCode: 'pipeline-gate-failed' }),
        mission('mission-working', 'working'),
        mission('mission-publishing', 'publishing'),
        mission('mission-watching', 'watching'),
        mission('mission-merged', 'merged'),
        mission('mission-no-change', 'completed-no-change'),
        mission('mission-failed', 'failed', { employeeId: 'employee-2' }),
      ].filter((row) => {
        const m = row as { employeeId: string | null; status: string }
        if (employeeId !== null && m.employeeId !== employeeId) return false
        if (missionStatuses !== null && !missionStatuses.includes(m.status)) return false
        return true
      })
      const counts: Record<string, number> = {}
      for (const row of rows) {
        const status = (row as { status: string }).status
        counts[status] = (counts[status] ?? 0) + 1
      }
      return json({ items: rows, nextCursor: null, counts })
    }
    if (url.pathname === '/api/code/metrics') {
      return json({
        windowMs: 30 * 86_400_000,
        adoption: [
          {
            capability: 'mr-review',
            published: 10,
            adopted: 4,
            quietFix: 3,
            disagreed: 2,
            outstanding: 1,
          },
        ],
        runs: [
          {
            capability: 'mr-review',
            rounds: 12,
            published: 9,
            failed: 2,
            awaiting: 0,
            incomplete: 1,
          },
        ],
      })
    }
    return json({})
  })
  return calls
}

async function renderCode(initial = '/code') {
  const page = await import('../src/routes/code')
  const root = createRootRoute()
  const code = createRoute({
    getParentRoute: () => root,
    path: '/code',
    validateSearch: page.validateCodeSearch,
    component: page.Route.options.component,
  })
  const router = createRouter({
    routeTree: root.addChildren([code]),
    history: createMemoryHistory({ initialEntries: [initial] }),
  })
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
}

describe('digital employee capability builder', () => {
  test('contains only construction destinations and sends execution to unified tasks', async () => {
    const calls = installFetch()
    await renderCode('/code?tab=activity')

    expect(await screen.findByTestId('journey-next-action')).toBeTruthy()
    expect(screen.getByTestId('digital-employee-build-employees')).toBeTruthy()
    expect(screen.getByTestId('digital-employee-build-executors')).toBeTruthy()
    expect(screen.getByTestId('digital-employee-build-assignments')).toBeTruthy()
    expect(screen.queryByTestId('digital-employee-build-outcomes')).toBeNull()
    expect(screen.getByTestId('digital-employee-open-tasks').getAttribute('href')).toBe(
      '/tasks?category=digital-employee',
    )
    expect(screen.queryByTestId('mission-operations-board')).toBeNull()
    expect(calls).not.toContain('/api/code/work-items')
    expect(calls).not.toContain('/api/code/missions')
  })

  test('shows the next setup action on the same first screen', async () => {
    installFetch()
    await renderCode()

    expect(
      await screen.findByRole('heading', { name: 'Give it the first piece of work' }),
    ).toBeTruthy()
    expect(screen.getByTestId('journey-next-link').getAttribute('href')).toBe(
      '/code/missions/new?employee=employee-1',
    )
  })
})

test('retired outcome routes remain compatibility redirects without a page surface', () => {
  const source = readFileSync(
    resolve(import.meta.dirname, '../src/routes/code.outcomes.tsx'),
    'utf8',
  )
  expect(source).toContain("throw redirect({ to: '/digital-employees' })")
  expect(source).not.toContain('run-outcomes-page')
  expect(source).not.toContain('OutcomeSummary')
})

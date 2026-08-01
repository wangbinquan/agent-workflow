// RFC-243 PR-5 — task-detail child-task link locks.
//
// A call-workflow / call-workgroup node_run carries `childTaskId`. The detail
// page must surface it as a「子任务」jump link + live status chip, resolved
// through the shared `GET /api/tasks?parent_id=<id>` children query — and
// degrade to a neutral non-link placeholder once the children list has loaded
// WITHOUT the child (deleted, or invisible to the viewer; the ACL-filtered
// endpoint makes both indistinguishable by design).
//
// Component cases render ChildTaskLink in a real Router+Query harness; the
// source-layer cases lock the wiring into BOTH consumers (NodeRunsTable rows
// in tasks.detail.tsx and the NodeDetailDrawer card) plus i18n parity, the
// task-detail-commit-row.test.ts idiom for this expensive-to-mount route.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from '@tanstack/react-router'
import type { TaskListItem } from '@agent-workflow/shared'
import { ChildTaskLink } from '../src/components/tasks/ChildTaskLink'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { enUS } from '../src/i18n/en-US'
import '../src/i18n'

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function childRow(id: string, status: TaskListItem['status']): TaskListItem {
  return {
    id,
    name: `child ${id}`,
    workflowId: 'wf1',
    workflowName: 'wf-one',
    repoPath: '/Users/w/proj/agent-workflow',
    repoUrl: null,
    cachedRepoId: null,
    status,
    startedAt: Date.now() - 60_000,
    finishedAt: null,
    errorSummary: null,
    repoCount: 1,
    spaceKind: 'remote',
    childCount: 0,
    parentTaskId: 't_parent',
    invocationDepth: 1,
    ownerUserId: 'u1',
    owner: { id: 'u1', username: 'alice', displayName: 'Alice' },
  }
}

function installFetch(children: TaskListItem[]): { urls: string[] } {
  const rec = { urls: [] as string[] }
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (req: RequestInfo | URL) => {
    const url = req.toString()
    rec.urls.push(url)
    const parsed = new URL(url)
    const payload =
      parsed.pathname === '/api/tasks' && parsed.searchParams.get('parent_id') === 't_parent'
        ? children
        : []
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  return rec
}

async function renderLink(childTaskId: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const hostRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <ChildTaskLink taskId="t_parent" childTaskId={childTaskId} />,
  })
  const detailStub = createRoute({
    getParentRoute: () => rootRoute,
    path: '/tasks/$id',
    component: () => <div data-testid="stub" />,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([hostRoute, detailStub]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  render(
    <QueryClientProvider client={qc}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
  return router
}

describe('ChildTaskLink (RFC-243 PR-5)', () => {
  test('renders the /tasks/<child> jump link plus the live status chip', async () => {
    const rec = installFetch([childRow('t_child', 'running')])
    await renderLink('t_child')

    const wrapper = await screen.findByTestId('child-task-link-t_child')
    const link = wrapper.querySelector('a')
    expect(link).not.toBeNull()
    expect(link!.getAttribute('href')).toBe('/tasks/t_child')
    expect(link!.textContent).toBe(enUS.tasks.childTaskLink)
    // Chip resolves from the shared parent_id children query.
    await waitFor(() => expect(wrapper.textContent).toContain(enUS.tasks.status.running))
    expect(wrapper.querySelector('.status-chip')).not.toBeNull()
    expect(rec.urls.some((u) => u.includes('parent_id=t_parent'))).toBe(true)
  })

  test('degrades to a neutral non-link placeholder when the child is absent (deleted/invisible)', async () => {
    installFetch([childRow('t_other', 'done')])
    await renderLink('t_ghost')

    const placeholder = await screen.findByTestId('child-task-unavailable-t_ghost')
    expect(placeholder.textContent).toBe(enUS.tasks.childTaskUnavailable)
    expect(placeholder.querySelector('a')).toBeNull()
    expect(screen.queryByTestId('child-task-link-t_ghost')).toBeNull()
  })
})

// ---------------------------------------------------------------------------

const DETAIL_SRC = readFileSync(
  resolve(import.meta.dirname, '..', 'src', 'routes', 'tasks.detail.tsx'),
  'utf-8',
)
const DRAWER_SRC = readFileSync(
  resolve(import.meta.dirname, '..', 'src', 'components', 'NodeDetailDrawer.tsx'),
  'utf-8',
)
const ZH = readFileSync(resolve(import.meta.dirname, '..', 'src', 'i18n', 'zh-CN.ts'), 'utf-8')
const EN = readFileSync(resolve(import.meta.dirname, '..', 'src', 'i18n', 'en-US.ts'), 'utf-8')

describe('task detail — ChildTaskLink wiring (source locks)', () => {
  test('NodeRunsTable rows render ChildTaskLink for runs carrying childTaskId', () => {
    expect(DETAIL_SRC).toMatch(/r\.childTaskId != null/)
    expect(DETAIL_SRC).toMatch(/<ChildTaskLink taskId=\{taskId\} childTaskId=\{r\.childTaskId\}/)
  })

  test('NodeDetailDrawer renders ChildTaskLink for the selected call run', () => {
    expect(DRAWER_SRC).toMatch(/run\.childTaskId != null/)
    expect(DRAWER_SRC).toMatch(/<ChildTaskLink taskId=\{taskId\} childTaskId=\{run\.childTaskId\}/)
  })

  test('i18n keys exist in both locales', () => {
    expect(ZH).toContain("childTaskLink: '子任务'")
    expect(ZH).toContain("childTaskUnavailable: '子任务不可见或已删除'")
    expect(EN).toContain("childTaskLink: 'Child task'")
    expect(EN).toContain("childTaskUnavailable: 'Child task not visible or deleted'")
  })
})

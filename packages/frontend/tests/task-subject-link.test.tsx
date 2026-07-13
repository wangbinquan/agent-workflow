// TaskSubjectLink — the single "execution subject" resolver shared by the
// /tasks list cell and the /tasks/:id detail header + meta row.
//
// Regression guard for the bug where the task DETAIL (and, for agent tasks, the
// LIST) leaked the builtin FK-anchor workflow: a workgroup task rendered
// `__workgroup_host__` linking to a dead /workflows/<id>, and a single-agent
// task rendered `__agent_host__`. This behavioral test pins that a workgroup /
// agent task links to its OWNING resource (/workgroups/$name, /agents/$name)
// with a kind badge, never the host anchor — and that plain workflow tasks are
// unchanged. It replaces the source-text locks that used to pin the inline cell
// (tasks-workgroup-badge.test.ts / task-detail-header-workflow-link.test.ts),
// which now only assert those callsites delegate here.

import { afterEach, describe, expect, test } from 'vitest'
import type { ReactElement } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import i18n from 'i18next'
import { TaskSubjectLink, type TaskSubjectFields } from '../src/components/TaskSubjectLink'
import '../src/i18n'

/** Mount `node` at /tasks inside a minimal real router (a bare Outlet root, so
 *  the app's auth `beforeLoad` gate is bypassed). TaskSubjectLink renders
 *  TanStack <Link>s, which need a RouterProvider whose tree registers the three
 *  subject detail routes so the links resolve their hrefs. */
function mountSubject(node: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const host = createRoute({
    getParentRoute: () => rootRoute,
    path: '/tasks',
    component: () => node,
  })
  const workflowStub = createRoute({
    getParentRoute: () => rootRoute,
    path: '/workflows/$id',
    component: () => null,
  })
  const workgroupStub = createRoute({
    getParentRoute: () => rootRoute,
    path: '/workgroups/$name',
    component: () => null,
  })
  const agentStub = createRoute({
    getParentRoute: () => rootRoute,
    path: '/agents/$name',
    component: () => null,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([host, workflowStub, workgroupStub, agentStub]),
    history: createMemoryHistory({ initialEntries: ['/tasks'] }),
  })
  return render(
    <QueryClientProvider client={qc}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

describe('TaskSubjectLink — workflow tasks (unchanged)', () => {
  test('links to /workflows/$id by name, no kind badge', async () => {
    const task: TaskSubjectFields = { workflowId: 'wf1', workflowName: 'My Flow' }
    mountSubject(<TaskSubjectLink task={task} taskId="t1" badge />)
    const link = await screen.findByRole('link', { name: 'My Flow' })
    expect(link.getAttribute('href')).toBe('/workflows/wf1')
    expect(screen.queryByTestId('task-workgroup-badge-t1')).toBeNull()
    expect(screen.queryByTestId('task-agent-badge-t1')).toBeNull()
  })

  test('falls back to the workflowId when the workflow row was deleted', async () => {
    const task: TaskSubjectFields = { workflowId: 'wf2', workflowName: null }
    mountSubject(<TaskSubjectLink task={task} taskId="t2" badge />)
    const link = await screen.findByRole('link', { name: 'wf2' })
    expect(link.getAttribute('href')).toBe('/workflows/wf2')
  })
})

describe('TaskSubjectLink — workgroup tasks link to the group, not the host anchor', () => {
  test('links to /workgroups/$name + 工作组 badge, never the __workgroup_host__ anchor', async () => {
    const task: TaskSubjectFields = {
      // A workgroup task is FK-anchored to __workgroup_host__ — these must NOT surface.
      workflowId: '00000000000000WORKGROUP00',
      workflowName: '__workgroup_host__',
      workgroupId: 'g1',
      workgroupName: 'my-group',
    }
    mountSubject(<TaskSubjectLink task={task} taskId="t3" badge />)

    const link = await screen.findByRole('link', { name: 'my-group' })
    expect(link.getAttribute('href')).toBe('/workgroups/my-group')
    // The subject link must never be the FK-anchor workflow route.
    expect(link.getAttribute('href')).not.toContain('/workflows/')

    const badge = screen.getByTestId('task-workgroup-badge-t3')
    expect(badge.textContent).toBe(i18n.t('tasks.workgroupBadge'))

    // No leak of the internal anchor name / dead workflow link.
    expect(screen.queryByText('__workgroup_host__')).toBeNull()
    expect(screen.queryByRole('link', { name: '__workgroup_host__' })).toBeNull()
  })

  test('a deleted group keeps the badge but drops the dead link (em-dash)', async () => {
    const task: TaskSubjectFields = {
      workflowId: 'x',
      workflowName: '__workgroup_host__',
      workgroupId: 'g9',
      workgroupName: null,
    }
    mountSubject(<TaskSubjectLink task={task} taskId="t5" badge />)
    const badge = await screen.findByTestId('task-workgroup-badge-t5')
    expect(badge.textContent).toBe(i18n.t('tasks.workgroupBadge'))
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText(i18n.t('common.emDash'))).toBeTruthy()
  })
})

describe('TaskSubjectLink — single-agent tasks link to the agent, not the host anchor', () => {
  test('links to /agents/$name + 代理 badge, never the __agent_host__ anchor', async () => {
    const task: TaskSubjectFields = {
      workflowId: 'someAgentHostId',
      workflowName: '__agent_host__',
      sourceAgentName: 'coder',
    }
    mountSubject(<TaskSubjectLink task={task} taskId="t4" badge />)

    const link = await screen.findByRole('link', { name: 'coder' })
    expect(link.getAttribute('href')).toBe('/agents/coder')
    expect(link.getAttribute('href')).not.toContain('/workflows/')

    const badge = screen.getByTestId('task-agent-badge-t4')
    expect(badge.textContent).toBe(i18n.t('tasks.agentBadge'))

    expect(screen.queryByText('__agent_host__')).toBeNull()
    expect(screen.queryByRole('link', { name: '__agent_host__' })).toBeNull()
  })
})

describe('TaskSubjectLink — badge omitted (detail meta row)', () => {
  test('renders a bare subject link with no badge/cell', async () => {
    const task: TaskSubjectFields = {
      workflowId: 'a',
      workflowName: '__workgroup_host__',
      workgroupId: 'g1',
      workgroupName: 'grp',
    }
    mountSubject(<TaskSubjectLink task={task} taskId="t6" />)
    const link = await screen.findByRole('link', { name: 'grp' })
    expect(link.getAttribute('href')).toBe('/workgroups/grp')
    expect(screen.queryByTestId('task-workgroup-badge-t6')).toBeNull()
    expect(screen.queryByTestId('task-agent-badge-t6')).toBeNull()
  })
})

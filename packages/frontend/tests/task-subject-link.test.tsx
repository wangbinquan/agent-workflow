// TaskSubjectLink — the single "execution subject" resolver shared by the
// /tasks list cell and the /tasks/:id detail header + meta row.
//
// Guards two layers:
//  1. (RFC-164) a workgroup/agent task links to its OWNING resource + kind badge,
//     never the builtin `__workgroup_host__` / `__agent_host__` FK-anchor.
//  2. (RFC-223) it links by the FROZEN STABLE ID via the canonical /…/$id
//     route (workgroupId / sourceAgentId), so a rename/reuse of the name can't
//     misidentify the subject. The link TEXT stays the frozen name. Historical
//     agent tasks with no frozen id render plain text (fail closed).
// Replaces the source-text locks that used to pin the inline cell
// (tasks-workgroup-badge.test.ts / task-detail-header-workflow-link.test.ts).

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
 *  TanStack <Link>s, which need a RouterProvider whose tree registers every
 *  subject target route (canonical id detail + workflow) so the
 *  links resolve their hrefs. */
function mountSubject(node: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const host = createRoute({
    getParentRoute: () => rootRoute,
    path: '/tasks',
    component: () => node,
  })
  const paths = ['/workflows/$id', '/workgroups/$id', '/agents/$id'] as const
  const stubs = paths.map((path) =>
    createRoute({ getParentRoute: () => rootRoute, path, component: () => null }),
  )
  const router = createRouter({
    routeTree: rootRoute.addChildren([host, ...stubs]),
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

describe('TaskSubjectLink — workflow tasks', () => {
  test('links to /workflows/$id by name, carrying the 「工作流」kind badge', async () => {
    const task: TaskSubjectFields = { workflowId: 'wf1', workflowName: 'My Flow' }
    mountSubject(<TaskSubjectLink task={task} taskId="t1" badge />)
    const link = await screen.findByRole('link', { name: 'My Flow' })
    expect(link.getAttribute('href')).toBe('/workflows/wf1')

    // 2026-07-14: workflow rows used to render BARE — the /tasks 工作流 column
    // labeled workgroup/agent rows only, so "plain workflow" was encoded in the
    // ABSENCE of a chip. All three kinds are labeled now; a regression that
    // restores the early-return (no badge) turns this red.
    const badgeEl = screen.getByTestId('task-workflow-badge-t1')
    expect(badgeEl.textContent).toBe(i18n.t('tasks.workflowBadge'))
    // The badge must be the workflow one, not a mislabeled group/agent chip.
    expect(screen.queryByTestId('task-workgroup-badge-t1')).toBeNull()
    expect(screen.queryByTestId('task-agent-badge-t1')).toBeNull()
  })

  test('falls back to the workflowId when the workflow row was deleted', async () => {
    const task: TaskSubjectFields = { workflowId: 'wf2', workflowName: null }
    mountSubject(<TaskSubjectLink task={task} taskId="t2" badge />)
    const link = await screen.findByRole('link', { name: 'wf2' })
    expect(link.getAttribute('href')).toBe('/workflows/wf2')
    expect(screen.getByTestId('task-workflow-badge-t2').textContent).toBe(
      i18n.t('tasks.workflowBadge'),
    )
  })

  test('badge omitted (detail meta row) → bare workflow link, no chip', async () => {
    const task: TaskSubjectFields = { workflowId: 'wf3', workflowName: 'Flow 3' }
    mountSubject(<TaskSubjectLink task={task} taskId="t8" />)
    const link = await screen.findByRole('link', { name: 'Flow 3' })
    expect(link.getAttribute('href')).toBe('/workflows/wf3')
    expect(screen.queryByTestId('task-workflow-badge-t8')).toBeNull()
  })
})

describe('TaskSubjectLink — workgroup tasks link by stable id (rename-safe)', () => {
  test('links to /workgroups/<workgroupId>, text = frozen name, never the host anchor', async () => {
    const task: TaskSubjectFields = {
      // A workgroup task is FK-anchored to __workgroup_host__ — these must NOT surface.
      workflowId: '00000000000000WORKGROUP00',
      workflowName: '__workgroup_host__',
      workgroupId: 'g1',
      workgroupName: 'my-group',
    }
    mountSubject(<TaskSubjectLink task={task} taskId="t3" badge />)

    const link = await screen.findByRole('link', { name: 'my-group' })
    // RFC-223: link by the stable id (not the frozen name) → canonical route.
    expect(link.getAttribute('href')).toBe('/workgroups/g1')
    // The subject link must never be the FK-anchor workflow route nor a name-derived link.
    expect(link.getAttribute('href')).not.toContain('/workflows/')
    expect(link.getAttribute('href')).not.toBe('/workgroups/my-group')

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

describe('TaskSubjectLink — single-agent tasks link by stable id (rename/reuse-safe)', () => {
  test('with a frozen sourceAgentId → /agents/<id> + 代理 badge, never the anchor', async () => {
    const task: TaskSubjectFields = {
      workflowId: 'someAgentHostId',
      workflowName: '__agent_host__',
      sourceAgentName: 'coder',
      sourceAgentId: 'ag1',
    }
    mountSubject(<TaskSubjectLink task={task} taskId="t4" badge />)

    const link = await screen.findByRole('link', { name: 'coder' })
    expect(link.getAttribute('href')).toBe('/agents/ag1')
    expect(link.getAttribute('href')).not.toContain('/workflows/')

    const badge = screen.getByTestId('task-agent-badge-t4')
    expect(badge.textContent).toBe(i18n.t('tasks.agentBadge'))

    expect(screen.queryByText('__agent_host__')).toBeNull()
    expect(screen.queryByRole('link', { name: '__agent_host__' })).toBeNull()
  })

  test('historical task with NO frozen sourceAgentId renders plain text', async () => {
    const task: TaskSubjectFields = {
      workflowId: 'someAgentHostId',
      workflowName: '__agent_host__',
      sourceAgentName: 'legacy-coder',
      // sourceAgentId omitted → historical row (RFC-175 migration did not backfill).
    }
    mountSubject(<TaskSubjectLink task={task} taskId="t7" badge />)
    expect(await screen.findByText('legacy-coder')).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'legacy-coder' })).toBeNull()
    expect(screen.getByTestId('task-agent-badge-t7').textContent).toBe(i18n.t('tasks.agentBadge'))
  })
})

describe('TaskSubjectLink — badge omitted (detail meta row)', () => {
  test('renders a bare subject link (by id) with no badge/cell', async () => {
    const task: TaskSubjectFields = {
      workflowId: 'a',
      workflowName: '__workgroup_host__',
      workgroupId: 'g1',
      workgroupName: 'grp',
    }
    mountSubject(<TaskSubjectLink task={task} taskId="t6" />)
    const link = await screen.findByRole('link', { name: 'grp' })
    expect(link.getAttribute('href')).toBe('/workgroups/g1')
    expect(screen.queryByTestId('task-workgroup-badge-t6')).toBeNull()
    expect(screen.queryByTestId('task-agent-badge-t6')).toBeNull()
  })
})

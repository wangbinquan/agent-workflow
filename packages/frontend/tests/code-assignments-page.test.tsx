// RFC-310 PR-8 T90 — repository/repo-group/global 三级 assignment 页。
//
// 锁：①三 scope 分组列表按解析优先级呈现且未发布引用有逐条警示（配置面的
// 「开单 ≠ 在跑」——不让用户存出跑不起来的组合而不自知）；②编辑 Dialog 保存
// 时提交**正确的 PUT 载荷**（employee/policy 一律 pin 到已发布 revision，未
// 发布资源根本不出现在下拉里）；③删除打到 scoped DELETE 端点（scopeRef 经
// query 传递）。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from '@tanstack/react-router'
import { setBaseUrl, setToken } from '../src/stores/auth'
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

const ME = {
  user: { id: 'u-1', username: 'admin', displayName: 'Admin', role: 'admin', status: 'active' },
  source: 'session',
  linkedIdentities: [],
  pats: [],
  permissions: ['repository-employee-assignments:read', 'repository-employee-assignments:update'],
}

interface Recorded {
  calls: Array<{ url: string; method: string; body: unknown }>
}

function installFetch(overrides: { assignments?: unknown[] } = {}): Recorded {
  const rec: Recorded = { calls: [] }
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (req: RequestInfo | URL, init?: RequestInit) => {
      const url = req.toString()
      const method = (init?.method ?? 'GET').toUpperCase()
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      rec.calls.push({ url, method, body })
      const json = (payload: unknown, status = 200) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        })
      if (url.includes('/api/auth/me')) return json(ME)
      if (url.includes('/api/code/repository-assignments') && method === 'GET') {
        return json({
          items: overrides.assignments ?? [
            {
              scopeKind: 'repository',
              scopeRef: 'repo-1',
              employeeId: 'emp-1',
              employeeRevision: 3,
              selectionPolicyId: 'pol-1',
              selectionPolicyRevision: 2,
              executionPolicyId: null,
              executionPolicyRevision: null,
              defaultRequirementSourceKey: 'jira',
            },
            {
              scopeKind: 'global-default',
              scopeRef: null,
              employeeId: 'emp-draft',
              employeeRevision: 1,
              selectionPolicyId: null,
              selectionPolicyRevision: null,
              executionPolicyId: null,
              executionPolicyRevision: null,
              defaultRequirementSourceKey: null,
            },
          ],
        })
      }
      if (url.includes('/api/code/repository-assignments') && method === 'PUT') {
        return json({ ok: true })
      }
      if (url.includes('/api/code/repository-assignments/') && method === 'DELETE') {
        return json({ ok: true })
      }
      if (url.includes('/api/code/digital-employees')) {
        return json([
          { id: 'emp-1', name: 'Java 员工', publishedRevision: 3 },
          { id: 'emp-draft', name: '草稿员工', publishedRevision: null },
        ])
      }
      if (url.includes('/api/code/automation-policies')) {
        return json([{ id: 'pol-1', name: '默认策略', publishedRevision: 2 }])
      }
      if (url.includes('/api/cached-repos')) {
        return json([{ id: 'repo-1', urlRedacted: 'https://git.test/team/app' }])
      }
      if (url.includes('/api/repo-groups')) {
        return json([{ id: 'grp-1', name: '后端组' }])
      }
      return json({ error: { code: 'not-found', message: url } }, 404)
    },
  )
  return rec
}

async function renderPage(): Promise<void> {
  const page = await import('../src/routes/code.assignments')
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path: '/code/assignments',
    component: page.Route.options.component,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ['/code/assignments'] }),
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

describe('/code/assignments', () => {
  test('renders scope-grouped rows with unpublished-reference warnings and deletes via scoped endpoint', async () => {
    const rec = installFetch()
    await renderPage()
    const repoSection = await screen.findByTestId('assignments-repository')
    expect(repoSection.textContent).toContain('Java 员工')
    expect(repoSection.textContent).toContain('默认策略')
    // 未发布员工的 global 行带警示 chip。
    const globalSection = await screen.findByTestId('assignments-global-default')
    expect(globalSection.querySelectorAll('.chip--warn').length).toBeGreaterThan(0)

    const deleteButtons = await screen.findAllByRole('button', { name: /delete|删除/i })
    fireEvent.click(deleteButtons[0]!)
    await waitFor(() => {
      const del = rec.calls.find((c) => c.method === 'DELETE')
      expect(del).toBeDefined()
      expect(del!.url).toContain('/api/code/repository-assignments/')
    })
  })

  test('edit dialog pins published revisions in the PUT payload; unpublished resources are not offered', async () => {
    const rec = installFetch()
    await renderPage()
    const repoSection = await screen.findByTestId('assignments-repository')
    fireEvent.click(within(repoSection).getAllByRole('button', { name: /edit|编辑/i })[0]!)
    const save = await screen.findByTestId('assignment-save')
    // 编辑既有行（emp-1/pol-1 已选）直接保存：载荷 pin 到已发布 revision。
    fireEvent.click(save)
    await waitFor(() => {
      const put = rec.calls.find((c) => c.method === 'PUT')
      expect(put).toBeDefined()
      expect(put!.body).toMatchObject({
        scopeKind: 'repository',
        scopeRef: 'repo-1',
        employee: { id: 'emp-1', revision: 3 },
        selectionPolicy: { id: 'pol-1', revision: 2 },
        executionPolicy: null,
      })
    })

    // 重开编辑：员工下拉不含未发布草稿（publishedOnly 过滤）。
    fireEvent.click(within(repoSection).getAllByRole('button', { name: /edit|编辑/i })[0]!)
    const save2 = await screen.findByTestId('assignment-save')
    const dialog = (save2.closest('[role="dialog"]') ?? document.body) as HTMLElement
    // Dialog 内 combobox 序：0=scope、1=repo ref、2=employee（repository scope 下）。
    fireEvent.click(within(dialog).getAllByRole('combobox')[2]!)
    await waitFor(() => {
      const options = screen.queryAllByRole('option')
      expect(options.length).toBeGreaterThan(0)
      expect(options.map((o) => o.textContent).join('|')).not.toContain('草稿员工')
    })
  })
})

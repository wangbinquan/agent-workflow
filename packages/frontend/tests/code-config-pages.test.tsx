// RFC-310 PR-8 T85/T86/T89 — 配置资源列表 + 详情（employees / action-templates /
// verification-profiles / adapters 四族共用一对参数化路由）。
//
// 锁页面对使用者的回答：①列表按 kind 拉对应 API 并如实标注未发布/已归档；
// ②创建 Dialog 按 kind 携带最小必填（模板 capabilityId、adapter purpose）提交
// 正确载荷；③详情页 publish 422 的 violations **逐条**示人（发布闭包校验是
// 配置正确性的最终裁判，不能吞成一句 Unknown error）；④adapter 的 draft 编辑
// 入口对无 scripts:author 的用户整体不可见（executableRef/secretProjection 是
// daemon 高危字段，不给「填了也保存不了」的假入口），secret projection 只显示
// key 名。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  Outlet,
  createRouter,
} from '@tanstack/react-router'
import { setBaseUrl, setToken } from '../src/stores/auth'
import '../src/i18n'
import { publishViolationsOf } from '../src/routes/code.config.detail'
import { ApiError } from '../src/api/client'

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

interface Recorded {
  calls: Array<{ url: string; method: string; body: unknown }>
}

function me(permissions: string[]): unknown {
  return {
    user: { id: 'u-1', username: 'admin', displayName: 'Admin', role: 'admin', status: 'active' },
    source: 'session',
    linkedIdentities: [],
    pats: [],
    permissions,
  }
}

const ALL_PERMS = [
  'digital-employees:read',
  'digital-employees:create',
  'digital-employees:update',
  'digital-employees:archive',
  'action-templates:read',
  'action-templates:create',
  'action-templates:update',
  'action-templates:archive',
  'verification-profiles:read',
  'verification-profiles:create',
  'adapter-definitions:read',
  'adapter-definitions:create',
  'adapter-definitions:update',
  'adapter-definitions:archive',
  'scripts:author',
]

const EMPLOYEE_ROW = {
  id: '01EMP0000000000000000001',
  name: 'Java 员工',
  publishedRevision: 3,
  ownerUserId: 'u-1',
  visibility: 'public',
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
  archivedAt: null,
}

const TEMPLATE_ROW = {
  ...EMPLOYEE_ROW,
  id: '01TPL0000000000000000001',
  name: 'impl-java',
  publishedRevision: null,
  capabilityId: 'change.implement',
}

const ADAPTER_DETAIL = {
  ...EMPLOYEE_ROW,
  id: '01ADP0000000000000000001',
  name: 'jira-adapter',
  purpose: 'requirement-source',
  draft: {
    schemaVersion: 1,
    purpose: 'requirement-source',
    operations: ['acquire'],
    executableRef: '/opt/adapters/jira.ts',
    connectionRef: null,
    secretProjection: ['JIRA_TOKEN'],
    outputBudget: { maxFiles: 100, maxFileBytes: 1048576, maxTotalBytes: 4194304 },
    timeoutMs: 30000,
  },
}

function installFetch(overrides: {
  permissions?: string[]
  employees?: unknown[]
  templates?: unknown[]
  detail?: unknown
  publishStatus?: number
  publishBody?: unknown
}): Recorded {
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
      if (url.includes('/api/auth/me')) return json(me(overrides.permissions ?? ALL_PERMS))
      if (url.includes('/publish') && method === 'POST') {
        return json(
          overrides.publishBody ?? { revision: 4, contentDigest: 'd'.repeat(64) },
          overrides.publishStatus ?? 200,
        )
      }
      if (/\/api\/code\/development-adapters\/[^/]+$/.test(url)) {
        return json(overrides.detail ?? ADAPTER_DETAIL)
      }
      if (/\/api\/code\/digital-employees\/[^/]+$/.test(url)) {
        return json(
          overrides.detail ?? {
            ...EMPLOYEE_ROW,
            draft: {
              schemaVersion: 1,
              description: 'Handles Java services',
              supportedRepositoryFacts: [],
              capabilityRoutes: [
                {
                  capabilityId: 'change.implement',
                  rules: [],
                  fallbackTemplateRef: '01TPL0000000000000000001@1',
                },
              ],
              requirementSources: [],
              pipelineProviders: [],
              defaultPolicyRef: 'pol-1@1',
            },
          },
        )
      }
      if (url.includes('/api/code/digital-employees') && method === 'POST') {
        return json({ ...EMPLOYEE_ROW, id: '01EMPNEW' }, 201)
      }
      if (url.includes('/api/code/action-templates') && method === 'POST') {
        return json({ ...TEMPLATE_ROW, id: '01TPLNEW' }, 201)
      }
      if (url.includes('/api/code/digital-employees')) {
        return json({ items: overrides.employees ?? [EMPLOYEE_ROW] })
      }
      if (url.includes('/api/code/action-templates')) {
        return json({ items: overrides.templates ?? [TEMPLATE_ROW] })
      }
      if (url.includes('/api/code/verification-profiles')) {
        return json({ items: [] })
      }
      if (url.includes('/api/code/development-adapters')) {
        return json({ items: [ADAPTER_DETAIL] })
      }
      return json({})
    },
  )
  return rec
}

async function renderConfig(initial: string) {
  const listPage = await import('../src/routes/code.config')
  const detailPage = await import('../src/routes/code.config.detail')
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const listRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/code/config/$kind',
    component: listPage.Route.options.component,
  })
  const detailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/code/config/$kind/$id',
    component: detailPage.Route.options.component,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([detailRoute, listRoute]),
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
  return router
}

describe('publishViolationsOf', () => {
  test('extracts typed violations from a 422 and ignores everything else', () => {
    const err = new ApiError(422, 'digital-employee-publish-blocked', 'publish closure failed', {
      violations: [
        { code: 'template-missing', where: 'capabilityRoutes/0', detail: 'tpl@9 not found' },
        { bogus: true },
      ],
    })
    expect(publishViolationsOf(err)).toEqual([
      { code: 'template-missing', where: 'capabilityRoutes/0', detail: 'tpl@9 not found' },
    ])
    expect(publishViolationsOf(new Error('x'))).toEqual([])
  })
})

describe('/code/config/$kind list', () => {
  test('lists employees, marks unpublished templates, and creates with kind-specific payload', async () => {
    const rec = installFetch({})
    await renderConfig('/code/config/employees')
    await screen.findByTestId(`config-link-${EMPLOYEE_ROW.id}`)
    expect(rec.calls.some((c) => c.url.includes('/api/code/digital-employees'))).toBe(true)

    // 切到模板族：未发布行如实标 Draft only。
    cleanup()
    installFetch({})
    await renderConfig('/code/config/action-templates')
    await screen.findByTestId(`config-link-${TEMPLATE_ROW.id}`)
    expect(screen.getByText('Draft only')).toBeTruthy()

    // 创建模板：payload 带 capabilityId（后端必填）。
    fireEvent.click(screen.getByTestId('config-create-open'))
    fireEvent.change(await screen.findByTestId('config-create-name'), {
      target: { value: 'fix-ci' },
    })
    const rec2: Recorded = { calls: [] }
    // 复用当前 mock 的记录（installFetch 的第二次调用已替换 spy）——直接从
    // fetch spy 抓 POST。
    fireEvent.click(screen.getByTestId('config-create-submit'))
    await waitFor(() => {
      const post = (globalThis.fetch as unknown as ReturnType<typeof vi.spyOn>).mock.calls.find(
        (call: unknown[]) =>
          String(call[0]).includes('/api/code/action-templates') &&
          (call[1] as RequestInit | undefined)?.method === 'POST',
      )
      expect(post).toBeTruthy()
      const body = JSON.parse(String((post![1] as RequestInit).body))
      expect(body).toMatchObject({ name: 'fix-ci', capabilityId: 'change.implement' })
      void rec2
    })
  })
})

describe('/code/config detail', () => {
  test('shows publish violations item by item on 422', async () => {
    installFetch({
      publishStatus: 422,
      publishBody: {
        error: {
          code: 'digital-employee-publish-blocked',
          message: 'publish closure check failed',
          details: {
            violations: [
              { code: 'template-missing', where: 'capabilityRoutes/0', detail: 'tpl@9 missing' },
              { code: 'policy-missing', where: 'defaultPolicyRef', detail: 'pol@1 missing' },
            ],
          },
        },
      },
    })
    await renderConfig(`/code/config/employees/${EMPLOYEE_ROW.id}`)
    fireEvent.click(await screen.findByTestId('config-publish'))
    const panel = await screen.findByTestId('config-publish-violations')
    expect(panel.textContent).toContain('template-missing')
    expect(panel.textContent).toContain('policy-missing')
    // routes 摘要也在（capability 路由表）。
    expect(screen.getByTestId('config-employee-routes').textContent).toContain('change.implement')
  })

  test('adapter edit entry is hidden without scripts:author; secret keys show names only', async () => {
    installFetch({
      permissions: ALL_PERMS.filter((p) => p !== 'scripts:author'),
    })
    await renderConfig(`/code/config/adapters/${ADAPTER_DETAIL.id}`)
    await screen.findByTestId('config-summary-adapter')
    expect(screen.queryByTestId('config-edit-open')).toBeNull()
    expect(screen.getByTestId('config-scripts-author-hint')).toBeTruthy()
    const secrets = screen.getByTestId('config-adapter-secrets')
    expect(secrets.textContent).toContain('JIRA_TOKEN')
    // 值绝不出现（fixture 里也没有值——断言 executableRef 正常显示以证明摘要渲染了）。
    expect(screen.getByText('/opt/adapters/jira.ts')).toBeTruthy()

    // 有 scripts:author 时编辑入口出现。
    cleanup()
    installFetch({})
    await renderConfig(`/code/config/adapters/${ADAPTER_DETAIL.id}`)
    await screen.findByTestId('config-summary-adapter')
    expect(await screen.findByTestId('config-edit-open')).toBeTruthy()
  })
})

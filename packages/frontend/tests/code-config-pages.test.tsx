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
// 直接引后端 domain schema 给 fixture 做裁定（同 code-policy-pages 的既有做法：
// 前端不 import 后端包，测试可以按相对路径引 domain 纯模块）。
import { digitalEmployeeContentSchema } from '../../backend/src/modules/development-automation/domain/digitalEmployee'
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
  'verification-profiles:update',
  'verification-profiles:archive',
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

/**
 * 员工草稿 fixture。**形状由后端 domain schema 裁定**（下方有一条用例直接拿
 * `digitalEmployeeContentSchema` 解析它）——此前这里的 versioned ref 写成
 * `'id@rev'` 字符串，与页面里同样写错的类型一起错，于是真实数据一进来就
 * React error #31 白屏，而测试全绿。fixture 与生产形状之间必须有机械链接，
 * 否则"测试越多越像有覆盖"。
 */
const EMPLOYEE_DRAFT = {
  schemaVersion: 1,
  description: 'Handles Java services',
  supportedRepositoryFacts: [],
  capabilityRoutes: [
    {
      capabilityId: 'change.implement',
      rules: [],
      fallbackTemplateRef: { id: '01TPL0000000000000000001', revision: 1 },
    },
  ],
  requirementSources: [
    { sourceKey: 'jira', adapterRef: { id: '01ADP0001', revision: 2 }, isDefault: true },
  ],
  pipelineProviders: [{ providerKey: 'gitlab-ci', adapterRef: { id: '01ADP0002', revision: 1 } }],
  defaultPolicyRef: { id: 'pol-1', revision: 1 },
}

const TEMPLATE_ROW = {
  ...EMPLOYEE_ROW,
  id: '01TPL0000000000000000001',
  name: 'impl-java',
  publishedRevision: null,
  capabilityId: 'change.implement',
}

const TEMPLATE_DETAIL = {
  ...TEMPLATE_ROW,
  draft: {
    schemaVersion: 1,
    capabilityId: 'change.implement',
    capabilityContractVersion: 1,
    labels: ['java'],
    compatibility: [],
    executor: { kind: 'agent', agentRef: 'agent-java' },
    runtimeProfileRef: 'runtime-java',
    promptSupplement: 'Follow the service conventions.',
    skillRefs: ['skill-java'],
    mcpRefs: [],
    readOnlyResourceRefs: [],
    contextProfileRef: null,
    writablePathPolicyRef: null,
    additionalProtectedPathClasses: [],
    verificationProfileRef: 'verify-java',
    retryDefaults: { sameSession: 1, freshSession: 1 },
  },
}

const VERIFICATION_DETAIL = {
  ...EMPLOYEE_ROW,
  id: '01VERIFY00000000000000001',
  name: 'java-gate',
  draft: {
    schemaVersion: 1,
    stopPolicy: 'first-failure',
    maxParallel: 1,
    steps: [],
  },
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
      if (/\/api\/integrations\/development-adapters\/[^/]+$/.test(url)) {
        return json(overrides.detail ?? ADAPTER_DETAIL)
      }
      if (/\/api\/code\/digital-employees\/[^/]+(?:\/playbook)?$/.test(url)) {
        return json(
          overrides.detail ?? {
            ...EMPLOYEE_ROW,
            draft: EMPLOYEE_DRAFT,
            playbook: EMPLOYEE_DRAFT,
          },
        )
      }
      if (/\/api\/code\/action-templates\/[^/]+$/.test(url)) {
        return json(overrides.detail ?? TEMPLATE_DETAIL)
      }
      if (/\/api\/code\/verification-profiles\/[^/]+$/.test(url)) {
        return json(overrides.detail ?? VERIFICATION_DETAIL)
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
      if (url.includes('/api/integrations/development-adapters')) {
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

  test('creating an adapter submits COMPLETE content — the backend parses it strictly on write', async () => {
    // 用户实测的 bug：创建对话框只发 { name, purpose }，而 adapter 的后端契约是
    // 「写入即 strict parse」（可执行引用不允许以草稿形态潜伏），于是必填字段
    // 全缺 → `adapter content failed schema: Invalid literal value, expected 1`
    // （第一条 issue 是 schemaVersion）。adapter 因此**根本无法从 UI 创建**，而
    // 当时没有任何用例覆盖这条创建路径。
    installFetch({})
    await renderConfig('/code/config/adapters')
    await screen.findByTestId('config-create-open')

    fireEvent.click(screen.getByTestId('config-create-open'))
    fireEvent.change(await screen.findByTestId('config-create-name'), {
      target: { value: 'jira-source' },
    })
    // executableRef 必填：空值时提交按钮禁用（不替用户编造可执行引用）。
    expect((screen.getByTestId('config-create-submit') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByTestId('config-create-executable-ref'), {
      target: { value: '/opt/adapters/jira.ts' },
    })
    expect((screen.getByTestId('config-create-submit') as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(screen.getByTestId('config-create-submit'))
    await waitFor(() => {
      const post = (globalThis.fetch as unknown as ReturnType<typeof vi.spyOn>).mock.calls.find(
        (call: unknown[]) =>
          String(call[0]).includes('/api/integrations/development-adapters') &&
          (call[1] as RequestInit | undefined)?.method === 'POST',
      )
      expect(post).toBeTruthy()
      const body = JSON.parse(String((post![1] as RequestInit).body)) as {
        name: string
        purpose: string
        draft: Record<string, unknown>
      }
      expect(body.name).toBe('jira-source')
      expect(body.purpose).toBe('requirement-source')
      // 逐字段对拍后端 strict schema 的必填面（缺任意一个都会整条拒）。
      expect(body.draft).toEqual({
        schemaVersion: 1,
        contractVersion: 1,
        purpose: 'requirement-source',
        operations: ['acquire'],
        executableRef: '/opt/adapters/jira.ts',
        parameterSchemaRef: null,
        connectionRef: null,
        secretProjection: [],
        outputBudget: {
          maxFiles: 200,
          maxFileBytes: 32 * 1024 * 1024,
          maxTotalBytes: 256 * 1024 * 1024,
        },
        timeoutMs: 120_000,
      })
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
    // 业务详情只讲员工职责；template/profile/ref 退到默认收起的技术区。
    const employeeCard = screen.getByTestId('config-summary-employee')
    expect(employeeCard.textContent).toContain('Handles Java services')
    expect(screen.queryByTestId('config-employee-routes')).toBeNull()
    const advanced = screen.getByTestId('config-draft-advanced')
    expect(advanced.hasAttribute('open')).toBe(false)
    expect(screen.getByTestId('config-draft-json').textContent).toContain(
      '01TPL0000000000000000001',
    )
  })

  test('adapter edit entry is hidden without scripts:author; secret keys show names only', async () => {
    installFetch({
      permissions: ALL_PERMS.filter((p) => p !== 'scripts:author'),
    })
    await renderConfig(`/code/config/adapters/${ADAPTER_DETAIL.id}`)
    // 摘要卡片的出现**不代表 draft 已到**：DraftSummary 用 `props.draft ?? {}`
    // 渲染，所以卡片会先带空 draft 挂出来（secretProjection 空 ⇒ 显示 '—'）。
    // 同步读内容因此是负载敏感的：本文件单跑必绿，而 gate:local 里后端分片并发
    // 抢 CPU 时这条会红（RFC-311 收口实测）。锚在数据本身上等。
    const secrets = await screen.findByTestId('config-adapter-secrets')
    await waitFor(() => expect(secrets.textContent).toContain('JIRA_TOKEN'))
    expect(screen.queryByTestId('config-edit-open')).toBeNull()
    expect(screen.getByTestId('config-scripts-author-hint')).toBeTruthy()
    // 值绝不出现（fixture 里也没有值——断言 executableRef 正常显示以证明摘要渲染了）。
    expect(screen.getByText('/opt/adapters/jira.ts')).toBeTruthy()

    // 有 scripts:author 时编辑入口出现。
    cleanup()
    installFetch({})
    await renderConfig(`/code/config/adapters/${ADAPTER_DETAIL.id}`)
    await screen.findByTestId('config-summary-adapter')
    expect(await screen.findByTestId('config-edit-open')).toBeTruthy()
  })

  test('edits an employee through business steps and keeps JSON behind an advanced fold', async () => {
    const rec = installFetch({})
    await renderConfig(`/code/config/employees/${EMPLOYEE_ROW.id}`)
    fireEvent.click(await screen.findByTestId('config-edit-open'))

    expect(await screen.findByTestId('employee-playbook-editor')).toBeTruthy()
    expect(screen.getByTestId('config-edit-advanced').hasAttribute('open')).toBe(false)
    fireEvent.change(screen.getByTestId('config-edit-description'), {
      target: { value: 'Owns Java delivery from requirement to merge-ready MR.' },
    })
    fireEvent.click(screen.getByTestId('employee-step-add'))
    fireEvent.click(screen.getByTestId('config-edit-save'))

    await waitFor(() => {
      const put = rec.calls.find(
        (call) =>
          call.method === 'PUT' &&
          call.url.includes('/api/code/digital-employees/') &&
          call.url.endsWith('/playbook'),
      )
      expect(put).toBeTruthy()
      expect(put!.body).toMatchObject({
        playbook: {
          description: 'Owns Java delivery from requirement to merge-ready MR.',
          defaultPolicyRef: { id: 'pol-1', revision: 1 },
          steps: [
            {
              displayName: 'Step 1',
              producer: { kind: 'platform', capabilityId: 'repository.inspect' },
            },
          ],
        },
      })
    })
  })

  test('provides guided editors for template, verification, and adapter contracts', async () => {
    const template = installFetch({ detail: TEMPLATE_DETAIL })
    await renderConfig(`/code/config/action-templates/${TEMPLATE_ROW.id}`)
    fireEvent.click(await screen.findByTestId('config-edit-open'))
    expect(await screen.findByTestId('config-guided-editor-template')).toBeTruthy()
    fireEvent.change(screen.getByTestId('config-template-executor-ref'), {
      target: { value: 'agent-java-21' },
    })
    fireEvent.click(screen.getByTestId('config-edit-save'))
    await waitFor(() =>
      expect(template.calls.find((call) => call.method === 'PUT')?.body).toMatchObject({
        draft: { executor: { kind: 'agent', agentRef: 'agent-java-21' } },
      }),
    )

    cleanup()
    installFetch({ detail: VERIFICATION_DETAIL })
    await renderConfig(`/code/config/verification-profiles/${VERIFICATION_DETAIL.id}`)
    fireEvent.click(await screen.findByTestId('config-edit-open'))
    expect(await screen.findByTestId('config-guided-editor-verification')).toBeTruthy()
    fireEvent.click(screen.getByTestId('config-step-add'))
    expect(screen.getByTestId('config-step-0-program')).toBeTruthy()

    cleanup()
    installFetch({ detail: ADAPTER_DETAIL })
    await renderConfig(`/code/config/adapters/${ADAPTER_DETAIL.id}`)
    fireEvent.click(await screen.findByTestId('config-edit-open'))
    expect(await screen.findByTestId('config-guided-editor-adapter')).toBeTruthy()
    expect(screen.getByTestId('config-adapter-executable')).toBeTruthy()
    expect(screen.getByTestId('config-adapter-timeout')).toBeTruthy()
  })
})

describe('fixtures are pinned to the backend domain shape', () => {
  test('the employee draft fixture parses as real DigitalEmployeeContent', () => {
    // 这条就是缺失的机械链接：fixture 一旦漂回"前端以为的形状"（例如把
    // versioned ref 写成 `'id@rev'` 字符串），这里当场红，而不是等用户在
    // 真实页面上撞出 React error #31 白屏。
    const parsed = digitalEmployeeContentSchema.safeParse(EMPLOYEE_DRAFT)
    expect(parsed.success ? [] : parsed.error.issues.map((i) => i.path.join('.'))).toEqual([])
  })
})

describe('/code/config create dialog — a stray overlay click must not discard input', () => {
  test('clicking the overlay keeps the dialog open and the typed name intact', async () => {
    // 用户实报：「我点击创建，弹窗就消失了，什么都没变化」。真相是页头那颗
    // 同名「创建」按钮在遮罩之下——看得见、点不到，那一下命中的是遮罩，于是
    // 走了"点遮罩关闭"，已填的名字被静默丢弃、也没有发出任何请求。
    // 装着用户输入的弹窗一律不接受遮罩关闭（本仓既有先例：AgentPortDialog /
    // tasks.new），ESC / 取消 / × 三条路径保留。
    installFetch({})
    await renderConfig('/code/config/employees')
    fireEvent.click(await screen.findByTestId('config-create-open'))
    const name = await screen.findByTestId('config-create-name')
    fireEvent.change(name, { target: { value: '不该被丢掉的名字' } })

    const overlay = document.querySelector('.dialog__overlay')
    expect(overlay).not.toBeNull()
    // Dialog 的关闭判据是 mousedown 落在遮罩本身（e.target === overlay）。
    fireEvent.mouseDown(overlay!)

    // 弹窗仍在、输入仍在、没有发出创建请求。
    expect(screen.queryByTestId('config-create-submit')).not.toBeNull()
    expect((screen.getByTestId('config-create-name') as HTMLInputElement).value).toBe(
      '不该被丢掉的名字',
    )
    const posts = (
      globalThis.fetch as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls.filter((c) => ((c[1] as RequestInit | undefined)?.method ?? 'GET') === 'POST')
    expect(posts).toEqual([])
  })
})

// 回归锁（RFC-310 T140 实测）：`/code` 首屏主动作的 href 是 `?create=1`，而
// TanStack 的默认 search 解析会 JSON.parse 每个值 ⇒ 到达路由时是**数字 1**。
// 只认 `true` / `'1'` 的版本会把它整个丢掉：点主动作只落到列表页、创建对话框
// 不开、且不报任何错——零配置操作链的第一跳静默断掉。
describe('RFC-310 deep-link create flags survive TanStack search parsing', () => {
  test('the employee list accepts every shape `?create=` can arrive in', async () => {
    const { validateConfigListSearch } = await import('../src/routes/code.config')
    expect(validateConfigListSearch({ create: 1 })).toEqual({ create: true })
    expect(validateConfigListSearch({ create: '1' })).toEqual({ create: true })
    expect(validateConfigListSearch({ create: true })).toEqual({ create: true })
    expect(validateConfigListSearch({ create: 'true' })).toEqual({ create: true })
    expect(validateConfigListSearch({ create: 0 })).toEqual({})
    expect(validateConfigListSearch({ create: 'no', keep: 'me' })).toEqual({ keep: 'me' })
  })

  test('the assignment page accepts the same shapes', async () => {
    const { validateAssignmentSearch } = await import('../src/routes/code.assignments')
    expect(validateAssignmentSearch({ create: 1 })).toMatchObject({ create: true })
    expect(validateAssignmentSearch({ create: '1' })).toMatchObject({ create: true })
    expect(validateAssignmentSearch({ create: true })).toMatchObject({ create: true })
    expect(validateAssignmentSearch({ create: 0 })).not.toMatchObject({ create: true })
  })
})

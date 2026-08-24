// RFC-319 —— 代理编辑面的真实往返（AGENT-01 / 04 / 07 / 23 / 35）。
//
// 为什么需要这个文件：开工审计对账出，在此之前整个 e2e 套件里**唯一**被证明能
// 「UI 改字段 → PUT → SQLite → reload 读回」的代理字段只有 Runtime
// （`e2e/ux-consistency.spec.ts:438`），而那条用例的 fixture agent 是个空壳
// （`:72-77`，没有 skills / mcp / plugins / inputs / role / branchPorts）。
// 也就是说 `agentToDraft` / `agentToPutBody` 漏拷任何字段，全套 e2e 一格都不会红。
//
// 而这件事**已经真实发生过至少四次**：`packages/frontend/src/routes/agents.detail.tsx:315-353`
// 排着 RFC-115 / RFC-155 / RFC-306 / RFC-166 四条「round-trip fix」注释。
// 每一条都是一次「保存之后用户的配置被静默清空」。
//
// 同时 `agent-create-button` 在全仓 e2e 里只出现一次，而且只量 boundingBox 宽度
// （`ux-consistency.spec.ts:826`）、从不点击——所有 e2e 的代理都是 API 播种的，
// 「用户填表创建」这条路从未被走过。

import { expect, test, type Page } from '@playwright/test'

import { startDaemon, type DaemonHandle } from './harness'

let daemon: DaemonHandle
let sequence = 0

test.setTimeout(60_000)

async function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await api(path, { method: 'POST', body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`POST ${path} → ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

async function primeAuth(page: Page): Promise<void> {
  await page.addInitScript(
    ({ baseUrl, token }) => {
      window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
      window.localStorage.setItem('agent-workflow.token', token)
      window.localStorage.setItem('aw-language', 'en-US')
    },
    { baseUrl: daemon.baseUrl, token: daemon.token },
  )
}

test.beforeAll(async () => {
  daemon = await startDaemon()
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

// ---------------------------------------------------------------------------
// AGENT-01 —— 用户填表创建代理，且真的落库
// ---------------------------------------------------------------------------

test('RFC-319 AGENT-01: filling the new-agent form creates a real row, not just a draft', async ({
  page,
}) => {
  const name = `rfc319-created-${++sequence}`
  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/agents/new`)

  const createButton = page.getByTestId('agent-create-button')
  // 空名字不放行——这是表单上唯一的必填护栏。
  await expect(createButton).toBeDisabled()

  await page.getByLabel(/^Name/).fill(name)
  await page.getByLabel('Description', { exact: true }).fill('RFC-319 authoring fixture')
  await expect(createButton).toBeEnabled()
  await createButton.click()

  // 创建成功后落在详情页。
  await expect(page).toHaveURL(new RegExp('/agents/[0-9A-Z]{26}$'))
  const id = new URL(page.url()).pathname.split('/').pop()!

  // **落库**而不是只改了前端缓存：直接问 API。
  const persisted = (await (await api(`/api/agents/${id}`)).json()) as {
    name: string
    description: string | null
  }
  expect(persisted.name).toBe(name)
  expect(persisted.description, '描述没有落库 ⇒ 创建只把草稿状态推进了，用户填的内容丢了').toBe(
    'RFC-319 authoring fixture',
  )
})

// ---------------------------------------------------------------------------
// AGENT-04 / AGENT-23 —— 富字段代理保存一次，其它字段一个都不许丢
// ---------------------------------------------------------------------------

test('RFC-319 AGENT-04/23: a description-only save keeps every untouched field intact', async ({
  page,
}) => {
  // 播一整套「用户可能配过的东西」。这条用例的全部价值在于 fixture 足够富：
  // 空壳 agent 证明不了任何 round-trip 保真性。
  const helperName = `rfc319-helper-${++sequence}`
  const helper = await post<{ id: string }>('/api/agents', {
    name: helperName,
    description: 'dependency target',
    outputs: ['result'],
    readonly: true,
    bodyMd: 'helper',
  })
  const mcp = await post<{ id: string }>('/api/mcps', {
    name: `rfc319-mcp-${++sequence}`,
    description: 'round-trip fixture',
    type: 'remote',
    config: { url: 'http://127.0.0.1:1/mcp', oauth: false },
    enabled: true,
  })
  const plugin = await post<{ id: string }>('/api/plugins', {
    name: `rfc319-plugin-${++sequence}`,
    spec: daemon.stubOpencode,
    description: 'round-trip fixture',
    enabled: true,
  })

  const name = `rfc319-rich-${++sequence}`
  const created = await post<{ id: string }>('/api/agents', {
    name,
    description: 'before',
    outputs: ['answer', 'notes'],
    readonly: false,
    bodyMd: 'Rich fixture body.',
    mcp: [mcp.id],
    plugins: [plugin.id],
    dependsOn: [helper.id],
    role: 'normal',
  })

  const before = (await (await api(`/api/agents/${created.id}`)).json()) as Record<string, unknown>

  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/agents/${created.id}`)
  await expect(page.getByTestId('agent-save-button')).toBeVisible()

  // 只改描述这一个字段。
  await page.getByTestId('agent-tab-basics').click()
  await page.getByLabel('Description', { exact: true }).fill('after')
  await page.getByTestId('agent-save-button').click()

  // 保存后 reload，断言只有 description 变了。
  await expect
    .poll(async () => {
      const row = (await (await api(`/api/agents/${created.id}`)).json()) as {
        description: string | null
      }
      return row.description
    })
    .toBe('after')

  const after = (await (await api(`/api/agents/${created.id}`)).json()) as Record<string, unknown>
  const compared = [
    'name',
    'outputs',
    'readonly',
    'bodyMd',
    'mcp',
    'plugins',
    'dependsOn',
    'role',
    'skills',
    'inputs',
  ] as const
  for (const field of compared) {
    expect(
      after[field],
      `保存一次之后 \`${field}\` 变了。这正是 agents.detail.tsx:315-353 那四条 ` +
        `round-trip fix 注释记录的事故形态：UI 只改了一个字段，其它字段被静默清空`,
    ).toEqual(before[field])
  }
})

// ---------------------------------------------------------------------------
// AGENT-07 —— 并发保存冲突必须被拦下并说清楚
// ---------------------------------------------------------------------------

test('RFC-319 AGENT-07: a stale save is refused with a readable conflict instead of silently overwriting', async ({
  page,
}) => {
  const name = `rfc319-conflict-${++sequence}`
  const created = await post<{ id: string }>('/api/agents', {
    name,
    description: 'v1',
    outputs: ['answer'],
    readonly: true,
    bodyMd: 'v1 body',
  })
  // PUT 是 sparse patch + exact revision fence（UpdateAgentRequestSchema 是 .strict()，
  // 且 name 被 omit 掉——改名不走这条路）。fence 的两个字段来自 GET 的 updatedAt /
  // aclRevision，与 agents.detail.tsx:104-105 取的是同一处。
  const fenced = (await (await api(`/api/agents/${created.id}`)).json()) as {
    updatedAt: number
    aclRevision: number | null
  }

  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/agents/${created.id}`)
  await expect(page.getByTestId('agent-save-button')).toBeVisible()

  // 另一个写者先落地（模拟另一个标签页 / 另一个人）。
  const other = await api(`/api/agents/${created.id}`, {
    method: 'PUT',
    body: JSON.stringify({
      description: 'written by someone else',
      expectedUpdatedAt: fenced.updatedAt,
      expectedAclRevision: fenced.aclRevision ?? 0,
    }),
  })
  expect(other.status, `另一个写者的正常保存被拒了：${await other.text()}`).toBe(200)

  // 这个页面手里的 expectedUpdatedAt 已经过期。
  await page.getByLabel('Description', { exact: true }).fill('written by this tab')
  await page.getByTestId('agent-save-button').click()

  // 必须看得见冲突，而不是静默覆盖对方。
  await expect(
    page.locator('.error-box').first(),
    '过期保存没有任何可读呈现 ⇒ 用户不知道自己刚覆盖了别人，或以为「点了没反应」',
  ).toBeVisible()

  // 而且对方的内容还在。
  const row = (await (await api(`/api/agents/${created.id}`)).json()) as {
    description: string | null
  }
  expect(row.description, '过期保存把别人的改动覆盖掉了').toBe('written by someone else')
})

// ---------------------------------------------------------------------------
// AGENT-35 / RFC-319 T32 —— 真实的引用完整性告警
// ---------------------------------------------------------------------------
//
// ⚠️ 这条用例存在的原因：唯一断言这个告警的浏览器用例
// （`e2e/rfc250-visual-states.spec.ts:689`）有两个问题——
//   ① 它用 `page.route` **把 `/resource-status` 的响应整个换掉**，所以后端那段
//      完整性计算一行都没跑过；
//   ② 它所在的整个 describe 被 `test.skip(!RUN_VISUAL_REGRESSION)` 关着
//      （同文件 `:530`），默认 `bun run e2e` 与 PR CI 的 Playwright 腿**根本不跑它**，
//      只有 path-filtered 的 visual-regression-nightly 才会执行。
// 两条叠起来的净效果是：后端完整性判据的回归在 e2e 侧零防护。
//
// 这里走**真实**路径：插件可以被 PUT 关掉（`enabled: false`），于是引用它的代理
// 就真的有了一条 `plugin-disabled` 问题——不需要任何 mock。
test('RFC-319 T32: disabling a referenced plugin surfaces a real integrity blocker (no route mock)', async ({
  page,
}) => {
  const plugin = await post<{ id: string; name: string }>('/api/plugins', {
    name: `rfc319-doomed-plugin-${++sequence}`,
    spec: daemon.stubOpencode,
    description: 'will be disabled',
    enabled: true,
  })
  const agent = await post<{ id: string }>('/api/agents', {
    name: `rfc319-integrity-${++sequence}`,
    description: 'references a plugin that is about to be disabled',
    outputs: ['answer'],
    readonly: true,
    bodyMd: 'body',
    plugins: [plugin.id],
  })

  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/agents/${agent.id}`)
  await page.getByTestId('agent-tab-resources').click()
  // 先证明**没有**告警——否则「告警可见」可能只是因为它一直可见。
  await expect(page.getByTestId('agent-resource-integrity-error')).toHaveCount(0)

  const pluginRow = (await (await api(`/api/plugins/${plugin.id}`)).json()) as {
    operationConfigHash: string
  }
  const disabled = await api(`/api/plugins/${plugin.id}`, {
    method: 'PUT',
    body: JSON.stringify({
      enabled: false,
      expectedConfigHash: pluginRow.operationConfigHash,
    }),
  })
  expect(disabled.status, `关闭插件失败：${await disabled.text()}`).toBe(200)

  await page.reload()
  await page.getByTestId('agent-tab-resources').click()
  const blocker = page.getByTestId('agent-resource-integrity-error')
  await expect(
    blocker,
    '引用的插件被停用后，能力页没有任何告警 ⇒ 用户要等到任务真跑起来才知道代理坏了',
  ).toBeVisible()
  await expect(blocker).toHaveAttribute('role', 'alert')
  // 告警要指得出是哪一个引用坏了，否则用户无从下手。
  await expect(blocker).toContainText(plugin.name)
})

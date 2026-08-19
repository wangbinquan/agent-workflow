// RFC-310 T140 E2E-A —— 零配置首次上手：一个什么都没配过的账号，只按每一页
// 高亮的那一个动作走，就能一路走到「给数字员工的第一件工作」。
//
// 这条用例锁的是 PR-13 的产品承诺本身：**下一步由服务端投影给出**，每一停点都
// 说得出「现在在第几步 / 下一步是什么 / 该谁做」，而且刷新与 daemon 重启都不丢。
// 它与 `rfc310-digital-employee-journey.spec.ts`（E2E-B：跨仓 + 审批 + merged）
// 互补：那条走完整交付生命周期，这条走**首次上手的导航链**。
//
// 诚实边界：员工的**技术闭包**（ActionTemplate / VerificationProfile / policy /
// 说明书正文）经 API 播种——本用例断言的是导航链与投影，不是创建向导的逐字段
// 编辑（那属 T121 的逐页浏览器回归）。真正走 UI 的是：创建员工、发布员工、
// 绑定仓库范围、发起首个任务，以及每一停点的 journey 断言。

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test, type Page } from '@playwright/test'

import { SYSTEM_MOCK_CODE_HOST_TOKEN, SystemMockClient } from '@agent-workflow/system-mocks'

import { defaultAutomationPolicyContent } from '../packages/backend/src/modules/development-automation/domain/automationPolicy'
import { startDaemon, type DaemonHandle } from './harness'

test.describe.configure({ mode: 'serial' })
test.setTimeout(300_000)

const PROJECT_PATH = 'rfc310/zero-config-onboarding'

let daemon: DaemonHandle
let mocks: SystemMockClient
// 本用例要**重启 daemon** 验证「刷新与重启都不丢」，所以 home 必须由用例自己持有：
// 不显式传 home 时 harness 视其为自己的临时目录，`stop()` 会连同数据库一起删掉，
// 重启后是一个空库——投影当然退回第一步，看起来像投影坏了（实测踩过）。
let daemonHome = ''
const suffix = Math.random().toString(36).slice(2, 10)

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`${name} is required`)
  return value
}

async function requestJson<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`${daemon.baseUrl}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${daemon.token}`,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} returned ${response.status}: ${text}`)
  }
  return (text === '' ? undefined : JSON.parse(text)) as T
}

async function publishResource<T extends { id: string }>(
  base: string,
  body: Record<string, unknown>,
): Promise<T & { revision: number }> {
  const created = await requestJson<T>(base, { method: 'POST', body })
  const published = await requestJson<{ revision: number }>(`${base}/${created.id}/publish`, {
    method: 'POST',
    body: {},
  })
  return { ...created, revision: published.revision }
}

async function importRepository(repoUrl: string): Promise<string> {
  let batch = await requestJson<{
    batchId: string
    state: 'running' | 'completed'
    rows: Array<{ status: string; message: string | null }>
  }>('/api/cached-repos/batch-import', { method: 'POST', body: { urls: [repoUrl] } })
  const deadline = Date.now() + 60_000
  while (batch.state !== 'completed' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150))
    batch = await requestJson(`/api/cached-repos/imports/${batch.batchId}`)
  }
  if (batch.state !== 'completed' || batch.rows.some((row) => row.status !== 'done')) {
    throw new Error(`repository import failed: ${JSON.stringify(batch.rows)}`)
  }
  const repos = await requestJson<{ items: Array<{ id: string; urlRedacted: string | null }> }>(
    '/api/cached-repos',
  )
  const repo = repos.items.find((row) => row.urlRedacted === repoUrl)
  if (repo === undefined) throw new Error(`imported repository ${repoUrl} is missing`)
  return repo.id
}

async function primeAuth(page: Page): Promise<void> {
  await page.addInitScript(
    ({ baseUrl, token }) => {
      localStorage.setItem('agent-workflow.baseUrl', baseUrl)
      localStorage.setItem('agent-workflow.token', token)
      localStorage.setItem('aw-language', 'en-US')
    },
    { baseUrl: daemon.baseUrl, token: daemon.token },
  )
}

async function choose(page: Page, testId: string, option: string | RegExp): Promise<void> {
  await page.getByTestId(testId).click()
  await page.getByRole('option', { name: option }).click()
}

/** 一个停点的三件事：现在第几步、下一步是什么、该谁做。 */
async function expectStop(
  page: Page,
  expected: { current: string; next: string; owner: string },
): Promise<void> {
  const journey = page.getByTestId('journey-next-action')
  await expect(journey).toBeVisible()
  // `aria-current="step"` 挂在 li 本身（不是后代），所以只能直接选它——用
  // `filter({has})` 会一个都匹配不上，再 `.or(...).first()` 就退化成"第一步"，
  // 于是这条断言在任何停点都读到 step 1，看起来像投影坏了（实测踩过）。
  await expect(journey.locator('li[aria-current="step"]')).toContainText(expected.current)
  await expect(journey.getByRole('heading', { level: 2 })).toHaveText(expected.next)
  await expect(journey).toContainText(`Owner: ${expected.owner}`)
}

test.beforeAll(async () => {
  mocks = new SystemMockClient(
    requiredEnv('AW_SYSTEM_MOCK_CONTROL_URL'),
    requiredEnv('AW_SYSTEM_MOCK_CONTROL_TOKEN'),
  )
  daemonHome = mkdtempSync(join(tmpdir(), 'rfc310-onboarding-'))
  daemon = await startDaemon({ home: daemonHome, stubMode: 'development' })
  await requestJson('/api/code-hosts/gitlab', {
    method: 'PUT',
    body: {
      baseUrl: requiredEnv('AW_SYSTEM_MOCK_GITLAB_API_BASE_URL'),
      token: SYSTEM_MOCK_CODE_HOST_TOKEN,
    },
  })
  const project = await mocks.seedCodeHost({
    provider: 'gitlab',
    projectPath: PROJECT_PATH,
    title: 'RFC-310 zero-config onboarding',
    defaultBranch: 'main',
    baseFiles: {
      'pom.xml': '<project><modelVersion>4.0.0</modelVersion></project>\n',
      'src/main/java/App.java': 'class App {}\n',
    },
  })
  // 仓库导入是「设置范围」那一步的前提；id 由 UI 的选择器自己解析，这里不需要留。
  await importRepository(project.repoHttpUrl)

  // 技术闭包（Agent + 验证 profile + 动作模板 + 策略）预置：本用例断言导航链，
  // 不断言技术资源的表单编辑。
  const agent = await requestJson<{ id: string }>('/api/agents', {
    method: 'POST',
    body: {
      name: `rfc310-onboarding-agent-${suffix}`,
      description: 'Capability-bound Agent used by the RFC-310 onboarding journey.',
      outputs: ['agent-result'],
      runtime: 'opencode',
      bodyMd: '',
    },
  })
  const verification = await publishResource<{ id: string }>('/api/code/verification-profiles', {
    name: `Repository verification ${suffix}`,
    draft: {
      schemaVersion: 1,
      steps: [
        {
          stepId: 'no-op',
          programRef: 'repo:pom.xml',
          argsRef: null,
          timeoutMs: 30_000,
          networkProfileRef: 'none@1',
          successExitCodes: [0],
          evidenceSelectors: [{ kind: 'stdout-tail', value: 4096 }],
        },
      ],
      stopPolicy: 'first-failure',
      maxParallel: 1,
    },
  })
  // 创建向导要求「至少一个已发布的动作模板 + 一个已发布的规则集」才能给出可发布的
  // 初始说明书；这里只需要它们**存在**，具体 ref 由向导自己解析。
  await publishResource<{ id: string }>('/api/code/action-templates', {
    name: `Java implement ${suffix}`,
    capabilityId: 'change.implement',
    draft: {
      schemaVersion: 1,
      capabilityId: 'change.implement',
      capabilityContractVersion: 1,
      labels: ['java', 'browser-e2e'],
      compatibility: [],
      executor: { kind: 'agent', agentRef: agent.id },
      runtimeProfileRef: 'opencode',
      promptSupplement: 'Implement the immutable requirement bundle.',
      skillRefs: [],
      mcpRefs: [],
      readOnlyResourceRefs: [],
      contextProfileRef: null,
      writablePathPolicyRef: null,
      additionalProtectedPathClasses: [],
      verificationProfileRef: `${verification.id}@${verification.revision}`,
      retryDefaults: { sameSession: 1, freshSession: 1 },
    },
  })
  await publishResource<{ id: string }>('/api/code/automation-policies', {
    name: `Zero config delivery ${suffix}`,
    draft: defaultAutomationPolicyContent(),
  })
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
  if (daemonHome !== '') rmSync(daemonHome, { recursive: true, force: true })
})

test('a first-time account reaches its first piece of work by only following the highlighted action', async ({
  page,
}) => {
  await primeAuth(page)

  // 停点 1：什么都没有 —— 第一步「定义员工」，下一步「创建数字员工」，该我做。
  await page.goto(`${daemon.baseUrl}/code`)
  await expectStop(page, {
    current: 'Define employee',
    next: 'Create a digital employee',
    owner: 'You',
  })

  // 只点这一个动作：落到员工列表并自动打开创建对话框。
  await page.getByTestId('journey-next-link').click()
  await page.waitForURL(/\/code\/config\/employees/)
  const employeeName = `Zero config employee ${suffix}`
  await page.getByTestId('config-create-name').fill(employeeName)
  await page.getByTestId('config-create-submit').click()
  await page.waitForURL(/\/code\/config\/employees\/[0-9A-Z]+$/)
  const employeeId = page.url().split('/').at(-1)!

  // 停点 2：创建向导给出的是**可发布的起点**（预置步骤 + 规则集），所以下一步
  // 直接是「发布这名数字员工」，而不是「先把说明书写完」。
  await page.goto(`${daemon.baseUrl}/code`)
  await expectStop(page, {
    current: 'Publish employee',
    next: 'Publish this digital employee',
    owner: 'You',
  })

  // `/code` 只给导航（发布是员工详情页的命令）；点过去后**同页**就是发布按钮。
  await page.getByTestId('journey-next-link').click()
  await page.waitForURL(new RegExp(`/code/config/employees/${employeeId}$`))
  await page.getByTestId('journey-next-command').click()

  // T137：发布成功后**不跳页**，同一页的下一步立刻变成「设置它服务的仓库」。
  await expectStop(page, {
    current: 'Set scope',
    next: 'Set the repositories it serves',
    owner: 'You',
  })

  // 停点 3：绑定范围。链接自带 `?employee=…&create=1` —— 落地即开对话框，
  // 用户不需要再找一次「新建指派」。
  await page.getByTestId('journey-next-link').click()
  await page.waitForURL(/\/code\/assignments/)
  await choose(page, 'assignment-scope-ref', /zero-config-onboarding/)
  await choose(page, 'assignment-employee', employeeName)
  await page.getByTestId('assignment-save').click()
  await expect(page.getByTestId('assignments-repository')).toContainText(employeeName)

  // 停点 4：范围绑好了 —— **同页**就出现「交给它第一件工作」（T138）。
  await expectStop(page, {
    current: 'Give first work',
    next: 'Give it the first piece of work',
    owner: 'You',
  })

  // 刷新不丢：投影来自服务端，不是页面内的一次性状态。
  await page.reload()
  await expectStop(page, {
    current: 'Give first work',
    next: 'Give it the first piece of work',
    owner: 'You',
  })

  // daemon 重启不丢：同一个 home 重新起进程，投影仍是同一停点。
  await daemon.stop()
  daemon = await startDaemon({ home: daemonHome, stubMode: 'development' })
  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/code`)
  await expectStop(page, {
    current: 'Give first work',
    next: 'Give it the first piece of work',
    owner: 'You',
  })

  // 继续按高亮动作走：发起第一件工作。
  await page.getByTestId('journey-next-link').click()
  await page.waitForURL(/\/code\/missions\/new/)
  await choose(page, 'mission-repo-select', /zero-config-onboarding/)
  await page.getByTestId('stepper-next').click()
  await page.getByTestId('mission-title').fill('First piece of work')
  await page.getByTestId('mission-body').fill('Add a short note describing the public behavior.')
  await page.getByTestId('stepper-next').click()
  await page.getByTestId('stepper-next').click()
  await page.getByTestId('mission-preflight').click()
  await expect(page.getByTestId('mission-preflight-ready')).toBeVisible()
  await page.getByTestId('mission-launch-submit').click()
  await page.waitForURL(/\/code\/missions\/[0-9A-Z]+$/)

  // 停点 5：任务详情 —— 交付旅程的第一停点，且明说这一步不需要我操作。
  const detail = page.getByTestId('journey-next-action')
  await expect(detail).toBeVisible()
  await expect(detail).toContainText('Owner: Platform')
  await expect(detail).toContainText('No action needed from you')
})

// RFC-319 B32 —— INTENT-39：提交策略步的「原地修改 vs 复制一份」。
//
// 意图构建器提交的是**一整批对既有资源的改动**。对 update 型操作，这一步问的
// 问题只有一个，但它决定的是「谁被改了」：
//
//   * 「修改」= 就地改掉那个资源。别人正在用它，改动立即对所有引用它的工作流 /
//     工作组生效；
//   * 「复制一份」= 铸一个新的，原件一个字节不动。
//
// 选反的后果完全不对称，而且是静默的：想复制却改成了原地，别人的资源被覆盖，
// 界面只会显示「已提交」。
//
// 判据因此落在**两边都读**：改动去了哪个 id、以及**另一个**有没有被动过。只断言
// 「新的那个对了」是不够的——原地修改同样能让「新的那个对了」成立。
//
// 这一步只在 changeset 里存在 update 操作时才出现，而此前所有 intent stub 变体
// 产出的都是 create——整步没有任何 e2e 能走到。本批因此给 stub 加了 `update`
// 变体（`packages/system-mocks/src/runtime/mode-intent.ts`），它按用户消息里的
// `rfc319-target:<name>` 从工作目录的清单文件里认出会话句柄，和真实模型读的是
// 同一份东西。
//
// 判据取自源码单一事实源：
//   routes/intent.detail.tsx:1444-1463          Apply mode 分段控件（仅 update op）
//   services/intent/resolveChangeset.ts:466-474 copy ⇒ 铸新 id；modify ⇒ 沿用原 id

import { expect, test, type Page } from '@playwright/test'

import { startDaemon, type DaemonHandle } from './harness'

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

let daemon: DaemonHandle
let sequence = 0

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  const body = await res.text()
  expect(res.ok, `${path}: ${res.status} ${body}`).toBe(true)
  return JSON.parse(body) as T
}

interface AgentRow {
  id: string
  name: string
  description: string
}

const listAgents = (): Promise<AgentRow[]> => api<AgentRow[]>('/api/agents')

test.beforeAll(async () => {
  daemon = await startDaemon({
    stubMode: 'intent',
    extraEnv: { STUB_INTENT_VARIANT: 'update' },
  })
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

async function seedAgent(name: string): Promise<AgentRow> {
  return api<AgentRow>('/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name,
      description: 'original description',
      outputs: ['answer'],
      outputKinds: { answer: 'markdown' },
      readonly: true,
      bodyMd: 'Original body.',
    }),
  })
}

/**
 * 从资源详情页的「Modify via intent」入口起会话。
 *
 * 走这个入口而不是 `/intent` 上的空白输入框：update 型操作要求目标**已挂载**，
 * 只在清单里可见不够——实测服务端会以
 * `op-1: target res#agent#N is inventory-only — request a mount before updating it`
 * 判定草稿有阻塞错误，提交入口随之不可用。这个入口会把目标预挂载进新会话。
 */
async function draftUpdateFor(page: Page, target: AgentRow): Promise<void> {
  await page.addInitScript(
    ([baseUrl, token]) => {
      window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
      window.localStorage.setItem('agent-workflow.token', token)
      window.localStorage.setItem('aw-language', 'en-US')
    },
    [daemon.baseUrl, daemon.token] as const,
  )
  await page.goto(`${daemon.baseUrl}/agents/${target.id}`)
  await page.getByTestId('agent-intent-entry').click()
  await page.waitForURL(/\/intent\?/)
  const dialog = page.getByRole('dialog')
  await dialog
    .getByTestId('intent-create-dialog')
    .getByTestId('intent-create-message')
    .fill(`rework rfc319-target:${target.name}`)
  await dialog.getByRole('button', { name: 'Start building' }).click()
  await page.waitForURL(/\/intent\/[0-9A-Z]+/i)
  await expect(page.getByTestId('intent-draft')).toBeVisible({ timeout: 60_000 })
}

/** 走完提交向导，在第 0 步选好 apply mode。 */
async function commitWith(
  page: Page,
  mode: 'Modify' | 'Create copy',
  copyName?: string,
): Promise<void> {
  await page.getByTestId('intent-open-commit').click()
  await expect(
    page.getByRole('heading', { name: 'Apply mode', exact: true }),
    'update 型操作必须问「改原件还是复制一份」——不问就等于替用户默默选了原地修改',
  ).toBeVisible()
  // Segmented 渲染成 role=radiogroup / role=radio（components/Segmented.tsx:142,160）。
  await page.getByRole('radio', { name: mode, exact: true }).click()
  await page.getByTestId('intent-commit-next').click()
  if (copyName !== undefined) {
    // 副本与原件同名会撞占用名预检，向导为此在第 1 步给出改名槽。
    await page.getByPlaceholder('New name').fill(copyName)
  }
  await page.getByTestId('intent-commit-next').click()
  await page.getByTestId('intent-commit-submit').click()
  await expect(page.getByText('Committed', { exact: false }).first()).toBeVisible({
    timeout: 60_000,
  })
}

test('选「修改」：改动落在原来那个 id 上，不铸新资源', async ({ page }) => {
  const name = `rfc319-intent39-modify-${++sequence}`
  const original = await seedAgent(name)
  const countBefore = (await listAgents()).length

  await draftUpdateFor(page, original)
  await commitWith(page, 'Modify')

  const agents = await listAgents()
  const survivor = agents.find((row) => row.id === original.id)
  expect(survivor, '原地修改把原来那个 id 弄丢了').toBeTruthy()
  expect(survivor?.name).toBe(name)
  expect(
    survivor?.description,
    '选「修改」却没改到原件 ⇒ 用户以为改好了，引用它的工作流仍在跑旧版本',
  ).toBe('updated by the e2e intent stub')
  expect(
    agents.length,
    '选「修改」却多出一个资源 ⇒ 用户以为改了原件，实际留下了两份各自演化的副本',
  ).toBe(countBefore)
})

test('选「复制一份」：铸出新 id，而原件一个字节都不动', async ({ page }) => {
  const name = `rfc319-intent39-copy-${++sequence}`
  const original = await seedAgent(name)

  await draftUpdateFor(page, original)
  const copyName = `${name}-copy`
  await commitWith(page, 'Create copy', copyName)

  const agents = await listAgents()
  const copy = agents.find((row) => row.name === copyName)
  expect(copy, '选「复制一份」却没有新资源').toBeTruthy()
  expect(copy?.id, '「复制一份」复用了原来的 id ⇒ 那不是复制，是就地覆盖').not.toBe(original.id)
  expect(copy?.description).toBe('updated by the e2e intent stub')

  const untouched = agents.find((row) => row.id === original.id)
  expect(untouched?.name, '原件被改名了——而用户选的是「不要动它」').toBe(name)
  expect(
    untouched?.description,
    '原件被覆盖是这一步最坏的失效：别人正在用它，而界面只显示「已提交」',
  ).toBe('original description')
})

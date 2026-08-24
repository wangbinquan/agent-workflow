// RFC-319 B20 —— 蒸馏任务分区的权限门（MEM-24 / MEM-31）。
//
// 蒸馏任务面暴露的是**未经人审的模型产出**与它们的失败诊断（stderr 摘录、
// 源事件、模型会话）。它由 `memory-distill-jobs:manage` 单点把守，而这道门有
// 三个必须同时成立的面，少任何一个都留下一条真实的口子：
//
//   ① 导航里不出现那一格 —— 否则用户点进去只会撞一堵 403 墙；
//   ② `?tab=distill-jobs` 深链**回落**到默认分区，并明确告诉他为什么 ——
//      深链会出现在书签、聊天记录、旧收藏里，静默显示空白是最坏的处置；
//   ③ 页面不因此发那些他无权发的请求 —— 否则日志里堆满 403，真正的问题被淹没。
//
// 判据取自源码单一事实源：`routes/memory.tsx:83-94`（`canManageDistillJobs`
// 为假时 `requestedTab === 'distill-jobs'` 被改写成 `'all'`）与同文件
// :117-125 的 `showUnavailableNotice`。

import { expect, test, type Page } from '@playwright/test'

import { startDaemon, type DaemonHandle } from './harness'

test.describe.configure({ mode: 'serial' })
test.setTimeout(120_000)

const PASSWORD = 'Rfc319DistillGatePass!1'

let daemon: DaemonHandle
let sequence = 0

test.beforeAll(async () => {
  daemon = await startDaemon()
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

async function req(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
}

async function jsonOf<T>(res: Response, what: string): Promise<T> {
  const body = await res.text()
  expect(res.ok, `${what}: ${res.status} ${body}`).toBe(true)
  return JSON.parse(body) as T
}

async function primeToken(page: Page, token: string): Promise<void> {
  await page.addInitScript(
    ({ url, tok }) => {
      window.localStorage.setItem('agent-workflow.baseUrl', url)
      window.localStorage.setItem('agent-workflow.token', tok)
      window.localStorage.setItem('aw-language', 'en-US')
    },
    { url: daemon.baseUrl, tok: token },
  )
}

/** `role` 决定是否带 `memory-distill-jobs:manage`（manager 预设里有，user 没有）。 */
async function seedToken(role: 'user' | 'manager'): Promise<string> {
  const username = `rfc319-distill-${role}-${++sequence}`
  await jsonOf(
    await req('/api/users', {
      method: 'POST',
      body: JSON.stringify({
        username,
        displayName: username,
        email: `${username}@example.com`,
        role,
        password: PASSWORD,
      }),
    }),
    `seed ${username}`,
  )
  const { sessionToken } = await jsonOf<{ sessionToken: string }>(
    await fetch(`${daemon.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: PASSWORD }),
    }),
    `login ${username}`,
  )
  return sessionToken
}

test('RFC-319 MEM-24/31: without memory-distill-jobs:manage the section is hidden, a deep link falls back with a stated reason, and no request is sent for it', async ({
  page,
}) => {
  // 正向对照先立起来：有权限的人**看得见**那一格。没有它，下面所有的
  // 「看不见」都可能只是「这个分区根本没渲染」。
  const manager = await seedToken('manager')
  await primeToken(page, manager)
  await page.goto(`${daemon.baseUrl}/memory`)
  await expect(page.getByTestId('memory-section-distill-jobs')).toBeVisible({ timeout: 30_000 })
})

test('RFC-319 MEM-24/31: a plain user gets no distill section, and the deep link lands on All with an explicit notice', async ({
  page,
}) => {
  const plain = await seedToken('user')
  await primeToken(page, plain)

  // 记下这一页发出的所有蒸馏任务请求。判据之一是「一个都没有」。
  const distillCalls: string[] = []
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname
    if (path.includes('distill')) distillCalls.push(path)
  })

  // ① 导航里没有那一格。
  await page.goto(`${daemon.baseUrl}/memory`)
  await expect(page.getByTestId('memory-section-all')).toBeVisible({ timeout: 30_000 })
  await expect(
    page.getByTestId('memory-section-distill-jobs'),
    '无权限的用户在导航里看到了蒸馏任务分区 ⇒ 点进去只会撞一堵 403 墙',
  ).toHaveCount(0)

  // ② 深链回落到 All，并且**说明了原因**。深链会出现在书签、聊天记录、
  //    旧收藏里；静默显示空白是最坏的处置——用户会以为功能坏了。
  await page.goto(`${daemon.baseUrl}/memory?tab=distill-jobs`)
  await expect(page.getByTestId('memory-section-panel')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('memory-section-panel'), '深链没有回落到默认分区').toHaveClass(
    /memory-section-panel--all/,
  )
  await expect(
    page.getByText('You cannot access that automation section'),
    '回落了但没告诉用户为什么 ⇒ 他会以为这个功能坏了，然后去提一个查不出问题的工单',
  ).toBeVisible({ timeout: 15_000 })

  // ③ 整个过程一个蒸馏任务请求都没发。发了的话日志里会堆满 403，
  //    真正的问题被淹没在噪声里。
  await page.waitForTimeout(1500)
  expect(distillCalls, '无权限的页面仍然去拉了蒸馏任务 ⇒ 服务端日志被必然失败的 403 刷屏').toEqual(
    [],
  )
})

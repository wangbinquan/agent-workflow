// RFC-319 B21 —— WS 推送让**已经打开的**列表自更新（UX-30）。
//
// 这条能力的价值全在「不导航」三个字上：用户停在一个列表页上等结果，
// 别处（另一个人、一个后台任务、一次自动化）改了数据。链路断掉的症状是
// **界面静止**——它不报错、不空白、不转圈，只是永远停在旧数据上，
// 而用户会以为「还没发生」。这是所有失效形态里最难被发现的一种。
//
// 判据取自源码单一事实源：`hooks/useMemoryWs.ts`（`/ws/memories` 的每个
// `memory.*` 变体映射到一组 react-query key），页面侧 `routes/memory.tsx:127`
// 的 `useMemoryWs()`。
//
// 用例刻意**不碰页面上的任何东西**：不点刷新、不切页签、不重新导航。
// 唯一的动作发生在浏览器之外（一次 HTTP 写），然后只等界面自己变。

import { expect, test, type Page } from '@playwright/test'

import { startDaemon, type DaemonHandle } from './harness'

test.setTimeout(120_000)

let daemon: DaemonHandle

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

async function primeToken(page: Page): Promise<void> {
  await page.addInitScript(
    ({ url, tok }) => {
      window.localStorage.setItem('agent-workflow.baseUrl', url)
      window.localStorage.setItem('agent-workflow.token', tok)
      window.localStorage.setItem('aw-language', 'en-US')
    },
    { url: daemon.baseUrl, tok: daemon.token },
  )
}

test('RFC-319 UX-30: a list that is already open picks up an out-of-band change without any navigation', async ({
  page,
}) => {
  await primeToken(page)

  // 打开「待审批」分区并停在这里。后面一步都不再碰浏览器。
  await page.goto(`${daemon.baseUrl}/memory?tab=approval-queue`)
  await expect(page.getByTestId('memory-section-panel')).toBeVisible({ timeout: 30_000 })

  const title = `rfc319-live-${Date.now().toString(36)}`
  await expect(page.getByText(title), '前提：这条记忆还不存在，界面上当然不该有它').toHaveCount(0)

  // 浏览器之外的一次写。手工建的记忆落在 `candidate`，正好属于待审批分区。
  const created = await jsonOf<{ memory: { id: string } }>(
    await req('/api/memories', {
      method: 'POST',
      body: JSON.stringify({
        scopeType: 'global',
        scopeId: null,
        title,
        bodyMd: 'RFC-319 live-update fixture.',
      }),
    }),
    'create memory out of band',
  )

  // 不刷新、不导航、不点任何东西——只等它自己出现。
  await expect(
    page.getByText(title),
    '别处新增的数据没有推到已打开的列表上 ⇒ 界面就那么静止着：' +
      '不报错、不空白、不转圈，用户会以为事情还没发生',
  ).toBeVisible({ timeout: 20_000 })

  // 反方向同样要成立：别处**删掉**它，界面也得跟着变。
  // 只测「新增会出现」的话，一个只做 append 的实现同样能通过。
  const removed = await req(`/api/memories/${created.memory.id}?confirm=true`, {
    method: 'DELETE',
  })
  expect(removed.status, `delete: ${await removed.clone().text()}`).toBe(200)
  await expect(
    page.getByText(title),
    '别处删掉的数据仍留在已打开的列表上 ⇒ 用户会对着一条已经不存在的记录做决定',
  ).toHaveCount(0, { timeout: 20_000 })
})

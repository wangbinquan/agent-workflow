// RFC-319 —— 保存结果未知时的 fail-closed 处置（RES-08 同源形态）。
//
// 这是分布式写入里最难处理的一种：请求发出去了，**响应丢了**。写没写成功，
// 客户端不知道。三种处置里有两种是错的：
//   * 当成失败重试 ⇒ 可能把同一次写做两遍；
//   * 当成成功放行 ⇒ 用户带着一个可能没生效的值继续操作；
//   * 正确的是**停下来、承认不知道**，并且**不再往这条连接上写**——那次写可能
//     仍在服务端跑，一个迟到的结果会覆盖掉别人后来的保存。
//
// 实测到的设计比审计条目（「页面锁死 +『重新判定』恢复」）更强：连接级的响应
// 丢失走的是**写屏障**这条更保守的路，刻意**不给**自动重判入口，恢复代价明确
// 写在界面上（重启 daemon 后重载）。「重新判定」属于另一类可判定的歧义，不是
// 这一条。判据按实际行为写，不照抄审计描述。
//
// 判据取自源码单一事实源：`lib/edit-scope.ts` 的 `ambiguousSubmit` →
// `outcomeUnknown`（:396-423），以及 `routes/settings.tsx:3328-3342` 的
// 告警条 + 「Recheck server」动作（`editState.reconcile`）。
//
// 用例用 `page.route` 把保存请求**中途掐断**（不是回错误码——错误码是"已知失败"，
// 那是另一条路径），精确复现"响应丢失"。

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

test('RFC-319 RES-08: a save whose response is lost fails closed — the section locks, writes stop for the connection, and nothing is silently retried', async ({
  page,
}) => {
  await primeToken(page)
  await page.goto(`${daemon.baseUrl}/settings?tab=gc`)

  const field = page.getByTestId('settings-webhook-body-retention')
  await expect(field).toBeVisible({ timeout: 30_000 })
  const saveButton = page.getByRole('button', { name: 'Save', exact: true })
  // 这句文案在页面上不止一处（左侧分区导航的徽标 aria-label、告警条的标题）。
  // 只认**告警条本身**——它才是这条能力要验的恢复入口所在。
  const notice = page.locator('.notice-banner', {
    hasText: 'The previous save is still being reconciled with the server',
  })

  await expect(notice, '什么都没做就已经是「结果未知」⇒ 这个状态与保存无关').toHaveCount(0)

  // 掐断保存请求：连接建立、请求发出，然后**没有响应**。
  // 不用 `route.fulfill` 回 5xx——那是"已知失败"，走的是另一条分支；
  // 这条用例要的正是"不知道"。
  let dropped = 0
  await page.route('**/api/config', async (route) => {
    if (route.request().method() === 'PUT' || route.request().method() === 'PATCH') {
      dropped += 1
      await route.abort('connectionaborted')
      return
    }
    await route.continue()
  })

  await field.fill('31')
  await expect(saveButton).toBeEnabled()
  await saveButton.click()

  await expect(
    notice,
    '响应丢了，页面却没有进入「结果未知」⇒ 它要么当成失败重试（可能写两遍）、' +
      '要么当成成功放行（用户带着一个可能没生效的值继续走），两种都错',
  ).toBeVisible({ timeout: 20_000 })
  expect(dropped, '保存请求没有被真的掐断，前提不成立').toBeGreaterThan(0)

  // 锁死：结果未知期间不许再写。再写一次就可能把同一次写做两遍。
  await expect(
    saveButton,
    '结果未知期间保存按钮仍可点 ⇒ 用户一着急就会把同一次写发第二遍',
  ).toBeDisabled()

  // 实测到的设计比审计条目描述的更强，值得单独锁住：**连接级**的响应丢失
  // 会把这条连接的写入整体 fail-closed（`lib/config-receipts.ts:166` 的
  // `getWriteBlock`），并**刻意不提供**自动重判入口——因为那次写可能仍在
  // 服务端跑，一个迟到的结果会覆盖掉别人后来的保存。恢复路径是重启 daemon
  // 后重载，代价明确、语义干净。
  await expect(
    page.locator('.notice-banner', { hasText: 'settings writes are stopped for this connection' }),
    '响应丢失后没有进入写屏障 ⇒ 后续写入可能被一个迟到的结果覆盖',
  ).toBeVisible({ timeout: 20_000 })
  await expect(
    page.getByRole('button', { name: 'Recheck server', exact: true }),
    '写屏障期间仍给了「重新判定」入口 ⇒ 它会诱导用户在结果未定时再发一次请求',
  ).toHaveCount(0)

  // 屏障是真的：即便把拦截撤掉、再改一次值，也不允许再写。
  await page.unroute('**/api/config')
  const droppedBefore = dropped
  await field.fill('32')
  await expect(
    saveButton,
    '写屏障之后改个值就又能保存了 ⇒ 屏障只是个提示，没有真的挡住写入',
  ).toBeDisabled()
  expect(dropped, '写屏障期间仍然发出了写请求').toBe(droppedBefore)
})

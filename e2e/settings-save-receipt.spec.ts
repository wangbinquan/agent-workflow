// RFC-319 B22 —— 设置分区的保存回执（CFG-04）。
//
// 设置页保存的是**守护进程的运行参数**：端口、保留期、限额。它的失败形态很特别
// ——用户点了保存、界面没有任何变化，于是他**以为存上了**，然后带着一个从未生效
// 的配置继续往下走；下一次真正需要那个值的时候（重启、清理、限额触发）才发现。
// 所以这条能力的判据有两半，缺一不可：
//   ① 保存成功要有**明确回执**（不是"没有报错"——那和什么都没发生长得一样）；
//   ② 回执必须对应**真的落库**了——只渲染一句 "Saved" 而后端没收到，是更坏的谎。
//
// 判据取自源码单一事实源：`routes/settings.tsx:3320` 的
// `{success !== null && <span className="form-actions__ok">{t('common.saved')}</span>}`，
// 其 `success` 由 `save.isSuccess && save.error === null` 驱动（:537 等处）。

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

async function readConfig(): Promise<Record<string, unknown>> {
  const res = await fetch(`${daemon.baseUrl}/api/config`, {
    headers: { Authorization: `Bearer ${daemon.token}` },
  })
  const body = await res.text()
  expect(res.ok, `read config: ${res.status} ${body}`).toBe(true)
  return JSON.parse(body) as Record<string, unknown>
}

test('RFC-319 CFG-04: saving a settings section shows an explicit receipt, and the receipt corresponds to a value that really landed', async ({
  page,
}) => {
  await primeToken(page)
  await page.goto(`${daemon.baseUrl}/settings?tab=gc`)

  const field = page.getByTestId('settings-webhook-body-retention')
  await expect(field).toBeVisible({ timeout: 30_000 })

  const before = await readConfig()
  const saveButton = page.getByRole('button', { name: 'Save', exact: true })
  const receipt = page.locator('.form-actions__ok')

  // 前提：还没改动时既没有回执、保存也点不下去。没有这一步，「保存后出现回执」
  // 可能只是「回执一直都在」。
  await expect(receipt, '什么都没改就已经显示保存成功了 ⇒ 回执与保存无关').toHaveCount(0)
  await expect(saveButton, '无改动时保存按钮仍可点').toBeDisabled()

  // 改一个有确定语义、且能从 /api/config 读回来的值。
  const currentValue = Number(before['webhookDeliveryBodyRetentionDays'] ?? 30)
  const nextValue = currentValue === 21 ? 22 : 21
  await field.fill(String(nextValue))
  await expect(saveButton, '改动之后保存按钮仍是灰的').toBeEnabled()

  await saveButton.click()

  // ① 明确回执。"没有报错" 和 "什么都没发生" 长得一模一样，所以必须要有这句。
  await expect(
    receipt,
    '保存成功却没有任何回执 ⇒ 用户以为存上了，带着一个从未生效的配置继续往下走',
  ).toBeVisible({ timeout: 20_000 })
  await expect(receipt).toHaveText('Saved')

  // ② 回执背后真的落库了。只渲染一句 Saved 而后端没收到，比没有回执更坏。
  await expect
    .poll(async () => Number((await readConfig())['webhookDeliveryBodyRetentionDays']), {
      timeout: 20_000,
      message: '界面报了保存成功，服务端配置却没变 ⇒ 回执在撒谎',
    })
    .toBe(nextValue)

  // ③ 重新加载后仍是新值——回执不该只对应一次内存态的乐观更新。
  await page.reload()
  await expect(page.getByTestId('settings-webhook-body-retention')).toHaveValue(String(nextValue), {
    timeout: 30_000,
  })
})

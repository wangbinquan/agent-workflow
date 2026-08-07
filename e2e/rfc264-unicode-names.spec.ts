// RFC-264 — Chinese resource names, end to end in a real browser.
//
// User report: 「工作组、工作流名称要能支持中文」. Before this the shared rule was
// `^[a-z0-9][a-z0-9_-]*$`, so a Chinese-facing installation had to call every
// resource `code-audit-pipeline`. The unit suites cover the rule itself; this
// spec locks the thing the user actually does: type a Chinese name into the
// real create dialog, rename it, and see it in the list.

import { test, expect, type Page } from '@playwright/test'

import { startDaemon, type DaemonHandle } from './harness'

let daemon: DaemonHandle

test.setTimeout(120_000)

test.beforeAll(async () => {
  daemon = await startDaemon()
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

async function primeAuth(page: Page): Promise<void> {
  await page.addInitScript(
    ({ baseUrl, token }) => {
      try {
        window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
        window.localStorage.setItem('agent-workflow.token', token)
        window.localStorage.setItem('aw-language', 'zh-CN')
      } catch {
        /* ignore */
      }
    },
    { baseUrl: daemon.baseUrl, token: daemon.token },
  )
}

test('a workflow can be created and renamed with a Chinese name', async ({ page }) => {
  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/workflows`)

  await page.getByTestId('workflow-new-button').click()
  const nameInput = page.getByTestId('workflow-create-name')
  await expect(nameInput).toBeVisible()

  // An illegal name still blocks — the gate did not simply disappear.
  await nameInput.fill('_reserved')
  await expect(page.getByTestId('workflow-create-confirm')).toBeDisabled()

  await nameInput.fill('代码审计流水线')
  const confirm = page.getByTestId('workflow-create-confirm')
  await expect(confirm).toBeEnabled()
  await confirm.click()

  // Lands in the editor, whose header carries the Chinese name.
  await expect(page).toHaveURL(/\/workflows\/[0-9A-HJKMNP-TV-Z]{26}/)
  await expect(page.getByText('代码审计流水线').first()).toBeVisible()

  // Rename through the shared RenameDialog to a mixed-script name.
  await page.getByTestId('workflow-rename-button').click()
  const renameInput = page.getByTestId('workflow-rename-name')
  await expect(renameInput).toBeVisible()
  await renameInput.fill('审计 Pipeline v2')
  await page.getByTestId('workflow-rename-confirm').click()
  await expect(page.getByText('审计 Pipeline v2').first()).toBeVisible()

  // And it reads back on the list page (i.e. it really persisted).
  await page.goto(`${daemon.baseUrl}/workflows`)
  await expect(page.getByText('审计 Pipeline v2').first()).toBeVisible()
})

test('a workgroup can be created with a Chinese name', async ({ page }) => {
  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/workgroups`)

  await page.getByTestId('workgroup-new-button').click()
  const nameInput = page.getByTestId('workgroup-create-name')
  await expect(nameInput).toBeVisible()

  await nameInput.fill('_reserved')
  await expect(page.getByTestId('workgroup-create-confirm')).toBeDisabled()

  // A trailing space is folded away by the shared normalizer, not rejected.
  await nameInput.fill('代码审计组 ')
  const confirm = page.getByTestId('workgroup-create-confirm')
  await expect(confirm).toBeEnabled()
  await confirm.click()

  await expect(page).toHaveURL(/\/workgroups\/[0-9A-HJKMNP-TV-Z]{26}/)
  await expect(page.getByText('代码审计组').first()).toBeVisible()

  await page.goto(`${daemon.baseUrl}/workgroups`)
  await expect(page.getByText('代码审计组').first()).toBeVisible()
})

// RFC-045 — e2e for the manual create + edit memory flow.
//
// Flow:
//   1. Admin (daemon-token) navigates to /memory.
//   2. Click [+ New memory], fill scope=global + title + body + tag, Save.
//   3. Approval Queue tab auto-selected; new candidate card visible.
//   4. Click candidate's [Edit] → change tag → Save.
//   5. Card refreshes with new tag (WS memory.updated round-trip).
//   6. Approve → All tab → new approved row carries the edited tag.

import { test, expect, type Page } from '@playwright/test'
import { startDaemon, type DaemonHandle } from './harness'

let daemon: DaemonHandle

test.beforeAll(async () => {
  daemon = await startDaemon()
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

async function primeAuth(page: Page, d: DaemonHandle): Promise<void> {
  await page.addInitScript(
    ({ baseUrl, token }) => {
      try {
        window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
        window.localStorage.setItem('agent-workflow.token', token)
        window.localStorage.setItem('aw-language', 'en-US')
      } catch {
        // ignore
      }
    },
    { baseUrl: d.baseUrl, token: d.token },
  )
}

test('RFC-045: admin manually creates a candidate, edits it, then approves it', async ({
  page,
}) => {
  await primeAuth(page, daemon)
  await page.goto(`${daemon.baseUrl}/memory`)

  // RFC-201: the stable library is the default landing section.
  await expect(page.getByTestId('memory-section-all')).toHaveAttribute('aria-current', 'page')

  // (1) Open the [+ New memory] dialog.
  await page.getByTestId('memory-new-button').click()
  await expect(page.getByTestId('memory-new-dialog')).toBeVisible()

  // (2) Fill the form. Default scope is global; just type title + body.
  await page.getByTestId('memory-form-title').fill('e2e-manual-rule')
  await page.getByTestId('memory-form-body').fill('Bodies with the [infra] prefix add @infra-team.')
  const tagInput = page.getByTestId('memory-form-tag-input')
  await tagInput.fill('e2e-tag-orig')
  await tagInput.press('Enter')

  // (3) Save → POST /api/memories. Approval queue refreshes; candidate
  // card appears.
  await page.getByTestId('memory-new-dialog-save').click()
  await expect(page.getByTestId('memory-new-dialog')).toHaveCount(0)

  // A successful manual candidate creation moves to the actionable queue.
  await expect(page.getByTestId('memory-section-approval-queue')).toHaveAttribute(
    'aria-current',
    'page',
  )

  // The newly-created candidate's id is unknown to the test, but its
  // title is unique. Wait for a candidate card whose body contains it.
  const newCard = page.locator('.memory-candidate-card', {
    hasText: 'e2e-manual-rule',
  })
  await expect(newCard).toBeVisible()

  // (4) Click the row-level Edit button on that card.
  await newCard.getByRole('button', { name: 'Edit' }).first().click()
  await expect(page.getByTestId('memory-edit-dialog')).toBeVisible()

  // Remove the original tag and add a new one.
  await page.getByTestId('memory-form-tag-remove-e2e-tag-orig').click()
  await page.getByTestId('memory-form-tag-input').fill('e2e-tag-edited')
  await page.getByTestId('memory-form-tag-input').press('Enter')

  // (5) Save the PATCH.
  await page.getByTestId('memory-edit-dialog-save').click()
  await expect(page.getByTestId('memory-edit-dialog')).toHaveCount(0)

  // Card now reflects the new tag (WS memory.updated → query invalidation).
  const editedCard = page.locator('.memory-candidate-card', {
    hasText: 'e2e-manual-rule',
  })
  await expect(editedCard).toContainText('e2e-tag-edited')
  await expect(editedCard).not.toContainText('e2e-tag-orig')

  // (6) Approve → row moves out of Approval Queue and into All Approved.
  await editedCard.getByRole('button', { name: 'Approve' }).click()
  // Approval queue should now be empty (or at least not show our card).
  await expect(page.locator('.memory-candidate-card', { hasText: 'e2e-manual-rule' })).toHaveCount(
    0,
  )

  // Switch to All Approved; the new row carries the edited tag.
  await page.getByTestId('memory-section-all').click()
  const approvedRow = page.locator('[data-testid^="memory-row-"]', {
    hasText: 'e2e-manual-rule',
  })
  await expect(approvedRow).toBeVisible()
  await expect(approvedRow).toContainText('e2e-tag-edited')
})

// RFC-054 W2-6 — keyboard-only navigation contracts.
//
// LOCKS the shared <Dialog /> primitive's keyboard a11y contract:
//   1. opens with focus inside (initial focus on first focusable, NOT
//      stuck on the trigger button)
//   2. Tab cycles within the dialog (focus trap, not leaking to body)
//   3. Shift+Tab cycles backward (no dead spots)
//   4. Escape closes the dialog
//   5. After Escape, focus returns to the original trigger (so
//      screen-reader / keyboard users don't lose their place)
//
// Why this lives in its own spec instead of inside a11y.spec.ts: axe
// validates STATIC a11y (DOM structure, labels, contrast). Focus-trap
// behaviour is DYNAMIC — only surfaces when you actually press keys.
// They're complementary signals that need separate test surfaces.
//
// Driving page: /repos has the BatchImportDialog (RFC-033) which is the
// canonical user-facing Dialog instance. The shared primitive is the
// same for AgentImportDialog / ReviewDecisionDialog etc., so locking
// these contracts here covers ALL Dialog instances.

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
        /* ignore */
      }
    },
    { baseUrl: d.baseUrl, token: d.token },
  )
}

async function openBatchImportDialog(page: Page): Promise<void> {
  await primeAuth(page, daemon)
  await page.goto(`${daemon.baseUrl}/repos`)
  const trigger = page.getByTestId('repos-batch-import-button')
  await expect(trigger).toBeVisible()
  await trigger.click()
  // Dialog mounts with role=dialog + aria-modal=true (shared primitive).
  await expect(page.getByRole('dialog')).toBeVisible()
}

test.describe('RFC-054 W2-6 — Dialog keyboard contract', () => {
  test('opens with focus inside the dialog (not stuck on the trigger)', async ({ page }) => {
    await primeAuth(page, daemon)
    await page.goto(`${daemon.baseUrl}/repos`)
    const trigger = page.getByTestId('repos-batch-import-button')
    await trigger.click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    // Active element must be INSIDE the dialog after open.
    const activeIsInDialog = await page.evaluate(() => {
      const ae = document.activeElement
      if (ae === null) return false
      const dlg = document.querySelector('[role="dialog"]')
      return dlg !== null && (dlg === ae || dlg.contains(ae))
    })
    expect(activeIsInDialog).toBe(true)
  })

  test('Escape closes the dialog and restores focus to the trigger', async ({ page }) => {
    await primeAuth(page, daemon)
    await page.goto(`${daemon.baseUrl}/repos`)
    const trigger = page.getByTestId('repos-batch-import-button')
    await trigger.click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    // Focus restored to the trigger so a keyboard user keeps their place.
    const triggerHasFocus = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="repos-batch-import-button"]')
      return el !== null && el === document.activeElement
    })
    expect(triggerHasFocus).toBe(true)
  })

  test('Tab cycle does not escape the dialog (focus trap)', async ({ page }) => {
    await openBatchImportDialog(page)

    // Press Tab 20 times. With a working trap, every press keeps the
    // active element INSIDE the dialog. Without the trap, focus would
    // walk out into the body (sidebar nav / page header) after a few
    // presses.
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press('Tab')
    }
    const stillInside = await page.evaluate(() => {
      const ae = document.activeElement
      if (ae === null || ae === document.body) return false
      const dlg = document.querySelector('[role="dialog"]')
      return dlg !== null && dlg.contains(ae)
    })
    expect(stillInside).toBe(true)
  })

  test('Shift+Tab cycle also stays trapped (backward direction)', async ({ page }) => {
    await openBatchImportDialog(page)

    for (let i = 0; i < 20; i++) {
      await page.keyboard.press('Shift+Tab')
    }
    const stillInside = await page.evaluate(() => {
      const ae = document.activeElement
      if (ae === null || ae === document.body) return false
      const dlg = document.querySelector('[role="dialog"]')
      return dlg !== null && dlg.contains(ae)
    })
    expect(stillInside).toBe(true)
  })

  test('dialog carries aria-modal=true so screen readers announce modal context', async ({
    page,
  }) => {
    await openBatchImportDialog(page)
    const ariaModal = await page.evaluate(() => {
      const dlg = document.querySelector('[role="dialog"]')
      return dlg?.getAttribute('aria-modal') ?? null
    })
    expect(ariaModal).toBe('true')
  })
})

test.describe('RFC-195 — Inbox dialog keyboard contract', () => {
  test('selected filter receives initial focus and Escape restores the inbox trigger', async ({
    page,
  }) => {
    await primeAuth(page, daemon)
    await page.goto(`${daemon.baseUrl}/agents`)

    const trigger = page.getByTestId('inbox-footer-button')
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: 'Inbox' })
    await expect(dialog).toBeVisible()

    const allFilter = page.getByTestId('inbox-tab-all')
    const clarifyFilter = page.getByTestId('inbox-tab-clarify')
    await expect(allFilter).toHaveAttribute('aria-checked', 'true')
    await expect(allFilter).toBeFocused()

    // Standard radio-group keyboard model: one Tab stop, arrow keys move
    // focus and selection across the segmented options.
    await page.keyboard.press('ArrowRight')
    await expect(page.getByTestId('inbox-tab-reviews')).toHaveAttribute('aria-checked', 'true')
    await page.keyboard.press('ArrowRight')
    await expect(clarifyFilter).toHaveAttribute('aria-checked', 'true')
    await expect(clarifyFilter).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(trigger).toBeFocused()

    // The selected filter is stateful across close/reopen. Initial focus must
    // follow that selection instead of falling back to the first (All) radio.
    await trigger.click()
    await expect(dialog).toBeVisible()
    await expect(clarifyFilter).toHaveAttribute('aria-checked', 'true')
    await expect(clarifyFilter).toBeFocused()

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(trigger).toBeFocused()
  })
})

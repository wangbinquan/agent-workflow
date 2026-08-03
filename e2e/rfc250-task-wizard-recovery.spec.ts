// RFC-250 T12/T22 — real-browser lock for Task Wizard recovery integrity.
//
// This spec intentionally exercises the embedded frontend served by a fresh
// daemon. Unit tests own the envelope parser's full matrix; these flows prove
// the browser-level contracts that can otherwise drift independently:
//   - a deep-linked draft survives reload in this tab and blocks in-app exits;
//   - Stay restores the compact menu trigger instead of an unmounted sheet link;
//   - a successful compact navigation commits focus into the destination page;
//   - credential-bearing repository URLs are never written to sessionStorage;
//   - a pending scheduled-task POST locks both the dialog and wizard material.

import { expect, test, type Dialog, type Page } from '@playwright/test'
import { startDaemon, type DaemonHandle } from './harness'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

interface ViewportCase {
  label: string
  width: number
  height: number
}

const VIEWPORTS: readonly ViewportCase[] = [
  { label: 'desktop', width: 1280, height: 800 },
  { label: '390px', width: 390, height: 844 },
]

const DRAFT_PREFIX = 'aw:task-wizard-draft:v1:'

let daemon: DaemonHandle | undefined
let seedAgentId = ''

test.beforeAll(async () => {
  daemon = await startDaemon()
  seedAgentId = await createStubAgent(daemon, 'rfc250-recovery-agent')
})

test.afterAll(async () => {
  await daemon?.stop()
})

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve']
  let reject!: Deferred<T>['reject']
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function authHeaders(d: DaemonHandle): Record<string, string> {
  return { Authorization: `Bearer ${d.token}`, 'Content-Type': 'application/json' }
}

async function createStubAgent(d: DaemonHandle, name: string): Promise<string> {
  const response = await fetch(`${d.baseUrl}/api/agents`, {
    method: 'POST',
    headers: authHeaders(d),
    body: JSON.stringify({
      name,
      description: 'RFC-250 Task Wizard recovery E2E fixture',
      outputs: ['answer'],
      readonly: true,
      bodyMd: '',
    }),
  })
  if (!response.ok) throw new Error(`create seed agent failed: HTTP ${response.status}`)
  return ((await response.json()) as { id: string }).id
}

async function primeAuthenticatedPage(
  page: Page,
  d: DaemonHandle,
  viewport: ViewportCase,
): Promise<void> {
  await page.setViewportSize({ width: viewport.width, height: viewport.height })
  await page.addInitScript(
    ({ baseUrl, token }) => {
      window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
      window.localStorage.setItem('agent-workflow.token', token)
      window.localStorage.setItem('aw-language', 'en-US')
    },
    { baseUrl: d.baseUrl, token: d.token },
  )
}

async function openTasksNavigation(page: Page, viewport: ViewportCase): Promise<void> {
  if (viewport.width <= 900) {
    await page.getByTestId('mobile-menu-trigger').click()
    const nav = page.getByTestId('shell-navigation-mobile')
    await expect(nav).toBeVisible()
    await nav.locator('a[href="/tasks"]').click()
    return
  }
  await page.getByTestId('shell-navigation-desktop').locator('a[href="/tasks"]').click()
}

async function reloadAcceptingBeforeUnload(page: Page): Promise<void> {
  const handleDialog = async (dialog: Dialog): Promise<void> => {
    if (dialog.type() === 'beforeunload') await dialog.accept()
    else await dialog.dismiss()
  }
  page.on('dialog', handleDialog)
  try {
    await page.reload({ waitUntil: 'domcontentloaded' })
  } finally {
    page.off('dialog', handleDialog)
  }
}

async function draftCount(page: Page): Promise<number> {
  return page.evaluate(
    (prefix) => Object.keys(window.sessionStorage).filter((key) => key.startsWith(prefix)).length,
    DRAFT_PREFIX,
  )
}

async function expectCompactStepperTargets(page: Page, viewport: ViewportCase): Promise<void> {
  if (viewport.width > 900) return

  const metrics = await page.locator('[data-testid^="stepper-step-"]').evaluateAll((steps) => ({
    count: steps.length,
    minimumHeight: Math.min(...steps.map((step) => step.getBoundingClientRect().height)),
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
  }))

  expect(metrics.count).toBeGreaterThan(0)
  expect(metrics.minimumHeight).toBeGreaterThanOrEqual(44)
  expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewportWidth)
}

for (const viewport of VIEWPORTS) {
  test(`${viewport.label}: deep-link draft blocks Stay/Discard and restores after reload`, async ({
    page,
  }) => {
    const d = daemon!
    await primeAuthenticatedPage(page, d, viewport)
    await page.goto(`${d.baseUrl}/tasks/new?kind=agent&agentId=${seedAgentId}`)
    await expect(page.getByTestId('task-wizard')).toBeVisible()
    await expectCompactStepperTargets(page, viewport)

    await page.getByTestId('wizard-space-scratch').click()
    await page.getByTestId('stepper-next').click()
    await page.getByTestId('wizard-task-name').fill(`recover-${viewport.label}`)
    await page.getByTestId('wizard-description').fill(`draft body retained at ${viewport.width}px`)

    await expect
      .poll(async () => {
        return page.evaluate((prefix) => {
          const raw = Object.entries(window.sessionStorage).find(([key]) =>
            key.startsWith(prefix),
          )?.[1]
          if (raw === undefined) return null
          try {
            const parsed = JSON.parse(raw) as {
              baselineFingerprint?: unknown
              values?: { taskName?: unknown; description?: unknown }
            }
            return {
              count: Object.keys(window.sessionStorage).filter((key) => key.startsWith(prefix))
                .length,
              baselineIsHash:
                typeof parsed.baselineFingerprint === 'string' &&
                /^sha256:[0-9a-f]{64}$/.test(parsed.baselineFingerprint),
              taskName: parsed.values?.taskName,
              description: parsed.values?.description,
            }
          } catch {
            return null
          }
        }, DRAFT_PREFIX)
      })
      .toEqual({
        count: 1,
        baselineIsHash: true,
        taskName: `recover-${viewport.label}`,
        description: `draft body retained at ${viewport.width}px`,
      })

    await openTasksNavigation(page, viewport)
    await expect(page.getByTestId('unsaved-guard-dialog')).toBeVisible()
    await expect(page.getByTestId('unsaved-stay')).toBeFocused()
    await page.getByTestId('unsaved-stay').click()
    await expect(page).toHaveURL(/\/tasks\/new\?/)
    await expect(page.getByTestId('wizard-task-name')).toHaveValue(`recover-${viewport.label}`)
    if (viewport.width <= 900) {
      await expect(page.getByTestId('mobile-menu-trigger')).toBeFocused()
    }

    await reloadAcceptingBeforeUnload(page)
    await expect(page.getByTestId('wizard-draft-recovery')).toBeVisible()
    await expect(page.getByTestId('wizard-draft-restore')).toBeFocused()
    await page.getByTestId('wizard-draft-restore').click()
    await expect(page.getByTestId('wizard-task-name')).toHaveValue(`recover-${viewport.label}`)
    await expect(page.getByTestId('wizard-description')).toHaveValue(
      `draft body retained at ${viewport.width}px`,
    )

    await openTasksNavigation(page, viewport)
    await expect(page.getByTestId('unsaved-guard-dialog')).toBeVisible()
    await page.getByTestId('unsaved-discard').click()
    await expect(page).toHaveURL(/\/tasks$/)
    if (viewport.width <= 900) {
      await expect(page.getByRole('heading', { name: 'Tasks', exact: true })).toBeFocused()
    }
    await expect.poll(() => draftCount(page)).toBe(0)
  })

  test(`${viewport.label}: credentialed repository URL is redacted and requires re-entry`, async ({
    page,
  }) => {
    const d = daemon!
    const credentialedUrl =
      'https://rfc250-user:literal-password@example.com/private/repo.git?access_token=literal-query-secret#literal-fragment-secret'
    await primeAuthenticatedPage(page, d, viewport)
    await page.goto(`${d.baseUrl}/tasks/new?kind=agent&agentId=${seedAgentId}`)
    await expect(page.getByTestId('task-wizard')).toBeVisible()

    await page.getByTestId('wizard-space-remote').click()
    const sourcePicker = page.getByTestId('repo-source-recent-urls-0')
    await expect(sourcePicker).toBeVisible()
    await sourcePicker.click()
    await page.getByRole('option', { name: 'Enter a new Git URL…', exact: true }).click()
    await page.getByTestId('repo-source-url-0').fill(credentialedUrl)

    await expect
      .poll(async () => {
        return page.evaluate((prefix) => {
          const rows = Object.entries(window.sessionStorage).filter(([key]) =>
            key.startsWith(prefix),
          )
          const raw = rows[0]?.[1]
          if (raw === undefined) return null
          try {
            const parsed = JSON.parse(raw) as {
              baselineFingerprint?: unknown
              values?: {
                space?: {
                  kind?: unknown
                  repos?: Array<{
                    repoUrlRedacted?: unknown
                    requiresRepoUrlReentry?: unknown
                  }>
                }
              }
            }
            const repo = parsed.values?.space?.repos?.[0]
            return {
              count: rows.length,
              containsCredential:
                raw.includes('rfc250-user') ||
                raw.includes('literal-password') ||
                raw.includes('access_token') ||
                raw.includes('literal-query-secret') ||
                raw.includes('literal-fragment-secret'),
              baselineIsHash:
                typeof parsed.baselineFingerprint === 'string' &&
                /^sha256:[0-9a-f]{64}$/.test(parsed.baselineFingerprint),
              kind: parsed.values?.space?.kind,
              redactedUrl: repo?.repoUrlRedacted,
              requiresReentry: repo?.requiresRepoUrlReentry,
            }
          } catch {
            return null
          }
        }, DRAFT_PREFIX)
      })
      .toEqual({
        count: 1,
        containsCredential: false,
        baselineIsHash: true,
        kind: 'remote',
        redactedUrl: 'https://***@example.com/private/repo.git',
        requiresReentry: true,
      })

    await reloadAcceptingBeforeUnload(page)
    await expect(page.getByTestId('wizard-draft-recovery')).toBeVisible()
    await page.getByTestId('wizard-draft-restore').click()
    const reentryNotice = page
      .getByRole('status')
      .filter({ hasText: 'Some values must be entered again' })
    await expect(reentryNotice).toBeVisible()
    await expect(reentryNotice).toContainText('repository: 1')
    const restoredSourcePicker = page.getByTestId('repo-source-recent-urls-0')
    await expect(restoredSourcePicker).toBeVisible()
    await restoredSourcePicker.click()
    await page.getByRole('option', { name: 'Enter a new Git URL…', exact: true }).click()
    await expect(page.getByTestId('repo-source-url-0')).toHaveValue('')
  })

  test(`${viewport.label}: pending schedule create locks dismiss paths and wizard material`, async ({
    page,
  }) => {
    const d = daemon!
    const requestSeen = deferred<void>()
    const releaseRequest = deferred<void>()
    await page.route('**/api/scheduled-tasks', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue()
        return
      }
      requestSeen.resolve()
      await releaseRequest.promise
      await route.continue()
    })

    await primeAuthenticatedPage(page, d, viewport)
    await page.goto(`${d.baseUrl}/tasks/new?schedule=1&kind=agent&agentId=${seedAgentId}`)
    await expect(page.getByTestId('task-wizard')).toBeVisible()
    await page.getByTestId('wizard-space-scratch').click()
    await page.getByTestId('stepper-next').click()
    await page.getByTestId('wizard-task-name').fill(`scheduled-${viewport.label}`)
    await page.getByTestId('wizard-description').fill('keep this configuration locked')
    await page.getByTestId('stepper-next').click()
    await page.getByTestId('wizard-save-scheduled').click()

    const scheduleDialog = page.getByTestId('schedule-dialog')
    await expect(scheduleDialog).toBeVisible()
    await page.getByTestId('schedule-name').fill(`RFC-250 ${viewport.label} pending`)
    await page.getByTestId('schedule-save').click()
    await requestSeen.promise

    try {
      const scheduleFieldset = scheduleDialog.locator('fieldset.schedule-dialog__fieldset')
      await expect(scheduleFieldset).toHaveAttribute('disabled', '')
      await expect(scheduleFieldset).toHaveJSProperty('disabled', true)
      await expect(scheduleFieldset).toHaveAttribute('aria-busy', 'true')
      await expect(page.getByTestId('schedule-name')).toBeDisabled()
      await expect(
        scheduleDialog.getByRole('button', { name: 'Cancel', exact: true }),
      ).toBeDisabled()
      await expect(scheduleDialog.locator('.dialog__close')).toBeDisabled()
      const wizardFieldset = page.locator('fieldset.task-wizard__material')
      await expect(wizardFieldset).toHaveAttribute('disabled', '')
      await expect(wizardFieldset).toHaveJSProperty('disabled', true)
      await expect(wizardFieldset).toHaveAttribute('aria-busy', 'true')
      await expect(page.getByTestId('wizard-summary-edit-2')).toBeDisabled()

      await page.keyboard.press('Escape')
      await expect(scheduleDialog).toBeVisible()

      const overlay = await scheduleDialog.boundingBox()
      expect(overlay).not.toBeNull()
      await page.mouse.click(overlay!.x + 2, overlay!.y + 2)
      await expect(scheduleDialog).toBeVisible()
    } finally {
      releaseRequest.resolve()
    }

    await expect(page).toHaveURL(/\/scheduled$/)
  })
}

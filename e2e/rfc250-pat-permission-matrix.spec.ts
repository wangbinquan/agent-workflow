// RFC-250 T29 / AC15 — real-layout coverage for the narrow PAT permission
// matrix. Source assertions cannot prove that every catalog-derived grant is
// reachable inside the production Dialog, nor that the shared checkbox label
// owns a 44px hit target without creating horizontal overflow.

import { expect, test, type Locator, type Page } from '@playwright/test'

import { startDaemon, type DaemonHandle } from './harness'

let daemon: DaemonHandle

test.beforeAll(async () => {
  daemon = await startDaemon()
})

test.afterAll(async () => {
  await daemon?.stop()
})

async function primeAdminSession(page: Page): Promise<void> {
  await page.addInitScript(
    ({ baseUrl, token }) => {
      window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
      window.localStorage.setItem('agent-workflow.token', token)
      window.localStorage.setItem('aw-language', 'en-US')
    },
    { baseUrl: daemon.baseUrl, token: daemon.token },
  )
}

async function expectNoHorizontalOverflow(locator: Locator, label: string): Promise<void> {
  const metrics = await locator.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }))
  expect(
    metrics.scrollWidth,
    `${label} horizontally overflows (${metrics.scrollWidth}px > ${metrics.clientWidth}px)`,
  ).toBeLessThanOrEqual(metrics.clientWidth + 1)
}

async function liveAdminGrantablePermissions(): Promise<string[]> {
  const response = await fetch(`${daemon.baseUrl}/api/docs/api`, {
    headers: { Authorization: `Bearer ${daemon.token}` },
  })
  expect(response.ok, `permission catalog request failed (${response.status})`).toBe(true)
  const docs = (await response.json()) as {
    role: string
    grantablePermissions: Array<{
      verbs: Array<{ permission: string }>
    }>
  }
  expect(docs.role).toBe('admin')
  return docs.grantablePermissions.flatMap((group) => group.verbs.map((verb) => verb.permission))
}

test('390px admin can discover, focus, and toggle every grantable PAT permission', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await primeAdminSession(page)
  await page.goto(`${daemon.baseUrl}/account?section=tokens`)

  // The compact shell intentionally does not mount the desktop user-menu
  // trigger. Confirm the authenticated destination through the actual account
  // content this flow needs instead of depending on hidden shell chrome.
  const tokensRegion = page.locator(
    'section.account-section-panel[aria-labelledby="account-section-title-tokens"]',
  )
  await expect(tokensRegion).toBeVisible()
  const createToken = tokensRegion.getByTestId('token-create-open')
  await expect(createToken).toBeVisible()
  await expect(createToken).toBeEnabled()
  await createToken.click()

  const dialog = page.getByTestId('token-create-dialog')
  await expect(dialog).toBeVisible()
  await page.getByTestId('token-advanced-toggle').click()

  const matrix = dialog.locator('.token-matrix')
  await expect(matrix).toBeVisible()

  const expectedPermissions = (await liveAdminGrantablePermissions()).sort()
  const checkboxes = matrix.getByRole('checkbox')
  await expect(checkboxes).toHaveCount(expectedPermissions.length)

  const renderedPermissions = (
    await checkboxes.evaluateAll((inputs) =>
      inputs.map((input) => input.getAttribute('data-testid')?.replace('token-matrix-cell-', '')),
    )
  )
    .filter((permission): permission is string => permission !== undefined)
    .sort()
  expect(renderedPermissions).toEqual(expectedPermissions)

  for (const permission of expectedPermissions) {
    const checkbox = page.getByTestId(`token-matrix-cell-${permission}`)
    const cell = checkbox.locator('xpath=ancestor::*[contains(@class, "token-matrix__cell")][1]')
    const row = cell.locator('xpath=ancestor::*[contains(@class, "token-matrix__row")][1]')
    const wrapper = checkbox.locator('xpath=ancestor::label[contains(@class, "form-checkbox")][1]')

    await expect(checkbox, `${permission} checkbox is not visible`).toBeVisible()
    const verbLabel = cell.locator('.token-matrix__cell-verb')
    const resourceLabel = row.locator('.token-matrix__resource')
    await expect(verbLabel, `${permission} has no visible verb label`).toBeVisible()
    await expect(resourceLabel, `${permission} has no visible resource label`).toBeVisible()
    await expect(verbLabel).toHaveText(/\S/)
    await expect(resourceLabel).toHaveText(/\S/)

    const accessibleName = await checkbox.getAttribute('aria-label')
    expect(accessibleName, `${permission} is missing its two-axis accessible label`).toMatch(/\S/)
    expect(accessibleName?.toLocaleLowerCase()).toContain(
      (await verbLabel.innerText()).trim().toLocaleLowerCase(),
    )
    expect(accessibleName?.toLocaleLowerCase()).toContain(
      (await resourceLabel.innerText()).trim().toLocaleLowerCase(),
    )
    await expect(
      matrix.getByRole('checkbox', { name: accessibleName ?? '', exact: true }),
    ).toHaveCount(1)

    await checkbox.focus()
    await expect(checkbox, `${permission} cannot receive keyboard focus`).toBeFocused()

    const hitRect = await wrapper.boundingBox()
    expect(hitRect, `${permission} has no measurable hit target`).not.toBeNull()
    expect(
      hitRect?.width ?? 0,
      `${permission} hit target is narrower than 44px`,
    ).toBeGreaterThanOrEqual(44)
    expect(
      hitRect?.height ?? 0,
      `${permission} hit target is shorter than 44px`,
    ).toBeGreaterThanOrEqual(44)

    await wrapper.click()
    await expect(checkbox, `${permission} wrapper did not toggle its checkbox`).toBeChecked()
  }

  await expectNoHorizontalOverflow(dialog.locator('.dialog__panel'), 'PAT Dialog panel')
  await expectNoHorizontalOverflow(dialog.locator('.dialog__body'), 'PAT Dialog body')
  await expectNoHorizontalOverflow(matrix, 'PAT permission matrix')
  await expectNoHorizontalOverflow(page.locator('html'), 'document')
})

// RFC-246 — populated browser acceptance for Scheduled and Cached Repos.

import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

import { startDaemon, type DaemonHandle } from './harness'
import { routeOperationsSurfaceFixtures } from './operations-surface-fixtures'

let daemon: DaemonHandle | undefined

function requireDaemon(): DaemonHandle {
  if (daemon === undefined) throw new Error('RFC-246 e2e daemon is not running')
  return daemon
}

async function primeAuth(page: Page): Promise<void> {
  await page.addInitScript(
    ({ baseUrl, token }) => {
      window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
      window.localStorage.setItem('agent-workflow.token', token)
      window.localStorage.setItem('aw-language', 'en-US')
    },
    { baseUrl: requireDaemon().baseUrl, token: requireDaemon().token },
  )
}

async function openPage(page: Page, path: '/scheduled' | '/repos'): Promise<void> {
  await routeOperationsSurfaceFixtures(page)
  await primeAuth(page)
  await page.goto(`${requireDaemon().baseUrl}${path}`)
  await expect(page.locator('.operations-surface')).toBeVisible()
  await expect(page.locator('.operations-toolbar')).toBeVisible()
}

async function expectNoHorizontalOverflow(page: Page, listSelector: string): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate((selector) => {
        const main = document.querySelector<HTMLElement>('[data-testid="app-shell-main"]')
        const list = document.querySelector<HTMLElement>(selector)
        const scroller = list?.closest<HTMLElement>('.table-viewport__scroller') ?? null
        const scrollerRect = scroller?.getBoundingClientRect() ?? null
        // WebKit can retain the table/scroller's pre-resize intrinsic scrollWidth
        // even after its block-level grid rows and visible scroller have reflowed.
        // Assert the user-visible overflow boundary and every rendered row so
        // a real clipped column still fails without trusting that stale metric.
        const rowsFit =
          list !== null &&
          scrollerRect !== null &&
          Array.from(list.querySelectorAll<HTMLElement>('tr'))
            .filter((row) => row.getClientRects().length > 0)
            .every((row) => {
              const rect = row.getBoundingClientRect()
              return (
                row.scrollWidth <= row.clientWidth &&
                rect.left >= scrollerRect.left - 0.5 &&
                rect.right <= scrollerRect.right + 0.5
              )
            })
        return {
          documentFits:
            document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          mainFits: main !== null && main.scrollWidth <= main.clientWidth,
          listFits: rowsFit,
        }
      }, listSelector),
    )
    .toEqual({ documentFits: true, mainFits: true, listFits: true })
}

async function expectToolbarFits(page: Page, prefix: 'scheduled' | 'repos'): Promise<void> {
  const search = await page.getByTestId(`${prefix}-search`).boundingBox()
  const filter = await page.getByTestId(`${prefix}-filter-button`).boundingBox()
  expect(search).not.toBeNull()
  expect(filter).not.toBeNull()
  expect(Math.abs(search!.y - filter!.y)).toBeLessThanOrEqual(2)
  expect(filter!.height).toBeGreaterThanOrEqual(42)
}

test.beforeAll(async () => {
  daemon = await startDaemon()
})

test.afterAll(async () => {
  await daemon?.stop()
})

test('desktop Scheduled and Repos keep dense rows, business views, and no overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await openPage(page, '/scheduled')
  await expect(page.locator('.scheduled-operations__row')).toHaveCount(28)
  const scheduledRow = await page.getByTestId('scheduled-row-scheduled-ux-02').boundingBox()
  expect(scheduledRow).not.toBeNull()
  expect(scheduledRow!.height).toBeGreaterThanOrEqual(56)
  expect(scheduledRow!.height).toBeLessThanOrEqual(64)
  await page.getByTestId('scheduled-view-paused').click()
  await expect(page.locator('.scheduled-operations__row')).toHaveCount(4)
  await page.getByTestId('scheduled-view-all').click()
  await page.getByTestId('scheduled-search').fill('release readiness')
  await expect(page.locator('.scheduled-operations__row')).toHaveCount(1)
  await expectNoHorizontalOverflow(page, '.scheduled-operations')

  await page.goto(`${requireDaemon().baseUrl}/repos`)
  await expect(page.getByTestId('repos-row-repo-ux-02')).toBeVisible()
  await expect(page.locator('.repo-operations__row')).toHaveCount(28)
  const repoRow = await page.getByTestId('repos-row-repo-ux-02').boundingBox()
  expect(repoRow).not.toBeNull()
  expect(repoRow!.height).toBeGreaterThanOrEqual(56)
  expect(repoRow!.height).toBeLessThanOrEqual(64)
  await page.getByTestId('repos-view-referenced').click()
  await expect(page.locator('.repo-operations__row')).toHaveCount(22)
  await page.getByTestId('repos-view-all').click()
  await page.getByTestId('repos-search').fill('release-coordination')
  await expect(page.locator('.repo-operations__row')).toHaveCount(1)
  await expectNoHorizontalOverflow(page, '.repo-operations')

  for (const width of [1024, 901]) {
    await page.setViewportSize({ width, height: 768 })
    await expectNoHorizontalOverflow(page, '.repo-operations')
  }
})

test('390×844 and 390×568 keep both operation surfaces usable without page scrolling sideways', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openPage(page, '/scheduled')
  await expectNoHorizontalOverflow(page, '.scheduled-operations')
  await expectToolbarFits(page, 'scheduled')
  const runNow = await page
    .getByTestId('scheduled-row-scheduled-ux-02')
    .getByRole('button', { name: 'Run now' })
    .boundingBox()
  expect(runNow).not.toBeNull()
  expect(runNow!.height).toBeGreaterThanOrEqual(44)

  await page.goto(`${requireDaemon().baseUrl}/repos`)
  await expect(page.getByTestId('repos-row-repo-ux-02')).toBeVisible()
  await expectNoHorizontalOverflow(page, '.repo-operations')
  await expectToolbarFits(page, 'repos')
  const repoActions = page.getByTestId('repos-row-repo-ux-02').getByRole('button')
  for (let index = 0; index < (await repoActions.count()); index += 1) {
    const box = await repoActions.nth(index).boundingBox()
    expect(box).not.toBeNull()
    expect(box!.height).toBeGreaterThanOrEqual(44)
  }

  await page.setViewportSize({ width: 390, height: 568 })
  await expectNoHorizontalOverflow(page, '.repo-operations')
  await page.getByTestId('repos-filter-button').click()
  const dialog = page.getByTestId('repos-filter-dialog').getByRole('dialog')
  await expect(dialog).toBeVisible()
  const dialogBox = await dialog.boundingBox()
  expect(dialogBox).not.toBeNull()
  expect(dialogBox!.y).toBeGreaterThanOrEqual(0)
  expect(dialogBox!.y + dialogBox!.height).toBeLessThanOrEqual(568)
})

test('populated Scheduled and Repos have no serious accessibility findings', async ({ page }) => {
  await openPage(page, '/scheduled')
  for (const path of ['/scheduled', '/repos'] as const) {
    if (!page.url().endsWith(path)) {
      await page.goto(`${requireDaemon().baseUrl}${path}`)
      await expect(page.locator('.operations-surface')).toBeVisible()
    }
    const results = await new AxeBuilder({ page }).analyze()
    expect(
      results.violations.filter(
        (violation) => violation.impact === 'critical' || violation.impact === 'serious',
      ),
    ).toEqual([])
  }
})

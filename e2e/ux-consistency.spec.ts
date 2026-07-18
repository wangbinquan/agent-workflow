// RFC-198 T8 — browser evidence for the global UX consistency contract.
//
// This spec deliberately uses semantic anchors and geometry instead of
// screenshots. It locks the independent breakpoints (1080px route-owned
// resource split, 900px shell, and 720px content), representative
// split/table/form/dialog surfaces, the workflow deep-create transaction,
// and explicit/system theme precedence.

import { expect, test, type Locator, type Page } from '@playwright/test'

import { startDaemon, type DaemonHandle } from './harness'
import { routePopulatedInbox } from './inbox-fixtures'

const FIXTURE_AGENT = 'ux-fixture-agent'
const FIXTURE_WORKFLOW = 'ux-fixture-workflow'

let daemon: DaemonHandle
let fixtureWorkflowId = ''

type AppTheme = 'system' | 'light' | 'dark'

async function primeAuth(page: Page): Promise<void> {
  await page.addInitScript(
    ({ baseUrl, token }) => {
      window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
      window.localStorage.setItem('agent-workflow.token', token)
      window.localStorage.setItem('aw-language', 'en-US')
    },
    { baseUrl: daemon.baseUrl, token: daemon.token },
  )
}

async function setDaemonTheme(theme: AppTheme): Promise<void> {
  const response = await fetch(`${daemon.baseUrl}/api/config`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ theme }),
  })
  expect(response.ok, `failed to set ${theme} theme (${response.status})`).toBe(true)
}

async function setDaemonLanguage(language: 'en-US' | 'zh-CN'): Promise<void> {
  const response = await fetch(`${daemon.baseUrl}/api/config`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ language }),
  })
  expect(response.ok, `failed to set ${language} language (${response.status})`).toBe(true)
}

async function postFixture(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${daemon.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  expect(response.ok, `failed to seed ${path} (${response.status})`).toBe(true)
  return response.json()
}

async function seedRepresentativeResources(): Promise<void> {
  await postFixture('/api/agents', {
    name: FIXTURE_AGENT,
    description: 'RFC-198 responsive split fixture',
    outputs: ['answer'],
    readonly: true,
    bodyMd: '',
  })
  const workflow = (await postFixture('/api/workflows', {
    name: FIXTURE_WORKFLOW,
    description: 'RFC-198 gallery fixture',
    definition: {
      $schema_version: 1,
      inputs: [],
      nodes: [],
      edges: [],
    },
  })) as { id: string }
  fixtureWorkflowId = workflow.id
}

async function openAgents(page: Page): Promise<void> {
  await page.goto(`${daemon.baseUrl}/agents`)
  await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible()
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  await expect(page.getByTestId('app-shell-main')).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(() => {
        const main = document.querySelector<HTMLElement>('[data-testid="app-shell-main"]')
        return {
          documentFits:
            document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          mainFits: main !== null && main.scrollWidth <= main.clientWidth,
          mainStayedAtStart: main !== null && main.scrollLeft === 0,
        }
      }),
    )
    .toEqual({ documentFits: true, mainFits: true, mainStayedAtStart: true })
}

async function expectWithinViewport(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible()
  expect(
    await locator.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return {
        left: rect.left >= -0.5,
        top: rect.top >= -0.5,
        right: rect.right <= window.innerWidth + 0.5,
        bottom: rect.bottom <= window.innerHeight + 0.5,
      }
    }),
  ).toEqual({ left: true, top: true, right: true, bottom: true })
}

async function expectTableOwnsOverflow(page: Page, preceding: Locator): Promise<void> {
  const viewport = page.locator('.table-viewport').first()
  const scroller = viewport.locator('.table-viewport__scroller')
  await expect(scroller).toHaveAttribute('tabindex', '0')

  expect(
    await scroller.evaluate((element) => {
      const main = document.querySelector<HTMLElement>('[data-testid="app-shell-main"]')
      return {
        ownsOverflow: element.scrollWidth > element.clientWidth,
        documentFits: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        bodyMainFits: main !== null && main.scrollWidth <= main.clientWidth,
      }
    }),
  ).toEqual({ ownsOverflow: true, documentFits: true, bodyMainFits: true })

  await preceding.focus()
  await page.keyboard.press('Tab')
  await expect(scroller).toBeFocused()

  await scroller.evaluate((element) => element.scrollTo({ left: 120 }))
  await expect(viewport).toHaveAttribute('data-overflow-start', 'true')
  await expect
    .poll(() => page.getByTestId('app-shell-main').evaluate((main) => main.scrollLeft))
    .toBe(0)
}

async function routeTaskFixture(page: Page): Promise<void> {
  await page.route(/\/api\/tasks(?:\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: 'ux-task-1',
          name: 'Responsive browser matrix task',
          workflowId: 'ux-workflow-id',
          workflowName: FIXTURE_WORKFLOW,
          repoPath: '/tmp/agent-workflow-with-a-deliberately-long-display-name',
          repoUrl: null,
          status: 'done',
          startedAt: Date.now() - 3_600_000,
          finishedAt: Date.now() - 3_000_000,
          errorSummary: null,
          repoCount: 1,
          spaceKind: 'remote',
          sourceAgentName: null,
          openAlertCount: 0,
        },
      ]),
    })
  })
}

async function routeOidcFixture(page: Page): Promise<void> {
  await page.route(/\/api\/oidc\/providers(?:\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: 'ux-provider',
          slug: 'ux-provider',
          displayName: 'UX identity provider',
          issuerUrl: 'https://identity-provider-with-a-long-hostname.example.test',
          clientId: 'ux-client',
          scopes: 'openid profile email',
          provisioning: 'invite',
          allowedEmailDomains: [],
          iconUrl: null,
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
    })
  })
}

async function routeReviewDiffFixture(page: Page): Promise<void> {
  const doc = (id: string, versionIndex: number, decision: string) => ({
    id,
    taskId: 'ux-review-task',
    reviewNodeId: 'review-node',
    reviewNodeRunId: 'ux-review',
    sourceNodeId: 'source-node',
    sourcePortName: 'document',
    versionIndex,
    reviewIteration: versionIndex - 1,
    bodyPath: `runs/ux-review-task/${id}.md`,
    commentsJson: '[]',
    decision,
    decisionReason: null,
    promptSnapshot: null,
    createdAt: 1,
    decidedAt: decision === 'pending' ? null : 1,
    decidedBy: null,
  })
  const current = doc('ux-review-current', 2, 'pending')
  const prior = {
    ...doc('ux-review-prior', 1, 'iterated'),
    body: '# Release plan\n\nThe old deployment text.',
    comments: [],
  }
  const detail = {
    summary: {
      nodeRunId: 'ux-review',
      taskId: 'ux-review-task',
      taskName: 'Responsive review task with a deliberately long title',
      workflowId: 'ux-review-workflow',
      workflowName: 'Responsive review workflow',
      reviewNodeId: 'review-node',
      title: 'Deployment readiness document',
      description: 'Check the generated document.',
      currentVersionIndex: 2,
      reviewIteration: 1,
      decision: 'pending',
      awaitingReview: true,
      shardKey: null,
      isMultiDoc: false,
      createdAt: 1,
      decidedAt: null,
    },
    currentVersion: current,
    currentBody: '# Release plan\n\nThe new deployment text.',
    comments: [],
    rerunnableOnReject: [],
    rerunnableOnIterate: [],
  }

  await page.route(/\/api\/reviews\/ux-review(?:\/.*)?$/, async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/reviews/ux-review') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(detail),
      })
    }
    if (path === '/api/reviews/ux-review/versions') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([current, prior]),
      })
    }
    if (path === '/api/reviews/ux-review/versions/ux-review-prior') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(prior),
      })
    }
    return route.fallback()
  })
}

async function readThemeStyles(page: Page): Promise<{
  theme: string | undefined
  background: string
  primaryBackground: string
}> {
  const primary = page.locator('.btn--primary').first()
  await expect(primary).toBeVisible()
  return primary.evaluate((element) => ({
    theme: document.documentElement.dataset.theme,
    background: getComputedStyle(document.body).backgroundColor,
    primaryBackground: getComputedStyle(element).backgroundColor,
  }))
}

async function controlColors(locator: Locator): Promise<{
  background: string
  border: string
  color: string
}> {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      background: style.backgroundColor,
      border: style.borderColor,
      color: style.color,
    }
  })
}

test.describe('RFC-198 global UX browser matrix', () => {
  test.beforeAll(async () => {
    daemon = await startDaemon()
    await seedRepresentativeResources()
  })

  test.afterAll(async () => {
    if (daemon !== undefined) await daemon.stop()
  })

  test('uses the canonical 1280x800 project viewport', async ({ page }) => {
    expect(page.viewportSize()).toEqual({ width: 1280, height: 800 })
  })

  test('1280 light covers home, gallery, side-by-side split, table, and settings form', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await setDaemonTheme('light')
    await primeAuth(page)

    await page.goto(`${daemon.baseUrl}/`)
    await expect(page.getByTestId('homepage')).toBeVisible()
    await expect(page.getByTestId('desktop-sidebar')).toBeVisible()
    await expect(page.getByTestId('mobile-topbar')).toHaveCount(0)
    await expectNoPageOverflow(page)

    await page.goto(`${daemon.baseUrl}/workflows`)
    await expect(page.getByRole('heading', { name: 'Workflows', exact: true })).toBeVisible()
    await expect(page.getByTestId(`workflow-card-${FIXTURE_WORKFLOW}`)).toBeVisible()
    await expect(page.getByTestId('workflow-new-button')).toBeVisible()
    const importTrigger = page.getByTestId('workflow-import-trigger')
    await importTrigger.click()
    const importDialog = page.getByTestId('workflow-import-dialog').getByRole('dialog')
    await expectWithinViewport(importDialog)
    await page.keyboard.press('Escape')
    await expect(importDialog).toHaveCount(0)
    await expect(importTrigger).toBeFocused()
    await expectNoPageOverflow(page)

    await openAgents(page)
    const listBox = await page.locator('.split__list').boundingBox()
    const detailBox = await page.getByTestId('split-detail').boundingBox()
    expect(listBox).not.toBeNull()
    expect(detailBox).not.toBeNull()
    expect(listBox!.x + listBox!.width).toBeLessThanOrEqual(detailBox!.x + 1)
    await expectNoPageOverflow(page)

    await routeTaskFixture(page)
    await page.goto(`${daemon.baseUrl}/tasks`)
    await expect(page.getByTestId('task-row-ux-task-1')).toBeVisible()
    await expect(page.getByTestId('tasks-new-button')).toBeVisible()
    await expect(page.locator('.status-chip--success')).toBeVisible()
    await expectNoPageOverflow(page)

    await page.goto(`${daemon.baseUrl}/settings?tab=limits`)
    await expect(
      page.locator('.settings-section-layout .page-section-nav__leaf[aria-current="page"]'),
    ).toContainText('Limits')
    await expect(page.getByRole('button', { name: 'Save' })).toBeVisible()
    await expect(page.locator('.form-input').first()).toBeVisible()
    await expectNoPageOverflow(page)
  })

  test('1081 to 1080 split resize hands off only hidden-list focus and preserves detail draft focus', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1081, height: 800 })
    await setDaemonTheme('light')
    await primeAuth(page)
    await page.goto(`${daemon.baseUrl}/agents/${FIXTURE_AGENT}`)

    const list = page.locator('.split__list')
    const detail = page.getByTestId('split-detail')
    const card = page.getByTestId(`split-card-${FIXTURE_AGENT}`)
    const back = page.getByTestId('agents-mobile-back')
    await expect(list).toBeVisible()
    await expect(detail).toBeVisible()
    await expect(back).toBeHidden()

    await card.focus()
    await expect(card).toBeFocused()
    await page.setViewportSize({ width: 1080, height: 800 })
    await expect(list).toBeHidden()
    await expect(detail).toBeVisible()
    await expect(back).toBeVisible()
    await expect(back).toBeFocused()

    await page.setViewportSize({ width: 1081, height: 800 })
    const description = page.getByRole('textbox', { name: 'Description' })
    await description.fill('RFC-201 resize keeps this unsaved draft')
    await expect(description).toBeFocused()
    await page.setViewportSize({ width: 1080, height: 800 })
    await expect(description).toBeFocused()
    await expect(description).toHaveValue('RFC-201 resize keeps this unsaved draft')

    await page.setViewportSize({ width: 1081, height: 800 })
    await expect(page.getByTestId(`split-card-dot-${FIXTURE_AGENT}`)).toBeVisible()
    await page.setViewportSize({ width: 1080, height: 800 })

    await back.click()
    const guard = page.getByTestId('unsaved-guard-dialog')
    await expect(guard).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`/agents/${FIXTURE_AGENT}$`))
    await page.getByTestId('unsaved-stay').click()
    await expect(guard).toHaveCount(0)
    await expect(page).toHaveURL(new RegExp(`/agents/${FIXTURE_AGENT}$`))
    await expect(description).toHaveValue('RFC-201 resize keeps this unsaved draft')
    await expect(back).toBeFocused()

    await back.click()
    await expect(guard).toBeVisible()
    await page.getByTestId('unsaved-discard').click()
    await expect(page).toHaveURL(new RegExp('/agents$'))
    await expect(card).toBeFocused()
    await expect(page.getByTestId(`split-card-dot-${FIXTURE_AGENT}`)).toHaveCount(0)

    await card.press('Enter')
    await expect(page).toHaveURL(new RegExp(`/agents/${FIXTURE_AGENT}$`))
    await expect(description).toHaveValue('RFC-198 responsive split fixture')
    await expectNoPageOverflow(page)
  })

  test('640x400 keeps ResourceSplit actions fixed while the active detail panel owns scrolling', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 640, height: 400 })
    await setDaemonTheme('light')
    await primeAuth(page)
    await page.goto(`${daemon.baseUrl}/agents/${FIXTURE_AGENT}`)

    const main = page.getByTestId('app-shell-main')
    const back = page.getByTestId('agents-mobile-back')
    const save = page.getByTestId('agent-save-button')
    await page.getByTestId('agent-tab-advanced').click()
    const panel = page.getByTestId('agent-panel-advanced')
    const lastField = page.getByTestId('agent-json-frontmatter-extra')

    await expect(back).toBeInViewport()
    await expect(save).toBeInViewport()
    await expect(panel).toHaveCSS('overflow-y', 'auto')
    expect(await panel.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
      true,
    )
    await lastField.scrollIntoViewIfNeeded()
    await expect(lastField).toBeInViewport()
    expect(await panel.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
    expect(await main.evaluate((element) => element.scrollTop)).toBe(0)
    await expect(back).toBeInViewport()
    await expect(save).toBeInViewport()
    await expectNoPageOverflow(page)
  })

  test('640x400 settings keeps its selector, purpose, field, and final action reachable', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 640, height: 400 })
    await setDaemonTheme('light')
    await primeAuth(page)
    await page.goto(`${daemon.baseUrl}/settings?tab=network`)

    await expect(page.getByTestId('settings-compact-select')).toBeInViewport()
    await expect(page.getByRole('heading', { name: 'Network', exact: true })).toBeInViewport()
    await expect(page.getByRole('textbox', { name: 'Bind host' })).toBeInViewport()

    const save = page.getByRole('button', { name: 'Save', exact: true })
    await save.scrollIntoViewIfNeeded()
    await expect(save).toBeInViewport()
    await expect(page.getByText('There are no changes to save')).toBeInViewport()
    await expectNoPageOverflow(page)
  })

  test('1024 keeps the desktop shell while resource split uses one full-height pane and table scroll stays internal', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1024, height: 768 })
    await setDaemonTheme('light')
    await primeAuth(page)
    await openAgents(page)

    await expect(page.getByTestId('desktop-sidebar')).toBeVisible()
    await expect(page.getByTestId('mobile-topbar')).toHaveCount(0)
    await expect(page.locator('.split__list')).toBeVisible()
    await expect(page.getByTestId('split-detail')).toBeHidden()

    await page.setViewportSize({ width: 1024, height: 480 })
    await page.goto(`${daemon.baseUrl}/agents/${FIXTURE_AGENT}`)
    await expect(page.locator('.split__list')).toBeHidden()
    await expect(page.getByTestId('split-detail')).toBeVisible()
    await expect(page.getByTestId('agents-mobile-back')).toBeVisible()
    await page.getByTestId('agent-tab-prompt').click()
    const promptTextarea = page.locator('.md-editor__pane--edit textarea')
    await expect(promptTextarea).toBeVisible()
    expect((await promptTextarea.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(120)
    await expectNoPageOverflow(page)

    await routeTaskFixture(page)
    await page.goto(`${daemon.baseUrl}/tasks`)
    await expect(page.getByRole('heading', { name: 'Tasks', exact: true })).toBeVisible()
    await expectTableOwnsOverflow(page, page.getByTestId('tasks-search'))
    await expectNoPageOverflow(page)
  })

  test('901/900 is the single shell boundary and resize never focuses hidden chrome', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 901, height: 800 })
    await setDaemonTheme('light')
    await primeAuth(page)
    await openAgents(page)

    const desktop = page.getByTestId('desktop-sidebar')
    await expect(desktop).toBeVisible()
    await expect(page.getByTestId('mobile-topbar')).toHaveCount(0)
    await desktop.locator('a[href="/agents"]').focus()
    await expect(desktop.locator('a[href="/agents"]')).toBeFocused()
    await expectNoPageOverflow(page)

    await page.setViewportSize({ width: 900, height: 800 })
    await expect(desktop).toHaveCount(0)
    await expect(page.getByTestId('mobile-topbar')).toBeVisible()
    const menu = page.getByTestId('mobile-menu-trigger')
    await menu.focus()
    await page.keyboard.press('Enter')
    const navDialog = page.getByRole('dialog', { name: 'Agent Workflow' })
    await expect(navDialog).toBeVisible()
    await expect(
      page.getByTestId('shell-navigation-mobile').locator('a[href="/agents"]'),
    ).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(navDialog).toHaveCount(0)
    await expect(menu).toBeFocused()

    await page.keyboard.press('Enter')
    await expect(navDialog).toBeVisible()
    await page.setViewportSize({ width: 901, height: 800 })
    await expect(navDialog).toHaveCount(0)
    await expect(desktop).toBeVisible()
    await expect(page.getByTestId('app-shell-main')).toBeFocused()
    await expectNoPageOverflow(page)
  })

  test('Inbox follows desktop, tablet, and mobile placement with focus restoration', async ({
    page,
  }) => {
    await routePopulatedInbox(page, { rows: 6 })
    await setDaemonTheme('light')
    await primeAuth(page)

    await page.setViewportSize({ width: 901, height: 800 })
    await openAgents(page)
    const desktopTrigger = page.getByTestId('inbox-footer-button')
    await desktopTrigger.click()
    const dialog = page.getByTestId('inbox-drawer').getByRole('dialog')
    await expect(dialog).toBeVisible()
    let box = await dialog.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.x).toBeGreaterThanOrEqual(220)
    expect(box!.height).toBeLessThan(800)
    await page.keyboard.press('Escape')
    await expect(desktopTrigger).toBeFocused()

    await page.setViewportSize({ width: 900, height: 800 })
    const tabletTrigger = page.getByTestId('compact-inbox-button')
    await tabletTrigger.click()
    await expect(dialog).toBeVisible()
    box = await dialog.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.x + box!.width).toBeLessThanOrEqual(900.5)
    expect(box!.x).toBeGreaterThan(400)
    expect(box!.y).toBeGreaterThanOrEqual(52)
    expect(box!.height).toBeLessThan(748)
    await page.keyboard.press('Escape')
    await expect(tabletTrigger).toBeFocused()

    await page.setViewportSize({ width: 720, height: 800 })
    await tabletTrigger.click()
    await expect(dialog).toBeVisible()
    box = await dialog.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.x).toBeGreaterThanOrEqual(-0.5)
    expect(box!.y).toBeGreaterThanOrEqual(-0.5)
    expect(box!.width).toBeGreaterThanOrEqual(719)
    expect(box!.height).toBeGreaterThanOrEqual(799)
    await expect(dialog.locator('.dialog__footer')).toBeInViewport()
    await expectNoPageOverflow(page)
    await page.keyboard.press('Escape')
    await expect(tabletTrigger).toBeFocused()
  })

  test('200% zoom-equivalent CSS viewport keeps navigation and the primary action reachable', async ({
    page,
  }) => {
    // Browser zoom turns a 1280x800 physical viewport into an approximately
    // 640x400 CSS viewport at 200%. Playwright has no cross-browser zoom API,
    // so this uses that exact CSS viewport equivalence in Chromium and WebKit.
    await page.setViewportSize({ width: 640, height: 400 })
    await setDaemonTheme('light')
    await primeAuth(page)
    await page.goto(`${daemon.baseUrl}/workflows`)

    await expect(page.getByTestId('mobile-topbar')).toBeVisible()
    await expect(page.getByTestId('workflow-new-button')).toBeInViewport()
    const menu = page.getByTestId('mobile-menu-trigger')
    await menu.click()
    const navDialog = page.getByRole('dialog', { name: 'Agent Workflow' })
    await expectWithinViewport(navDialog)
    await expectNoPageOverflow(page)

    // Returning to 100% while the sheet is open unmounts compact chrome and
    // must land focus on the stable main landmark rather than <body>.
    await page.setViewportSize({ width: 1280, height: 800 })
    await expect(navDialog).toHaveCount(0)
    await expect(page.getByTestId('desktop-sidebar')).toBeVisible()
    await expect(page.getByTestId('app-shell-main')).toBeFocused()
    await expectNoPageOverflow(page)
  })

  test('Chinese page-section navigation stays discoverable at 1280 and 390', async ({ page }) => {
    await setDaemonTheme('light')
    await setDaemonLanguage('zh-CN')
    await primeAuth(page)

    try {
      await page.goto(`${daemon.baseUrl}/settings?tab=limits`)
      await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
      await expect(page.getByRole('navigation', { name: '设置分区' })).toBeVisible()
      await expect(page.getByRole('heading', { name: '限额', exact: true })).toBeVisible()
      await expectNoPageOverflow(page)

      await page.setViewportSize({ width: 390, height: 844 })
      await expect(page.getByTestId('settings-compact-select')).toBeVisible()
      await expect(page.getByRole('combobox', { name: '设置分区' })).toBeVisible()
      await expectNoPageOverflow(page)
    } finally {
      await setDaemonLanguage('en-US')
    }
  })

  test('reduced motion makes overflowing TabBar controls scroll instantly', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await setDaemonTheme('light')
    await primeAuth(page)
    await page.goto(`${daemon.baseUrl}/agents/new`)

    const tablist = page.getByRole('tablist', { name: 'Agent configuration groups' })
    await expect(tablist).toBeVisible()
    const scrollEnd = page.getByRole('button', { name: 'Show more sections after' })
    await expect(scrollEnd).toBeEnabled()
    await tablist.evaluate((element) => {
      ;(
        window as typeof window & { __rfc201ScrollBehavior?: ScrollBehavior }
      ).__rfc201ScrollBehavior = undefined
      element.scrollBy = ((options: ScrollToOptions) => {
        ;(
          window as typeof window & { __rfc201ScrollBehavior?: ScrollBehavior }
        ).__rfc201ScrollBehavior = options.behavior
      }) as typeof element.scrollBy
    })

    await scrollEnd.click()
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as typeof window & { __rfc201ScrollBehavior?: ScrollBehavior })
              .__rfc201ScrollBehavior,
        ),
      )
      .toBe('auto')
  })

  test('768 compact shell keeps split actions and form fields at usable widths', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 768, height: 1024 })
    await setDaemonTheme('light')
    await routeTaskFixture(page)
    await primeAuth(page)
    await page.goto(`${daemon.baseUrl}/agents/new`)

    await expect(page.getByTestId('mobile-topbar')).toBeVisible()
    await expect(page.getByTestId('desktop-sidebar')).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'New agent', exact: true })).toBeVisible()
    const action = page.getByTestId('agent-create-button')
    const field = page.locator('.split__detail input.form-input:visible').first()
    await expect(action).toBeVisible()
    await expect(field).toBeVisible()

    const mainBox = await page.getByTestId('app-shell-main').boundingBox()
    const actionBox = await action.boundingBox()
    const fieldBox = await field.boundingBox()
    expect(mainBox).not.toBeNull()
    expect(actionBox).not.toBeNull()
    expect(fieldBox).not.toBeNull()
    expect(actionBox!.width).toBeGreaterThanOrEqual(36)
    expect(fieldBox!.width).toBeGreaterThanOrEqual(240)
    expect(actionBox!.x + actionBox!.width).toBeLessThanOrEqual(mainBox!.x + mainBox!.width + 0.5)
    expect(fieldBox!.x + fieldBox!.width).toBeLessThanOrEqual(mainBox!.x + mainBox!.width + 0.5)
    await expectNoPageOverflow(page)

    await page.goto(`${daemon.baseUrl}/tasks`)
    await expectTableOwnsOverflow(page, page.getByTestId('tasks-search'))
    await expectNoPageOverflow(page)
  })

  test('721/720 changes content and form while compact resource split stays route-owned', async ({
    page,
  }) => {
    await setDaemonTheme('light')
    await primeAuth(page)

    await page.setViewportSize({ width: 721, height: 800 })
    await page.goto(`${daemon.baseUrl}/workflows`)
    await expect(page.getByTestId('mobile-topbar')).toBeVisible()
    await expect(page.locator('.page__header--row')).toHaveCSS('flex-direction', 'row')

    await page.goto(`${daemon.baseUrl}/settings?tab=limits`)
    const twoColumnGrid = page.locator('.form-grid--cols-2').first()
    await expect(twoColumnGrid).toBeVisible()
    expect(
      await twoColumnGrid.evaluate(
        (element) => getComputedStyle(element).gridTemplateColumns.split(' ').length,
      ),
    ).toBe(2)

    await openAgents(page)
    await expect(page.locator('.split__list')).toBeVisible()
    await expect(page.getByTestId('split-detail')).toBeHidden()
    await expectNoPageOverflow(page)

    await page.setViewportSize({ width: 720, height: 800 })
    await page.goto(`${daemon.baseUrl}/workflows`)
    await expect(page.getByTestId('mobile-topbar')).toBeVisible()
    await expect(page.locator('.page__header--row')).toHaveCSS('flex-direction', 'column')
    const headerWidth = await page
      .locator('.page__header--row')
      .evaluate((element) => element.getBoundingClientRect().width)
    const actionsWidth = await page
      .locator('.page__actions')
      .evaluate((element) => element.getBoundingClientRect().width)
    expect(actionsWidth).toBeGreaterThanOrEqual(headerWidth - 1)

    await page.goto(`${daemon.baseUrl}/settings?tab=limits`)
    const oneColumnGrid = page.locator('.form-grid--cols-2').first()
    await expect(oneColumnGrid).toBeVisible()
    expect(
      await oneColumnGrid.evaluate(
        (element) => getComputedStyle(element).gridTemplateColumns.split(' ').length,
      ),
    ).toBe(1)

    await openAgents(page)
    await expect(page.locator('.split__list')).toBeVisible()
    await expect(page.getByTestId('split-detail')).toBeHidden()
    await page.goto(`${daemon.baseUrl}/agents/${FIXTURE_AGENT}`)
    await expect(page.locator('.split__list')).toBeHidden()
    await expect(page.getByTestId('split-detail')).toBeVisible()
    await expect(page.getByTestId('agents-mobile-back')).toBeVisible()
    await expectNoPageOverflow(page)
  })

  test('390 light keeps mobile navigation, split focus, and tasks table reachable', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await setDaemonTheme('light')
    await routeTaskFixture(page)
    await primeAuth(page)
    await openAgents(page)

    const menu = page.getByTestId('mobile-menu-trigger')
    await menu.focus()
    await page.keyboard.press('Enter')
    const navDialog = page.getByRole('dialog', { name: 'Agent Workflow' })
    await expectWithinViewport(navDialog)
    const nav = page.getByTestId('shell-navigation-mobile')
    for (const href of [
      '/',
      '/agents',
      '/skills',
      '/mcps',
      '/plugins',
      '/workflows',
      '/workgroups',
      '/tasks',
      '/scheduled',
      '/repos',
      '/memory?tab=all',
    ]) {
      await expect(nav.locator(`a[href="${href}"]`)).toHaveCount(1)
    }
    await expect(navDialog.locator('.user-menu__trigger')).toBeVisible()
    await expect(navDialog.locator('.settings-gear')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(menu).toBeFocused()

    const card = page.getByTestId(`split-card-${FIXTURE_AGENT}`)
    await card.focus()
    await page.keyboard.press('Enter')
    await page.waitForURL(new RegExp(`/agents/${FIXTURE_AGENT}$`))
    await expect(page.locator('.split__list')).toBeHidden()
    const back = page.getByTestId('agents-mobile-back')
    await expect(back).toBeVisible()
    await back.focus()
    await page.keyboard.press('Enter')
    await page.waitForURL(/\/agents$/)
    await expect(card).toBeFocused()
    await expectNoPageOverflow(page)

    await page.goto(`${daemon.baseUrl}/tasks`)
    await expect(page.getByRole('heading', { name: 'Tasks', exact: true })).toBeVisible()
    await expect(page.getByTestId('tasks-new-button')).toBeVisible()
    await expectTableOwnsOverflow(page, page.getByTestId('tasks-search'))
    await expectNoPageOverflow(page)

    await page.goto(`${daemon.baseUrl}/settings?tab=network`)
    await expect(page.getByTestId('settings-compact-select')).toContainText('Network')
    await expect(page.getByTestId('settings-bind-port')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Save' })).toBeVisible()
    await expectNoPageOverflow(page)
  })

  test('390 workflow deep-create is one-shot and import dialog fits with focus restoration', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await setDaemonTheme('light')
    await primeAuth(page)
    await page.goto(`${daemon.baseUrl}/agents`)
    await page.goto(`${daemon.baseUrl}/workflows?create=1&scope=all`)

    const createDialog = page.getByTestId('workflow-create-dialog').getByRole('dialog')
    await expect(createDialog).toBeVisible()
    await expect
      .poll(() => {
        const url = new URL(page.url())
        return { create: url.searchParams.has('create'), scope: url.searchParams.get('scope') }
      })
      .toEqual({ create: false, scope: 'all' })
    expect(await createDialog.evaluate((dialog) => dialog.contains(document.activeElement))).toBe(
      true,
    )
    await page.keyboard.press('Escape')
    await expect(createDialog).toHaveCount(0)

    await page.reload()
    await expect(page.getByTestId('workflow-create-dialog')).toHaveCount(0)
    await page.goBack()
    await page.waitForURL(/\/agents$/)
    await page.goForward()
    await page.waitForURL(/\/workflows\?scope=all$/)
    await expect(page.getByTestId('workflow-create-dialog')).toHaveCount(0)

    const trigger = page.getByTestId('workflow-import-trigger')
    await trigger.focus()
    await page.keyboard.press('Enter')
    const importDialog = page.getByTestId('workflow-import-dialog').getByRole('dialog')
    await expectWithinViewport(importDialog)
    await expect(page.getByTestId('workflow-import-file-button')).toBeFocused()
    await expect(page.getByTestId('workflow-import-submit')).toBeInViewport()
    expect(
      await importDialog
        .locator('.dialog__body')
        .evaluate((body) => body.scrollWidth <= body.clientWidth),
    ).toBe(true)
    await expectNoPageOverflow(page)

    const yaml = [
      `id: ${fixtureWorkflowId}`,
      `name: ${FIXTURE_WORKFLOW}`,
      'description: RFC-198 conflict fixture',
      'definition:',
      '  $schema_version: 1',
      '  inputs: []',
      '  nodes: []',
      '  edges: []',
      '',
    ].join('\n')
    await page.getByTestId('workflow-import-file').setInputFiles({
      name: 'existing-workflow.yaml',
      mimeType: 'application/yaml',
      buffer: Buffer.from(yaml),
    })
    await page.getByTestId('workflow-import-submit').click()
    const conflict = page.getByTestId('workflow-import-conflict')
    await expect(conflict).toBeVisible()
    await expectWithinViewport(conflict)
    await expect(page.getByTestId('workflow-import-choice-new')).toHaveAttribute(
      'aria-checked',
      'true',
    )
    await page.getByTestId('workflow-import-choice-overwrite').click()
    await page.getByTestId('workflow-import-submit').click()
    await expect(page.getByTestId('workflow-import-result')).toBeVisible()
    await page.getByTestId('workflow-import-close').click()
    await expect(importDialog).toHaveCount(0)
    await expect(trigger).toBeFocused()
  })

  test('390 OIDC table and ConfirmDialog keep overflow and focus inside their owners', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await setDaemonTheme('light')
    await routeOidcFixture(page)
    await primeAuth(page)
    await page.goto(`${daemon.baseUrl}/settings?tab=authentication`)

    const deleteTrigger = page.getByTestId('oidc-delete-ux-provider')
    await expect(deleteTrigger).toBeVisible()
    const tableScroller = page.locator('.table-viewport__scroller')
    await expect(tableScroller).toHaveAttribute('tabindex', '0')
    expect(
      await tableScroller.evaluate((element) => element.scrollWidth > element.clientWidth),
    ).toBe(true)
    await expectNoPageOverflow(page)

    await deleteTrigger.focus()
    await page.keyboard.press('Enter')
    const confirmDialog = page.locator('.confirm-dialog')
    await expectWithinViewport(confirmDialog)
    // <Dialog> intentionally assigns initial focus from a 0ms timer so its
    // portaled panel has mounted. Visibility can win that race; wait on the
    // actual focus invariant instead of sampling it once and depending on a
    // Playwright retry to hide the timing window.
    await expect
      .poll(() => confirmDialog.evaluate((dialog) => dialog.contains(document.activeElement)))
      .toBe(true)
    for (const button of await confirmDialog.getByRole('button').all()) {
      const box = await button.boundingBox()
      expect(box).not.toBeNull()
      expect(box!.height).toBeGreaterThanOrEqual(44)
    }
    await confirmDialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(confirmDialog).toHaveCount(0)
    await expect(deleteTrigger).toBeFocused()
  })

  test('explicit app themes win over the opposite OS color scheme on desktop', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await setDaemonTheme('light')
    await primeAuth(page)
    await openAgents(page)
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    expect(await readThemeStyles(page)).toEqual({
      theme: 'light',
      background: 'rgb(248, 249, 251)',
      primaryBackground: 'rgb(31, 95, 218)',
    })

    await page.emulateMedia({ colorScheme: 'light' })
    await setDaemonTheme('dark')
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    expect(await readThemeStyles(page)).toEqual({
      theme: 'dark',
      background: 'rgb(21, 24, 29)',
      primaryBackground: 'rgb(39, 89, 165)',
    })
  })

  test('1280 dark covers status, settings, and dialog surfaces', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await setDaemonTheme('dark')
    await routeTaskFixture(page)
    await primeAuth(page)
    await page.goto(`${daemon.baseUrl}/tasks`)

    await expect(page.getByTestId('task-row-ux-task-1')).toBeVisible()
    const status = page.locator('.status-chip--success')
    await expect(status).toHaveCSS('color', 'rgb(102, 209, 122)')
    await expect(page.getByTestId('tasks-new-button')).toHaveCSS(
      'background-color',
      'rgb(39, 89, 165)',
    )
    await expectNoPageOverflow(page)

    await page.goto(`${daemon.baseUrl}/settings?tab=appearance`)
    await expect(
      page.locator('.settings-section-layout .page-section-nav__leaf[aria-current="page"]'),
    ).toContainText('Appearance')
    await expect(page.getByRole('button', { name: 'Save' })).toBeVisible()

    await routeReviewDiffFixture(page)
    await page.goto(`${daemon.baseUrl}/reviews/ux-review`)
    await expect(page.getByRole('heading', { name: /Responsive review task/ })).toBeVisible()
    await page.getByRole('radio', { name: 'Word' }).click()
    const diff = page.getByTestId('markdown-diff-view')
    await expect(diff).toBeVisible()
    await expect(diff.locator('.diff-ins').first()).toHaveCSS('background-color', 'rgb(22, 64, 26)')
    await expect(diff.locator('.diff-ins').first()).toHaveCSS('color', 'rgb(174, 240, 168)')
    await expect(diff.locator('.diff-del').first()).toHaveCSS('background-color', 'rgb(58, 20, 20)')
    await expect(diff.locator('.diff-del').first()).toHaveCSS('color', 'rgb(244, 164, 164)')
    await expectNoPageOverflow(page)

    await page.goto(`${daemon.baseUrl}/workflows`)
    await page.getByTestId('workflow-import-trigger').click()
    const dialog = page.getByTestId('workflow-import-dialog').getByRole('dialog')
    await expect(dialog).toHaveCSS('background-color', 'rgb(28, 32, 40)')
    await expectNoPageOverflow(page)
  })

  test('390 dark keeps compact navigation, form, and dialog representative surfaces usable', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ colorScheme: 'light' })
    await setDaemonTheme('dark')
    await routeTaskFixture(page)
    await routeReviewDiffFixture(page)
    await primeAuth(page)

    await page.goto(`${daemon.baseUrl}/reviews/ux-review`)
    await expect(page.getByRole('heading', { name: /Responsive review task/ })).toBeVisible()
    const reviewActions = page.locator('.review-detail__page-header-actions')
    await expect(reviewActions).toBeVisible()
    expect(
      await reviewActions.evaluate((element) => ({
        fitsSelf: element.scrollWidth <= element.clientWidth,
        fitsViewport: element.getBoundingClientRect().right <= window.innerWidth + 0.5,
      })),
    ).toEqual({ fitsSelf: true, fitsViewport: true })
    for (const button of await reviewActions.getByRole('button').all()) {
      await expectWithinViewport(button)
    }
    await expectNoPageOverflow(page)

    await page.goto(`${daemon.baseUrl}/tasks`)
    await expect(page.getByTestId('task-row-ux-task-1')).toBeVisible()
    await expectTableOwnsOverflow(page, page.getByTestId('tasks-search'))
    await expectNoPageOverflow(page)

    await page.goto(`${daemon.baseUrl}/settings?tab=network`)

    await expect(page.getByTestId('mobile-topbar')).toBeVisible()
    await expect(page.getByTestId('settings-bind-port')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Save' })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expectNoPageOverflow(page)

    await page.getByTestId('mobile-menu-trigger').click()
    const dialog = page.getByRole('dialog', { name: 'Agent Workflow' })
    await expectWithinViewport(dialog)
    await expect(dialog).toHaveCSS('background-color', 'rgb(28, 32, 40)')
    await expectNoPageOverflow(page)
  })

  test('Skill ZIP primary matches the global primary in explicit-dark and system-dark modes', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await setDaemonTheme('dark')
    await primeAuth(page)
    await page.goto(`${daemon.baseUrl}/skills/new`)
    await page.getByTestId('skills-tab-zip').click()

    const zipPrimary = page.getByTestId('zip-parse-button')
    const globalPrimary = page.getByTestId('split-new-button')
    await expect(zipPrimary).toBeVisible()
    await expect(globalPrimary).toBeVisible()
    const explicitDark = await controlColors(zipPrimary)
    expect(explicitDark).toEqual(await controlColors(globalPrimary))
    expect(explicitDark.background).toBe('rgb(39, 89, 165)')

    await page.emulateMedia({ colorScheme: 'dark' })
    await setDaemonTheme('system')
    await page.reload()
    await expect(page.locator('html')).not.toHaveAttribute('data-theme')
    await page.getByTestId('skills-tab-zip').click()
    const systemDark = await controlColors(page.getByTestId('zip-parse-button'))
    expect(systemDark).toEqual(await controlColors(page.getByTestId('split-new-button')))
    expect(systemDark).toEqual(explicitDark)
  })
})

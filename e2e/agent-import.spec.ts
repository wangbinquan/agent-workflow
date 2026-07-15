// RFC-197 — real-daemon coverage for the Agent agent.md select → review →
// draft-result task flow. The dialog must disclose every applied section,
// remain responsive, and never confuse draft mutation with backend creation.

import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { startDaemon, type DaemonHandle } from './harness'

let daemon: DaemonHandle

test.beforeAll(async () => {
  daemon = await startDaemon()
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

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

async function expectDialogAxeClean(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .include('[data-testid="agent-import-dialog"]')
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze()
  const blocking = results.violations.filter(
    (violation) => violation.impact === 'critical' || violation.impact === 'serious',
  )
  const details = blocking
    .map(
      (violation) =>
        `${violation.impact}: ${violation.id} — ${violation.help}\n${violation.nodes
          .map((node) => `  ${node.target.join(' ')}: ${node.failureSummary ?? ''}`)
          .join('\n')}`,
    )
    .join('\n')
  expect(blocking, details).toEqual([])
}

const FULL_AGENT_MARKDOWN = [
  '---',
  'name: responsive-reviewer',
  'description: Reviews changes before they are merged into a deliberately long-lived branch.',
  'runtime: opencode-review',
  'inputs:',
  '  - name: source',
  '    kind: markdown',
  '    description: The source document that should be inspected carefully.',
  'outputs: [result]',
  'outputKinds:',
  '  result: markdown',
  'outputWrapperPortNames:',
  '  result: merged-review',
  'dependsOn: [planner, implementer]',
  'mcp: [github]',
  'plugins: [review-tools]',
  'role: aggregator',
  'permission:',
  '  edit: deny',
  'mode: subagent',
  '---',
  'Review the supplied changes and explain every material risk.',
].join('\n')

test.describe('RFC-197 Agent import UX', () => {
  test('full paste review is responsive, accessible, draft-only, and focus-safe', async ({
    page,
  }) => {
    const agentCreates: string[] = []
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/agents') {
        agentCreates.push(request.url())
      }
    })

    await primeAuth(page)
    await page.goto(`${daemon.baseUrl}/agents/new`)
    const trigger = page.getByTestId('agent-import-open')
    await trigger.click()

    const dialog = page.getByTestId('agent-import-dialog')
    await expect(dialog).toBeVisible()
    await expect(page.getByTestId('agent-import-file-button')).toBeFocused()
    await expectDialogAxeClean(page)

    await page.getByRole('tab', { name: 'Paste text' }).click()
    await page.getByTestId('agent-import-textarea').fill(FULL_AGENT_MARKDOWN)
    await page.getByTestId('agent-import-parse').click()

    await expect(page.getByTestId('agent-import-review-heading')).toBeFocused()
    for (const section of ['basics', 'prompt', 'ports', 'resources', 'advanced']) {
      await expect(page.getByTestId(`agent-import-section-${section}`)).toBeVisible()
    }
    for (const field of ['runtime', 'dependsOn', 'mcp', 'plugins']) {
      await expect(page.getByTestId(`agent-import-item-${field}`)).toBeVisible()
    }
    await expect(dialog.locator('table')).toHaveCount(0)
    await expectDialogAxeClean(page)

    await page.setViewportSize({ width: 390, height: 844 })
    const geometry = await dialog.evaluate((overlay) => {
      const panel = overlay.querySelector<HTMLElement>('.dialog__panel')
      const body = overlay.querySelector<HTMLElement>('.dialog__body')
      const footer = overlay.querySelector<HTMLElement>('.dialog__footer')
      const cards = Array.from(overlay.querySelectorAll<HTMLElement>('.agent-import__section'))
      if (panel === null || body === null || footer === null) return null
      const panelRect = panel.getBoundingClientRect()
      const footerRect = footer.getBoundingClientRect()
      return {
        documentFits:
          document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
        panelFits: panel.scrollWidth <= panel.clientWidth + 1,
        bodyFits: body.scrollWidth <= body.clientWidth + 1,
        cardsFit: cards.every((card) => card.scrollWidth <= card.clientWidth + 1),
        panelWithinViewport: panelRect.left >= 0 && panelRect.right <= window.innerWidth + 1,
        footerVisible: footerRect.top >= 0 && footerRect.bottom <= window.innerHeight + 1,
      }
    })
    expect(geometry).toEqual({
      documentFits: true,
      panelFits: true,
      bodyFits: true,
      cardsFit: true,
      panelWithinViewport: true,
      footerVisible: true,
    })
    await expectDialogAxeClean(page)

    await page.getByTestId('agent-import-apply').click()
    await expect(page.getByTestId('agent-import-result-heading')).toBeFocused()
    await expect(page.getByTestId('agent-import-not-created')).toHaveText(
      'Agent has not been created',
    )
    expect(agentCreates).toEqual([])

    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark'
    })
    await expectDialogAxeClean(page)

    await page.getByTestId('agent-import-view-form').click()
    await expect(dialog).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await expect(page.getByRole('textbox', { name: 'Name' })).toHaveValue('responsive-reviewer')
    expect(agentCreates).toEqual([])

    const response = await fetch(`${daemon.baseUrl}/api/agents`, {
      headers: { Authorization: `Bearer ${daemon.token}` },
    })
    if (!response.ok) throw new Error(`GET /api/agents failed: ${await response.text()}`)
    const agents = (await response.json()) as Array<{ name: string }>
    expect(agents.some((agent) => agent.name === 'responsive-reviewer')).toBe(false)
  })
})

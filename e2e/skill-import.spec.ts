// RFC-196 — real-daemon visual, responsive, keyboard-focus, and axe coverage
// for the Skill ZIP select → review → result task.

import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { zipSync } from 'fflate'
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

async function expectNoBlockingAxeViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .include('[data-testid="skill-import"]')
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

function skillMarkdown(name: string, description: string): Uint8Array {
  return new TextEncoder().encode(
    `---\nname: ${name}\ndescription: ${description}\n---\nUse this skill.\n`,
  )
}

test.describe('RFC-196 Skill ZIP import UX', () => {
  test('real ZIP reaches responsive review and stable result with clean axe/focus contracts', async ({
    page,
  }) => {
    const seed = await fetch(`${daemon.baseUrl}/api/skills`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${daemon.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'existing-skill',
        description: 'Existing target for the conflict decision.',
        bodyMd: 'Existing body.',
      }),
    })
    expect(seed.ok, await seed.text()).toBe(true)

    const archive = zipSync({
      'fresh-skill/SKILL.md': skillMarkdown(
        'different-frontmatter-name',
        'A deliberately long description that proves candidate cards wrap without becoming a five-column table.',
      ),
      'fresh-skill/references/notes.md': new TextEncoder().encode('notes'),
      'existing-skill/SKILL.md': skillMarkdown(
        'existing-skill',
        'This candidate intentionally conflicts with an existing managed skill.',
      ),
    })

    await primeAuth(page)
    await page.goto(`${daemon.baseUrl}/skills/new`)
    await page.getByTestId('skills-tab-zip').click()
    await expect(page.getByRole('heading', { level: 2, name: 'Import skills' })).toBeVisible()
    await expect(page.getByTestId('zip-select-phase')).toBeVisible()
    await expectNoBlockingAxeViolations(page)

    await page.getByTestId('zip-file-input').setInputFiles({
      name: 'community-pack.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(archive),
    })
    await page.getByTestId('zip-parse-button').click()
    await expect(page.getByTestId('zip-review-phase')).toBeVisible()
    await expect(page.getByTestId('zip-row-fresh-skill')).toBeVisible()
    await expect(page.getByTestId('zip-row-existing-skill')).toBeVisible()
    await expect(page.getByTestId('zip-review-phase').locator('table')).toHaveCount(0)
    await expectNoBlockingAxeViolations(page)

    const action = page.getByTestId('zip-action-existing-skill')
    await action.click()
    await page.getByRole('option', { name: 'Rename' }).click()
    const rename = page.getByTestId('zip-rename-existing-skill')
    await rename.fill('Bad Name')
    await expect(rename).toHaveAttribute('aria-invalid', 'true')

    await page.setViewportSize({ width: 390, height: 844 })
    const geometry = await page.getByTestId('skill-import').evaluate((root) => {
      const rootRect = root.getBoundingClientRect()
      const controls = Array.from(
        root.querySelectorAll<HTMLElement>('button, input:not([type="file"]), [role="combobox"]'),
      )
      return {
        rootWidth: rootRect.width,
        rootFits: root.scrollWidth <= root.clientWidth + 1,
        documentFits:
          document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
        outside: controls
          .filter((control) => {
            const rect = control.getBoundingClientRect()
            return rect.left < rootRect.left - 1 || rect.right > rootRect.right + 1
          })
          .map((control) => ({
            testid: control.dataset.testid ?? '',
            text: control.textContent?.trim() ?? '',
          })),
      }
    })
    expect(geometry.rootWidth).toBeGreaterThanOrEqual(340)
    expect(geometry.rootFits).toBe(true)
    expect(geometry.documentFits).toBe(true)
    expect(geometry.outside).toEqual([])
    await expect(page.getByRole('link', { name: 'Back to list' })).toBeVisible()
    await expectNoBlockingAxeViolations(page)

    await rename.fill('existing-skill-renamed')
    await expect(page.getByTestId('zip-commit-button')).toBeEnabled()
    await page.getByTestId('zip-commit-button').click()
    const result = page.getByTestId('zip-import-summary')
    await expect(result).toBeVisible()
    await expect(result).toContainText('Import complete')
    await expect(result.getByRole('link', { name: /fresh-skill/ })).toBeVisible()
    await expect(result.getByRole('link', { name: /existing-skill-renamed/ })).toBeVisible()
    await expect(result.getByRole('heading', { name: 'Import complete' })).toBeFocused()

    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark'
    })
    await expectNoBlockingAxeViolations(page)

    await result.getByRole('button', { name: 'Import another ZIP' }).click()
    await expect(page.getByTestId('zip-select-phase')).toBeVisible()
    await expect(page.getByTestId('zip-file-input-button')).toBeFocused()
  })
})

// Real resource routes, browser geometry and persisted Markdown. The unit suite
// covers state transitions; only a browser can detect intrinsic-size crowding
// or a textarea clipped by an ancestor with overflow:hidden.
import { expect, test, type Locator, type Page } from '@playwright/test'
import { startDaemon, type DaemonHandle } from './harness'

let daemon: DaemonHandle
let sequence = 0
const storageKey = 'aw.markdown-editor.layout.v1'
const body = [
  '# Layout regression',
  '',
  '```text',
  'long_code_'.repeat(100),
  '```',
  '',
  `| ${Array.from({ length: 12 }, (_, i) => `Column ${i}`).join(' | ')} |`,
  `| ${Array.from({ length: 12 }, () => '---').join(' | ')} |`,
  `| ${Array.from({ length: 12 }, () => 'Wide table content').join(' | ')} |`,
  '',
  ...Array.from(
    { length: 45 },
    (_, i) => `Paragraph ${i}: preserve the source and scroll position.\n`,
  ),
].join('\n')

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  })
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`)
  return (await response.json()) as T
}

async function seed(kind: 'agents' | 'skills') {
  return api<{ id: string }>(`/api/${kind}`, {
    method: 'POST',
    body: JSON.stringify({
      name: `rfc373-${kind}-${++sequence}`,
      description: 'Markdown layout fixture',
      bodyMd: body,
      ...(kind === 'agents' ? { outputs: ['result'], readonly: false } : {}),
    }),
  })
}

async function prime(page: Page) {
  await page.addInitScript(
    ({ baseUrl, token }) => {
      localStorage.setItem('agent-workflow.baseUrl', baseUrl)
      localStorage.setItem('agent-workflow.token', token)
      localStorage.setItem('aw-language', 'en-US')
    },
    { baseUrl: daemon.baseUrl, token: daemon.token },
  )
}

async function assertNoCrowding(page: Page, split: boolean) {
  const root = page.getByTestId('markdown-editor')
  const sizes = await root.evaluate((element) => ({
    client: element.clientWidth,
    scroll: element.scrollWidth,
    source: element.querySelector('textarea')!.getBoundingClientRect().width,
    preview: element.querySelector('.md-editor__pane--preview')!.getBoundingClientRect().width,
    pageWidth: document.documentElement.clientWidth,
    pageScroll: document.documentElement.scrollWidth,
  }))
  expect(sizes.scroll).toBeLessThanOrEqual(sizes.client + 1)
  expect(sizes.pageScroll).toBeLessThanOrEqual(sizes.pageWidth + 1)
  if (split) {
    expect(sizes.source).toBeGreaterThanOrEqual(319)
    expect(sizes.preview).toBeGreaterThanOrEqual(319)
  }
}

async function visibleArea(locator: Locator) {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    let left = Math.max(0, rect.left)
    let top = Math.max(0, rect.top)
    let right = Math.min(innerWidth, rect.right)
    let bottom = Math.min(innerHeight, rect.bottom)
    for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) {
      const style = getComputedStyle(parent)
      const bounds = parent.getBoundingClientRect()
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
        left = Math.max(left, bounds.left)
        right = Math.min(right, bounds.right)
      }
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
        top = Math.max(top, bounds.top)
        bottom = Math.min(bottom, bounds.bottom)
      }
    }
    return { width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
  })
}

test.beforeAll(async () => {
  daemon = await startDaemon()
})
test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

test('Agent edit: drag limits, container fallback, draft preservation, save and restored preferences', async ({
  page,
}) => {
  const agent = await seed('agents')
  let saves = 0
  page.on('request', (request) => {
    if (
      request.method() === 'PUT' &&
      new URL(request.url()).pathname === `/api/agents/${agent.id}`
    ) {
      saves += 1
    }
  })
  await prime(page)
  await page.setViewportSize({ width: 1600, height: 960 })
  await page.goto(`${daemon.baseUrl}/agents/${agent.id}`)
  await page.getByTestId('agent-tab-prompt').click()
  const root = page.getByTestId('markdown-editor')
  const source = page.getByTestId('markdown-source')
  const separator = root.getByRole('separator')
  await expect(root).toHaveAttribute('data-mode', 'split')
  await expect(separator).toHaveAttribute('aria-valuenow', '50')
  // Establish the pane the user was editing after page metadata has settled;
  // automatic compact fallback deliberately follows the last interacted pane.
  await expect(source).toBeEditable()
  await source.focus()
  await assertNoCrowding(page, true)
  const bounds = (await separator.boundingBox())!
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  await page.mouse.down()
  await page.mouse.move(bounds.x + 2000, bounds.y + bounds.height / 2, { steps: 8 })
  await page.mouse.up()
  const max = await separator.getAttribute('aria-valuemax')
  await expect(separator).toHaveAttribute('aria-valuenow', max!)
  await assertNoCrowding(page, true)
  await root.getByRole('button', { name: 'Equal split' }).click()
  await separator.focus()
  await page.keyboard.press('ArrowRight')
  await expect(separator).toHaveAttribute('aria-valuenow', '52')
  // A width change inside a wide window must be observed without a window resize.
  await root.evaluate((element) => {
    element.style.width = '620px'
  })
  await expect(root).toHaveAttribute('data-mode', 'edit')
  await expect(page.getByTestId('markdown-mode-split')).toBeDisabled()
  await root.evaluate((element) => {
    element.style.width = ''
  })
  await expect(root).toHaveAttribute('data-mode', 'split')
  await expect(separator).toHaveAttribute('aria-valuenow', '52')
  expect(saves, 'Layout controls must not save the resource').toBe(0)

  const updated = body + '\nUnsaved body from the real editor.\n'
  await source.fill(updated)
  const before = await source.evaluate((element: HTMLTextAreaElement) => {
    element.setSelectionRange(4, 16)
    element.scrollTop = 100
    return { start: element.selectionStart, end: element.selectionEnd, scroll: element.scrollTop }
  })
  await page.getByTestId('markdown-mode-preview').click()
  await expect(root.locator('table')).toBeVisible()
  await page.getByTestId('markdown-mode-edit').click()
  expect(
    await source.evaluate((element: HTMLTextAreaElement) => ({
      start: element.selectionStart,
      end: element.selectionEnd,
      scroll: element.scrollTop,
    })),
  ).toEqual(before)
  await expect(source).toHaveValue(updated)
  await page.getByTestId('markdown-mode-split').click()
  await page.getByTestId('agent-tab-basics').click()
  await page.getByTestId('agent-tab-prompt').click()
  await expect(source).toHaveValue(updated)
  await page.getByTestId('agent-save-button').click()
  await expect
    .poll(async () => (await api<{ bodyMd: string }>(`/api/agents/${agent.id}`)).bodyMd)
    .toBe(updated)
  await expect(page.getByTestId('agent-save-button')).toBeEnabled()
  expect(saves).toBe(1)
  await page.reload()
  await page.getByTestId('agent-tab-prompt').click()
  await expect(source).toHaveValue(updated)
  await expect(separator).toHaveAttribute('aria-valuenow', '52')
  expect(
    await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).ratio, storageKey),
  ).toBe(0.52)
  await assertNoCrowding(page, true)
})

test('Agent new: phone widths stay editable, preview works and creation retains the Markdown', async ({
  page,
}) => {
  await prime(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${daemon.baseUrl}/agents/new`)
  await page.getByLabel(/^Name/).fill(`rfc373-created-${++sequence}`)
  await page.getByTestId('agent-tab-prompt').click()
  const root = page.getByTestId('markdown-editor')
  const source = page.getByTestId('markdown-source')
  await expect(root).toHaveAttribute('data-mode', 'edit')
  await source.fill(body)
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 })
    await expect(page.getByTestId('markdown-mode-split')).toBeDisabled()
    await source.scrollIntoViewIfNeeded()
    const area = await visibleArea(source)
    expect(area.width).toBeGreaterThan(160)
    expect(area.height).toBeGreaterThan(100)
    await assertNoCrowding(page, false)
    await page.getByTestId('markdown-mode-preview').click()
    await expect(root.locator('table')).toBeVisible()
    await assertNoCrowding(page, false)
    await page.getByTestId('markdown-mode-edit').click()
    await expect(source).toHaveValue(body)
  }
  await page.getByTestId('agent-create-button').click()
  await expect(page).toHaveURL(/\/agents\/[0-9A-Z]{26}$/)
  const id = new URL(page.url()).pathname.split('/').pop()!
  expect((await api<{ bodyMd: string }>(`/api/agents/${id}`)).bodyMd).toBe(body)
})

test('Skill edit: short-window scroll reaches source, preview and technical details, and saves the draft', async ({
  page,
}) => {
  const skill = await seed('skills')
  await prime(page)
  await page.setViewportSize({ width: 1000, height: 500 })
  await page.goto(`${daemon.baseUrl}/skills/${skill.id}`)
  await page.getByTestId('skill-tab-edit').click()
  const workspace = page.locator('.skill-detail__edit')
  const source = page.getByTestId('markdown-source')
  await page.getByTestId('markdown-mode-edit').click()
  await expect(workspace).toHaveCSS('overflow-y', 'auto')
  expect(await workspace.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
    true,
  )
  // The editor also scrolls in a short window. Wheel over the description so
  // the outer workspace, rather than that nested scroll owner, receives it.
  await page.getByTestId('skill-description-input').hover()
  await page.mouse.wheel(0, 600)
  await expect.poll(() => workspace.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  await source.scrollIntoViewIfNeeded()
  expect((await visibleArea(source)).height).toBeGreaterThan(60)
  const updated = body + '\nSkill short-window edit.\n'
  await source.fill(updated)
  await page.getByTestId('markdown-mode-preview').click()
  const preview = page.getByRole('region', { name: 'Preview' })
  await preview.scrollIntoViewIfNeeded()
  expect((await visibleArea(preview)).height).toBeGreaterThan(60)
  const technical = workspace.locator('.skill-detail__technical summary')
  await technical.scrollIntoViewIfNeeded()
  expect((await visibleArea(technical)).height).toBeGreaterThan(10)
  await technical.click()
  await expect(workspace.locator('.skill-detail__technical')).toHaveAttribute('open', '')
  await page.getByTestId('markdown-mode-edit').click()
  await expect(source).toHaveValue(updated)
  await page.getByTestId('skill-save-button').click()
  await expect
    .poll(async () => (await api<{ bodyMd: string }>(`/api/skills/${skill.id}/content`)).bodyMd)
    .toBe(updated)
  await expect(page.getByTestId('skill-save-button')).toBeDisabled()

  await page.setViewportSize({ width: 1600, height: 960 })
  await page.getByTestId('markdown-mode-split').click()
  await expect(page.getByTestId('markdown-editor')).toHaveAttribute('data-mode', 'split')
  await assertNoCrowding(page, true)
  await page.reload()
  await expect(source).toHaveValue(updated)
  await expect(page.getByTestId('markdown-editor')).toHaveAttribute('data-mode', 'split')
})

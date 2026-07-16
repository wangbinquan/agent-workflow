// RFC-194 — end-to-end locks for the Agent port-card/Dialog editor.
//
// This spec intentionally drives the real embedded frontend against a fresh
// daemon.  It covers the contracts that unit DOM tests cannot prove reliably:
// focus hand-off across React list updates, nested portaled Select Escape,
// axe against the browser DOM, and true 390px layout measurements.

import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Locator, type Page } from '@playwright/test'

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
      try {
        window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
        window.localStorage.setItem('agent-workflow.token', token)
        window.localStorage.setItem('aw-language', 'en-US')
      } catch {
        /* ignore */
      }
    },
    { baseUrl: daemon.baseUrl, token: daemon.token },
  )
}

async function openNewAgentPorts(page: Page): Promise<Locator> {
  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/agents/new`)
  const portsTab = page.getByTestId('agent-tab-ports')
  await expect(portsTab).toBeVisible()
  await portsTab.click()
  const panel = page.getByTestId('agent-panel-ports')
  await expect(panel).toBeVisible()
  return panel
}

async function chooseOption(page: Page, trigger: Locator, name: RegExp): Promise<void> {
  await trigger.click()
  const listbox = page.getByRole('listbox')
  await expect(listbox).toBeVisible()
  await listbox.getByRole('option', { name }).click()
  await expect(listbox).toHaveCount(0)
}

async function fillInputDialog(page: Page, values: { name: string; description?: string }) {
  const dialog = page.getByTestId('agent-input-port-dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByTestId('agent-input-port-name').fill(values.name)
  if (values.description !== undefined) {
    await dialog.getByTestId('agent-input-port-description').fill(values.description)
  }
  return dialog
}

async function configureListMarkdownPathOutput(page: Page, name: string): Promise<Locator> {
  const dialog = page.getByTestId('agent-output-port-dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByTestId('agent-output-port-name').fill(name)

  const baseKind = dialog.getByRole('combobox').first()
  await chooseOption(page, baseKind, /file path/i)

  const extension = dialog.getByRole('combobox', { name: /file extension/i })
  await chooseOption(page, extension, /Markdown \(\.md\)/i)

  const list = dialog.getByRole('checkbox', { name: /list/i })
  await list.check()
  await expect(list).toBeChecked()
  return dialog
}

async function expectNoBlockingAxeViolations(page: Page, selector: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .include(selector)
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

test.describe('RFC-194 Agent port editor', () => {
  test('input add/edit/delete keeps transactional data and deterministic focus hand-off', async ({
    page,
  }) => {
    const panel = await openNewAgentPorts(page)
    const add = panel.getByTestId('agent-input-port-add')
    await add.click()

    const dialog = page.getByTestId('agent-input-port-dialog')
    const name = dialog.getByTestId('agent-input-port-name')
    await expect(name).toBeFocused()
    await name.fill('request')
    await dialog.getByTestId('agent-input-port-description').fill('  Original request  ')
    await dialog.getByRole('checkbox', { name: 'Required input' }).check()
    await chooseOption(page, dialog.getByRole('combobox').first(), /^markdown/i)
    await dialog.getByTestId('agent-input-port-save').click()

    const firstCard = panel.getByTestId('agent-port-card-input-0')
    await expect(firstCard).toContainText('request')
    await expect(firstCard).toContainText('Original request')
    await expect(firstCard).toContainText('required')
    await expect(firstCard).toContainText('markdown')
    const firstEdit = firstCard.getByRole('button', { name: /Edit input port request/i })
    await expect(firstEdit).toBeFocused()

    // Add a neighbour so deleting index 0 must focus the card that shifts into
    // its place, not a stale node keyed by the old port name.
    await add.click()
    const secondDialog = await fillInputDialog(page, { name: 'context' })
    await secondDialog.getByTestId('agent-input-port-save').click()
    const secondEdit = panel
      .getByTestId('agent-port-card-input-1')
      .getByRole('button', { name: /Edit input port context/i })
    await expect(secondEdit).toBeFocused()

    // Reopen the first card and rename it. The same index's new Edit action is
    // the post-commit focus target.
    await firstEdit.click()
    await expect(name).toBeFocused()
    await name.fill('user_request')
    await dialog.getByTestId('agent-input-port-save').click()
    await expect(firstCard).toContainText('user_request')
    const renamedEdit = firstCard.getByRole('button', {
      name: /Edit input port user_request/i,
    })
    await expect(renamedEdit).toBeFocused()

    const deleteRenamed = firstCard.getByRole('button', {
      name: /Delete input port user_request/i,
    })
    await deleteRenamed.click()
    await firstCard
      .getByRole('button', { name: /Confirm deletion of input port user_request/i })
      .click()

    const remainingCard = panel.getByTestId('agent-port-card-input-0')
    await expect(remainingCard).toContainText('context')
    const remainingEdit = remainingCard.getByRole('button', {
      name: /Edit input port context/i,
    })
    await expect(remainingEdit).toBeFocused()

    const deleteRemaining = remainingCard.getByRole('button', {
      name: /Delete input port context/i,
    })
    await deleteRemaining.click()
    await remainingCard
      .getByRole('button', { name: /Confirm deletion of input port context/i })
      .click()
    await expect(panel.getByTestId('agent-input-ports-empty')).toBeVisible()
    await expect(add).toBeFocused()
  })

  test('output path+md+list selection consumes the first Escape; the second closes and restores focus', async ({
    page,
  }) => {
    const panel = await openNewAgentPorts(page)
    const add = panel.getByTestId('agent-output-port-add')
    await add.click()

    const dialog = await configureListMarkdownPathOutput(page, 'documents')
    const extension = dialog.getByRole('combobox', { name: /file extension/i })
    await extension.click()
    const listbox = page.getByRole('listbox')
    await expect(listbox).toBeVisible()
    // Select moves focus on a zero-delay timer after the portal mounts. Wait
    // for that hand-off so Escape is consumed by the listbox instead of racing
    // the parent Dialog's global Escape listener on slower macOS runners.
    await expect(listbox).toBeFocused()

    await page.keyboard.press('Escape')
    await expect(page.getByRole('listbox')).toHaveCount(0)
    await expect(dialog).toBeVisible()
    await expect(extension).toBeFocused()

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(add).toBeFocused()
    await expect(panel.getByTestId('agent-output-ports-empty')).toBeVisible()

    // Reopen after the cancelled transaction, save the same compound kind,
    // then reopen Edit and rename without losing the kind sidecar.
    await add.click()
    const reopened = await configureListMarkdownPathOutput(page, 'documents')
    await reopened.getByTestId('agent-output-port-save').click()

    const card = panel.getByTestId('agent-port-card-output-0')
    await expect(card).toContainText('documents')
    await expect(card).toContainText('list<path<md>>')
    const edit = card.getByRole('button', { name: /Edit output port documents/i })
    await expect(edit).toBeFocused()
    await edit.click()

    const editDialog = page.getByTestId('agent-output-port-dialog')
    const editName = editDialog.getByTestId('agent-output-port-name')
    await expect(editName).toBeFocused()
    await editName.fill('document_bundle')
    await editDialog.getByTestId('agent-output-port-save').click()

    await expect(card).toContainText('document_bundle')
    await expect(card).toContainText('list<path<md>>')
    await expect(
      card.getByRole('button', { name: /Edit output port document_bundle/i }),
    ).toBeFocused()
  })

  test('Ports panel and open port Dialog have no critical or serious axe violations', async ({
    page,
  }) => {
    const panel = await openNewAgentPorts(page)
    await expectNoBlockingAxeViolations(page, '[data-testid="agent-panel-ports"]')

    await panel.getByTestId('agent-input-port-add').click()
    await expect(page.getByTestId('agent-input-port-dialog')).toBeVisible()
    await expectNoBlockingAxeViolations(page, '[data-testid="agent-input-port-dialog"]')
  })

  test('390px pressure state keeps 2 inputs, 2 outputs, and every action inside the viewport', async ({
    page,
  }) => {
    const agentName = 'e2e-port-pressure'
    const seed = await fetch(`${daemon.baseUrl}/api/agents`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${daemon.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: agentName,
        description: 'RFC-194 narrow viewport fixture',
        inputs: [
          {
            name: 'requirement_context',
            kind: 'string',
            required: true,
            description: 'A deliberately long requirement description for the narrow card.',
          },
          {
            name: 'source_documents',
            kind: 'list<path<md>>',
            description: 'Markdown sources that the agent must inspect before producing output.',
          },
        ],
        outputs: ['generated_markdown_bundle', 'artifact_paths'],
        outputKinds: {
          generated_markdown_bundle: 'path<md>',
          artifact_paths: 'list<path<*>>',
        },
        syncOutputsOnIterate: true,
        permission: {},
        skills: [],
        dependsOn: [],
        mcp: [],
        plugins: [],
        frontmatterExtra: {},
        bodyMd: '',
      }),
    })
    if (!seed.ok) {
      throw new Error(`seed agent failed: ${seed.status} ${await seed.text()}`)
    }

    await page.setViewportSize({ width: 390, height: 844 })
    await primeAuth(page)
    await page.goto(`${daemon.baseUrl}/agents/${agentName}`)
    await expect(page.getByRole('heading', { name: agentName, exact: true })).toBeVisible()
    await page.getByTestId('agent-tab-ports').click()
    const panel = page.getByTestId('agent-panel-ports')
    await expect(panel).toBeVisible()
    await expect(panel.locator('.agent-port-card')).toHaveCount(4)

    const fit = await panel.evaluate((root) => {
      const checked = [
        root,
        ...root.querySelectorAll<HTMLElement>('.form-section, .agent-port-list, .agent-port-card'),
      ]
      return {
        documentFits:
          document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
        panelFits: root.scrollWidth <= root.clientWidth + 1,
        overflowing: checked
          .filter((element) => element.scrollWidth > element.clientWidth + 1)
          .map((element) => ({
            className: element.className,
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth,
          })),
      }
    })
    expect(fit).toEqual({ documentFits: true, panelFits: true, overflowing: [] })

    const actions = panel.locator('.agent-port-section__add, .agent-port-card .card__footer button')
    expect(await actions.count()).toBeGreaterThanOrEqual(10)
    for (let index = 0; index < (await actions.count()); index += 1) {
      const action = actions.nth(index)
      await action.scrollIntoViewIfNeeded()
      await expect(action).toBeVisible()
      await expect(action).toBeInViewport()
      const box = await action.boundingBox()
      expect(box, `action ${index} must have a measurable box`).not.toBeNull()
      if (box !== null) {
        expect(box.x, `action ${index} left edge`).toBeGreaterThanOrEqual(-0.5)
        expect(box.x + box.width, `action ${index} right edge`).toBeLessThanOrEqual(390.5)
      }
    }
  })
})

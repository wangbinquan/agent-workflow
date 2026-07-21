// Regression lock — 2026-07-21 insecure-context incident.
//
// A single-binary deployment reached over plain http://<LAN-IP>:<port> is not
// a secure context, so the browser exposes NO SubtleCrypto there. Before the
// fix, the editor hashed every snapshot through a bare `.digest(...)`
// dereference: each autosave threw before its PUT was issued, so new nodes
// vanished on reload, Validate / Launch hung forever on their ensureSaved
// barrier, and every reload warned about unsaved changes. Playwright can't
// make 127.0.0.1 insecure, so this spec removes the exact API surface that
// deployment loses — `window.crypto.subtle` — before any page script runs,
// then walks the reported symptoms end-to-end against the real daemon: the
// pure-JS fallback hash must also AGREE with the server's recomputed
// snapshot hash, or the save receipt would not come back clean.
// Unit-level sibling: packages/frontend/tests/workflow-hash-insecure-context.test.ts.

import { test, expect, type Page } from '@playwright/test'

import { startDaemon, type DaemonHandle } from './harness'

let daemon: DaemonHandle

test.setTimeout(120_000)

test.beforeAll(async () => {
  daemon = await startDaemon()
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

async function primeInsecureContext(page: Page): Promise<void> {
  // Shadow the [SecureContext]-gated accessor exactly as a plain-http origin
  // experiences it; everything else (getRandomValues, WebSocket, …) stays.
  await page.addInitScript(() => {
    Object.defineProperty(window.crypto, 'subtle', {
      get: () => undefined,
      configurable: true,
    })
  })
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

async function seedWorkflow(name: string): Promise<string> {
  const response = await fetch(`${daemon.baseUrl}/api/workflows`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name,
      description: 'insecure-context regression fixture',
      definition: {
        $schema_version: 3,
        inputs: [],
        nodes: [],
        edges: [],
      },
    }),
  })
  if (!response.ok) throw new Error(`seedWorkflow ${name}: ${response.status}`)
  return ((await response.json()) as { id: string }).id
}

async function readWorkflowName(workflowId: string): Promise<string> {
  const response = await fetch(
    `${daemon.baseUrl}/api/workflows/${encodeURIComponent(workflowId)}`,
    { headers: { Authorization: `Bearer ${daemon.token}` } },
  )
  if (!response.ok) throw new Error(`readWorkflowName ${workflowId}: ${response.status}`)
  return ((await response.json()) as { name: string }).name
}

async function renameDraft(page: Page, name: string): Promise<void> {
  await page.getByTestId('workflow-more-actions').click()
  const actionsDialog = page.getByTestId('workflow-actions-dialog')
  await expect(actionsDialog).toBeVisible()
  await actionsDialog.getByTestId('workflow-rename-button').click()
  await expect(page.getByTestId('workflow-rename-dialog')).toBeVisible()
  await page.getByTestId('workflow-rename-name').fill(name)
  await page.getByTestId('workflow-rename-confirm').click()
  await expect(page.getByTestId('workflow-rename-dialog')).toBeHidden()
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()
}

test('editor saves nodes, survives reload, and Validate completes without SubtleCrypto', async ({
  page,
}) => {
  const initialName = 'insecure-ctx-editor'
  const renamedName = 'insecure-ctx-editor-renamed'
  const workflowId = await seedWorkflow(initialName)

  await primeInsecureContext(page)
  await page.goto(`${daemon.baseUrl}/workflows/${encodeURIComponent(workflowId)}`)
  await expect(page.getByRole('heading', { level: 1, name: initialName })).toBeVisible()
  await expect(page.getByTestId('workflow-draft-phase')).toHaveText('Saved')

  // Prove the simulation is live — otherwise this spec silently tests nothing.
  expect(await page.evaluate(() => window.crypto.subtle === undefined)).toBe(true)

  // Symptom 1 — "cannot create nodes": add one through the picker and require
  // the autosave to land (draft phase returns to Saved, not stuck dirty).
  await page.getByTestId('workflow-add-step').click()
  const palette = page.getByTestId('workflow-editor-palette-surface')
  await palette.getByTestId('workflow-node-picker-item-kind-input').first().click()
  await expect(page.locator('.react-flow__node')).toHaveCount(1)
  await expect(page.getByTestId('workflow-draft-phase')).toHaveText('Saved')

  // The rename exercises the same PUT path with a distinct, queryable marker:
  // the server accepted a snapshot whose hash was computed by the JS fallback.
  await renameDraft(page, renamedName)
  await expect(page.getByTestId('workflow-draft-phase')).toHaveText('Saved')
  await expect.poll(() => readWorkflowName(workflowId)).toBe(renamedName)

  // Symptom 3 — "reload warns about unsaved changes / nodes vanish": after a
  // clean save there is nothing to lose, and the node must still be there.
  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: renamedName })).toBeVisible()
  await expect(page.getByTestId('workflow-draft-phase')).toHaveText('Saved')
  await expect(page.locator('.react-flow__node')).toHaveCount(1)

  // Symptom 2 — "Validate hangs forever": the ensureSaved barrier must settle
  // and produce a receipt (the empty-ish workflow yields issues, not a hang).
  await page.getByRole('button', { name: 'Validate', exact: true }).click()
  await expect(page.getByTestId('workflow-validation-summary')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Validate', exact: true })).toBeEnabled()
})

// RFC-242 PR-5 — call-workflow node authoring against a real daemon.
//
// Scope note (deliberate, per the PR-5 plan): this spec covers the EDITOR
// seam only — the palette's new Calls section, interactive creation of a
// call-workflow node, Inspector child-workflow selection with the child-port
// preview, real autosave persistence, and an error-free validation badge.
// It does NOT run a parent→child task execution chain: the full
// D→L→W→F→M runtime path is locked by the backend integration suites
// (rfc242-call-workflow.test.ts and friends) with the stub runtime, and a
// browser re-run would only re-prove them at much higher cost.
//
// The seeded CHILD workflow has zero inputs on purpose: a call node whose
// child declares inputs requires inbound edges (`call-workflow-input-unwired`),
// and connecting edges via synthetic xyflow handle drags is the one gesture
// this suite cannot drive reliably (see workflow-editor.spec.ts header).

import { expect, test, type Page } from '@playwright/test'

import { startDaemon, type DaemonHandle } from './harness'

let daemon: DaemonHandle
let parentWorkflowId: string

const CHILD_WORKFLOW_NAME = 'rfc242-child-wf'

test.setTimeout(60_000)

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

async function seedWorkflow(name: string): Promise<string> {
  const res = await fetch(`${daemon.baseUrl}/api/workflows`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name,
      description: 'RFC-242 PR-5 e2e fixture',
      definition: { $schema_version: 4, inputs: [], nodes: [], edges: [] },
    }),
  })
  if (!res.ok) throw new Error(`seedWorkflow ${name}: ${res.status} ${await res.text()}`)
  return ((await res.json()) as { id: string }).id
}

test.beforeAll(async () => {
  daemon = await startDaemon()
  await seedWorkflow(CHILD_WORKFLOW_NAME)
  parentWorkflowId = await seedWorkflow('rfc242-parent-wf')
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

test('palette Calls section creates a call-workflow node that selects a child and saves clean', async ({
  page,
}) => {
  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/workflows/${parentWorkflowId}`)
  await expect(page.locator('.workflow-canvas')).toBeVisible()
  await expect(page.locator('.react-flow__node')).toHaveCount(0)

  // Empty-state entry → the canvas-owned node picker. The Calls category
  // (RFC-242) must be present alongside the RFC-219 sections, and it carries
  // the generic call-workflow entry.
  await page.getByTestId('workflow-empty-add-first').click()
  const picker = page.getByTestId('workflow-node-picker-dialog')
  await expect(picker).toBeVisible()
  await expect(picker.getByRole('tab', { name: /Calls/ })).toBeVisible()
  await picker.getByTestId('workflow-node-picker-item-kind-call-workflow').first().click()

  // One node inserted + selected; the desktop Inspector drawer opens on it
  // (the `workflow-editor-inspector-surface` Dialog is the COMPACT-viewport
  // surface only — at the canonical 1280×800 the drawer renders inline, so
  // anchor on the call-workflow reference Select instead).
  await expect(page.locator('.react-flow__node')).toHaveCount(1)
  const refSelect = page.getByTestId('call-workflow-ref-select')
  await expect(refSelect).toBeVisible()

  // Pick the child workflow through the shared Select; the read-only child
  // port preview replaces the "no reference" placeholder (empty child ⇒ the
  // preview lists no ports but must resolve — not the neutral
  // "not visible / does not exist" degrade).
  //
  // Save observability: RFC-199 autosave debounces 1s, so the node INSERT and
  // the reference edit may coalesce into a single PUT (one version bump) or
  // land as two — the deterministic signal is the first successful PUT whose
  // payload carries the child reference, armed BEFORE the option click.
  const savedWithRef = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/workflows/${parentWorkflowId}`) &&
      response.request().method() === 'PUT' &&
      response.ok() &&
      (response.request().postData() ?? '').includes(CHILD_WORKFLOW_NAME),
  )
  await refSelect.click()
  await page.getByRole('option', { name: new RegExp(CHILD_WORKFLOW_NAME) }).click()
  await expect(page.getByTestId('call-workflow-ports-preview')).toBeVisible()
  await expect(page.getByTestId('call-workflow-ref-unavailable')).toHaveCount(0)

  // RFC-199 autosave persists the mutation without a manual Save action.
  await savedWithRef
  await expect(page.getByTestId('workflow-draft-phase')).toHaveText('Saved')

  // Real persistence: a fresh load re-hydrates the call node (titled by its
  // child reference) from the daemon.
  await page.reload()
  await expect(page.locator('.workflow-canvas')).toBeVisible()
  await expect(page.locator('.react-flow__node')).toHaveCount(1)
  await expect(page.locator('.react-flow__node').first()).toContainText(CHILD_WORKFLOW_NAME)

  // "Validation badge shows no error": the ValidationPanel badge only mounts
  // after an exact validation run, and the Launch gate IS that run
  // (ensureSaved → POST /validate → navigate only when zero blocking errors;
  // errors keep us on the editor with the "N validation issue(s)" summary).
  // Reaching the launch route therefore asserts an error-free validation of
  // the saved call-workflow definition.
  await page.getByRole('button', { name: 'Launch task', exact: true }).click()
  // /workflows/:id/launch immediately forwards to the task wizard carrying
  // the validated workflow + saved version.
  await expect(page).toHaveURL(
    new RegExp(`/tasks/new\\?kind=workflow&workflow=${parentWorkflowId}`),
  )
  await expect(page.getByTestId('workflow-validation-summary')).toHaveCount(0)
})

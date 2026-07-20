// RFC-199 G1 — real-browser workflow draft reliability under weak networks.
//
// These tests deliberately intercept the production PUT/GET endpoints in
// Chromium. They lock the user-visible contract that a save receipt only
// acknowledges the snapshot it actually carried, and that an uncertain save
// is reconciled by exact version/hash before a queued edit is sent.

import { test, expect, type Page, type Route } from '@playwright/test'
import type { SaveWorkflowReceipt, WorkflowDetail } from '@agent-workflow/shared'
import { randomBytes } from 'node:crypto'

import { startDaemon, type DaemonHandle } from './harness'

let daemon: DaemonHandle

test.setTimeout(120_000)

test.beforeAll(async () => {
  daemon = await startDaemon()
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

interface SaveRequestProbe {
  clientMutationId: string
  snapshot: { name: string }
}

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function workflowMutationId(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let value = BigInt(`0x${randomBytes(16).toString('hex')}`)
  let encoded = ''
  for (let index = 0; index < 26; index += 1) {
    encoded = alphabet[Number(value & 31n)]! + encoded
    value >>= 5n
  }
  return encoded
}

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
  const response = await fetch(`${daemon.baseUrl}/api/workflows`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name,
      description: 'RFC-199 G1 network reliability fixture',
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

async function readWorkflow(workflowId: string): Promise<WorkflowDetail> {
  const response = await fetch(
    `${daemon.baseUrl}/api/workflows/${encodeURIComponent(workflowId)}`,
    { headers: { Authorization: `Bearer ${daemon.token}` } },
  )
  if (!response.ok) throw new Error(`readWorkflow ${workflowId}: ${response.status}`)
  return (await response.json()) as WorkflowDetail
}

async function renameWorkflowOnServer(
  workflowId: string,
  name: string,
): Promise<SaveWorkflowReceipt> {
  const current = await readWorkflow(workflowId)
  const response = await fetch(
    `${daemon.baseUrl}/api/workflows/${encodeURIComponent(workflowId)}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${daemon.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        expectedVersion: current.version,
        clientMutationId: workflowMutationId(),
        snapshot: {
          name,
          description: current.description,
          definition: current.definition,
        },
      }),
    },
  )
  if (!response.ok) throw new Error(`renameWorkflowOnServer ${workflowId}: ${response.status}`)
  return (await response.json()) as SaveWorkflowReceipt
}

async function openEditor(page: Page, workflowId: string, expectedName: string): Promise<void> {
  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/workflows/${encodeURIComponent(workflowId)}`)
  await expect(page.getByRole('heading', { level: 1, name: expectedName })).toBeVisible()
  await expect(page.getByTestId('workflow-draft-phase')).toHaveText('Saved')
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

function readSaveRequest(route: Route): SaveRequestProbe {
  return route.request().postDataJSON() as SaveRequestProbe
}

test.describe('RFC-199 G1 — weak-network save reliability', () => {
  test('editing while a PUT is in flight saves the queued revision and survives reload', async ({
    page,
  }) => {
    const initialName = 'rfc199-delayed-save-base'
    const firstName = 'rfc199-delayed-save-first'
    const latestName = 'rfc199-delayed-save-latest'
    const workflowId = await seedWorkflow(initialName)
    await openEditor(page, workflowId, initialName)

    const endpoint = `${daemon.baseUrl}/api/workflows/${encodeURIComponent(workflowId)}`
    const firstSaveSeen = deferred<void>()
    const releaseFirstSave = deferred<void>()
    const savedNames: string[] = []

    await page.route(endpoint, async (route) => {
      if (route.request().method() !== 'PUT') {
        await route.continue()
        return
      }
      const request = readSaveRequest(route)
      savedNames.push(request.snapshot.name)
      if (savedNames.length === 1) {
        firstSaveSeen.resolve()
        await releaseFirstSave.promise
      }
      await route.continue()
    })

    await renameDraft(page, firstName)
    await firstSaveSeen.promise
    await expect(page.getByTestId('workflow-draft-phase')).toHaveText('Saving')

    // The second edit happens while the first request is still held at the
    // browser boundary. Releasing the old request must not mark this draft clean.
    await renameDraft(page, latestName)
    releaseFirstSave.resolve()

    await expect(page.getByTestId('workflow-draft-phase')).toHaveText('Saved')
    await expect.poll(() => savedNames).toEqual([firstName, latestName])
    await expect.poll(async () => (await readWorkflow(workflowId)).name).toBe(latestName)

    await page.reload()
    await expect(page.getByRole('heading', { level: 1, name: latestName })).toBeVisible()
    await expect(page.getByTestId('workflow-draft-phase')).toHaveText('Saved')
  })

  test('response loss plus offline reconcile preserves the attempt and sends queued work after exact convergence', async ({
    page,
  }) => {
    const initialName = 'rfc199-response-loss-base'
    const committedName = 'rfc199-response-loss-committed'
    const queuedName = 'rfc199-response-loss-queued'
    const workflowId = await seedWorkflow(initialName)
    let droppedEchoMutationId: string | null = null

    // This case specifically covers HTTP reconciliation after a lost response.
    // Drop the matching own WS echo so it cannot legitimately settle the exact
    // attempt before the controller exercises that branch.
    await page.routeWebSocket(/\/ws\/workflows(?:\?.*)?$/, (browserSocket) => {
      const serverSocket = browserSocket.connectToServer()
      serverSocket.onMessage((message) => {
        try {
          const frame = JSON.parse(
            typeof message === 'string' ? message : message.toString('utf8'),
          ) as {
            type?: string
            workflowId?: string
            clientMutationId?: string
          }
          if (
            frame.type === 'workflow.updated' &&
            frame.workflowId === workflowId &&
            frame.clientMutationId === droppedEchoMutationId
          ) {
            return
          }
        } catch {
          // Non-JSON frames still pass through unchanged.
        }
        browserSocket.send(message)
      })
    })
    await openEditor(page, workflowId, initialName)

    const endpoint = `${daemon.baseUrl}/api/workflows/${encodeURIComponent(workflowId)}`
    const firstCommitReachedServer = deferred<void>()
    const savedNames: string[] = []
    let dropFirstResponse = true
    let failReconcileReads = false
    let failedReadCount = 0

    await page.route(endpoint, async (route) => {
      const method = route.request().method()
      if (method === 'PUT') {
        const request = readSaveRequest(route)
        savedNames.push(request.snapshot.name)
        if (dropFirstResponse) {
          dropFirstResponse = false
          droppedEchoMutationId = request.clientMutationId
          // Commit over an independent Node-side connection, then abort the
          // browser request. Reusing route.fetch() lets WebKit race delivery of
          // that successful response against route.abort().
          const response = await fetch(endpoint, {
            method: 'PUT',
            headers: {
              Authorization: `Bearer ${daemon.token}`,
              'Content-Type': 'application/json',
            },
            body: route.request().postData() ?? undefined,
          })
          expect(response.ok).toBe(true)
          failReconcileReads = true
          await route.abort('failed')
          firstCommitReachedServer.resolve()
          return
        }
      } else if (method === 'GET' && failReconcileReads) {
        failedReadCount += 1
        await route.abort('failed')
        return
      }
      await route.continue()
    })

    await renameDraft(page, committedName)
    await firstCommitReachedServer.promise
    await expect.poll(async () => (await readWorkflow(workflowId)).name).toBe(committedName)
    await expect(page.getByTestId('workflow-draft-phase')).toHaveText('Checking save result')
    await expect(page.getByTestId('workflow-draft-transport')).toHaveText('Offline')
    expect(failedReadCount).toBeGreaterThan(0)

    // This edit is local-only while the controller still owns the uncertain
    // first attempt. Recovery must reconcile that exact attempt before B is sent.
    await renameDraft(page, queuedName)
    expect((await readWorkflow(workflowId)).name).toBe(committedName)

    failReconcileReads = false
    await page.getByRole('button', { name: 'Retry now' }).first().click()

    await expect(page.getByTestId('workflow-draft-phase')).toHaveText('Saved')
    await expect(page.getByTestId('workflow-draft-transport')).toHaveText('Online')
    await expect.poll(() => savedNames).toEqual([committedName, queuedName])
    await expect.poll(async () => (await readWorkflow(workflowId)).name).toBe(queuedName)

    const final = await readWorkflow(workflowId)
    expect(final.version).toBe(3)
    expect(final.snapshotHash).toMatch(/^[0-9a-f]{64}$/)
    await page.reload()
    await expect(page.getByRole('heading', { level: 1, name: queuedName })).toBeVisible()
    await expect(page.getByTestId('workflow-draft-phase')).toHaveText('Saved')
  })

  test('offline before the PUT reaches the server retries the same attempt before queued work', async ({
    page,
  }) => {
    const initialName = 'rfc199-request-offline-base'
    const attemptedName = 'rfc199-request-offline-attempted'
    const queuedName = 'rfc199-request-offline-queued'
    const workflowId = await seedWorkflow(initialName)
    await openEditor(page, workflowId, initialName)

    const endpoint = `${daemon.baseUrl}/api/workflows/${encodeURIComponent(workflowId)}`
    const firstRequestBlocked = deferred<void>()
    const savedRequests: SaveRequestProbe[] = []
    let blockFirstRequest = true
    let failReconcileReads = false

    await page.route(endpoint, async (route) => {
      const method = route.request().method()
      if (method === 'PUT') {
        const request = readSaveRequest(route)
        savedRequests.push(request)
        if (blockFirstRequest) {
          blockFirstRequest = false
          failReconcileReads = true
          firstRequestBlocked.resolve()
          await route.abort('failed')
          return
        }
      } else if (method === 'GET' && failReconcileReads) {
        await route.abort('failed')
        return
      }
      await route.continue()
    })

    await renameDraft(page, attemptedName)
    await firstRequestBlocked.promise
    await expect(page.getByTestId('workflow-draft-phase')).toHaveText('Checking save result')
    await expect(page.getByTestId('workflow-draft-transport')).toHaveText('Offline')
    expect((await readWorkflow(workflowId)).name).toBe(initialName)

    await renameDraft(page, queuedName)
    failReconcileReads = false
    await page.getByRole('button', { name: 'Retry now' }).first().click()

    await expect(page.getByTestId('workflow-draft-phase')).toHaveText('Saved')
    await expect
      .poll(() => savedRequests.map((request) => request.snapshot.name))
      .toEqual([attemptedName, attemptedName, queuedName])
    expect(savedRequests[1]?.clientMutationId).toBe(savedRequests[0]?.clientMutationId)
    await expect.poll(async () => (await readWorkflow(workflowId)).name).toBe(queuedName)

    await page.reload()
    await expect(page.getByRole('heading', { level: 1, name: queuedName })).toBeVisible()
    await expect(page.getByTestId('workflow-draft-phase')).toHaveText('Saved')
  })

  test('editor exact revision handoff shows a wizard mismatch before any stale launch', async ({
    page,
  }) => {
    const initialName = 'rfc199-editor-wizard-v1'
    const workflowId = await seedWorkflow(initialName)
    await openEditor(page, workflowId, initialName)

    const endpoint = `${daemon.baseUrl}/api/workflows/${encodeURIComponent(workflowId)}`
    const wizardDetailSeen = deferred<void>()
    const releaseWizardDetail = deferred<void>()
    let armed = false
    let held = false
    await page.route(endpoint, async (route) => {
      if (armed && !held && route.request().method() === 'GET') {
        held = true
        wizardDetailSeen.resolve()
        await releaseWizardDetail.promise
      }
      await route.continue()
    })

    try {
      armed = true
      await page.getByRole('button', { name: /Launch task/ }).click()
      await wizardDetailSeen.promise
      const updated = await renameWorkflowOnServer(workflowId, 'rfc199-editor-wizard-v2')
      expect(updated.revision.version).toBe(2)
      releaseWizardDetail.resolve()

      await expect(page).toHaveURL(/\/tasks\/new\?.*workflowVersion=1/)
      await expect(page.getByTestId('wizard-workflow-version-mismatch')).toBeVisible()
      await expect(page.getByTestId('wizard-workflow-version-mismatch')).toContainText('v1')
      await expect(page.getByTestId('wizard-workflow-version-mismatch')).toContainText('v2')
      await expect(page.getByTestId('wizard-workflow-version-recover')).toHaveText(
        'Return to editor and validate',
      )
    } finally {
      releaseWizardDetail.resolve()
    }
  })

  test('two tabs converge to an explicit conflict without overwriting either draft', async ({
    page,
  }) => {
    const initialName = 'rfc199-two-tab-base'
    const localName = 'rfc199-two-tab-local'
    const remoteName = 'rfc199-two-tab-remote'
    const workflowId = await seedWorkflow(initialName)
    const second = await page.context().newPage()
    await openEditor(page, workflowId, initialName)
    await openEditor(second, workflowId, initialName)

    const endpoint = `${daemon.baseUrl}/api/workflows/${encodeURIComponent(workflowId)}`
    const localSaveSeen = deferred<void>()
    const releaseLocalSave = deferred<void>()
    let held = false
    await page.route(endpoint, async (route) => {
      if (route.request().method() !== 'PUT' || held) {
        await route.continue()
        return
      }
      held = true
      localSaveSeen.resolve()
      await releaseLocalSave.promise
      await route.continue()
    })

    try {
      await renameDraft(page, localName)
      await localSaveSeen.promise
      await renameDraft(second, remoteName)
      await expect(second.getByTestId('workflow-draft-phase')).toHaveText('Saved')
      await expect.poll(async () => (await readWorkflow(workflowId)).name).toBe(remoteName)

      releaseLocalSave.resolve()
      await expect(page.getByTestId('workflow-draft-phase')).toHaveText('Version conflict')
      await expect(page.getByRole('heading', { level: 1, name: localName })).toBeVisible()
      expect((await readWorkflow(workflowId)).name).toBe(remoteName)
    } finally {
      releaseLocalSave.resolve()
      await second.close()
    }
  })
})

// RFC-165 (§11.28/§11.29) — /tasks/new unified wizard e2e.
//
//   1. Single-agent + scratch space: wizard chain → task reaches `done`
//      (stub-opencode emits the fixed envelope) → the diff tab is reachable.
//   2. Workgroup + scratch space: wizard chain → the group task reaches a
//      terminal status (engine semantics are locked by backend tests; this
//      chain locks the wizard → engine wiring end-to-end).
//   3. Scheduled agent task (`?schedule=1`): save-as-scheduled becomes the
//      primary action; the saved schedule fires via run-now and produces a
//      task that terminates.
//
// The workflow-arm chain is covered by main.spec.ts (editor deep link +
// legacy-URL redirect), so it is not repeated here.

import { test, expect, type Page } from '@playwright/test'
import { startDaemon, type DaemonHandle } from './harness'

let daemon: DaemonHandle | undefined

test.beforeAll(async () => {
  daemon = await startDaemon()
})

test.afterAll(async () => {
  await daemon?.stop()
})

function authHeaders(d: DaemonHandle): Record<string, string> {
  return { Authorization: `Bearer ${d.token}`, 'Content-Type': 'application/json' }
}

function expectOk(res: Response, what: string): void {
  if (!res.ok) throw new Error(`${what} failed: HTTP ${res.status}`)
}

async function pollUntilTerminal(
  d: DaemonHandle,
  taskId: string,
  timeoutMs: number,
): Promise<{ status: string }> {
  const terminal = new Set(['done', 'failed', 'canceled', 'interrupted'])
  const deadline = Date.now() + timeoutMs
  let last: { status: string } = { status: 'pending' }
  while (Date.now() < deadline) {
    const res = await fetch(`${d.baseUrl}/api/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${d.token}` },
    })
    if (res.ok) {
      last = (await res.json()) as { status: string }
      if (terminal.has(last.status)) return last
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(
    `task ${taskId} did not reach terminal status in ${timeoutMs}ms; last=${last.status}`,
  )
}

async function primeAuthLocalStorage(page: Page, d: DaemonHandle): Promise<void> {
  await page.addInitScript(
    ({ baseUrl, token }) => {
      try {
        window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
        window.localStorage.setItem('agent-workflow.token', token)
        window.localStorage.setItem('aw-language', 'en-US')
      } catch {
        // ignore
      }
    },
    { baseUrl: d.baseUrl, token: d.token },
  )
}

async function createStubAgent(d: DaemonHandle, name: string): Promise<void> {
  const res = await fetch(`${d.baseUrl}/api/agents`, {
    method: 'POST',
    headers: authHeaders(d),
    body: JSON.stringify({
      name,
      description: 'rfc165 e2e stub agent',
      outputs: ['answer'],
      readonly: true,
      bodyMd: '',
    }),
  })
  expectOk(res, `create agent ${name}`)
}

test.describe('RFC-165 — /tasks/new wizard', () => {
  test('agent + scratch: wizard chain reaches done and the diff tab opens', async ({ page }) => {
    const d = daemon!
    await createStubAgent(d, 'wizard-scratch-agent')
    await primeAuthLocalStorage(page, d)

    // Deep link with the agent pre-picked lands on Step 2 (workspace).
    await page.goto(`${d.baseUrl}/tasks/new?kind=agent&agent=wizard-scratch-agent`)
    await expect(page.getByTestId('task-wizard')).toBeVisible({ timeout: 10_000 })
    await page.getByTestId('wizard-space-scratch').click()
    await page.getByTestId('stepper-next').click()

    // Step 3 — name + description (the prompt).
    await page.fill('[data-testid="wizard-task-name"]', 'wizard-agent-scratch')
    await page.fill('[data-testid="wizard-description"]', 'say hello into the envelope')
    await page.getByTestId('stepper-next').click()

    // Step 4 — confirm shows the picks; launch.
    await expect(page.getByTestId('wizard-summary-space')).toContainText(/scratch/i)
    await page.getByTestId('wizard-launch').click()
    await page.waitForURL(/\/tasks\/[A-Z0-9]{26}$/i, { timeout: 15_000 })
    const taskId = page.url().match(/\/tasks\/([A-Z0-9]{26})/i)![1]!

    const final = await pollUntilTerminal(d, taskId, 60_000)
    expect(final.status).toBe('done')

    // The diff tab is reachable (scratch delivery surface — empty diff is
    // fine, the stub writes no files).
    await page.locator('.task-detail__tab-bar [role="tab"]', { hasText: /Diff/i }).click()
  })

  test('workgroup + scratch: wizard chain reaches a terminal status', async ({ page }) => {
    const d = daemon!
    await createStubAgent(d, 'wizard-wg-member')
    const wgRes = await fetch(`${d.baseUrl}/api/workgroups`, {
      method: 'POST',
      headers: authHeaders(d),
      body: JSON.stringify({
        name: 'wizard-squad',
        description: '',
        instructions: '',
        mode: 'free_collab',
        maxRounds: 1,
        members: [{ memberType: 'agent', agentName: 'wizard-wg-member', displayName: 'Member' }],
      }),
    })
    expectOk(wgRes, 'create workgroup')

    await primeAuthLocalStorage(page, d)
    await page.goto(`${d.baseUrl}/tasks/new?kind=workgroup&workgroup=wizard-squad`)
    await expect(page.getByTestId('task-wizard')).toBeVisible({ timeout: 10_000 })
    await page.getByTestId('wizard-space-scratch').click()
    await page.getByTestId('stepper-next').click()

    await page.fill('[data-testid="wizard-task-name"]', 'wizard-wg-task')
    await page.fill('[data-testid="wizard-goal"]', 'coordinate one round and finish')
    await page.getByTestId('stepper-next').click()

    await page.getByTestId('wizard-launch').click()
    await page.waitForURL(/\/tasks\/[A-Z0-9]{26}$/i, { timeout: 15_000 })
    const taskId = page.url().match(/\/tasks\/([A-Z0-9]{26})/i)![1]!

    // Engine round semantics are locked by backend tests — here we only
    // require the wizard-launched group task to terminate.
    const final = await pollUntilTerminal(d, taskId, 90_000)
    expect(['done', 'failed']).toContain(final.status)
  })

  test('scheduled agent (?schedule=1): save-as-scheduled is primary; run-now fires a task', async ({
    page,
  }) => {
    const d = daemon!
    await createStubAgent(d, 'wizard-sched-agent')
    await primeAuthLocalStorage(page, d)

    await page.goto(`${d.baseUrl}/tasks/new?schedule=1&kind=agent&agent=wizard-sched-agent`)
    await expect(page.getByTestId('task-wizard')).toBeVisible({ timeout: 10_000 })
    await page.getByTestId('wizard-space-scratch').click()
    await page.getByTestId('stepper-next').click()

    await page.fill('[data-testid="wizard-task-name"]', 'wizard-sched-task')
    await page.fill('[data-testid="wizard-description"]', 'nightly stub poke')
    await page.getByTestId('stepper-next').click()

    // Primary action is save-as-scheduled in schedule mode.
    const saveBtn = page.getByTestId('wizard-save-scheduled')
    await expect(saveBtn).toHaveClass(/btn--primary/)
    await saveBtn.click()

    await page.fill('[data-testid="schedule-name"]', 'wizard nightly')
    await page.getByTestId('schedule-save').click()
    await page.waitForURL(/\/scheduled$/, { timeout: 10_000 })

    // The saved schedule carries the agent kind; run-now produces a task.
    const listRes = await fetch(`${d.baseUrl}/api/scheduled-tasks`, {
      headers: { Authorization: `Bearer ${d.token}` },
    })
    expectOk(listRes, 'list schedules')
    const rows = (await listRes.json()) as Array<{ id: string; name: string; launchKind: string }>
    const sched = rows.find((r) => r.name === 'wizard nightly')
    expect(sched).toBeDefined()
    expect(sched!.launchKind).toBe('agent')

    const runRes = await fetch(`${d.baseUrl}/api/scheduled-tasks/${sched!.id}/run-now`, {
      method: 'POST',
      headers: authHeaders(d),
    })
    expectOk(runRes, 'run-now')
    const run = (await runRes.json()) as { taskId: string }
    expect(run.taskId).toBeTruthy()

    const final = await pollUntilTerminal(d, run.taskId, 60_000)
    expect(final.status).toBe('done')
  })
})

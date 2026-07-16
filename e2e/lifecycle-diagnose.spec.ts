// RFC-053 PR-F — Playwright e2e for stuck-task banner + diagnose panel.
//
// Coverage:
//   1. Healthy task → no banner rendered on the detail page.
//   2. Plant a real R1 violation directly in SQLite (an approved
//      doc_version pointing at a node_run that is stuck in
//      'awaiting_review'). Re-render the detail page → the
//      <StuckTaskBanner> appears + the rule code is visible in the
//      details disclosure.
//   3. Clicking "Diagnose" opens <TaskDiagnosePanel> which POSTs
//      /api/tasks/:id/diagnose live → the panel table lists the R1 row
//      with severity='warning'.
//   4. "Re-scan" button issues a second POST; assert the request count
//      bumped + the panel still shows the violation.
//   5. Close the panel → returns to the task detail page; banner still
//      visible (alert remains open).
//
// The DB injection uses the `sqlite3` CLI against the daemon's
// db.sqlite file (Playwright's Node runtime can't import bun:sqlite).
// `sqlite3` is universally available on CI runners (apt installs by
// default on ubuntu, ships in macOS).

import { test, expect, type Page } from '@playwright/test'
import { execFileSync, execSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { startDaemon, type DaemonHandle } from './harness'

interface Fixtures {
  workflowId: string
  workflowName: string
  agentName: string
  repoPath: string
}

let daemon: DaemonHandle
let repoDir: string
let fixtures: Fixtures
let taskId: string

test.beforeAll(async () => {
  daemon = await startDaemon()

  repoDir = mkdtempSync(join(tmpdir(), 'aw-e2e-lifecycle-repo-'))
  writeFileSync(join(repoDir, 'README.md'), '# e2e lifecycle fixture\n', 'utf-8')
  execSync('git init -b main -q', { cwd: repoDir })
  execSync('git config user.email e2e@example.com', { cwd: repoDir })
  execSync('git config user.name e2e', { cwd: repoDir })
  execSync('git add .', { cwd: repoDir })
  execSync('git commit -qm initial', { cwd: repoDir })

  fixtures = await setupViaApi(daemon, repoDir)
  // Launch a task so the detail page has something to render.
  taskId = await launchTaskAndWaitForDone(daemon, fixtures)
})

test.afterAll(async () => {
  try {
    rmSync(repoDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  if (daemon !== undefined) await daemon.stop()
})

async function setupViaApi(d: DaemonHandle, repoPath: string): Promise<Fixtures> {
  const headers = {
    Authorization: `Bearer ${d.token}`,
    'Content-Type': 'application/json',
  }
  const agentName = 'e2e-lifecycle-stub'
  const a = await fetch(`${d.baseUrl}/api/agents`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: agentName,
      description: 'stub for lifecycle e2e',
      outputs: ['answer'],
      readonly: true,
      bodyMd: 'echo',
    }),
  })
  expectOk(a, 'create agent')
  const workflowName = 'e2e-lifecycle'
  const w = await fetch(`${d.baseUrl}/api/workflows`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: workflowName,
      description: 'lifecycle e2e',
      definition: {
        $schema_version: 1,
        inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
        nodes: [
          { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
          {
            id: 'agent_1',
            kind: 'agent-single',
            agentName,
            promptTemplate: 'Explain {{topic}}.',
            position: { x: 320, y: 0 },
          },
          {
            id: 'out_1',
            kind: 'output',
            ports: [{ name: 'answer', bind: { nodeId: 'agent_1', portName: 'answer' } }],
            position: { x: 640, y: 0 },
          },
        ],
        edges: [
          {
            id: 'e1',
            source: { nodeId: 'in_1', portName: 'topic' },
            target: { nodeId: 'agent_1', portName: 'topic' },
          },
          {
            id: 'e2',
            source: { nodeId: 'agent_1', portName: 'answer' },
            target: { nodeId: 'out_1', portName: 'answer' },
          },
        ],
      },
    }),
  })
  expectOk(w, 'create workflow')
  const workflow = (await w.json()) as { id: string }
  return { workflowId: workflow.id, workflowName, agentName, repoPath }
}

async function launchTaskAndWaitForDone(d: DaemonHandle, f: Fixtures): Promise<string> {
  const headers = {
    Authorization: `Bearer ${d.token}`,
    'Content-Type': 'application/json',
  }
  const res = await fetch(`${d.baseUrl}/api/tasks`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'lifecycle-e2e-task',
      workflowId: f.workflowId,
      repoUrl: pathToFileURL(f.repoPath).href,
      ref: 'main',
      inputs: { topic: 'state machines' },
    }),
  })
  expectOk(res, 'launch task')
  const task = (await res.json()) as { id: string }
  // Wait for terminal status so the page is stable.
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const r = await fetch(`${d.baseUrl}/api/tasks/${task.id}`, {
      headers: { Authorization: `Bearer ${d.token}` },
    })
    if (r.ok) {
      const t = (await r.json()) as { status: string }
      if (['done', 'failed', 'canceled', 'interrupted', 'exhausted'].includes(t.status)) {
        return task.id
      }
    }
    await sleep(500)
  }
  throw new Error(`task did not reach terminal in 60s`)
}

function expectOk(res: Response, what: string): void {
  if (!res.ok) throw new Error(`${what} failed: HTTP ${res.status}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function dbPath(): string {
  return join(daemon.home, 'db.sqlite')
}

/**
 * Inject a real R1 violation directly into the daemon's sqlite file:
 * an approved doc_version whose review node_run is still 'awaiting_review'.
 * The next /diagnose call will reproduce it as a finding.
 *
 * Returns the ULIDs of the inserted rows so cleanup can target them.
 */
function plantR1Violation(taskId: string): {
  nodeRunId: string
  docVersionId: string
} {
  const nodeRunId = `nr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const docVersionId = `dv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const now = Date.now()
  const sql = `
    INSERT INTO node_runs (id, task_id, node_id, parent_node_run_id, iteration,
      shard_key, retry_index, review_iteration, status,
      started_at, finished_at)
    VALUES ('${nodeRunId}', '${taskId}', 'rev_stuck', NULL, 0, NULL, 0, 0,
      'awaiting_review', ${now - 1000}, NULL);
    INSERT INTO doc_versions (id, task_id, review_node_id, review_node_run_id,
      source_node_id, source_port_name, version_index, review_iteration,
      body_path, comments_json, decision, decision_reason, prompt_snapshot,
      source_file_path, created_at, decided_at, decided_by)
    VALUES ('${docVersionId}', '${taskId}', 'rev_stuck', '${nodeRunId}',
      'agent_1', 'answer', 1, 0, 'dv/v1.md', '[]', 'approved', NULL, NULL,
      NULL, ${now}, ${now}, 'e2e-fixture');
  `
  execFileSync('sqlite3', [dbPath(), sql])
  return { nodeRunId, docVersionId }
}

async function primeAuth(page: Page, d: DaemonHandle): Promise<void> {
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
    { baseUrl: d.baseUrl, token: d.token },
  )
}

test('healthy task → no stuck-task banner rendered', async ({ page }) => {
  await primeAuth(page, daemon)
  await page.goto(`${daemon.baseUrl}/tasks/${taskId}`)
  // Task name renders at the top → wait for stable page.
  await expect(page.locator('h1')).toContainText('lifecycle-e2e-task')
  // Banner is absent on a healthy task.
  await expect(page.locator('[data-testid="stuck-task-banner"]')).toHaveCount(0)
})

test('R1 violation surfaces banner + Diagnose panel renders the rule', async ({ page }) => {
  // Plant a real R1 violation in the DB.
  plantR1Violation(taskId)

  // Trigger the live invariant scan so /alerts has a row to return.
  // (Otherwise we'd wait up to 1 hour for the periodic tick.)
  const diag = await fetch(`${daemon.baseUrl}/api/tasks/${taskId}/diagnose`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${daemon.token}` },
  })
  expectOk(diag, 'initial diagnose')

  await primeAuth(page, daemon)
  await page.goto(`${daemon.baseUrl}/tasks/${taskId}`)

  // Banner appears (warning chrome — newly-detected = severity warning).
  const banner = page.locator('[data-testid="stuck-task-banner"]')
  await expect(banner).toBeVisible({ timeout: 10_000 })
  await expect(banner).toContainText(/R1/)

  // Click "Diagnose" → panel opens.
  await page.locator('[data-testid="stuck-task-banner-diagnose"]').click()
  const panel = page.locator('[data-testid="task-diagnose-panel"]')
  await expect(panel).toBeVisible()

  // The table renders the R1 row.
  const table = page.locator('[data-testid="task-diagnose-table"]')
  await expect(table).toBeVisible()
  await expect(table).toContainText('R1')
  await expect(table).toContainText(/Warning/i)

  // Re-scan triggers a second POST; we observe the network round by
  // counting `/diagnose` request URLs.
  let diagnoseCalls = 0
  page.on('request', (req) => {
    if (req.url().endsWith(`/api/tasks/${taskId}/diagnose`)) diagnoseCalls++
  })
  await page.locator('[data-testid="task-diagnose-rescan"]').click()
  // Wait for the call to land.
  await expect.poll(() => diagnoseCalls).toBeGreaterThanOrEqual(1)
  // Table still shows the R1 row (violation persists).
  await expect(table).toContainText('R1')

  // Close the panel; banner still visible (alert remains open).
  await page.locator('[data-testid="task-diagnose-panel"]').press('Escape')
  await expect(panel).toHaveCount(0)
  await expect(banner).toBeVisible()

  // The alert remains server-side, but the operator can reclaim page space
  // for this exact alert signature during the current page session.
  await page.locator('[data-testid="stuck-task-banner-dismiss"]').click()
  await expect(banner).toHaveCount(0)
})

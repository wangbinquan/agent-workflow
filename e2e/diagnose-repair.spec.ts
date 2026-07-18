// RFC-057 PR-D — Playwright e2e for diagnose-repair flow.
//
// Coverage:
//   1. S3 happy path. Plant an S3 wedge directly in SQLite (task in
//      running but every node_run is terminal). Open <TaskDiagnosePanel>
//      → click "Repair…" on the S3 row → pick "Demote task" → click
//      Next → click Apply. Assert the alert resolves (re-scan shows
//      empty) within 5s.
//   2. R1 happy path. Plant an R1 wedge (approved doc but review run
//      not done). Repair via "Mark review node_run done". Assert the
//      alert resolves.
//   3. U1 happy path. Plant a U1 violation (two active node_runs on the
//      same (nodeId, iteration, shard)). Repair via
//      "Keep newest active run, cancel the rest". Assert the alert
//      resolves.
//   4. Preflight-stale path. Plant an S3 wedge, then mutate the DB out
//      from under the panel so the chosen option becomes invalid (e.g.
//      flip the task to interrupted manually) and Apply. The backend
//      MUST return outcome=preflight-stale; the UI surfaces the
//      message inline (alert stays open).
//
// Direct DB injection (sqlite3 CLI) — matches lifecycle-diagnose.spec.ts.

import { test, expect, type Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { startDaemon, type DaemonHandle } from './harness'
import { initGitRepo, runSqlite } from './command'

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

  repoDir = mkdtempSync(join(tmpdir(), 'aw-e2e-repair-repo-'))
  writeFileSync(join(repoDir, 'README.md'), '# e2e repair fixture\n', 'utf-8')
  initGitRepo(repoDir)

  fixtures = await setupViaApi(daemon, repoDir)
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
  const agentName = 'e2e-repair-stub'
  const a = await fetch(`${d.baseUrl}/api/agents`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: agentName,
      description: 'stub for repair e2e',
      outputs: ['answer'],
      readonly: true,
      bodyMd: 'echo',
    }),
  })
  expectOk(a, 'create agent')
  const workflowName = 'e2e-repair'
  const w = await fetch(`${d.baseUrl}/api/workflows`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: workflowName,
      description: 'repair e2e',
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
      name: 'repair-e2e-task',
      workflowId: f.workflowId,
      repoUrl: pathToFileURL(f.repoPath).href,
      ref: 'main',
      inputs: { topic: 'state machines' },
    }),
  })
  expectOk(res, 'launch task')
  const task = (await res.json()) as { id: string }
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

function runSql(sql: string): void {
  runSqlite(dbPath(), sql)
}

/** Plant a real S3 violation: task running but a node_run that was once
 * active is now terminal (interrupted), and the task hasn't been demoted.
 *
 * Also seeds the lifecycle_alerts row directly. The production
 * stuckTaskDetector only flags S3 after 30 minutes of inactivity (see
 * DEFAULT_STUCK_THRESHOLD_MS in stuckTaskDetector.ts), and the
 * `/api/tasks/:id/diagnose` route only runs the invariant scan — not
 * the stuck detector. So we mimic what the periodic 5-min scan would
 * have written once the threshold elapsed. */
function plantS3Violation(taskId: string): { reviewRunId: string; alertId: string } {
  const reviewRunId = `nr_s3_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const alertId = `al_s3_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const now = Date.now()
  const detail = JSON.stringify({
    rule: 'S3',
    message: 'task running but every node_run is terminal',
    repairHint: { kind: 'review', nodeRunId: reviewRunId },
  }).replace(/'/g, "''")
  runSql(`
    UPDATE tasks SET status='running' WHERE id='${taskId}';
    INSERT INTO node_runs (id, task_id, node_id, parent_node_run_id, iteration,
      shard_key, retry_index, review_iteration, status,
      started_at, finished_at)
    VALUES ('${reviewRunId}', '${taskId}', 'rev_s3', NULL, 0, NULL, 0, 0,
      'interrupted', ${now - 5000}, ${now - 1000});
    INSERT INTO lifecycle_alerts
      (id, task_id, rule, severity, detail, detected_at, resolved_at)
    VALUES ('${alertId}', '${taskId}', 'S3', 'warning', '${detail}', ${now}, NULL);
  `)
  return { reviewRunId, alertId }
}

function plantR1Violation(taskId: string): { nodeRunId: string; docVersionId: string } {
  const nodeRunId = `nr_r1_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const docVersionId = `dv_r1_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const now = Date.now()
  runSql(`
    INSERT INTO node_runs (id, task_id, node_id, parent_node_run_id, iteration,
      shard_key, retry_index, review_iteration, status,
      started_at, finished_at)
    VALUES ('${nodeRunId}', '${taskId}', 'rev_r1', NULL, 0, NULL, 0, 0,
      'awaiting_review', ${now - 1000}, NULL);
    INSERT INTO doc_versions (id, task_id, review_node_id, review_node_run_id,
      source_node_id, source_port_name, version_index, review_iteration,
      body_path, comments_json, decision, decision_reason, prompt_snapshot,
      source_file_path, created_at, decided_at, decided_by)
    VALUES ('${docVersionId}', '${taskId}', 'rev_r1', '${nodeRunId}',
      'agent_1', 'answer', 1, 0, 'dv/v1.md', '[]', 'approved', NULL, NULL,
      NULL, ${now}, ${now}, 'e2e-fixture');
  `)
  return { nodeRunId, docVersionId }
}

function plantU1Violation(taskId: string): { olderId: string; newerId: string } {
  const olderId = `nr_u1o_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const newerId = `nr_u1n_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const now = Date.now()
  // U1 invariant only fires on rows in {awaiting_review, awaiting_human}.
  // Two rows share (nodeId, iteration, shard_key=NULL, reviewIteration,
  // clarifyIteration) on different retry_index slots so the unique index
  // doesn't reject the second insert.
  runSql(`
    INSERT INTO node_runs (id, task_id, node_id, parent_node_run_id, iteration,
      shard_key, retry_index, review_iteration, status,
      started_at, finished_at)
    VALUES ('${olderId}', '${taskId}', 'rev_u1', NULL, 0, NULL, 0, 0,
      'awaiting_review', ${now - 4000}, NULL);
    INSERT INTO node_runs (id, task_id, node_id, parent_node_run_id, iteration,
      shard_key, retry_index, review_iteration, status,
      started_at, finished_at)
    VALUES ('${newerId}', '${taskId}', 'rev_u1', NULL, 0, NULL, 1, 0,
      'awaiting_review', ${now - 1000}, NULL);
  `)
  return { olderId, newerId }
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

async function openDiagnose(page: Page): Promise<void> {
  await primeAuth(page, daemon)
  await page.goto(`${daemon.baseUrl}/tasks/${taskId}`)
  await expect(page.locator('[data-testid="stuck-task-banner-diagnose"]')).toBeVisible({
    timeout: 10_000,
  })
  await page.locator('[data-testid="stuck-task-banner-diagnose"]').click()
  await expect(page.locator('[data-testid="task-diagnose-panel"]')).toBeVisible()
}

async function triggerDiagnoseFromApi(): Promise<void> {
  const diag = await fetch(`${daemon.baseUrl}/api/tasks/${taskId}/diagnose`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${daemon.token}` },
  })
  expectOk(diag, 'initial diagnose')
}

async function clearStuckState(): Promise<void> {
  // Clean alerts + planted node_runs so each test starts from a clean slate.
  // Leave the task itself + the original done node_runs alone — those are
  // shared launch state.
  runSql(`
    DELETE FROM lifecycle_alerts WHERE task_id='${taskId}';
    DELETE FROM doc_versions WHERE task_id='${taskId}' AND review_node_id IN ('rev_s3','rev_r1');
    DELETE FROM node_runs WHERE task_id='${taskId}'
      AND node_id IN ('rev_s3','rev_r1','rev_u1');
    UPDATE tasks SET status='done' WHERE id='${taskId}';
  `)
}

test.afterEach(async () => {
  await clearStuckState()
})

test('S3 happy: demote-task resolves the alert', async ({ page }) => {
  plantS3Violation(taskId)
  await triggerDiagnoseFromApi()
  await openDiagnose(page)

  // Click the per-row repair button for S3.
  await page.locator('[data-testid="task-diagnose-repair-S3"]').click()
  const dialog = page.locator('[data-testid="repair-choice-dialog"]')
  await expect(dialog).toBeVisible({ timeout: 10_000 })

  // The preview surfaces — confirm by looking for the step list.
  await expect(page.locator('[data-testid="repair-preview-steps"]')).toBeVisible()

  // Pick S3.demote-task by opening the Select and choosing the option.
  // (Default selection may not be the demote option; force it.)
  // The Select's listbox renders inside the portal; click the trigger then
  // click the option whose text matches our label.
  await page.locator('[role="combobox"]').first().click()
  await page.getByRole('option', { name: /Demote task/i }).click()

  // Next → confirm modal.
  await page.locator('[data-testid="repair-choice-next"]').click()
  await expect(page.locator('[data-testid="repair-confirm-modal"]')).toBeVisible()
  await page.locator('[data-testid="repair-confirm-apply"]').click()

  // Both dialogs close; the diagnose table re-scans. The S3 row disappears
  // (alert resolved) or the empty banner shows. Either way, no S3 testid
  // survives within 5 seconds.
  await expect(page.locator('[data-testid="task-diagnose-repair-S3"]')).toHaveCount(0, {
    timeout: 5_000,
  })
})

test('R1 happy: approve-run resolves the alert', async ({ page }) => {
  plantR1Violation(taskId)
  await triggerDiagnoseFromApi()
  await openDiagnose(page)

  await page.locator('[data-testid="task-diagnose-repair-R1"]').click()
  await expect(page.locator('[data-testid="repair-choice-dialog"]')).toBeVisible({
    timeout: 10_000,
  })

  // R1's default option is approve-run (low risk, first available).
  await page.locator('[data-testid="repair-choice-next"]').click()
  await expect(page.locator('[data-testid="repair-confirm-modal"]')).toBeVisible()
  await page.locator('[data-testid="repair-confirm-apply"]').click()

  await expect(page.locator('[data-testid="task-diagnose-repair-R1"]')).toHaveCount(0, {
    timeout: 5_000,
  })
})

test('U1 happy: cancel-older-keep-newest resolves the alert', async ({ page }) => {
  plantU1Violation(taskId)
  await triggerDiagnoseFromApi()
  await openDiagnose(page)

  await page.locator('[data-testid="task-diagnose-repair-U1"]').click()
  await expect(page.locator('[data-testid="repair-choice-dialog"]')).toBeVisible({
    timeout: 10_000,
  })

  // Default is cancel-older-keep-newest (first available).
  await page.locator('[data-testid="repair-choice-next"]').click()
  await expect(page.locator('[data-testid="repair-confirm-modal"]')).toBeVisible()
  await page.locator('[data-testid="repair-confirm-apply"]').click()

  await expect(page.locator('[data-testid="task-diagnose-repair-U1"]')).toHaveCount(0, {
    timeout: 5_000,
  })
})

test('preflight-stale: option-id unknown after DB drift surfaces error', async ({ page }) => {
  plantS3Violation(taskId)
  await triggerDiagnoseFromApi()
  await openDiagnose(page)

  await page.locator('[data-testid="task-diagnose-repair-S3"]').click()
  await expect(page.locator('[data-testid="repair-choice-dialog"]')).toBeVisible({
    timeout: 10_000,
  })
  // Wait for the preview to land so we know the option list is realized.
  await expect(page.locator('[data-testid="repair-preview-steps"]')).toBeVisible()

  // Mutate state out from under the panel so demote-task's preflight
  // fails: flip the task to a non-running terminal state. Apply should
  // then return outcome=preflight-stale; <ErrorBanner> appears.
  runSql(`UPDATE tasks SET status='canceled' WHERE id='${taskId}';`)

  // Pick demote-task explicitly to make the failure predictable.
  await page.locator('[role="combobox"]').first().click()
  await page.getByRole('option', { name: /Demote task/i }).click()

  await page.locator('[data-testid="repair-choice-next"]').click()
  await expect(page.locator('[data-testid="repair-confirm-modal"]')).toBeVisible()
  await page.locator('[data-testid="repair-confirm-apply"]').click()

  // Backend returns 4xx → modal stays open + ErrorBanner.
  await expect(page.locator('.error-box')).toBeVisible({ timeout: 5_000 })
  await expect(page.locator('[data-testid="repair-confirm-modal"]')).toBeVisible()
})

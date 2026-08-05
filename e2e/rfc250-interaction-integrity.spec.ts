// RFC-250 T36/T37 — real-browser interaction-integrity closure.
//
// This spec intentionally owns only the browser gaps that component tests and
// the existing exact geometry suites cannot prove:
//   * Clarify generation durability across a late acknowledgement and retry;
//   * Memory archive/delete/unarchive pending, error, and retry transactions;
//   * Scheduled list/detail parity for eligibility, confirmation, and failure;
//   * Changes group/file/viewed keyboard ownership;
//   * a partial Inbox feed with long zh-CN content at the uncovered 736 width.
//
// Complementary exact gates remain deliberately separate: keyboard-flows owns
// shared Dialog cycling, ux-consistency/agent-port-editor own production Select,
// rfc246-operations-surfaces owns 1024 + 390x568 geometry, and
// rfc232-owner-list owns long Owner readability. Screenshots are not evidence
// here: every assertion targets a semantic, request, focus, or geometry result.

import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Locator, type Page } from '@playwright/test'
import type { StructuralDiff } from '@agent-workflow/shared'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { initGitRepo } from './command'
import { startDaemon, type DaemonHandle } from './harness'
import { scheduledOperationsFixture } from './operations-surface-fixtures'

let daemon: DaemonHandle | undefined
let ownedTempDirs: string[] = []

function requireDaemon(): DaemonHandle {
  if (daemon === undefined) throw new Error('RFC-250 interaction daemon is not running')
  return daemon
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${requireDaemon().token}`,
    'Content-Type': 'application/json',
  }
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${requireDaemon().baseUrl}${path}`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    throw new Error(`RFC-250 fixture POST ${path}: ${response.status} ${await response.text()}`)
  }
  return (await response.json()) as T
}

async function setDaemonLanguage(language: 'en-US' | 'zh-CN'): Promise<void> {
  const response = await fetch(`${requireDaemon().baseUrl}/api/config`, {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify({ language }),
  })
  expect(response.ok, `failed to set ${language} language (${response.status})`).toBe(true)
}

async function primePage(
  page: Page,
  options: {
    viewport?: { width: number; height: number }
    language?: 'en-US' | 'zh-CN'
  } = {},
): Promise<void> {
  const d = requireDaemon()
  await page.setViewportSize(options.viewport ?? { width: 1280, height: 800 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.addInitScript(
    ({ baseUrl, token, language }) => {
      window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
      window.localStorage.setItem('agent-workflow.token', token)
      window.localStorage.setItem('aw-language', language)
    },
    { baseUrl: d.baseUrl, token: d.token, language: options.language ?? 'en-US' },
  )
}

interface DeferredGate {
  wait: Promise<void>
  release: () => void
}

function deferredGate(): DeferredGate {
  let resolveGate!: () => void
  let released = false
  const wait = new Promise<void>((resolvePromise) => {
    resolveGate = resolvePromise
  })
  return {
    wait,
    release: () => {
      if (released) return
      released = true
      resolveGate()
    },
  }
}

async function waitForTaskStatus(taskId: string, expected: string): Promise<void> {
  const d = requireDaemon()
  await expect
    .poll(
      async () => {
        const response = await fetch(`${d.baseUrl}/api/tasks/${taskId}`, {
          headers: { Authorization: `Bearer ${d.token}` },
        })
        if (!response.ok) return `http-${response.status}`
        return ((await response.json()) as { status: string }).status
      },
      { timeout: 30_000 },
    )
    .toBe(expected)
}

async function createAgent(name: string, outputs: string[] = ['answer']): Promise<string> {
  const created = await postJson<{ id: string }>('/api/agents', {
    name,
    description: 'Deterministic RFC-250 interaction fixture',
    outputs,
    outputKinds: Object.fromEntries(outputs.map((output) => [output, 'markdown'])),
    readonly: true,
    bodyMd: '',
  })
  return created.id
}

async function seedClarifySession(): Promise<string> {
  const repoDir = mkdtempSync(join(tmpdir(), 'aw-rfc250-interaction-clarify-'))
  ownedTempDirs.push(repoDir)
  writeFileSync(join(repoDir, 'README.md'), '# RFC-250 clarify interaction fixture\n', 'utf8')
  initGitRepo(repoDir)

  const agentId = await createAgent('rfc250-interaction-clarify-designer', ['design'])
  const workflow = await postJson<{ id: string }>('/api/workflows', {
    name: 'rfc250-interaction-clarify-workflow',
    description: 'Deterministic Clarify generation fixture',
    definition: {
      $schema_version: 3,
      inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
      nodes: [
        { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
        {
          id: 'designer',
          kind: 'agent-single',
          agentId,
          agentName: 'rfc250-interaction-clarify-designer',
          promptTemplate: 'Design for {{topic}}.',
          position: { x: 320, y: 0 },
        },
        {
          id: 'clarify_1',
          kind: 'clarify',
          title: 'Clarify design',
          description: 'Ask before producing the document.',
          position: { x: 560, y: 160 },
        },
        {
          id: 'review_design',
          kind: 'review',
          title: 'Review design',
          description: '',
          inputSource: { nodeId: 'designer', portName: 'design' },
          rerunnableOnReject: [],
          rerunnableOnIterate: [],
          rollbackFilesOnReject: false,
          rollbackFilesOnIterate: false,
          position: { x: 640, y: 0 },
        },
        {
          id: 'out_1',
          kind: 'output',
          ports: [{ name: 'doc', bind: { nodeId: 'review_design', portName: 'approved_doc' } }],
          position: { x: 960, y: 0 },
        },
      ],
      edges: [
        {
          id: 'e_in_designer',
          source: { nodeId: 'in_1', portName: 'topic' },
          target: { nodeId: 'designer', portName: 'topic' },
        },
        {
          id: 'e_clarify_ask',
          source: { nodeId: 'designer', portName: '__clarify__' },
          target: { nodeId: 'clarify_1', portName: 'questions' },
        },
        {
          id: 'e_clarify_answer',
          source: { nodeId: 'clarify_1', portName: 'answers' },
          target: { nodeId: 'designer', portName: '__clarify_response__' },
        },
        {
          id: 'e_designer_review',
          source: { nodeId: 'designer', portName: 'design' },
          target: { nodeId: 'review_design', portName: '__review_input__' },
        },
        {
          id: 'e_review_output',
          source: { nodeId: 'review_design', portName: 'approved_doc' },
          target: { nodeId: 'out_1', portName: 'doc' },
        },
      ],
    },
  })

  const task = await postJson<{ id: string }>('/api/tasks', {
    workflowId: workflow.id,
    name: 'RFC-250 latest Clarify generation',
    repoUrl: pathToFileURL(repoDir).href,
    ref: 'main',
    inputs: { topic: 'durable interaction state' },
  })
  await waitForTaskStatus(task.id, 'awaiting_human')

  const d = requireDaemon()
  const response = await fetch(
    `${d.baseUrl}/api/clarify?status=awaiting_human&taskId=${encodeURIComponent(task.id)}`,
    { headers: { Authorization: `Bearer ${d.token}` } },
  )
  if (!response.ok) throw new Error(`RFC-250 Clarify fixture failed: ${response.status}`)
  const sessions = (await response.json()) as Array<{ intermediaryNodeRunId: string }>
  const nodeRunId = sessions[0]?.intermediaryNodeRunId
  if (nodeRunId === undefined) throw new Error('RFC-250 Clarify fixture produced no session')
  return nodeRunId
}

async function seedApprovedMemory(title: string): Promise<string> {
  const created = await postJson<{ memory: { id: string } }>('/api/memories', {
    scopeType: 'global',
    scopeId: null,
    title,
    bodyMd: `Durable interaction fixture for ${title}.`,
    tags: ['rfc250'],
  })
  await postJson(`/api/memories/${encodeURIComponent(created.memory.id)}/promote`, {
    action: 'approve',
  })
  return created.memory.id
}

const CHANGES_DIFF = `diff --git a/src/ui/account.ts b/src/ui/account.ts
index 1111..2222 100644
--- a/src/ui/account.ts
+++ b/src/ui/account.ts
@@ -1,2 +1,2 @@
-export const accountState = 'legacy'
+export const accountState = 'ready'
 export const owner = 'platform'
diff --git a/src/ui/navigation.ts b/src/ui/navigation.ts
index 3333..4444 100644
--- a/src/ui/navigation.ts
+++ b/src/ui/navigation.ts
@@ -1,2 +1,2 @@
-export const compact = false
+export const compact = true
 export const keyboard = true
diff --git a/src/core/session.ts b/src/core/session.ts
index 5555..6666 100644
--- a/src/core/session.ts
+++ b/src/core/session.ts
@@ -1,2 +1,2 @@
-export const durable = false
+export const durable = true
 export const generation = 3
diff --git a/src/core/recovery.ts b/src/core/recovery.ts
index 7777..8888 100644
--- a/src/core/recovery.ts
+++ b/src/core/recovery.ts
@@ -1,2 +1,2 @@
-export const restore = 'manual'
+export const restore = 'guided'
 export const discard = 'explicit'
diff --git a/src/core/permissions.ts b/src/core/permissions.ts
index 9999..aaaa 100644
--- a/src/core/permissions.ts
+++ b/src/core/permissions.ts
@@ -1,2 +1,2 @@
-export const matrix = 'table'
+export const matrix = 'responsive'
 export const discoverable = true
diff --git a/README.md b/README.md
index bbbb..cccc 100644
--- a/README.md
+++ b/README.md
@@ -1,1 +1,2 @@
 # RFC-250 fixture
+Interaction states are recoverable and explicit.
`

async function seedChangesTask(): Promise<string> {
  const repoDir = mkdtempSync(join(tmpdir(), 'aw-rfc250-interaction-changes-'))
  ownedTempDirs.push(repoDir)
  writeFileSync(join(repoDir, 'README.md'), '# RFC-250 Changes interaction fixture\n', 'utf8')
  initGitRepo(repoDir)

  const agentId = await createAgent('rfc250-interaction-changes-agent')
  const workflow = await postJson<{ id: string }>('/api/workflows', {
    name: 'rfc250-interaction-changes-workflow',
    description: 'Deterministic Changes keyboard fixture',
    definition: {
      $schema_version: 4,
      inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
      nodes: [
        { id: 'input_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
        {
          id: 'agent_1',
          kind: 'agent-single',
          agentId,
          agentName: 'rfc250-interaction-changes-agent',
          promptTemplate: 'Explain {{topic}}.',
          position: { x: 320, y: 0 },
        },
        {
          id: 'output_1',
          kind: 'output',
          ports: [{ name: 'answer', bind: { nodeId: 'agent_1', portName: 'answer' } }],
          position: { x: 640, y: 0 },
        },
      ],
      edges: [
        {
          id: 'e_input_agent',
          source: { nodeId: 'input_1', portName: 'topic' },
          target: { nodeId: 'agent_1', portName: 'topic' },
        },
        {
          id: 'e_agent_output',
          source: { nodeId: 'agent_1', portName: 'answer' },
          target: { nodeId: 'output_1', portName: 'answer' },
        },
      ],
    },
  })
  const task = await postJson<{ id: string }>('/api/tasks', {
    workflowId: workflow.id,
    name: 'RFC-250 keyboard ownership review',
    repoUrl: pathToFileURL(repoDir).href,
    ref: 'main',
    inputs: { topic: 'keyboard ownership' },
  })
  await waitForTaskStatus(task.id, 'done')
  return task.id
}

function changesStructuralFixture(taskId: string): StructuralDiff {
  return {
    scope: 'task',
    taskId,
    fromRef: '1111111111111111111111111111111111111111',
    toRef: 'WORKTREE',
    engine: 'baseline',
    status: 'ok',
    files: [
      {
        filePath: 'src/ui/account.ts',
        lang: 'typescript',
        status: 'ok',
        changes: [
          {
            changeType: 'modified',
            kind: 'method',
            after: {
              id: 'src/ui/account.ts#renderAccount:method:1',
              kind: 'method',
              name: 'renderAccount',
              qualifiedName: 'AccountView.renderAccount',
              lang: 'typescript',
              filePath: 'src/ui/account.ts',
              confidence: 'extracted',
              range: { startLine: 1, endLine: 2 },
            },
            bodyChanged: true,
          },
        ],
        edges: [],
        impact: [],
      },
    ],
    dependencyChanges: [],
    impact: [],
    classEdges: [],
    callChainAvailable: true,
    contentDigest: 'rfc250-interaction-content-digest',
    summary: {
      files: 6,
      classes: { added: 0, modified: 0, removed: 0, renamed: 0 },
      methods: { added: 0, modified: 1, removed: 0, renamed: 0 },
      fields: { added: 0, modified: 0, removed: 0, renamed: 0 },
      imports: { added: 0, modified: 0, removed: 0, renamed: 0 },
      dependencies: { added: 0, modified: 0, removed: 0, renamed: 0 },
    },
  }
}

async function expectNoHorizontalOverflow(page: Page, owned: Locator): Promise<void> {
  await expect
    .poll(async () => {
      return owned.evaluate((element) => {
        const main = document.querySelector<HTMLElement>('[data-testid="app-shell-main"]')
        return {
          documentFits:
            document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
          mainFits: main !== null && main.scrollWidth <= main.clientWidth + 1,
          ownedFits: element.scrollWidth <= element.clientWidth + 1,
        }
      })
    })
    .toEqual({ documentFits: true, mainFits: true, ownedFits: true })
}

async function expectNoSeriousAxeViolations(page: Page, include: string): Promise<void> {
  const scan = await new AxeBuilder({ page }).include(include).analyze()
  expect(
    scan.violations.filter(
      (violation) => violation.impact === 'critical' || violation.impact === 'serious',
    ),
  ).toEqual([])
}

test.describe('RFC-250 interaction-integrity browser closure', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(120_000)

  test.beforeEach(async ({ page: _page }, testInfo) => {
    ownedTempDirs = []
    if (testInfo.title.includes('Clarify')) {
      const stubState = mkdtempSync(join(tmpdir(), 'aw-rfc250-interaction-clarify-state-'))
      ownedTempDirs.push(stubState)
      daemon = await startDaemon({
        stubMode: 'clarify',
        extraEnv: { CLARIFY_STUB_STATE: stubState },
      })
      return
    }
    daemon = await startDaemon()
  })

  test.afterEach(async () => {
    const active = daemon
    daemon = undefined
    if (active !== undefined) await active.stop()
    for (const path of ownedTempDirs) rmSync(path, { recursive: true, force: true })
    ownedTempDirs = []
  })

  test('Clarify late ack cannot bless the latest generation; retry preserves and saves it', async ({
    page,
  }) => {
    const nodeRunId = await seedClarifySession()
    const firstPutGate = deferredGate()
    const putBodies: Array<{ selectedOptionIndices: number[]; questionId: string }> = []
    await page.route(`**/api/clarify/${nodeRunId}/draft`, async (route) => {
      if (route.request().method() !== 'PUT') {
        await route.continue()
        return
      }
      const body = route.request().postDataJSON() as {
        selectedOptionIndices: number[]
        questionId: string
      }
      putBodies.push(body)
      if (putBodies.length === 1) {
        await firstPutGate.wait
        await route.fulfill({ json: { ok: true } })
        return
      }
      if (putBodies.length === 2) {
        await route.fulfill({
          status: 503,
          json: { code: 'draft-sync-unavailable', message: 'draft sync unavailable' },
        })
        return
      }
      await route.continue()
    })

    try {
      await primePage(page)
      await page.goto(`${requireDaemon().baseUrl}/clarify/${nodeRunId}`)
      const indicator = page.getByTestId('clarify-draft-indicator')
      await expect(indicator).toHaveAttribute('data-draft-status', 'saved')

      const postgres = page.getByRole('radio', { name: 'Postgres', exact: true })
      const sqlite = page.getByRole('radio', { name: 'SQLite', exact: true })
      await postgres.click()
      await expect.poll(() => putBodies.length).toBe(1)

      // Queue a newer answer while the first generation is still in flight.
      await sqlite.click()
      await expect(sqlite).toBeChecked()
      firstPutGate.release()

      await expect.poll(() => putBodies.length).toBe(2)
      await expect(page.getByTestId('clarify-draft-local-only')).toBeVisible()
      await expect(indicator).toHaveAttribute('data-draft-status', 'local-only')
      await expect(sqlite).toBeChecked()
      await expect(postgres).not.toBeChecked()
      expect(putBodies.map((body) => body.selectedOptionIndices)).toEqual([[0], [1]])
      expect(putBodies.every((body) => body.questionId === 'q-db')).toBe(true)

      await page.getByTestId('clarify-draft-server-retry').click()
      await expect.poll(() => putBodies.length).toBe(3)
      expect(putBodies[2]?.selectedOptionIndices).toEqual([1])
      await expect(indicator).toHaveAttribute('data-draft-status', 'saved')
      await expect(page.getByTestId('clarify-draft-local-only')).toBeHidden()
      await expect(sqlite).toBeChecked()
    } finally {
      firstPutGate.release()
    }
  })

  test('Memory archive, delete, and unarchive stay target-scoped through pending/error/retry', async ({
    page,
  }) => {
    const archiveId = await seedApprovedMemory('RFC-250 archive transaction')
    const deleteId = await seedApprovedMemory('RFC-250 delete transaction')
    const unarchiveId = await seedApprovedMemory('RFC-250 unarchive transaction')
    await postJson(`/api/memories/${encodeURIComponent(unarchiveId)}/archive`, {})

    const archiveGate = deferredGate()
    const deleteGate = deferredGate()
    const unarchiveGate = deferredGate()
    const archiveUrls: string[] = []
    const deleteUrls: string[] = []
    const unarchiveUrls: string[] = []

    await page.route(
      (url) => url.pathname === `/api/memories/${archiveId}/archive`,
      async (route) => {
        archiveUrls.push(route.request().url())
        if (archiveUrls.length === 1) {
          await archiveGate.wait
          await route.fulfill({
            status: 503,
            json: { code: 'archive-failed', message: 'archive failed' },
          })
          return
        }
        await route.continue()
      },
    )
    await page.route(
      (url) =>
        url.pathname === `/api/memories/${deleteId}` && url.searchParams.get('confirm') === 'true',
      async (route) => {
        deleteUrls.push(route.request().url())
        if (deleteUrls.length === 1) {
          await deleteGate.wait
          await route.fulfill({
            status: 503,
            json: { code: 'delete-failed', message: 'delete failed' },
          })
          return
        }
        await route.continue()
      },
    )
    await page.route(
      (url) => url.pathname === `/api/memories/${unarchiveId}/unarchive`,
      async (route) => {
        unarchiveUrls.push(route.request().url())
        if (unarchiveUrls.length === 1) {
          await unarchiveGate.wait
          await route.fulfill({
            status: 503,
            json: { code: 'unarchive-failed', message: 'unarchive failed' },
          })
          return
        }
        await route.continue()
      },
    )

    try {
      await primePage(page)
      await page.goto(`${requireDaemon().baseUrl}/memory?tab=all`)
      await expect(page.getByTestId(`memory-all-${archiveId}-archive`)).toBeVisible()

      await page.getByTestId(`memory-all-${archiveId}-archive`).click()
      const archiveDialog = page.getByTestId('memory-confirm-dialog')
      await expect(archiveDialog).toBeVisible()
      const archiveConfirm = page.getByTestId('memory-confirm-ok')
      // Same JS task: the synchronous ref must close the pre-render double-click gap.
      await archiveConfirm.evaluate((element) => {
        element.click()
        element.click()
      })
      await expect.poll(() => archiveUrls.length).toBe(1)
      await expect(archiveConfirm).toBeDisabled()
      await expect(page.getByTestId('memory-confirm-cancel')).toBeDisabled()
      await expect(archiveDialog.locator('.dialog__close')).toBeDisabled()
      await page.keyboard.press('Escape')
      await expect(archiveDialog).toBeVisible()
      archiveGate.release()

      const archiveError = page.getByTestId('memory-confirm-error')
      await expect(archiveError).toBeVisible()
      await expect(page.getByTestId(`memory-row-${archiveId}`)).toBeVisible()
      await archiveError.getByRole('button', { name: /retry/i }).click()
      await expect.poll(() => archiveUrls.length).toBe(2)
      await expect(archiveDialog).toBeHidden()
      await expect(page.getByTestId(`memory-row-${archiveId}`)).toBeHidden()
      expect(
        archiveUrls.every((url) => new URL(url).pathname.endsWith(`/${archiveId}/archive`)),
      ).toBe(true)

      await page.getByTestId(`memory-all-${deleteId}-delete`).click()
      const deleteDialog = page.getByTestId('memory-confirm-dialog')
      await page.getByTestId('memory-confirm-ok').click()
      await expect.poll(() => deleteUrls.length).toBe(1)
      await expect(deleteDialog).toBeVisible()
      await expect(page.getByTestId('memory-confirm-ok')).toBeDisabled()
      deleteGate.release()

      const deleteError = page.getByTestId('memory-confirm-error')
      await expect(deleteError).toBeVisible()
      await expect(page.getByTestId(`memory-row-${deleteId}`)).toBeVisible()
      await deleteError.getByRole('button', { name: /retry/i }).click()
      await expect.poll(() => deleteUrls.length).toBe(2)
      await expect(deleteDialog).toBeHidden()
      await expect(page.getByTestId(`memory-row-${deleteId}`)).toBeHidden()
      expect(
        deleteUrls.every((url) => {
          const parsed = new URL(url)
          return (
            parsed.pathname.endsWith(`/${deleteId}`) &&
            parsed.searchParams.get('confirm') === 'true'
          )
        }),
      ).toBe(true)

      await page.getByTestId('memory-all-filter-archived').click()
      const unarchive = page.getByTestId(`memory-all-${unarchiveId}-unarchive`)
      await expect(unarchive).toBeVisible()
      await unarchive.click()
      await expect.poll(() => unarchiveUrls.length).toBe(1)
      await expect(unarchive).toBeDisabled()
      unarchiveGate.release()

      const unarchiveError = page.getByTestId(`memory-unarchive-error-${unarchiveId}`)
      await expect(unarchiveError).toBeVisible()
      await expect(page.getByTestId(`memory-row-${unarchiveId}`)).toBeVisible()
      await unarchiveError.getByRole('button', { name: /retry/i }).click()
      await expect.poll(() => unarchiveUrls.length).toBe(2)
      await expect(page.getByTestId(`memory-row-${unarchiveId}`)).toBeHidden()
      expect(
        unarchiveUrls.every((url) => new URL(url).pathname.endsWith(`/${unarchiveId}/unarchive`)),
      ).toBe(true)
    } finally {
      archiveGate.release()
      deleteGate.release()
      unarchiveGate.release()
    }
  })

  test('Scheduled list/detail share blocked reason, two-click confirmation, pending, and retry', async ({
    page,
  }) => {
    const fixtureBase = scheduledOperationsFixture()[1]!
    const listAllowed = {
      ...fixtureBase,
      id: 'rfc250-scheduled-list-allowed',
      name: 'List allowed transaction',
    }
    const detailAllowed = {
      ...fixtureBase,
      id: 'rfc250-scheduled-detail-allowed',
      name: 'Detail allowed transaction',
    }
    const blocked = {
      ...fixtureBase,
      id: 'rfc250-scheduled-blocked',
      name: 'Blocked legacy transaction',
      migrationNeeded: true,
    }
    const schedules = [listAllowed, detailAllowed, blocked]
    const attempts = new Map<string, number>()
    const listGate = deferredGate()
    const detailGate = deferredGate()

    await page.route('**/api/scheduled-tasks**', async (route) => {
      const request = route.request()
      const method = request.method()
      const url = new URL(request.url())
      if (method === 'GET' && url.pathname === '/api/scheduled-tasks') {
        await route.fulfill({ json: schedules })
        return
      }
      const detailMatch = url.pathname.match(/^\/api\/scheduled-tasks\/([^/]+)$/)
      if (method === 'GET' && detailMatch !== null) {
        const schedule = schedules.find((row) => row.id === detailMatch[1])
        if (schedule !== undefined) {
          await route.fulfill({ json: schedule })
          return
        }
      }
      const runMatch = url.pathname.match(/^\/api\/scheduled-tasks\/([^/]+)\/run-now$/)
      if (method === 'POST' && runMatch !== null) {
        const id = runMatch[1]!
        const attempt = (attempts.get(id) ?? 0) + 1
        attempts.set(id, attempt)
        if (attempt === 1) {
          await (id === listAllowed.id ? listGate.wait : detailGate.wait)
          await route.fulfill({
            status: 409,
            json: { code: 'launch-rejected', message: 'cannot launch now' },
          })
          return
        }
        await route.fulfill({ status: 201, json: { taskId: `task-from-${id}` } })
        return
      }
      await route.continue()
    })

    const describedText = async (button: Locator): Promise<string | null> => {
      const id = await button.getAttribute('aria-describedby')
      if (id === null) return null
      return page.locator(`#${id}`).textContent()
    }

    try {
      await primePage(page)
      await page.goto(`${requireDaemon().baseUrl}/scheduled`)
      const blockedListButton = page.getByTestId(`scheduled-run-now-${blocked.id}`)
      await expect(blockedListButton).toBeDisabled()
      const listReason = await describedText(blockedListButton)
      expect(listReason).not.toBeNull()

      await page.goto(`${requireDaemon().baseUrl}/scheduled/${blocked.id}`)
      const blockedDetailButton = page.getByTestId('scheduled-run-now')
      await expect(blockedDetailButton).toBeDisabled()
      expect(await describedText(blockedDetailButton)).toBe(listReason)

      await page.goto(`${requireDaemon().baseUrl}/scheduled`)
      const listRunNow = page.getByTestId(`scheduled-run-now-${listAllowed.id}`)
      await listRunNow.click()
      expect(attempts.get(listAllowed.id) ?? 0).toBe(0)
      await expect(listRunNow).toHaveAccessibleName(/confirm/i)
      await listRunNow.click()
      await expect.poll(() => attempts.get(listAllowed.id) ?? 0).toBe(1)
      await expect(listRunNow).toBeDisabled()
      await listRunNow.evaluate((element) => element.click())
      expect(attempts.get(listAllowed.id)).toBe(1)
      listGate.release()

      const listError = page.getByTestId(`scheduled-run-now-error-${listAllowed.id}`)
      await expect(listError).toBeVisible()
      const feedbackRow = page.getByTestId(`scheduled-run-now-feedback-row-${listAllowed.id}`)
      await expect(feedbackRow).toBeVisible()
      await expect(feedbackRow.locator('td')).toHaveAttribute('colspan', '6')
      const feedbackGeometry = await listError.evaluate((banner) => {
        const table = banner.closest('table')
        const content = banner.querySelector<HTMLElement>('.notice-banner__content')
        const retry = banner.querySelector<HTMLElement>('.notice-banner__action button')
        if (table === null || content === null || retry === null) return null
        const tableRect = table.getBoundingClientRect()
        const bannerRect = banner.getBoundingClientRect()
        const contentRect = content.getBoundingClientRect()
        const retryRect = retry.getBoundingClientRect()
        const contentRetryOverlap =
          contentRect.left < retryRect.right &&
          contentRect.right > retryRect.left &&
          contentRect.top < retryRect.bottom &&
          contentRect.bottom > retryRect.top
        return {
          tableWidth: tableRect.width,
          bannerWidth: bannerRect.width,
          contentWidth: contentRect.width,
          contentRetryOverlap,
        }
      })
      expect(feedbackGeometry).not.toBeNull()
      expect(feedbackGeometry!.bannerWidth).toBeGreaterThanOrEqual(
        feedbackGeometry!.tableWidth * 0.75,
      )
      expect(feedbackGeometry!.contentWidth).toBeGreaterThan(320)
      expect(feedbackGeometry!.contentRetryOverlap).toBe(false)
      await listError.getByRole('button', { name: /retry/i }).click()
      await expect.poll(() => attempts.get(listAllowed.id) ?? 0).toBe(2)
      await expect(page).toHaveURL(new RegExp(`/tasks/task-from-${listAllowed.id}$`))

      await page.goto(`${requireDaemon().baseUrl}/scheduled/${detailAllowed.id}`)
      const detailRunNow = page.getByTestId('scheduled-run-now')
      await detailRunNow.click()
      expect(attempts.get(detailAllowed.id) ?? 0).toBe(0)
      await expect(detailRunNow).toHaveAccessibleName(/confirm/i)
      await detailRunNow.click()
      await expect.poll(() => attempts.get(detailAllowed.id) ?? 0).toBe(1)
      await expect(detailRunNow).toBeDisabled()
      detailGate.release()

      const detailError = page.getByTestId('scheduled-run-now-error')
      await expect(detailError).toBeVisible()
      await detailError.getByRole('button', { name: /retry/i }).click()
      await expect.poll(() => attempts.get(detailAllowed.id) ?? 0).toBe(2)
      await expect(page).toHaveURL(new RegExp(`/tasks/task-from-${detailAllowed.id}$`))
    } finally {
      listGate.release()
      detailGate.release()
    }
  })

  test('Changes keeps group, file, and viewed keyboard semantics separate', async ({ page }) => {
    const taskId = await seedChangesTask()
    await page.route(`**/api/tasks/${taskId}/diff`, async (route) => {
      await route.fulfill({
        json: {
          diff: CHANGES_DIFF,
          baseCommit: '1111111111111111111111111111111111111111',
          truncated: false,
        },
      })
    })
    await page.route(`**/api/tasks/${taskId}/structural-diff?*`, async (route) => {
      await route.fulfill({ json: changesStructuralFixture(taskId) })
    })
    await page.route(`**/api/tasks/${taskId}/change-narrative`, async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue()
        return
      }
      await route.fulfill({
        status: 404,
        json: { code: 'narrative-not-found', message: 'No narrative yet.' },
      })
    })

    await primePage(page)
    await page.goto(`${requireDaemon().baseUrl}/tasks/${taskId}?tab=changes`)
    const panel = page.getByTestId('change-review')
    await expect(panel).toBeVisible()
    await expect(panel.getByTestId('change-group')).toHaveCount(3)
    expect(await panel.getByRole('tablist').count()).toBe(0)
    expect(await panel.getByRole('tab').count()).toBe(0)

    const fileButtons = panel.locator('.changes__file-tab')
    await expect(fileButtons).toHaveCount(6)
    const firstFile = fileButtons.first()
    const secondFile = fileButtons.nth(1)
    const lastFile = fileButtons.last()
    await firstFile.focus()
    await firstFile.press('ArrowDown')
    await expect(secondFile).toBeFocused()
    await expect(secondFile).toHaveAttribute('aria-current', 'true')

    const selectedBeforeGroupKey = await secondFile.getAttribute('title')
    const firstGroup = panel.getByTestId('change-group').first()
    // Keep a stable locator across the expanded → collapsed state change;
    // a getByRole({ expanded: true }) locator intentionally stops matching
    // after the click and would turn a successful focus restore into a false
    // "element not found" failure.
    const groupHeader = firstGroup.locator('.changes__group-header')
    await expect(groupHeader).toHaveAttribute('aria-expanded', 'true')
    await groupHeader.focus()
    await groupHeader.press('End')
    await expect(groupHeader).toBeFocused()
    await expect(panel.locator('.changes__file-tab[aria-current="true"]')).toHaveAttribute(
      'title',
      selectedBeforeGroupKey ?? '',
    )

    await firstFile.focus()
    await firstFile.press('End')
    await expect(lastFile).toBeFocused()
    await expect(lastFile).toHaveAttribute('aria-current', 'true')
    await firstFile.focus()
    await firstFile.press('Enter')
    await expect(firstFile).toHaveAttribute('aria-current', 'true')

    const viewedCheckbox = firstGroup.getByRole('checkbox').first()
    await viewedCheckbox.focus()
    await viewedCheckbox.press(' ')
    await expect(viewedCheckbox).toBeChecked()
    await expect(firstFile).toHaveAttribute('aria-current', 'true')
    await expect(panel.getByTestId('diff-viewed-progress')).toContainText(/1\s*\/\s*6|已看\s*1/)

    // Programmatic activation preserves the checkbox as activeElement until
    // the disclosure handler applies its explicit focus restoration.
    await groupHeader.evaluate((element) => element.click())
    await expect(groupHeader).toBeFocused()
    await expect(groupHeader).toHaveAttribute('aria-expanded', 'false')
    await expectNoSeriousAxeViolations(page, '[data-testid="change-review"]')
  })

  test('RFC-258: identifier click → symbol menu → jump to an out-of-diff definition → breadcrumb back', async ({
    page,
  }) => {
    const taskId = await seedChangesTask()
    await page.route(`**/api/tasks/${taskId}/diff`, async (route) => {
      await route.fulfill({
        json: {
          diff: CHANGES_DIFF,
          baseCommit: '1111111111111111111111111111111111111111',
          truncated: false,
        },
      })
    })
    await page.route(`**/api/tasks/${taskId}/structural-diff?*`, async (route) => {
      await route.fulfill({ json: changesStructuralFixture(taskId) })
    })
    await page.route(`**/api/tasks/${taskId}/change-narrative`, async (route) => {
      await route.fulfill({
        status: 404,
        json: { code: 'narrative-not-found', message: 'No narrative yet.' },
      })
    })
    // the definition lives OUTSIDE the diff — the read-only viewer must open it
    await page.route(`**/api/tasks/${taskId}/code-intel?*`, async (route) => {
      await route.fulfill({
        json: {
          requestedEngine: 'baseline',
          engine: 'baseline',
          symbol: 'accountState',
          definitions: [
            {
              repoKey: '',
              filePath: 'src/lib/state.ts',
              side: 'worktree',
              startLine: 2,
            },
          ],
          references: [],
        },
      })
    })
    await page.route(`**/api/tasks/${taskId}/file-content?*`, async (route) => {
      const url = new URL(route.request().url())
      if (url.searchParams.get('path') === 'src/lib/state.ts') {
        await route.fulfill({
          json: {
            exists: true,
            content: '// state module\nexport const accountState = 1\n',
            size: 44,
          },
        })
        return
      }
      await route.continue()
    })

    await primePage(page)
    await page.goto(`${requireDaemon().baseUrl}/tasks/${taskId}?tab=changes`)
    const panel = page.getByTestId('change-review')
    await expect(panel).toBeVisible()

    // select the account.ts entry, then click the identifier inside its added
    // row (real caret APIs resolve the column)
    await panel.locator('.changes__file-tab[title="src/ui/account.ts"]').click()
    const addedRow = panel.locator('[data-hunkrow]', { hasText: 'accountState' }).nth(1)
    await addedRow.getByText(/accountState/).click()
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()
    await menu.getByRole('menuitem', { name: /state\.ts:2/ }).click()

    // out-of-diff read-only viewer, focused on the definition line
    await expect(page.locator('.code-viewer')).toBeVisible()
    await expect(page.getByText(/任务外文件|Outside the diff/)).toBeVisible()
    const crumbs = page.getByTestId('code-nav-crumbs')
    await expect(crumbs).toBeVisible()

    // breadcrumb returns to the pre-jump hunk view
    await crumbs.getByRole('button', { name: /返回|Back/ }).click()
    await expect(page.locator('.code-viewer')).toBeHidden()
    await expect(panel.locator('.changes__diff')).toBeVisible()
  })

  test('736 zh-CN Inbox keeps long known content when the peer source fails', async ({ page }) => {
    await createAgent('rfc250-inbox-non-first-run-agent')
    const longWorkflowName =
      '跨区域发布准备与客户数据迁移回滚演练工作流需要保留完整上下文并明确展示当前负责人和所有待处理风险'.repeat(
        3,
      )
    let reviewCalls = 0
    let clarifyCalls = 0
    let allowClarifySuccess = false
    await page.route('**/api/reviews?status=pending', async (route) => {
      reviewCalls += 1
      await route.fulfill({
        json: [
          {
            nodeRunId: 'rfc250-review-run',
            taskId: 'rfc250-review-task',
            taskName: 'RFC-250 长内容任务',
            workflowId: 'rfc250-review-workflow',
            workflowName: longWorkflowName,
            reviewNodeId: 'review-node',
            title: '请复核交互完整性与恢复路径',
            description: '',
            currentVersionIndex: 1,
            reviewIteration: 0,
            decision: 'pending',
            awaitingReview: true,
            shardKey: null,
            createdAt: 1_700_000_000_000,
            decidedAt: null,
          },
        ],
      })
    })
    await page.route('**/api/clarify?status=awaiting_human', async (route) => {
      clarifyCalls += 1
      // Automatic/background retries must not make the warning disappear.
      // Only the user's explicit source-scoped retry opens this gate.
      if (!allowClarifySuccess) {
        await route.fulfill({
          status: 503,
          json: { code: 'clarify-unavailable', message: 'Clarify unavailable' },
        })
        return
      }
      await route.fulfill({ json: [] })
    })

    await setDaemonLanguage('zh-CN')
    await primePage(page, {
      viewport: { width: 736, height: 900 },
      language: 'zh-CN',
    })
    await page.goto(requireDaemon().baseUrl)
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')

    const inbox = page.getByTestId('homepage-section-inbox')
    const row = page.getByTestId('inbox-preview-review-rfc250-review-run')
    await expect(inbox).toBeVisible()
    await expect(row).toBeVisible()
    await expect(page.getByTestId('inbox-preview-empty')).toBeHidden()
    const partialWarning = page.getByTestId('inbox-preview-error-clarify')
    await expect(partialWarning).toBeVisible({ timeout: 15_000 })
    await expect(partialWarning).toHaveClass(/notice-banner--warning/)
    await expect(partialWarning).not.toHaveClass(/error-banner/)

    const subtitle = row.locator('.inbox-row__subtitle')
    await expect(subtitle).toHaveText(longWorkflowName)
    const longTextGeometry = await subtitle.evaluate((element) => {
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return {
        whiteSpace: style.whiteSpace,
        wraps: rect.height > Number.parseFloat(style.fontSize) * 1.5,
        fits: element.scrollWidth <= element.clientWidth + 1,
      }
    })
    expect(longTextGeometry.whiteSpace).not.toBe('nowrap')
    expect(longTextGeometry.wraps).toBe(true)
    expect(longTextGeometry.fits).toBe(true)
    await expectNoHorizontalOverflow(page, inbox)

    const rowBox = await row.boundingBox()
    expect(rowBox).not.toBeNull()
    expect(rowBox!.x).toBeGreaterThanOrEqual(0)
    expect(rowBox!.x + rowBox!.width).toBeLessThanOrEqual(736)
    await expectNoSeriousAxeViolations(page, '[data-testid="homepage-section-inbox"]')

    const retry = partialWarning.locator('button')
    await expect(retry).toHaveCount(1)
    await expect(retry).toBeVisible()
    const clarifyCallsBeforeRetry = clarifyCalls
    const reviewCallsBeforeRetry = reviewCalls
    allowClarifySuccess = true
    await retry.click()
    await expect.poll(() => clarifyCalls).toBeGreaterThan(clarifyCallsBeforeRetry)
    await expect(partialWarning).toBeHidden()
    expect(reviewCalls).toBe(reviewCallsBeforeRetry)
    await expect(row).toBeVisible()
  })
})

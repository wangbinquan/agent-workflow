// RFC-349 T9 — the browser is an adapter over the one durable migration
// operation. Real PostgreSQL copy/crash/compiled evidence lives in the hosted
// RFC-349 workflow; this journey isolates the user contract so a slow external
// server cannot hide duplicate dispatch, restart recovery, rollback-horizon or
// artifact-download regressions in the Settings surface.

import { expect, test, type Page, type Route } from '@playwright/test'

import { startDaemon, type DaemonHandle } from './harness'

test.setTimeout(120_000)

let daemon: DaemonHandle

const DIGEST = `sha256:${'a'.repeat(64)}`
const TARGET = Object.freeze({
  provider: 'postgresql' as const,
  urlEnv: 'AGENT_WORKFLOW_DATABASE_URL',
  poolMax: 16,
  connectTimeoutMs: 10_000,
  statementTimeoutMs: 60_000,
  idleTimeoutMs: 30_000,
})

type MigrationStatus = ReturnType<typeof status>

function status(input: {
  readonly revision: number
  readonly phase: 'copying' | 'accepting-writes' | 'finalized'
  readonly failure?: boolean
  readonly firstLiveWriteAt?: number | null
}): {
  readonly operationId: string
  readonly revision: number
  readonly phase: 'copying' | 'accepting-writes' | 'finalized'
  readonly sourceGenerationId: string
  readonly targetProvider: 'postgresql'
  readonly targetUrlEnv: string
  readonly target: typeof TARGET
  readonly targetDatabaseFingerprint: string
  readonly tableCounts: { readonly source: 184; readonly active: 178; readonly archiveOnly: 6 }
  readonly progress: {
    readonly table: string | null
    readonly chunk: number
    readonly tablesCompleted: number
    readonly tablesTotal: 184
    readonly rowsCopied: number
    readonly bytesCopied: number
    readonly lastMigrationKey: readonly string[]
  }
  readonly failure: {
    readonly phase: string
    readonly category: string
    readonly detailCode: string
    readonly retryable: true
    readonly failedAt: number
    readonly retryCount: number
    readonly nextRetryAt: null
  } | null
  readonly cancelEligible: boolean
  readonly resumeEligible: boolean
  readonly rollback: {
    readonly eligible: boolean
    readonly reason: 'pointer-not-switched' | 'reverse-migration-required' | 'operation-finalized'
  }
  readonly firstLiveWriteAt: number | null
  readonly rolledBackAt: null
  readonly rollbackReceiptDigest: null
  readonly createdAt: number
  readonly updatedAt: number
} {
  const liveWriteAt = input.firstLiveWriteAt ?? null
  const finalized = input.phase === 'finalized'
  const cutOver = input.phase === 'accepting-writes' || finalized
  return Object.freeze({
    operationId: 'dbm_e2e00001',
    revision: input.revision,
    phase: input.phase,
    sourceGenerationId: 'dbg_e2e00001',
    targetProvider: 'postgresql',
    targetUrlEnv: TARGET.urlEnv,
    target: TARGET,
    targetDatabaseFingerprint: 'postgresql:e2e-target',
    tableCounts: { source: 184, active: 178, archiveOnly: 6 },
    progress: {
      table: input.phase === 'copying' ? 'tasks' : null,
      chunk: input.phase === 'copying' ? 7 : 0,
      tablesCompleted: input.phase === 'copying' ? 40 : 184,
      tablesTotal: 184,
      rowsCopied: input.phase === 'copying' ? 12_345 : 98_765,
      bytesCopied: input.phase === 'copying' ? 456_789 : 1_234_567,
      lastMigrationKey: input.phase === 'copying' ? ['task-012345'] : [],
    },
    failure:
      input.failure === true
        ? {
            phase: 'copying',
            category: 'target-transient',
            detailCode: 'postgresql-connection-reset',
            retryable: true,
            failedAt: 1_000,
            retryCount: 1,
            nextRetryAt: null,
          }
        : null,
    cancelEligible: input.phase === 'copying',
    resumeEligible: input.failure === true,
    rollback: finalized
      ? { eligible: false, reason: 'operation-finalized' }
      : cutOver && liveWriteAt !== null
        ? { eligible: false, reason: 'reverse-migration-required' }
        : { eligible: false, reason: 'pointer-not-switched' },
    firstLiveWriteAt: liveWriteAt,
    rolledBackAt: null,
    rollbackReceiptDigest: null,
    createdAt: 100,
    updatedAt: 100 + input.revision,
  })
}

async function primeToken(page: Page): Promise<void> {
  await page.addInitScript(
    ({ url, token }) => {
      window.localStorage.setItem('agent-workflow.baseUrl', url)
      window.localStorage.setItem('agent-workflow.token', token)
      window.localStorage.setItem('aw-language', 'en-US')
    },
    { url: daemon.baseUrl, token: daemon.token },
  )
}

async function json(route: Route, body: unknown, statusCode = 200): Promise<void> {
  await route.fulfill({
    status: statusCode,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

async function confirmMigration(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog', { name: 'Start the database migration?' })
  await expect(dialog).toBeVisible()
  await dialog.getByTestId('confirm-input').fill('MIGRATE')
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect(dialog).toBeHidden()
}

test.beforeAll(async () => {
  daemon = await startDaemon()
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

test('one click is idempotent, reload resumes, cutover closes rollback, and receipts remain downloadable', async ({
  page,
}) => {
  await primeToken(page)
  await page.setViewportSize({ width: 390, height: 844 })

  let current: MigrationStatus | null = null
  let liveProvider: 'sqlite' | 'postgresql' = 'sqlite'
  const starts: Array<Record<string, unknown>> = []
  const actions: string[] = []

  await page.route('**/api/database**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    if (request.method() === 'GET' && path === '/api/database') {
      await json(route, {
        provider: liveProvider,
        generationId: liveProvider === 'sqlite' ? 'dbg_e2e00001' : 'dbg_e2e00002',
        schemaDigest: DIGEST,
        databaseFingerprint:
          liveProvider === 'sqlite' ? 'sqlite:e2e-source' : 'postgresql:e2e-target',
        serverVersion: liveProvider === 'sqlite' ? null : 'PostgreSQL 17.4',
        operationId: current?.operationId ?? null,
        target: current === null ? null : TARGET,
        source: {
          databaseFingerprint: 'sqlite:e2e-source',
          fileBytes: 1_234_567,
          totalRows: 98_765,
        },
        tableCounts: { source: 184, active: 178, archiveOnly: 6 },
      })
      return
    }
    if (request.method() === 'GET' && path === '/api/database/migrations') {
      await json(route, { operations: current === null ? [] : [current] })
      return
    }
    if (request.method() === 'POST' && path === '/api/database/migrations/preflight') {
      const body = request.postDataJSON() as { target: unknown }
      expect(body).toEqual({ target: TARGET })
      expect(JSON.stringify(body)).not.toContain('postgresql://')
      await json(route, {
        ok: true,
        databaseFingerprint: 'postgresql:e2e-target',
        serverMajor: 17,
        serverVersionNum: 170_004,
        serverEncoding: 'UTF8',
        timezone: 'UTC',
        databaseBytes: 8_192,
        targetState: 'empty',
        applicationTableCount: 0,
        metadataTableCount: 0,
        sourceDatabaseFingerprint: 'sqlite:e2e-source',
        sourceBytes: 1_234_567,
        sourceRows: 98_765,
        tableCounts: { source: 184, active: 178, archiveOnly: 6 },
      })
      return
    }
    if (request.method() === 'POST' && path === '/api/database/migrations') {
      const body = request.postDataJSON() as Record<string, unknown>
      starts.push(body)
      current = status({ revision: starts.length, phase: 'copying', failure: true })
      await json(route, current, 202)
      return
    }
    const actionMatch = path.match(/^\/api\/database\/migrations\/([^/]+)\/(resume|finalize)$/)
    if (request.method() === 'POST' && actionMatch !== null) {
      const [, operationId, action] = actionMatch
      expect(operationId).toBe('dbm_e2e00001')
      actions.push(action!)
      if (action === 'resume') {
        liveProvider = 'postgresql'
        current = status({
          revision: 3,
          phase: 'accepting-writes',
          firstLiveWriteAt: 2_000,
        })
      } else {
        current = status({ revision: 4, phase: 'finalized', firstLiveWriteAt: 2_000 })
      }
      await json(route, current)
      return
    }
    const artifactMatch = path.match(
      /^\/api\/database\/migrations\/([^/]+)\/artifacts\/(legacy-archive|receipt)$/,
    )
    if (request.method() === 'GET' && artifactMatch !== null) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ operationId: artifactMatch[1], kind: artifactMatch[2] }),
      })
      return
    }
    await route.continue()
  })

  await page.goto(`${daemon.baseUrl}/settings?tab=database`)
  await expect(page.getByTestId('database-migration-settings')).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Test target' }).click()
  await expect(page.getByText('Target preflight passed')).toBeVisible()

  await page.getByRole('button', { name: 'Detect and migrate' }).click()
  await confirmMigration(page)
  await expect(page.getByText('postgresql-connection-reset')).toBeVisible()

  // A repeated user action is allowed to reach the durable API, but it must be
  // byte-identical and therefore resolve to the same operation rather than
  // constructing a browser-local second identity.
  await page.getByRole('button', { name: 'Detect and migrate' }).click()
  await confirmMigration(page)
  expect(starts).toHaveLength(2)
  expect(starts[1]).toEqual(starts[0])
  expect(String(starts[0]?.idempotencyKey)).toMatch(/^database-migration:v1:[a-f0-9]{64}$/)
  expect(JSON.stringify(starts[0])).not.toContain('postgresql://')

  await page.reload()
  await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Resume' }).click()
  await expect(page.getByText('Live provider').locator('..')).toContainText('postgresql')
  await expect(page.getByText(/PostgreSQL accepted a business write/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Roll back to SQLite' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Test target' })).toBeDisabled()

  await page.getByRole('button', { name: 'Finalize migration' }).click()
  const finalizeDialog = page.getByRole('dialog', { name: 'Finalize the migration?' })
  await finalizeDialog.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect(finalizeDialog).toBeHidden()
  expect(actions).toEqual(['resume', 'finalize'])

  for (const label of ['Download legacy archive manifest', 'Download final receipt']) {
    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: label }).click()
    const download = await downloadPromise
    await expect(download.suggestedFilename()).toMatch(
      /dbm_e2e00001-(legacy-archive|receipt)\.json/,
    )
  }

  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    'database migration settings overflow the 390px viewport',
  ).toBe(true)
})

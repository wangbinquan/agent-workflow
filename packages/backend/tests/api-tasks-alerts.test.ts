// RFC-053 PR-E — GET /api/tasks/:id/alerts.
//
// Returns currently-open lifecycle_alerts for a task in detected_at ASC
// order. Empty when no alerts. 401 without bearer.

import { afterEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { resolve } from 'node:path'
import { ulid } from 'ulid'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { lifecycleAlerts, tasks, workflows } from '../src/db/schema'
import { createApp } from '../src/server'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { describeEachProvider } from './helpers/eachProvider'
import {
  createProviderHttpApplication,
  type ProviderHttpApplication,
} from './helpers/providerHttpApplication'
import { mkdtempSync as createFixtureDirectory, rmSync as removeFixtureDirectory } from 'node:fs'
import { tmpdir as fixtureTmpDirectory } from 'node:os'
import { join as joinFixturePath } from 'node:path'

const TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

afterEach(() => {
  resetBroadcastersForTests()
})

function buildApp(): { db: DbClient; app: Hono } {
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: TOKEN,
    configPath: '',
    opencodeVersion: '1.15.0',
    dbVersion: 1,
    db,
  })
  return { db, app }
}

async function seedTask(
  db: ProviderNeutralDatabase,
  lineage?: (id: string) => { executionLineageId: string; lineageSlotPathJson: string },
): Promise<string> {
  const taskId = `task_${ulid()}`
  const workflowId = `wf_${taskId}`
  await db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}',
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 't',
    workflowId,
    workflowSnapshot: '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}',
    repoPath: '/tmp',
    worktreePath: '/tmp',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
    ...(lineage?.(taskId) ?? {}),
  })
  return taskId
}

async function alerts(app: Hono, taskId: string, opts: { auth?: boolean } = {}): Promise<Response> {
  const auth = opts.auth ?? true
  return app.request(`/api/tasks/${taskId}/alerts`, {
    headers: auth ? { Authorization: `Bearer ${TOKEN}` } : {},
  })
}

describe('GET /api/tasks/:id/alerts', () => {
  test('401 without bearer', async () => {
    const { db, app } = buildApp()
    const taskId = await seedTask(db)
    const res = await alerts(app, taskId, { auth: false })
    expect(res.status).toBe(401)
  })

  registerProviderApplication((buildApp, seedTask) => {
    test('empty when no alerts', async () => {
      const { db, app } = await buildApp()
      const taskId = await seedTask(db)
      const res = await alerts(app, taskId)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { alerts: unknown[] }
      expect(body.alerts).toEqual([])
    })
  })

  registerProviderApplication((buildApp, seedTask) => {
    test('returns open alerts in detected_at ASC order', async () => {
      const { db, app } = await buildApp()
      const taskId = await seedTask(db)
      // Three alerts (two open + one resolved) with intentionally
      // out-of-order detected_at so we can lock ordering.
      await db.insert(lifecycleAlerts).values({
        id: 'a-newer',
        taskId,
        rule: 'S4',
        severity: 'warning',
        detail: JSON.stringify({ rule: 'S4', pendingForMs: 600_000 }),
        detectedAt: 2000,
        resolvedAt: null,
      })
      await db.insert(lifecycleAlerts).values({
        id: 'a-older',
        taskId,
        rule: 'R1',
        severity: 'error',
        detail: JSON.stringify({ rule: 'R1' }),
        detectedAt: 1000,
        resolvedAt: null,
      })
      await db.insert(lifecycleAlerts).values({
        id: 'a-resolved',
        taskId,
        rule: 'S1',
        severity: 'warning',
        detail: '{"rule":"S1"}',
        detectedAt: 1500,
        resolvedAt: 1700,
      })
      const res = await alerts(app, taskId)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        alerts: Array<{ id: string; rule: string; severity: string; detail: unknown }>
      }
      expect(body.alerts.map((a) => a.id)).toEqual(['a-older', 'a-newer'])
      expect(body.alerts[0]!.rule).toBe('R1')
      expect(body.alerts[0]!.severity).toBe('error')
      // detail JSON is parsed.
      expect(body.alerts[1]!.detail).toEqual({ rule: 'S4', pendingForMs: 600_000 })
    })
  })

  registerProviderApplication((buildApp, seedTask) => {
    test('malformed detail JSON degrades gracefully', async () => {
      const { db, app } = await buildApp()
      const taskId = await seedTask(db)
      await db.insert(lifecycleAlerts).values({
        id: 'a-bad',
        taskId,
        rule: 'R1',
        severity: 'warning',
        detail: 'not-valid-json',
        detectedAt: 100,
        resolvedAt: null,
      })
      const res = await alerts(app, taskId)
      const body = (await res.json()) as { alerts: Array<{ detail: { raw?: string } }> }
      expect(body.alerts[0]!.detail.raw).toBe('not-valid-json')
    })
  })
})

// RFC-359 W49: keep native fixtures while running the original selected calls on each provider.
function registerProviderApplication(
  register: (
    buildApp: () => Promise<{ db: ProviderNeutralDatabase; app: Hono }>,
    seedTaskForCase: typeof seedTask,
  ) => void,
): void {
  describeEachProvider('provider', (harness) => {
    describe('application lifetime', () => {
      let application: ProviderHttpApplication | undefined
      let ownedHome: string | undefined
      let previousHome: string | undefined
      let homeAssigned = false
      async function buildApp() {
        ownedHome = createFixtureDirectory(
          joinFixturePath(fixtureTmpDirectory(), 'rfc359-w49-api-tasks-alerts-'),
        )
        previousHome = process.env.AGENT_WORKFLOW_HOME
        process.env.AGENT_WORKFLOW_HOME = ownedHome
        homeAssigned = true
        const appHome = ownedHome
        application = await createProviderHttpApplication(harness, {
          token: TOKEN,
          configPath: joinFixturePath(appHome, 'config.json'),
          opencodeVersion: '1.15.0',
          dbVersion: 1,
          appHome,
        })
        return { db: harness.db, app: application.app }
      }
      afterEach(async () => {
        try {
          await application?.dispose()
        } finally {
          application = undefined
          if (homeAssigned) {
            if (previousHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
            else process.env.AGENT_WORKFLOW_HOME = previousHome
          }
          homeAssigned = false
          if (ownedHome !== undefined)
            removeFixtureDirectory(ownedHome, { recursive: true, force: true })
          ownedHome = undefined
        }
      })
      register(buildApp, (db) => seedTask(db, providerTaskLineage))
    })
  })
}

function providerTaskLineage(id: string) {
  return {
    executionLineageId: id,
    lineageSlotPathJson: JSON.stringify([
      { stableNodeKey: 'task-root', frozenOccurrenceKey: id, workflowRevision: null },
    ]),
  }
}

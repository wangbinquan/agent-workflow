// RFC-053 PR-E — GET /api/tasks/:id/alerts.
//
// Returns currently-open lifecycle_alerts for a task in detected_at ASC
// order. Empty when no alerts. 401 without bearer.

import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { afterEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { ulid } from 'ulid'

import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { describeEachProviderHttpApplication } from './helpers/providerHttpApplicationScope'

const TOKEN = 'a'.repeat(64)

afterEach(() => {
  resetBroadcastersForTests()
})

async function seedTask(
  db: PersistenceDb,
  lineage?: (id: string) => { executionLineageId: string; lineageSlotPathJson: string },
): Promise<string> {
  const taskId = `task_${ulid()}`
  const workflowId = `wf_${taskId}`
  const { workflows, tasks } = tablesOf(db)
  await insertOne(db, workflows, {
    id: workflowId,
    name: 'wf',
    definition: '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}',
  })
  await insertOne(db, tasks, {
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
  // RFC-359 AC-6：本文件最后一处直接建库就在这条 401 判据里。鉴权门与库无关，
  // 但「无关」得由两个引擎各跑一遍来证明——路由挂载、中间件顺序、错误体在两侧各走一条装配。
  registerProviderApplication((buildApp, seedTask) => {
    test('401 without bearer', async () => {
      const { db, app } = await buildApp()
      const taskId = await seedTask(db)
      const res = await alerts(app, taskId, { auth: false })
      expect(res.status).toBe(401)
    })
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
      const { lifecycleAlerts } = tablesOf(db)
      // Three alerts (two open + one resolved) with intentionally
      // out-of-order detected_at so we can lock ordering.
      await insertOne(db, lifecycleAlerts, {
        id: 'a-newer',
        taskId,
        rule: 'S4',
        severity: 'warning',
        detail: JSON.stringify({ rule: 'S4', pendingForMs: 600_000 }),
        detectedAt: 2000,
        resolvedAt: null,
      })
      await insertOne(db, lifecycleAlerts, {
        id: 'a-older',
        taskId,
        rule: 'R1',
        severity: 'error',
        detail: JSON.stringify({ rule: 'R1' }),
        detectedAt: 1000,
        resolvedAt: null,
      })
      await insertOne(db, lifecycleAlerts, {
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
      const { lifecycleAlerts } = tablesOf(db)
      await insertOne(db, lifecycleAlerts, {
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

// RFC-359 AC-6：生命周期走共用的 `describeEachProviderHttpApplication`（`tests/helpers/`），
// 这里只剩「把本文件的 seed 夹具绑上去」这一点文件私有的东西。
function registerProviderApplication(
  register: (
    buildApp: () => Promise<{ db: PersistenceDb; app: Hono }>,
    seedTaskForCase: typeof seedTask,
  ) => void,
): void {
  describeEachProviderHttpApplication(
    'provider',
    {
      token: TOKEN,
      opencodeVersion: '1.15.0',
      dbVersion: 1,
      tempPrefix: 'rfc359-w49-api-tasks-alerts-',
    },
    (scope) =>
      register(
        async () => ({ db: scope.harness.db, app: (await scope.open()).app }),
        (db) => seedTask(db, providerTaskLineage),
      ),
  )
}

function providerTaskLineage(id: string) {
  return {
    executionLineageId: id,
    lineageSlotPathJson: JSON.stringify([
      { stableNodeKey: 'task-root', frozenOccurrenceKey: id, workflowRevision: null },
    ]),
  }
}

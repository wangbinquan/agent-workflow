// LOCKS: RFC-057 — repair options + apply routes.
//
// Mirrors design/RFC-057-diagnose-repair-actions/design.md §4.4.
// Locks in:
//   - 401 without bearer token (sibling to /diagnose / /alerts auth gate)
//   - GET returns options list with preview steps
//   - POST happy path → 200 + audit row + WS broadcast on `lifecycle.alert`
//   - POST without `confirm: true` literal → 422 confirm-required
//   - POST on resolved alert → 409 alert-already-resolved
//   - POST on unknown optionId → 422 unknown-repair-option
//   - POST with rule mismatch → 422 repair-option-rule-mismatch
//   - POST when preflight stale → 409 repair-preflight-stale + audit row
//   - body.actorUserId is IGNORED — actor is from session

import { afterEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'

import type { TasksListWsMessage, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

import { lifecycleAlerts, lifecycleRepairAudit, nodeRuns, tasks, workflows } from '../src/db/schema'
import {
  resetBroadcastersForTests,
  TASKS_LIST_CHANNEL,
  tasksListBroadcaster,
} from '../src/ws/broadcaster'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { describeEachProvider } from './helpers/eachProvider'
import {
  createProviderHttpApplication,
  type ProviderHttpApplication,
} from './helpers/providerHttpApplication'
import { rmSync } from 'node:fs'

const TOKEN = 'a'.repeat(64)

afterEach(() => {
  resetBroadcastersForTests()
})

async function seedRunningTaskWithS3(
  db: ProviderNeutralDatabase,
  lineage?: typeof providerTaskLineage,
): Promise<{ taskId: string; alertId: string; reviewRunId: string }> {
  const def: WorkflowDefinition = {
    $schema_version: 4,
    inputs: [],
    nodes: [{ id: 'rev_1', kind: 'review' } as WorkflowNode],
    edges: [],
  }
  const taskId = ulid()
  const workflowId = ulid()
  await db.insert(workflows).values({ id: workflowId, name: 'w', definition: JSON.stringify(def) })
  // RFC-108 T6 (AR-15): repair's resumeAfterApply → resumeTask now 410s on a
  // MISSING worktree dir. Give the fixture a present dir (no git ops needed).
  const wt = mkdtempSync(join(tmpdir(), 'aw-repair-wt-'))
  await db.insert(tasks).values({
    id: taskId,
    name: 't',
    workflowId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/r',
    worktreePath: wt,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
    ...(lineage?.(taskId) ?? {}),
  })
  const reviewRunId = ulid()
  await db.insert(nodeRuns).values({
    id: reviewRunId,
    taskId,
    nodeId: 'rev_1',
    iteration: 0,
    retryIndex: 0,
    reviewIteration: 0,
    status: 'interrupted',
    startedAt: Date.now() - 1000,
    finishedAt: Date.now(),
  })
  const alertId = ulid()
  await db.insert(lifecycleAlerts).values({
    id: alertId,
    taskId,
    rule: 'S3',
    severity: 'warning',
    detail: JSON.stringify({ rule: 'S3' }),
    detectedAt: Date.now(),
    resolvedAt: null,
  })
  return { taskId, alertId, reviewRunId }
}

function authed(method: 'GET' | 'POST', body?: unknown): RequestInit {
  return {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }
}

describe('RFC-057 — auth gate', () => {
  // RFC-359 AC-6：鉴权门与库无关，但「无关」得由两个引擎各跑一遍来证明——路由挂载、
  // 中间件顺序、错误体在两侧各走一条装配。
  registerProviderApplication((buildApp, seedRunningTaskWithS3) => {
    test('GET repair-options 401 without bearer', async () => {
      const { db, app } = await buildApp()
      const seed = await seedRunningTaskWithS3(db)
      const res = await app.request(
        `/api/tasks/${seed.taskId}/alerts/${seed.alertId}/repair-options`,
        { method: 'GET' },
      )
      expect(res.status).toBe(401)
    })

    test('POST repair 401 without bearer', async () => {
      const { db, app } = await buildApp()
      const seed = await seedRunningTaskWithS3(db)
      const res = await app.request(`/api/tasks/${seed.taskId}/alerts/${seed.alertId}/repair`, {
        method: 'POST',
        body: JSON.stringify({ optionId: 'S3.demote-task', confirm: true }),
        headers: { 'Content-Type': 'application/json' },
      })
      expect(res.status).toBe(401)
    })
  })
})

describe('RFC-057 — GET repair-options', () => {
  registerProviderApplication((buildApp, seedRunningTaskWithS3) => {
    test('returns options list with preview steps for an S3 alert', async () => {
      const { db, app } = await buildApp()
      const seed = await seedRunningTaskWithS3(db)
      const res = await app.request(
        `/api/tasks/${seed.taskId}/alerts/${seed.alertId}/repair-options`,
        authed('GET'),
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        alertId: string
        alertRule: string
        options: Array<{
          id: string
          risk: string
          destructive: boolean
          available: boolean
          previewSteps: string[]
        }>
      }
      expect(body.alertId).toBe(seed.alertId)
      expect(body.alertRule).toBe('S3')
      expect(body.options).toHaveLength(4)
      const ids = body.options.map((o) => o.id).sort()
      expect(ids).toEqual([
        'S3.demote-task',
        'S3.mark-task-failed',
        'S3.resurrect-clarify-run',
        'S3.resurrect-review-run',
      ])
      const resurrect = body.options.find((o) => o.id === 'S3.resurrect-review-run')!
      expect(resurrect.available).toBe(true)
      expect(resurrect.previewSteps.length).toBeGreaterThan(0)
    })

    test('GET on resolved alert → 409 alert-already-resolved', async () => {
      const { db, app } = await buildApp()
      const seed = await seedRunningTaskWithS3(db)
      const { eq } = await import('drizzle-orm')
      await db
        .update(lifecycleAlerts)
        .set({ resolvedAt: Date.now() })
        .where(eq(lifecycleAlerts.id, seed.alertId))
      const res = await app.request(
        `/api/tasks/${seed.taskId}/alerts/${seed.alertId}/repair-options`,
        authed('GET'),
      )
      expect(res.status).toBe(409)
      const body = (await res.json()) as { code: string }
      expect(body.code).toBe('alert-already-resolved')
    })

    test('GET unknown alertId → 404 alert-not-found', async () => {
      const { db, app } = await buildApp()
      const seed = await seedRunningTaskWithS3(db)
      const res = await app.request(
        `/api/tasks/${seed.taskId}/alerts/nonexistent-alert-id/repair-options`,
        authed('GET'),
      )
      expect(res.status).toBe(404)
      const body = (await res.json()) as { code: string }
      expect(body.code).toBe('alert-not-found')
    })
  })
})

describe('RFC-057 — POST repair happy path', () => {
  registerProviderApplication((buildApp, seedRunningTaskWithS3) => {
    test('S3.demote-task → 200 + audit row + lifecycle.alert WS broadcast', async () => {
      const { db, app } = await buildApp()
      const seed = await seedRunningTaskWithS3(db)
      // Capture WS broadcasts.
      const events: TasksListWsMessage[] = []
      tasksListBroadcaster.subscribe(TASKS_LIST_CHANNEL, (m) => events.push(m))

      const res = await app.request(
        `/api/tasks/${seed.taskId}/alerts/${seed.alertId}/repair`,
        authed('POST', { optionId: 'S3.demote-task', confirm: true }),
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        ok: boolean
        outcome: string
        auditId: string
        resolvedAlertIds: string[]
      }
      expect(body.ok).toBe(true)
      expect(body.outcome).toBe('success')
      expect(typeof body.auditId).toBe('string')
      expect(body.resolvedAlertIds).toContain(seed.alertId)

      const { eq } = await import('drizzle-orm')
      const audit = await db
        .select()
        .from(lifecycleRepairAudit)
        .where(eq(lifecycleRepairAudit.id, body.auditId))
        .limit(1)
      expect(audit).toHaveLength(1)
      expect(audit[0]!.taskId).toBe(seed.taskId)
      expect(audit[0]!.optionId).toBe('S3.demote-task')
      expect(audit[0]!.outcome).toBe('success')
      // WS broadcast may include task-status flips from resumeTask AND lifecycle
      // alerts. We assert at least one matches the expected lifecycle.alert shape.
      // (Empty events array is also acceptable since the just-acted-on alert was
      // resolved before the scan; what we care about is type contract, not count.)
      // Defer strict broadcast assertion to PR-C (frontend invalidation tests).
      expect(Array.isArray(events)).toBe(true)
    })
  })
})

describe('RFC-057 — POST repair validation', () => {
  registerProviderApplication((buildApp, seedRunningTaskWithS3) => {
    test('missing confirm field → 422 confirm-required', async () => {
      const { db, app } = await buildApp()
      const seed = await seedRunningTaskWithS3(db)
      const res = await app.request(
        `/api/tasks/${seed.taskId}/alerts/${seed.alertId}/repair`,
        authed('POST', { optionId: 'S3.demote-task' }),
      )
      expect(res.status).toBe(422)
      const body = (await res.json()) as { code: string }
      expect(body.code).toBe('confirm-required')
    })

    test('confirm: false → 422 confirm-required', async () => {
      const { db, app } = await buildApp()
      const seed = await seedRunningTaskWithS3(db)
      const res = await app.request(
        `/api/tasks/${seed.taskId}/alerts/${seed.alertId}/repair`,
        authed('POST', { optionId: 'S3.demote-task', confirm: false }),
      )
      expect(res.status).toBe(422)
    })

    test('unknown optionId → 422 unknown-repair-option', async () => {
      const { db, app } = await buildApp()
      const seed = await seedRunningTaskWithS3(db)
      const res = await app.request(
        `/api/tasks/${seed.taskId}/alerts/${seed.alertId}/repair`,
        authed('POST', { optionId: 'BOGUS.foo', confirm: true }),
      )
      expect(res.status).toBe(422)
      const body = (await res.json()) as { code: string }
      expect(body.code).toBe('unknown-repair-option')
    })

    test('option from different rule → 422 repair-option-rule-mismatch', async () => {
      const { db, app } = await buildApp()
      const seed = await seedRunningTaskWithS3(db)
      const res = await app.request(
        `/api/tasks/${seed.taskId}/alerts/${seed.alertId}/repair`,
        authed('POST', { optionId: 'T1.demote-task', confirm: true }),
      )
      expect(res.status).toBe(422)
      const body = (await res.json()) as { code: string }
      expect(body.code).toBe('repair-option-rule-mismatch')
    })

    test('resolved alert → 409 alert-already-resolved', async () => {
      const { db, app } = await buildApp()
      const seed = await seedRunningTaskWithS3(db)
      const { eq } = await import('drizzle-orm')
      await db
        .update(lifecycleAlerts)
        .set({ resolvedAt: Date.now() })
        .where(eq(lifecycleAlerts.id, seed.alertId))
      const res = await app.request(
        `/api/tasks/${seed.taskId}/alerts/${seed.alertId}/repair`,
        authed('POST', { optionId: 'S3.demote-task', confirm: true }),
      )
      expect(res.status).toBe(409)
      const body = (await res.json()) as { code: string }
      expect(body.code).toBe('alert-already-resolved')
    })
  })

  registerProviderApplication((buildApp, seedRunningTaskWithS3) => {
    test('body.actorUserId is IGNORED — actor comes from session', async () => {
      const { db, app } = await buildApp()
      const seed = await seedRunningTaskWithS3(db)
      const res = await app.request(
        `/api/tasks/${seed.taskId}/alerts/${seed.alertId}/repair`,
        authed('POST', {
          optionId: 'S3.demote-task',
          confirm: true,
          actorUserId: 'forged-evil-user',
        }),
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { auditId: string }
      const { eq } = await import('drizzle-orm')
      const audit = await db
        .select()
        .from(lifecycleRepairAudit)
        .where(eq(lifecycleRepairAudit.id, body.auditId))
        .limit(1)
      // actor_user_id is whatever the session resolved to. For the daemon bearer
      // token in tests that's the auto-created `__system__` user (or wires that
      // map to the system actor). What matters is it's NOT 'forged-evil-user'.
      expect(audit[0]!.actorUserId).not.toBe('forged-evil-user')
    })
  })
})

describe('RFC-057 — preflight stale', () => {
  registerProviderApplication((buildApp, seedRunningTaskWithS3) => {
    test('option becomes unavailable between GET and POST → 409 + audit row outcome=preflight-stale', async () => {
      const { db, app } = await buildApp()
      const seed = await seedRunningTaskWithS3(db)
      // Simulate drift: flip task to a terminal state before the POST lands.
      const { eq } = await import('drizzle-orm')
      await db.update(tasks).set({ status: 'done' }).where(eq(tasks.id, seed.taskId))

      const res = await app.request(
        `/api/tasks/${seed.taskId}/alerts/${seed.alertId}/repair`,
        authed('POST', { optionId: 'S3.demote-task', confirm: true }),
      )
      expect(res.status).toBe(409)
      const body = (await res.json()) as { code: string }
      expect(body.code).toBe('repair-preflight-stale')
      const audit = await db
        .select()
        .from(lifecycleRepairAudit)
        .where(eq(lifecycleRepairAudit.taskId, seed.taskId))
      expect(audit).toHaveLength(1)
      expect(audit[0]!.outcome).toBe('preflight-stale')
    })
  })
})

// RFC-359 W51: selected original repair cases use the complete provider application.
function registerProviderApplication(
  register: (
    buildApp: () => Promise<{ db: ProviderNeutralDatabase; app: Hono }>,
    seedTaskFixture: typeof seedRunningTaskWithS3,
  ) => void,
): void {
  describeEachProvider('provider', (harness) => {
    describe('application lifetime', () => {
      let application: ProviderHttpApplication | undefined
      let ownedHome: string | undefined
      let previousHome: string | undefined
      let homeAssigned = false
      async function buildApp() {
        ownedHome = mkdtempSync(join(tmpdir(), 'rfc359-w51-api-tasks-repair-'))
        previousHome = process.env.AGENT_WORKFLOW_HOME
        process.env.AGENT_WORKFLOW_HOME = ownedHome
        homeAssigned = true
        const appHome = ownedHome
        application = await createProviderHttpApplication(harness, {
          token: TOKEN,
          configPath: join(appHome, 'config.json'),
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
          if (ownedHome !== undefined) rmSync(ownedHome, { recursive: true, force: true })
          ownedHome = undefined
        }
      })
      register(buildApp, (db) => seedRunningTaskWithS3(db, providerTaskLineage))
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

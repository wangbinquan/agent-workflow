import { afterEach, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'

import {
  MaintenanceStatusSchema,
  type DatabaseRuntimeTelemetry,
  type MaintenanceStatus,
} from '@agent-workflow/shared'

import { createSession } from './helpers/auth/sessionStore'
import type { ProviderNeutralDatabase } from '@/db/query'
import { createUser } from '@/services/users'
import { describeEachProviderHttpApplication } from './helpers/providerHttpApplicationScope'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function adminToken(db: ProviderNeutralDatabase): Promise<string> {
  const user = await createUser(db, {
    username: 'root',
    displayName: 'Root',
    role: 'admin',
    password: 'longEnoughPassword',
  })
  return (await createSession({ db, userId: user.id })).token
}

// RFC-359 AC-6：缺省装配（没有维护服务）在两个引擎上各跑一遍。两个组合根的
// `maintenanceStatus` 都是可选入参，作用域一个都不传，于是两侧都走同一条 fallback。
describeEachProviderHttpApplication(
  'RFC-338 维护状态（双引擎）',
  {
    token: 'a'.repeat(64),
    opencodeVersion: null,
    dbVersion: 1,
    tempPrefix: 'aw-rfc338-status-',
  },
  (scope) => {
    test('returns the exact durable/live projection consumed by Settings', async () => {
      const token = await adminToken(scope.harness.db)
      const status: MaintenanceStatus = {
        version: 1,
        worker: { state: 'ready', lastHeartbeatAt: 200, error: null },
        eventLoop: { samplePeriodMs: 50, windowMs: 30_000, sampleCount: 600, maxGapMs: 51.5 },
        schedule: { kind: 'daily', at: '03:00', timezone: 'Asia/Shanghai' },
        nextRunAt: 300,
        active: {
          runId: 'active',
          cycleKey: 'daily:2026-08-29',
          job: 'retentionSweep',
          startedAt: 150,
          counters: { distillEvents: 2 },
        },
        last: {
          runId: 'last',
          job: 'tokenAuditGc',
          outcome: 'succeeded',
          finishedAt: 100,
          counters: { audits: 10 },
        },
        backlog: [{ runId: 'queued', job: 'eventsArchive', state: 'deferred', since: 175 }],
      }
      const database: DatabaseRuntimeTelemetry = {
        version: 1,
        provider: 'postgresql',
        poolWait: {
          windowMs: 600_000,
          sampleCount: 3,
          acquiredCount: 2,
          failedCount: 1,
          p50Ms: 5,
          p95Ms: 25,
          maxMs: 25,
        },
      }
      // RFC-359 AC-6：两个注入口都从作用域喂进去。PG 根原本把 `databaseTelemetry` 写死成所选
      // 机制自己的遥测，作用域现在传 `input.databaseTelemetry ?? binding.runtime.telemetry`，
      // 于是这条判据（断言路由**原样回显**注入的投影）在两个引擎上是同一件事。
      const app = (
        await scope.open({ maintenanceStatus: () => status, databaseTelemetry: () => database })
      ).app

      const response = await app.request('/api/maintenance/status', {
        headers: { authorization: `Bearer ${token}` },
      })
      expect(response.status).toBe(200)
      expect(MaintenanceStatusSchema.parse(await response.json())).toEqual({ ...status, database })
    })

    test('reports an explicit degraded fallback when an embedding omits the service', async () => {
      const token = await adminToken(scope.harness.db)
      const app = (await scope.open()).app

      const response = await app.request('/api/maintenance/status', {
        headers: { authorization: `Bearer ${token}` },
      })
      expect(MaintenanceStatusSchema.parse(await response.json())).toMatchObject({
        worker: { state: 'degraded', error: 'maintenance-service-not-composed' },
        schedule: { kind: 'hourly' },
        active: null,
        nextRunAt: null,
      })
    })
  },
)

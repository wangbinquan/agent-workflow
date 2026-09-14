import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_CONFIG,
  MaintenanceStatusSchema,
  type DatabaseRuntimeTelemetry,
  type MaintenanceStatus,
} from '@agent-workflow/shared'

import { createSession } from './helpers/auth/sessionStore'
import { createInMemoryDb } from '@/db/client'
import type { ProviderNeutralDatabase } from '@/db/query'
import { createApp } from '@/server'
import { createUser } from '@/services/users'
import { describeEachProviderHttpApplication } from './helpers/providerHttpApplicationScope'
import { MIGRATIONS } from './migration-freeze'

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

// RFC-359 AC-6 例外：单引擎。这条用例注入的是一份**伪造的** `databaseTelemetry`，而
// PostgreSQL 组合根把它写死成所选机制自己的遥测
// （`src/cli/postgresqlDaemonApplication.ts:1929` —— `databaseTelemetry: input.provider.telemetry`），
// 没有任何入参能覆盖它；测试用的 HTTP 作用域也还没把 `maintenanceStatus` / `databaseTelemetry`
// 列进 `ProviderHttpApplicationInput` 的 Pick（`tests/helpers/providerHttpApplication.ts:27-47`）。
// 两处都补上（PG 侧改成 `input.databaseTelemetry ?? input.provider.telemetry`）之后这条就能
// 并进下面的双引擎块，判据一个字都不用动。
describe('RFC-338 maintenance status API', () => {
  test('returns the exact durable/live projection consumed by Settings', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rfc338-status-'))
    roots.push(root)
    const configPath = join(root, 'config.json')
    writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG))
    const db = createInMemoryDb(MIGRATIONS)
    const token = await adminToken(db)
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
    const app = createApp({
      token: 'a'.repeat(64),
      configPath,
      opencodeVersion: null,
      dbVersion: 1,
      db,
      maintenanceStatus: () => status,
      databaseTelemetry: () => database,
    })

    const response = await app.request('/api/maintenance/status', {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.status).toBe(200)
    expect(MaintenanceStatusSchema.parse(await response.json())).toEqual({ ...status, database })
  })
})

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

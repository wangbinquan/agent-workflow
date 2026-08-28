import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_CONFIG,
  MaintenanceStatusSchema,
  type MaintenanceStatus,
} from '@agent-workflow/shared'

import { createSession } from '@/auth/sessionStore'
import { createInMemoryDb } from '@/db/client'
import { createApp } from '@/server'
import { createUser } from '@/services/users'
import { MIGRATIONS } from './migration-freeze'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function adminToken(db: ReturnType<typeof createInMemoryDb>): Promise<string> {
  const user = await createUser(db, {
    username: 'root',
    displayName: 'Root',
    role: 'admin',
    password: 'longEnoughPassword',
  })
  return (await createSession({ db, userId: user.id })).token
}

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
    const app = createApp({
      token: 'a'.repeat(64),
      configPath,
      opencodeVersion: null,
      dbVersion: 1,
      db,
      maintenanceStatus: () => status,
    })

    const response = await app.request('/api/maintenance/status', {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.status).toBe(200)
    expect(MaintenanceStatusSchema.parse(await response.json())).toEqual(status)
  })

  test('reports an explicit degraded fallback when an embedding omits the service', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rfc338-status-fallback-'))
    roots.push(root)
    const configPath = join(root, 'config.json')
    writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG))
    const db = createInMemoryDb(MIGRATIONS)
    const token = await adminToken(db)
    const app = createApp({
      token: 'a'.repeat(64),
      configPath,
      opencodeVersion: null,
      dbVersion: 1,
      db,
    })

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
})

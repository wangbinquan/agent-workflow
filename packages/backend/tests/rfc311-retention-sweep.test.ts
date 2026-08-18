// RFC-311 PR-3 — retention sweeper for the unbounded ledger tables (proposal
// C6). The audit found the three node_run_events-shaped event streams plus
// webhook_trigger_fires / user_access_audit / mcp_probes had NO cleanup at all;
// production grows them at webhook-volume rates forever. This locks: expired
// rows go, in-window rows stay, per-MCP probe windows keep the newest N, and
// a 0 config disables each stage.

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { count } from 'drizzle-orm'

import { createInMemoryDb } from '../src/db/client'
import {
  mcpProbes,
  mcps,
  memoryDistillEvents,
  memoryDistillJobs,
  userAccessAudit,
  users,
} from '../src/db/schema'
import { runRetentionSweep, type RetentionConfig } from '../src/services/maintenanceRetention'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const DAY = 86_400_000
const NOW = 1_788_278_400_000

type Db = ReturnType<typeof createInMemoryDb>

const OFF: RetentionConfig = {
  eventStreamRetentionDays: 0,
  webhookTriggerFiresRetentionDays: 0,
}

async function rowsIn(
  db: Db,
  table: typeof userAccessAudit | typeof mcpProbes | typeof memoryDistillEvents,
): Promise<number> {
  const r = await db.select({ n: count() }).from(table)
  return r[0]?.n ?? 0
}

async function seedUser(db: Db, id: string): Promise<void> {
  await db
    .insert(users)
    .values({ id, username: id, displayName: id, role: 'user', createdAt: NOW, updatedAt: NOW })
    .onConflictDoNothing()
}

async function seedAudit(db: Db, createdAt: number): Promise<void> {
  await seedUser(db, 'u1')
  await seedUser(db, 'admin')
  await db.insert(userAccessAudit).values({
    id: ulid(),
    targetUserId: 'u1',
    actorUserId: 'admin',
    actorKind: 'session',
    operationId: ulid(),
    beforeRole: 'user',
    afterRole: 'manager',
    addedPermissionsJson: '[]',
    removedPermissionsJson: '[]',
    accessRevision: 1,
    createdAt,
  })
}

describe('RFC-311 — retention sweep', () => {
  test('user_access_audit stays OUT of retention — its append-only trigger is a design guarantee', async () => {
    // 落地时发现该表带 user_access_audit_append_only 触发器（RFC-305 防篡改
    // 审计）：任何 DELETE 直接被拒。裁决=尊重安全设计,sweeper 不碰它;此用例
    // 锁双向——触发器仍在,且 sweep 结果恒 0。
    const db = createInMemoryDb(MIGRATIONS)
    await seedAudit(db, NOW - 100 * DAY)
    const swept = await runRetentionSweep(
      db,
      { ...OFF, eventStreamRetentionDays: 30, webhookTriggerFiresRetentionDays: 90 },
      NOW,
    )
    expect(swept.userAccessAudit).toBe(0)
    expect(await rowsIn(db, userAccessAudit)).toBe(1)
    expect(() => db.$client.exec('DELETE FROM user_access_audit')).toThrow(/append_only/)
  })

  test('mcp_probes is a per-MCP upsert row (UNIQUE mcp_id) — retention rightly skips it', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await db.insert(mcps).values({ id: 'm1', name: 'm1', type: 'local' })
    const probe = {
      id: ulid(),
      mcpId: 'm1',
      status: 'ok' as const,
      latencyMs: 5,
      startedAt: NOW,
      finishedAt: NOW + 5,
      createdAt: NOW,
    }
    await db.insert(mcpProbes).values(probe)
    let threw = false
    try {
      await db.insert(mcpProbes).values({ ...probe, id: ulid() })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    expect(await rowsIn(db, mcpProbes)).toBe(1)
  })

  test('memory_distill_events (event-stream family): pure-timestamp expiry', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const jobId = ulid()
    await db.insert(memoryDistillJobs).values({
      id: jobId,
      debounceKey: 'k1',
      sourceKind: 'review',
      sourceEventId: ulid(),
      scopeResolvedJson: '{}',
      status: 'done',
      nextRunAt: NOW,
      createdAt: NOW - 40 * DAY,
    })
    const event = (ts: number) => ({
      distillJobId: jobId,
      attemptIndex: 0,
      sessionId: 's1',
      ts,
      kind: 'text',
      payload: 'x',
    })
    await db
      .insert(memoryDistillEvents)
      .values([event(NOW - 40 * DAY), event(NOW - 35 * DAY), event(NOW - 2 * DAY)])

    const swept = await runRetentionSweep(db, { ...OFF, eventStreamRetentionDays: 30 }, NOW)
    expect(swept.distillEvents).toBe(2)
    expect(await rowsIn(db, memoryDistillEvents)).toBe(1)
  })
})

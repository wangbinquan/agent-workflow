// RFC-311 PR-3 — retention sweeper for the unbounded ledger tables (proposal
// C6). The audit found the three node_run_events-shaped event streams plus
// webhook_trigger_fires / user_access_audit / mcp_probes had NO cleanup at all;
// production grows them at webhook-volume rates forever. This locks: expired
// rows go, in-window rows stay, per-MCP probe windows keep the newest N, and
// a 0 config disables each stage.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { count, eq } from 'drizzle-orm'

import { createInMemoryDb } from '../src/db/client'
import {
  mcpProbes,
  mcps,
  memoryDistillEvents,
  memoryDistillJobs,
  userAccessAudit,
  users,
  intentSessions,
  intentTurnEvents,
  intentTurns,
  tasks,
  webhookEndpoints,
  webhookTriggerFires,
  webhookTriggers,
  workflows,
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

// 实现门 P0-4(变异 #14:同时关掉 webhook_trigger_fires 与另两条事件腿,3 个用例
// 全绿)—— proposal §5 C6 承诺六张表,此前只有 memory_distill_events 有正向断言,
// 而 webhook_trigger_fires 恰恰是审计里增长最快的一张。
describe('RFC-311 C6 — webhook_trigger_fires retention', () => {
  async function seedFires(db: Db, ages: readonly number[]): Promise<void> {
    await db.insert(webhookEndpoints).values({
      id: 'ep1',
      name: 'ep',
      provider: 'gitlab',
      urlToken: 'tok',
      secretEnc: 'enc',
      createdAt: NOW,
    })
    await db.insert(webhookTriggers).values({
      id: 'tr1',
      name: 'trigger',
      endpointId: 'ep1',
      ownerUserId: 'u1',
      repoScope: '{}',
      eventTypes: '[]',
      launchKind: 'workflow',
      launchRefId: 'wf1',
      launchPayload: '{}',
      createdAt: NOW,
      updatedAt: NOW,
    })
    for (const [i, ageDays] of ages.entries()) {
      await db.insert(webhookTriggerFires).values({
        id: `fire-${i}`,
        deliveryId: `d-${i}`,
        triggerId: 'tr1',
        streamKey: '/repo|mr:1',
        outcome: 'launched',
        firedAt: NOW - ageDays * DAY,
      })
    }
  }

  async function fireCount(db: Db): Promise<number> {
    const r = await db.select({ n: count() }).from(webhookTriggerFires)
    return r[0]?.n ?? 0
  }

  test('rows past the window go, in-window rows stay', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedUser(db, 'u1')
    await seedFires(db, [200, 120, 91, 89, 1])
    const result = await runRetentionSweep(
      db,
      { ...OFF, webhookTriggerFiresRetentionDays: 90 },
      NOW,
    )
    expect(result.webhookTriggerFires).toBe(3)
    expect(await fireCount(db)).toBe(2)
  })

  // 实现门 P1-3:这张表是 webhook supersede 的唯一事实源(同流最近一次 launched
  // 的任务未终态 ⇒ 取消)。一个卡在 awaiting_human 的任务超期后 fire 行被删,下次
  // 同流触发就不再取消它——同一 MR 上两个活任务在同一分支互相踩,而代码里没有
  // 任何地方承认这个 90 天的界。保留期必须豁免仍未终态的那一行。
  test('a fire whose launched task is still non-terminal survives the window', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedUser(db, 'u1')
    await seedFires(db, [200, 150])
    await db.insert(workflows).values({ id: 'wf1', name: 'wf', definition: '{}' })
    const mkTask = async (id: string, status: 'awaiting_human' | 'done'): Promise<void> => {
      await db.insert(tasks).values({
        id,
        name: id,
        workflowId: 'wf1',
        workflowSnapshot: '{}',
        repoPath: '/tmp/x',
        worktreePath: '/tmp/x',
        baseBranch: 'main',
        branch: `agent-workflow/${id}`,
        status,
        inputs: '{}',
        startedAt: NOW - 200 * DAY,
        finishedAt: status === 'done' ? NOW - 199 * DAY : null,
        runningMs: 0,
        ownerUserId: 'u1',
        launchOrigin: 'webhook',
      })
    }
    await mkTask('stuck', 'awaiting_human')
    await mkTask('settled', 'done')
    await db
      .update(webhookTriggerFires)
      .set({ taskId: 'stuck' })
      .where(eq(webhookTriggerFires.id, 'fire-0'))
    await db
      .update(webhookTriggerFires)
      .set({ taskId: 'settled' })
      .where(eq(webhookTriggerFires.id, 'fire-1'))

    const result = await runRetentionSweep(
      db,
      { ...OFF, webhookTriggerFiresRetentionDays: 90 },
      NOW,
    )
    expect(result.webhookTriggerFires).toBe(1)
    const left = await db.select({ id: webhookTriggerFires.id }).from(webhookTriggerFires)
    expect(left.map((r) => r.id)).toEqual(['fire-0'])
  })

  test('0 disables the stage', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedUser(db, 'u1')
    await seedFires(db, [500, 400])
    const result = await runRetentionSweep(db, OFF, NOW)
    expect(result.webhookTriggerFires).toBe(0)
    expect(await fireCount(db)).toBe(2)
  })
})

describe('RFC-311 C6 — the other two event streams share the window', () => {
  test('intent_turn_events past the window go; 0 disables', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedUser(db, 'u1')
    await db
      .insert(intentSessions)
      .values({ id: 's1', ownerUserId: 'u1', createdAt: NOW, updatedAt: NOW })
    await db
      .insert(intentTurns)
      .values({ id: 't1', sessionId: 's1', seq: 1, role: 'user', kind: 'message', createdAt: NOW })
    for (const [i, ageDays] of [90, 45, 31, 29, 1].entries()) {
      await db.insert(intentTurnEvents).values({
        turnId: 't1',
        eventSeq: i,
        ts: NOW - ageDays * DAY,
        kind: 'text',
        payload: '{}',
        source: 'stream',
      })
    }
    const counted = async (): Promise<number> => {
      const r = await db.select({ n: count() }).from(intentTurnEvents)
      return r[0]?.n ?? 0
    }
    expect(await counted()).toBe(5)
    expect((await runRetentionSweep(db, OFF, NOW)).intentTurnEvents).toBe(0)
    expect(await counted()).toBe(5)
    // 会话仍 active ⇒ 即便超期也一条不删(否则 UI 会「N events」而面板空白)。
    expect(
      (await runRetentionSweep(db, { ...OFF, eventStreamRetentionDays: 30 }, NOW)).intentTurnEvents,
    ).toBe(0)
    expect(await counted()).toBe(5)

    await db.update(intentSessions).set({ status: 'archived' }).where(eq(intentSessions.id, 's1'))
    const result = await runRetentionSweep(db, { ...OFF, eventStreamRetentionDays: 30 }, NOW)
    expect(result.intentTurnEvents).toBe(3)
    expect(await counted()).toBe(2)
  })

  // mcp_runtime_test_events 的 fixture 需要一整条 runtime-test session 链(必填列
  // 远多于上面两张),这里用源码守卫锁住「第三条腿仍然接着」；RFC-338 后每条腿
  // 必须是一个 predicate-rechecking bounded DELETE，不能退回全阶段同步循环。
  test('all three event streams stay wired into the same window (source lock)', () => {
    const src = readFileSync(
      resolve(
        import.meta.dir,
        '..',
        'src',
        'platform',
        'persistence',
        'sqlite',
        'systemMaintenanceRetention.ts',
      ),
      'utf8',
    )
    for (const table of [
      'memory_distill_events',
      'intent_turn_events',
      'mcp_runtime_test_events',
    ]) {
      expect(src).toContain(`DELETE FROM ${table}`)
    }
    expect(src).toContain('export async function runRetentionSweepSlice(')
    expect(src).toContain('LIMIT ${batchSize}')
    // 且三条腿都带宿主终态判据(实现门 P2-11)。
    expect(src).toContain("job.status IN ('done', 'failed', 'canceled')")
    expect(src).toContain("session.status = 'archived'")
    expect(src).toContain("session.status = 'ended'")
  })
})

// RFC-300 — locks the exact direct-Webhook terminal workspace admission rule
// and the lifecycle atomicity seam: terminal status + prune claim are one CAS,
// while a losing CAS leaves no orphaned claim.

import type { SpaceKind, TaskStatus } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { resolve } from 'node:path'
import { monotonicFactory } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { tasks, workflows } from '../src/db/schema'
import {
  ConcurrentTaskTransition,
  registerTerminalWorkspacePrunePolicy,
  setTaskStatus,
} from '../src/services/lifecycle'
import { installTaskLifecycleAfterCommitTestPump } from './helpers/taskLifecycleCommittedEvents'
import { shouldRequestWebhookWorkspacePrune } from '../src/services/webhook/terminalWorkspaceCleanup'
import { composeSqliteWebhookTerminalWorkspacePrunePolicy } from '../src/modules/integration/composition/terminalWorkspaceCleanup'

const ulid = monotonicFactory()
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

let db: DbClient
let workflowId: string
let uninstallAfterCommitPump: (() => void) | null = null

beforeEach(async () => {
  db = createInMemoryDb(MIGRATIONS)
  uninstallAfterCommitPump = null
  workflowId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: 'rfc300-policy',
    definition: '{}',
  })
})

afterEach(() => {
  registerTerminalWorkspacePrunePolicy(null)
  uninstallAfterCommitPump?.()
})

async function seedTask(
  status: TaskStatus = 'running',
  overrides: Partial<typeof tasks.$inferInsert> = {},
): Promise<string> {
  const id = ulid()
  await db.insert(tasks).values({
    id,
    name: 'rfc300-policy',
    workflowId,
    workflowSnapshot: '{}',
    repoPath: '/managed/source.git',
    worktreePath: '/managed/worktree',
    baseBranch: 'main',
    branch: `agent-workflow/${id}`,
    status,
    inputs: '{}',
    startedAt: 1,
    webhookTriggerId: 'webhook-trigger-fixture',
    spaceKind: 'remote',
    ...overrides,
  })
  return id
}

async function rowOf(id: string) {
  return (await db.select().from(tasks).where(eq(tasks.id, id)))[0]!
}

/**
 * 真并发模拟：返回一个 db 代理，在 helper **正要进入那笔原子事务**的瞬间（SELECT + 双闸校验
 * 已完成）先同步执行竞争写者，再放行事务——其 `WHERE status = from` 谓词必然 miss。
 * bun:sqlite 全同步（.run() 立即落库），时序 100% 确定。
 *
 * RFC-359：拦截点要认两种事务形态。旧的 `dbTxSync` 走 drizzle 的 `db.transaction(...)`；
 * 统一原语 `databaseSessionFor(db).transaction(...)` 不走它，而是自己发
 * `db.run(sql.raw('BEGIN IMMEDIATE'))`（`platform/persistence/databaseTransaction.ts`）。
 * 只拦 `transaction` 的旧写法在新原语下**一次都不会触发**，竞争写者不发生、CAS 照常成功，
 * 判据于是静默变成「没有并发」——所以这里两种都拦，谁先来算谁。
 */
function dbWithCompetingWriter(real: DbClient, sabotage: () => void): DbClient {
  let fired = false
  const fire = (): void => {
    if (fired) return
    fired = true
    sabotage()
  }
  return new Proxy(real, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown
      // `transaction`：drizzle 的事务包装（`dbTxSync` 那条路）。
      // `run`：统一事务原语开事务发的第一条语句就是 `BEGIN IMMEDIATE`；helper 在此之前
      // 只 `select`，所以「第一次 run」与「事务即将开始」是同一个时刻。
      if ((prop === 'transaction' || prop === 'run') && typeof value === 'function') {
        return (...args: unknown[]) => {
          fire()
          return (value as (...inner: unknown[]) => unknown).apply(target, args)
        }
      }
      return typeof value === 'function'
        ? (value as (...inner: unknown[]) => unknown).bind(target)
        : value
    },
  }) as DbClient
}

describe('RFC-300 exact cleanup candidate predicate', () => {
  const base = {
    webhookTriggerId: 'trigger-1',
    spaceKind: 'remote' as SpaceKind,
    workspacePruningAt: null,
    workspacePruneCause: null,
    workspacePrunedAt: null,
  }

  for (const to of ['done', 'canceled'] as const) {
    for (const spaceKind of ['remote', 'scratch'] as const) {
      test(`accepts direct Webhook ${spaceKind} ${to}`, () => {
        expect(shouldRequestWebhookWorkspacePrune(true, { ...base, to, spaceKind })).toBe(true)
      })
    }
  }

  test('accepts generic Event Center attribution without legacy Webhook ids', () => {
    expect(
      shouldRequestWebhookWorkspacePrune(true, {
        ...base,
        to: 'done',
        webhookTriggerId: null,
        eventSubscriptionId: 'event-subscription-1',
      }),
    ).toBe(true)
  })

  test('rejects failed/interrupted and every active status', () => {
    for (const to of [
      'failed',
      'interrupted',
      'pending',
      'running',
      'awaiting_review',
      'awaiting_human',
    ] as const) {
      expect(shouldRequestWebhookWorkspacePrune(true, { ...base, to })).toBe(false)
    }
  })

  test('rejects disabled, non-direct attribution, non-owning spaces, and tombstones', () => {
    expect(shouldRequestWebhookWorkspacePrune(false, { ...base, to: 'done' })).toBe(false)
    expect(
      shouldRequestWebhookWorkspacePrune(true, {
        ...base,
        to: 'done',
        webhookTriggerId: null,
      }),
    ).toBe(false)
    for (const spaceKind of ['local', 'internal', 'inherited'] as const) {
      expect(shouldRequestWebhookWorkspacePrune(true, { ...base, to: 'done', spaceKind })).toBe(
        false,
      )
    }
    expect(
      shouldRequestWebhookWorkspacePrune(true, {
        ...base,
        to: 'done',
        workspacePruningAt: 1,
      }),
    ).toBe(false)
    expect(
      shouldRequestWebhookWorkspacePrune(true, {
        ...base,
        to: 'done',
        workspacePruneCause: 'webhook-terminal',
      }),
    ).toBe(false)
    expect(
      shouldRequestWebhookWorkspacePrune(true, {
        ...base,
        to: 'done',
        workspacePrunedAt: 1,
      }),
    ).toBe(false)
  })
})

describe('RFC-300 lifecycle terminal status + workspace claim CAS', () => {
  test('winning done CAS writes the claim with the same clock and wakes the effect', async () => {
    const taskId = await seedTask()
    const effects: Array<{ taskId: string; to: string }> = []
    registerTerminalWorkspacePrunePolicy(
      composeSqliteWebhookTerminalWorkspacePrunePolicy({ db, enabled: () => true }),
    )
    uninstallAfterCommitPump = installTaskLifecycleAfterCommitTestPump(db, {
      onWorkspacePrune(_db, id, to) {
        effects.push({ taskId: id, to })
      },
    })

    await setTaskStatus({
      db,
      taskId,
      to: 'done',
      allowedFrom: ['running'],
      now: 300,
      reason: 'rfc300-atomic-win',
    })

    const row = await rowOf(taskId)
    expect(row.status).toBe('done')
    expect(row.workspacePruningAt).toBe(300)
    expect(row.workspacePruneCause).toBe('webhook-terminal')
    expect(row.workspacePrunedAt).toBeNull()
    expect(effects).toEqual([{ taskId, to: 'done' }])
  })

  test('the setting is sampled at terminal transition, not when the task started', async () => {
    let enabled = false
    registerTerminalWorkspacePrunePolicy(
      composeSqliteWebhookTerminalWorkspacePrunePolicy({ db, enabled: () => enabled }),
    )

    const startedWhileOff = await seedTask()
    enabled = true
    await setTaskStatus({
      db,
      taskId: startedWhileOff,
      to: 'done',
      allowedFrom: ['running'],
      now: 305,
      reason: 'rfc300-enabled-before-terminal',
    })
    expect(await rowOf(startedWhileOff)).toMatchObject({
      workspacePruningAt: 305,
      workspacePruneCause: 'webhook-terminal',
    })

    const finishingAfterDisable = await seedTask()
    enabled = false
    await setTaskStatus({
      db,
      taskId: finishingAfterDisable,
      to: 'canceled',
      allowedFrom: ['running'],
      now: 306,
      reason: 'rfc300-disabled-before-terminal',
    })
    expect(await rowOf(finishingAfterDisable)).toMatchObject({
      workspacePruningAt: null,
      workspacePruneCause: null,
    })
  })

  test('losing terminal CAS writes neither claim nor effect', async () => {
    const taskId = await seedTask()
    let effectCount = 0
    registerTerminalWorkspacePrunePolicy(
      composeSqliteWebhookTerminalWorkspacePrunePolicy({ db, enabled: () => true }),
    )
    uninstallAfterCommitPump = installTaskLifecycleAfterCommitTestPump(db, {
      onWorkspacePrune() {
        effectCount += 1
      },
    })
    const raced = dbWithCompetingWriter(db, () => {
      db.update(tasks).set({ status: 'canceled' }).where(eq(tasks.id, taskId)).run()
    })

    await expect(
      setTaskStatus({
        db: raced,
        taskId,
        to: 'done',
        allowedFrom: ['running'],
        now: 301,
        reason: 'rfc300-atomic-loss',
      }),
    ).rejects.toBeInstanceOf(ConcurrentTaskTransition)

    const row = await rowOf(taskId)
    expect(row.status).toBe('canceled')
    expect(row.workspacePruningAt).toBeNull()
    expect(row.workspacePruneCause).toBeNull()
    expect(effectCount).toBe(0)
  })

  test('racing done/canceled transitions leave exactly one terminal winner with its claim', async () => {
    const taskId = await seedTask()
    const effects: Array<{ taskId: string; to: string }> = []
    registerTerminalWorkspacePrunePolicy(
      composeSqliteWebhookTerminalWorkspacePrunePolicy({ db, enabled: () => true }),
    )
    uninstallAfterCommitPump = installTaskLifecycleAfterCommitTestPump(db, {
      onWorkspacePrune(_db, id, to) {
        effects.push({ taskId: id, to })
      },
    })

    const outcomes = await Promise.allSettled([
      setTaskStatus({
        db,
        taskId,
        to: 'done',
        allowedFrom: ['running'],
        now: 310,
        reason: 'rfc300-done-racer',
      }),
      setTaskStatus({
        db,
        taskId,
        to: 'canceled',
        allowedFrom: ['running'],
        now: 311,
        reason: 'rfc300-cancel-racer',
      }),
    ])

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    const row = await rowOf(taskId)
    expect(row.workspacePruningAt).toBe(row.status === 'done' ? 310 : 311)
    expect(row.workspacePruneCause).toBe('webhook-terminal')
    expect(effects).toEqual([{ taskId, to: row.status }])
  })

  test('failed/interrupted and a context-only inherited child never gain a claim', async () => {
    registerTerminalWorkspacePrunePolicy(
      composeSqliteWebhookTerminalWorkspacePrunePolicy({ db, enabled: () => true }),
    )
    let effectCount = 0
    uninstallAfterCommitPump = installTaskLifecycleAfterCommitTestPump(db, {
      onWorkspacePrune() {
        effectCount += 1
      },
    })

    for (const to of ['failed', 'interrupted'] as const) {
      const taskId = await seedTask()
      await setTaskStatus({
        db,
        taskId,
        to,
        allowedFrom: ['running'],
        reason: `rfc300-retained-${to}`,
      })
      expect(await rowOf(taskId)).toMatchObject({
        workspacePruningAt: null,
        workspacePruneCause: null,
      })
    }

    const inheritedId = await seedTask('running', {
      webhookTriggerId: null,
      spaceKind: 'inherited',
      triggerContextJson: JSON.stringify({ webhook: { event_type: 'push' } }),
    })
    await setTaskStatus({
      db,
      taskId: inheritedId,
      to: 'done',
      allowedFrom: ['running'],
      reason: 'rfc300-context-only-inherited-child',
    })
    expect(await rowOf(inheritedId)).toMatchObject({
      workspacePruningAt: null,
      workspacePruneCause: null,
    })
    expect(effectCount).toBe(0)
  })

  test('disabled or throwing provider never blocks the terminal transition', async () => {
    const disabledId = await seedTask()
    registerTerminalWorkspacePrunePolicy(
      composeSqliteWebhookTerminalWorkspacePrunePolicy({ db, enabled: () => false }),
    )
    await setTaskStatus({
      db,
      taskId: disabledId,
      to: 'done',
      allowedFrom: ['running'],
      reason: 'rfc300-disabled',
    })
    expect(await rowOf(disabledId)).toMatchObject({
      workspacePruningAt: null,
      workspacePruneCause: null,
    })

    const throwingId = await seedTask()
    registerTerminalWorkspacePrunePolicy(() => {
      throw new Error('corrupt config fixture')
    })
    await setTaskStatus({
      db,
      taskId: throwingId,
      to: 'canceled',
      allowedFrom: ['running'],
      reason: 'rfc300-provider-error',
    })
    const throwing = await rowOf(throwingId)
    expect(throwing.status).toBe('canceled')
    expect(throwing.workspacePruningAt).toBeNull()
    expect(throwing.workspacePruneCause).toBeNull()
  })
})

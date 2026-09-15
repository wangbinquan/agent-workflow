// RFC-097 — setTaskStatus / trySetTaskStatus 单测（tasks.status CAS 三件套）。
//
// 锁定 services/lifecycle.ts 尾部 task 级 CAS helper 的全部合同
// （RFC-053 node_runs 侧 lifecycle-cas-race.test.ts 的 1:1 镜像）：
//   - CAS 赢：返回 { from, to }，行翻转，extra 伴随列原子落库；
//   - CAS 输（真并发模拟：在 helper 的 SELECT 与 UPDATE 之间插入竞争写者）
//     → ConcurrentTaskTransition（code 'concurrent-task-transition'，409），
//     赢家的写不被覆盖；
//   - allowedFrom 拒绝 → ConflictError('illegal-task-transition')，行不动；
//   - 终态 from 默认拒绝（即使列在 allowedFrom 里）；allowTerminal=true 的
//     逃生口放行（恰 4 类持有者：resumeTask / retryNode / 修复 CR-1 / T3）；
//   - extra 显式 null 写入生效（resume 清错误四元组、T3 清 finishedAt）；
//   - 任务不存在 → NotFoundError('task-not-found')；
//   - trySetTaskStatus：赢 → true；Conflict / NotFound → false（"尊重赢家"
//     语义，见 helper docstring）；其他错误原样重抛。
//   - 转移矩阵表驱动：design §1 矩阵按各调用方的 allowedFrom 形态抽样
//     合法 / 非法组合。
//
// RFC-359 AC-6（2026-09-15）：本文件从单引擎迁到 `describeEachProvider`，两个引擎各跑一遍。
// 迁移里唯一需要重新设计的是**CAS 竞态怎么造**：原来靠代理 `db.run` / `db.transaction`，
// 在「事务正要开始」的瞬间**同步**插入竞争写者——那依赖 bun:sqlite 的同步落库
// （`.run()` 立即生效），PostgreSQL 上驱动是异步的，同样的代理只会让竞争写者还在飞、
// CAS 照常成功，判据静默退化成「没有并发」。
// 改用 helper 自己的注入点 `beforeCas`：它在 SELECT + 双闸校验之后、CAS 事务之前**被 await**，
// 正是「SELECT 与 UPDATE 之间」这个位置，且两个引擎都成立。承重的判据一条没少——
// 竞争写者先落库、CAS 的 `WHERE status = from` 必然 miss、赢家的写不被覆盖。

import type { TaskStatus } from '@agent-workflow/shared'
import { beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { monotonicFactory } from 'ulid'
import { tasks, workflows } from '../src/db/schema'
import {
  ConcurrentTaskTransition,
  isTerminalTaskStatus,
  setTaskStatus,
  TERMINAL_TASK_STATUSES,
  trySetTaskStatus,
} from '../src/services/lifecycle'
import { ConflictError, NotFoundError } from '../src/util/errors'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { describeEachProvider } from './helpers/eachProvider'

const ulid = monotonicFactory()

interface Harness {
  db: ProviderNeutralDatabase
  seedTask: (status: TaskStatus, extra?: Partial<typeof tasks.$inferInsert>) => Promise<string>
}

async function buildHarness(db: ProviderNeutralDatabase): Promise<Harness> {
  const workflowId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: JSON.stringify({ $schema_version: 3, inputs: [], nodes: [], edges: [] }),
  })
  // RFC-165: terminal→non-terminal transitions (retry/resume revivals) now
  // pass a workspace-liveness gate — a missing worktree dir tombstones the
  // row and 410s. These tests exercise the CAS matrix itself, so the fixture
  // workspace must EXIST (the gate's own behavior is locked in
  // rfc165-workspace-gc.test.ts).
  const worktreePath = mkdtempSync(join(tmpdir(), 'aw-rfc097-wt-'))
  return {
    db,
    seedTask: async (status, extra = {}) => {
      const taskId = ulid()
      await db.insert(tasks).values({
        id: taskId,
        name: 'rfc097-cas',
        workflowId,
        workflowSnapshot: '{}',
        repoPath: '/nonexistent/rfc097/repo',
        worktreePath,
        baseBranch: 'main',
        branch: `agent-workflow/${taskId}`,
        status,
        inputs: '{}',
        startedAt: Date.now(),
        ...extra,
      })
      return taskId
    },
  }
}

async function statusOf(db: ProviderNeutralDatabase, taskId: string): Promise<string> {
  return (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!.status
}

describeEachProvider('RFC-097 tasks.status CAS（双引擎）', (harness) => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness(harness.db)
  })

  describe('RFC-097 terminal-status helpers', () => {
    test('TERMINAL_TASK_STATUSES / isTerminalTaskStatus split the 8-value universe correctly', () => {
      expect([...TERMINAL_TASK_STATUSES].sort()).toEqual([
        'canceled',
        'done',
        'failed',
        'interrupted',
      ])
      for (const s of TERMINAL_TASK_STATUSES) expect(isTerminalTaskStatus(s)).toBe(true)
      for (const s of ['pending', 'running', 'awaiting_review', 'awaiting_human']) {
        expect(isTerminalTaskStatus(s)).toBe(false)
      }
    })
  })

  describe('RFC-097 setTaskStatus', () => {
    test('CAS win: pending → running returns {from,to} and flips the row', async () => {
      const taskId = await h.seedTask('pending')
      const r = await setTaskStatus({
        db: h.db,
        taskId,
        to: 'running',
        allowedFrom: ['pending'],
        reason: 'unit-happy-path',
      })
      expect(r).toEqual({ from: 'pending', to: 'running' })
      expect(await statusOf(h.db, taskId)).toBe('running')
    })

    test('extra companion columns land atomically with the status flip', async () => {
      const taskId = await h.seedTask('running')
      await setTaskStatus({
        db: h.db,
        taskId,
        to: 'failed',
        allowedFrom: ['pending', 'running'],
        extra: {
          finishedAt: 777,
          errorSummary: 'boom',
          errorMessage: 'node exploded',
          failedNodeId: 'n1',
        },
        reason: 'unit-extra',
      })
      const row = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!
      expect(row.status).toBe('failed')
      expect(row.finishedAt).toBe(777)
      expect(row.errorSummary).toBe('boom')
      expect(row.errorMessage).toBe('node exploded')
      expect(row.failedNodeId).toBe('n1')
    })

    test('extra explicit null is written through (resume clears the error quadruple + finishedAt)', async () => {
      const taskId = await h.seedTask('failed', {
        finishedAt: 123,
        errorSummary: 's',
        errorMessage: 'm',
        failedNodeId: 'n1',
      })
      await setTaskStatus({
        db: h.db,
        taskId,
        to: 'pending',
        allowedFrom: ['failed', 'interrupted', 'awaiting_review', 'awaiting_human'],
        allowTerminal: true,
        extra: { finishedAt: null, errorSummary: null, errorMessage: null, failedNodeId: null },
        reason: 'unit-resume-clears',
      })
      const row = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!
      expect(row.status).toBe('pending')
      expect(row.finishedAt).toBeNull()
      expect(row.errorSummary).toBeNull()
      expect(row.errorMessage).toBeNull()
      expect(row.failedNodeId).toBeNull()
    })

    test('repair T3 shape: done → interrupted with allowTerminal clears finishedAt to null', async () => {
      const taskId = await h.seedTask('done', { finishedAt: 456 })
      await setTaskStatus({
        db: h.db,
        taskId,
        to: 'interrupted',
        allowedFrom: ['done'],
        allowTerminal: true,
        extra: { finishedAt: null },
        reason: 'unit-T3-demote',
      })
      const row = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!
      expect(row.status).toBe('interrupted')
      expect(row.finishedAt).toBeNull()
    })

    test('allowedFrom miss → ConflictError(illegal-task-transition), row untouched', async () => {
      const taskId = await h.seedTask('running')
      let err: unknown = null
      try {
        await setTaskStatus({
          db: h.db,
          taskId,
          to: 'running',
          allowedFrom: ['pending'],
          reason: 'unit-stale-gate',
        })
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(ConflictError)
      expect((err as ConflictError).code).toBe('illegal-task-transition')
      expect(await statusOf(h.db, taskId)).toBe('running')
    })

    test('terminal from is refused by default EVEN IF listed in allowedFrom', async () => {
      const taskId = await h.seedTask('done', { finishedAt: 1 })
      let err: unknown = null
      try {
        await setTaskStatus({
          db: h.db,
          taskId,
          to: 'pending',
          allowedFrom: ['done'], // 列了也没用：终态闸先于 allowedFrom 检查
          reason: 'unit-terminal-gate',
        })
      } catch (e) {
        err = e
      }
      expect((err as ConflictError).code).toBe('illegal-task-transition')
      expect((err as ConflictError).message).toContain('terminal')
      expect(await statusOf(h.db, taskId)).toBe('done')
    })

    test('allowTerminal=true escape hatch lets retry revive a canceled task (RFC-095 shape)', async () => {
      const taskId = await h.seedTask('canceled')
      const r = await setTaskStatus({
        db: h.db,
        taskId,
        to: 'pending',
        allowedFrom: [
          'done',
          'failed',
          'canceled',
          'interrupted',
          'awaiting_review',
          'awaiting_human',
        ],
        allowTerminal: true,
        reason: 'unit-retry-revival',
      })
      expect(r.from).toBe('canceled')
      expect(await statusOf(h.db, taskId)).toBe('pending')
    })

    test('missing task → NotFoundError(task-not-found)', async () => {
      let err: unknown = null
      try {
        await setTaskStatus({
          db: h.db,
          taskId: '01NOPE00000000000000000000',
          to: 'running',
          allowedFrom: ['pending'],
          reason: 'unit-missing',
        })
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(NotFoundError)
      expect((err as NotFoundError).code).toBe('task-not-found')
    })

    test('CAS loss: competing writer between SELECT and UPDATE → ConcurrentTaskTransition, winner kept', async () => {
      const taskId = await h.seedTask('running')
      // 竞争写者在 helper 发 CAS UPDATE 前把任务翻成 canceled
      // （cancelTask fallback 赢得 done-vs-cancel 窗口的实战形态）。
      // `beforeCas` 在 SELECT + 双闸校验之后、CAS 事务之前**被 await**——两个引擎上都是
      // 「SELECT 与 UPDATE 之间」这个确定位置，不依赖任何驱动的同步性。
      let err: unknown = null
      try {
        await setTaskStatus({
          db: h.db,
          taskId,
          to: 'done',
          allowedFrom: ['running'],
          reason: 'unit-cas-loss',
          beforeCas: async () => {
            await h.db.update(tasks).set({ status: 'canceled' }).where(eq(tasks.id, taskId))
          },
        })
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(ConcurrentTaskTransition)
      expect((err as ConcurrentTaskTransition).code).toBe('concurrent-task-transition')
      expect((err as ConcurrentTaskTransition).status).toBe(409)
      // 赢家（canceled）的写不被输家覆盖。
      expect(await statusOf(h.db, taskId)).toBe('canceled')
    })
  })

  describe('RFC-097 trySetTaskStatus', () => {
    test('winner returns true and flips the row', async () => {
      const taskId = await h.seedTask('pending')
      const won = await trySetTaskStatus({
        db: h.db,
        taskId,
        to: 'running',
        allowedFrom: ['pending'],
        reason: 'unit-try-win',
      })
      expect(won).toBe(true)
      expect(await statusOf(h.db, taskId)).toBe('running')
    })

    test('status-gate miss returns false (no throw), row untouched', async () => {
      const taskId = await h.seedTask('canceled')
      const won = await trySetTaskStatus({
        db: h.db,
        taskId,
        to: 'running',
        allowedFrom: ['pending'],
        reason: 'unit-try-terminal',
      })
      expect(won).toBe(false)
      expect(await statusOf(h.db, taskId)).toBe('canceled')
    })

    test('CAS loss returns false, winner kept', async () => {
      const taskId = await h.seedTask('running')
      const won = await trySetTaskStatus({
        db: h.db,
        taskId,
        to: 'done',
        allowedFrom: ['running'],
        reason: 'unit-try-cas-loss',
        beforeCas: async () => {
          await h.db.update(tasks).set({ status: 'failed' }).where(eq(tasks.id, taskId))
        },
      })
      expect(won).toBe(false)
      expect(await statusOf(h.db, taskId)).toBe('failed')
    })

    test('missing task returns false (NotFound maps to "respect the winner" semantics)', async () => {
      const won = await trySetTaskStatus({
        db: h.db,
        taskId: '01NOPE00000000000000000000',
        to: 'running',
        allowedFrom: ['pending'],
        reason: 'unit-try-missing',
      })
      expect(won).toBe(false)
    })

    test('non-domain errors are rethrown, not swallowed', async () => {
      const exploding = {
        select() {
          throw new Error('db exploded')
        },
      } as unknown as ProviderNeutralDatabase
      await expect(
        trySetTaskStatus({
          db: exploding,
          taskId: 'whatever',
          to: 'running',
          allowedFrom: ['pending'],
          reason: 'unit-try-rethrow',
        }),
      ).rejects.toThrow('db exploded')
    })
  })

  // ---------------------------------------------------------------------------
  // 转移矩阵表驱动（design §1）：按各调用方真实传入的 allowedFrom 形态抽样。
  // legal 行断言翻转成功 + 落库；illegal 行断言 illegal-task-transition + 行不动。
  // ---------------------------------------------------------------------------

  interface MatrixCase {
    name: string
    from: TaskStatus
    to: TaskStatus
    allowedFrom: readonly TaskStatus[]
    allowTerminal?: boolean
    expectOk: boolean
  }

  const RESUME_FROM = ['failed', 'interrupted', 'awaiting_review', 'awaiting_human'] as const
  const RETRY_FROM = [
    'done',
    'failed',
    'canceled',
    'interrupted',
    'awaiting_review',
    'awaiting_human',
  ] as const

  const MATRIX: MatrixCase[] = [
    // —— 合法转移 ——
    {
      name: 'runTask claims pending',
      from: 'pending',
      to: 'running',
      allowedFrom: ['pending'],
      expectOk: true,
    },
    {
      name: 'scheduler finishes running → done',
      from: 'running',
      to: 'done',
      allowedFrom: ['running'],
      expectOk: true,
    },
    {
      name: 'scheduler parks running → awaiting_review',
      from: 'running',
      to: 'awaiting_review',
      allowedFrom: ['running'],
      expectOk: true,
    },
    {
      name: 'scheduler parks running → awaiting_human',
      from: 'running',
      to: 'awaiting_human',
      allowedFrom: ['running'],
      expectOk: true,
    },
    {
      name: 'failTask early (snapshot-invalid) pending → failed',
      from: 'pending',
      to: 'failed',
      allowedFrom: ['pending', 'running'],
      expectOk: true,
    },
    {
      name: 'failTask mid-run running → failed',
      from: 'running',
      to: 'failed',
      allowedFrom: ['pending', 'running'],
      expectOk: true,
    },
    {
      name: 'cancelTaskRow running → canceled',
      from: 'running',
      to: 'canceled',
      allowedFrom: ['running'],
      expectOk: true,
    },
    {
      name: 'cancelTask fallback pending → canceled',
      from: 'pending',
      to: 'canceled',
      allowedFrom: ['pending', 'running'],
      expectOk: true,
    },
    {
      name: 'orphan/shutdown reaper running → interrupted',
      from: 'running',
      to: 'interrupted',
      allowedFrom: ['running'],
      expectOk: true,
    },
    {
      name: 'boot reaper (crash-window) pending → interrupted',
      from: 'pending',
      to: 'interrupted',
      allowedFrom: ['pending'],
      expectOk: true,
    },
    {
      name: 'resume failed → pending (allowTerminal)',
      from: 'failed',
      to: 'pending',
      allowedFrom: RESUME_FROM,
      allowTerminal: true,
      expectOk: true,
    },
    {
      name: 'resume awaiting_human → pending',
      from: 'awaiting_human',
      to: 'pending',
      allowedFrom: RESUME_FROM,
      allowTerminal: true,
      expectOk: true,
    },
    {
      name: 'retry revives canceled → pending (RFC-095)',
      from: 'canceled',
      to: 'pending',
      allowedFrom: RETRY_FROM,
      allowTerminal: true,
      expectOk: true,
    },
    {
      name: 'retry re-opens done → pending',
      from: 'done',
      to: 'pending',
      allowedFrom: RETRY_FROM,
      allowTerminal: true,
      expectOk: true,
    },
    {
      name: 'repair CR-1 failed → interrupted (allowTerminal)',
      from: 'failed',
      to: 'interrupted',
      allowedFrom: ['failed'],
      allowTerminal: true,
      expectOk: true,
    },
    // —— 非法转移 ——
    {
      name: 'runTask must NOT revive canceled (terminal gate)',
      from: 'canceled',
      to: 'running',
      allowedFrom: ['pending'],
      expectOk: false,
    },
    {
      name: 'runTask must NOT re-enter done (terminal gate)',
      from: 'done',
      to: 'running',
      allowedFrom: ['pending'],
      expectOk: false,
    },
    {
      name: 'cancelTaskRow must NOT flip a done task',
      from: 'done',
      to: 'canceled',
      allowedFrom: ['running'],
      expectOk: false,
    },
    {
      name: 'scheduler done-write must NOT hit awaiting_review (allowedFrom miss)',
      from: 'awaiting_review',
      to: 'done',
      allowedFrom: ['running'],
      expectOk: false,
    },
    {
      name: 'running-only reaper must NOT touch pending (allowedFrom miss)',
      from: 'pending',
      to: 'interrupted',
      allowedFrom: ['running'],
      expectOk: false,
    },
    {
      name: 'stale resume must NOT flip a running task back to pending',
      from: 'running',
      to: 'pending',
      allowedFrom: RESUME_FROM,
      allowTerminal: true,
      expectOk: false,
    },
  ]

  describe('RFC-097 transition matrix (design §1, caller-shaped allowedFrom samples)', () => {
    for (const c of MATRIX) {
      test(`${c.expectOk ? 'legal' : 'illegal'}: ${c.name} (${c.from} → ${c.to})`, async () => {
        const taskId = await h.seedTask(c.from)
        if (c.expectOk) {
          const r = await setTaskStatus({
            db: h.db,
            taskId,
            to: c.to,
            allowedFrom: c.allowedFrom,
            allowTerminal: c.allowTerminal,
            reason: `matrix:${c.name}`,
          })
          expect(r).toEqual({ from: c.from, to: c.to })
          expect(await statusOf(h.db, taskId)).toBe(c.to)
        } else {
          let err: unknown = null
          try {
            await setTaskStatus({
              db: h.db,
              taskId,
              to: c.to,
              allowedFrom: c.allowedFrom,
              allowTerminal: c.allowTerminal,
              reason: `matrix:${c.name}`,
            })
          } catch (e) {
            err = e
          }
          expect(err).toBeInstanceOf(ConflictError)
          expect((err as ConflictError).code).toBe('illegal-task-transition')
          expect(await statusOf(h.db, taskId)).toBe(c.from)
        }
      })
    }
  })
})

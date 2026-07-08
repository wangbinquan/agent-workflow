// RFC-144 T2 — transitionMergeState / tryTransitionMergeState /
// abandonSupersededMergeStates CAS behavior.
//
// 为什么这条测试存在：merge_state 此前 19 处裸直写零 CAS（flag-audit §4.4），
// 并发覆盖与非法转移全靠隐式约定。本文件把新 CAS 层锁死：
//   ① happy path：事件驱动转移 + iso 伴随列（extra 白名单）与 mergeState 同条
//      UPDATE 原子落库；
//   ② CAS 竞态：SELECT 与 UPDATE 之间插入竞争写者 → ConcurrentMergeStateTransition
//      ——含 **NULL-from 格**（谓词必须用 IS NULL，`eq(col,null)` 恒 false 会让
//      CAS 永远 miss，这是与 status 机唯一的机械差异）；
//   ③ try 变体：域错误（非法转移/竞态/行不存在）折 false，非域错误重抛；
//   ④ abandonSupersededMergeStates：(a) 支前代 top-level / (b) 支前代子行闭包 /
//      merged 与 merge-failed 不可误废弃 / id< 边界（新行自身与更新行不动）/
//      **父行未被取代的子行不误伤**（Codex 设计门 P1-2 对应格）/ 幂等 /
//      **dbTxSync 原子性**（tx 内注入故障 → abandon 全回滚，P1-1 对应格）。
// 节点行 id 用定长补零字符串（字典序 = 数值序）而非 ulid()，保证「谁更新」
// 100% 确定——同毫秒 ulid 随机段不保证单调。

import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '../src/db/client'
import { createInMemoryDb } from '../src/db/client'
import { dbTxSync } from '../src/db/txSync'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import {
  ConcurrentMergeStateTransition,
  abandonSupersededMergeStates,
  transitionMergeState,
  tryTransitionMergeState,
} from '../src/services/lifecycle'
import {
  IllegalMergeStateTransition,
  type MergeStateOrNull,
  type NodeRunStatus,
} from '@agent-workflow/shared'
import { NotFoundError } from '../src/util/errors'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

/** 定长补零 id：字典序 = 数值序，供 supersededByRunId 的 id< 边界断言。 */
const mkId = (n: number): string => String(n).padStart(26, '0')

interface Harness {
  db: DbClient
  taskId: string
}

async function buildHarness(): Promise<Harness> {
  const db = createInMemoryDb(MIGRATIONS)
  const workflowId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: 'w',
    definition: JSON.stringify({ $schema_version: 2, inputs: [], nodes: [], edges: [] }),
  })
  const taskId = ulid()
  await db.insert(tasks).values({
    name: 't',
    id: taskId,
    workflowId,
    workflowSnapshot: '{}',
    repoPath: '/nonexistent/rfc144/repo',
    worktreePath: '/nonexistent/rfc144/wt',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return { db, taskId }
}

async function seedRun(
  h: Harness,
  opts: {
    id?: string
    nodeId?: string
    iteration?: number
    mergeState?: MergeStateOrNull
    parentNodeRunId?: string | null
    status?: NodeRunStatus
  } = {},
): Promise<string> {
  const id = opts.id ?? ulid()
  await h.db.insert(nodeRuns).values({
    id,
    taskId: h.taskId,
    nodeId: opts.nodeId ?? 'n',
    iteration: opts.iteration ?? 0,
    retryIndex: 0,
    status: opts.status ?? 'done',
    mergeState: opts.mergeState ?? null,
    parentNodeRunId: opts.parentNodeRunId ?? null,
    startedAt: Date.now() - 10,
  })
  return id
}

async function mergeStateOf(db: DbClient, id: string): Promise<string | null> {
  return (await db.select().from(nodeRuns).where(eq(nodeRuns.id, id)))[0]!.mergeState
}

/**
 * 真并发模拟（照 rfc097-task-status-cas 的 dbWithCompetingWriter）：第一次
 * `.update(...)` 被调用时（helper 已完成 SELECT、正要发 CAS UPDATE 的瞬间）
 * 先同步执行竞争写者，再放行原 UPDATE——其 merge_state 谓词必然 miss。
 */
function dbWithCompetingWriter(real: DbClient, sabotage: () => void): DbClient {
  let fired = false
  return new Proxy(real, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown
      if (prop === 'update' && typeof v === 'function') {
        return (...args: unknown[]) => {
          if (!fired) {
            fired = true
            sabotage()
          }
          return (v as (...a: unknown[]) => unknown).apply(target, args)
        }
      }
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
    },
  }) as DbClient
}

let h: Harness
beforeEach(async () => {
  h = await buildHarness()
})

describe('RFC-144 transitionMergeState — happy path', () => {
  test('begin-isolation：NULL→isolating，iso base 伴随列同条 UPDATE 原子落库', async () => {
    const id = await seedRun(h, { mergeState: null, status: 'running' })
    const r = await transitionMergeState({
      db: h.db,
      nodeRunId: id,
      event: { kind: 'begin-isolation' },
      extra: { isoWorktreePath: '/iso/x', isoBaseSnapshot: 'sha-base' },
    })
    expect(r).toEqual({ from: null, to: 'isolating' })
    const after = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, id)))[0]!
    expect(after.mergeState).toBe('isolating')
    expect(after.isoWorktreePath).toBe('/iso/x')
    expect(after.isoBaseSnapshot).toBe('sha-base')
  })

  test('全链：NULL→isolating→pending-merge→merged（伴随列逐段 pin）', async () => {
    const id = await seedRun(h, { mergeState: null, status: 'running' })
    await transitionMergeState({ db: h.db, nodeRunId: id, event: { kind: 'begin-isolation' } })
    const r2 = await transitionMergeState({
      db: h.db,
      nodeRunId: id,
      event: { kind: 'mark-pending-merge' },
      extra: { isoNodeTree: 'sha-tree' },
    })
    expect(r2).toEqual({ from: 'isolating', to: 'pending-merge' })
    const r3 = await transitionMergeState({
      db: h.db,
      nodeRunId: id,
      event: { kind: 'mark-merged', via: 'live' },
    })
    expect(r3).toEqual({ from: 'pending-merge', to: 'merged' })
    const after = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, id)))[0]!
    expect(after.mergeState).toBe('merged')
    expect(after.isoNodeTree).toBe('sha-tree')
  })

  test('冲突链：pending-merge→conflict-human→merged（人工决议）', async () => {
    const id = await seedRun(h, { mergeState: 'pending-merge' })
    await transitionMergeState({
      db: h.db,
      nodeRunId: id,
      event: { kind: 'park-conflict-human', via: 'replay' },
    })
    expect(await mergeStateOf(h.db, id)).toBe('conflict-human')
    await transitionMergeState({
      db: h.db,
      nodeRunId: id,
      event: { kind: 'complete-human-resolution' },
    })
    expect(await mergeStateOf(h.db, id)).toBe('merged')
  })

  test('非法转移抛 IllegalMergeStateTransition 且不落库（NULL 上直接 mark-merged / 终态重写）', async () => {
    const idNull = await seedRun(h, { mergeState: null })
    await expect(
      transitionMergeState({ db: h.db, nodeRunId: idNull, event: { kind: 'mark-merged' } }),
    ).rejects.toThrow(IllegalMergeStateTransition)
    expect(await mergeStateOf(h.db, idNull)).toBeNull()

    const idTerminal = await seedRun(h, { mergeState: 'merged' })
    await expect(
      transitionMergeState({
        db: h.db,
        nodeRunId: idTerminal,
        event: { kind: 'abandon', reason: 'x' },
      }),
    ).rejects.toThrow(IllegalMergeStateTransition)
    expect(await mergeStateOf(h.db, idTerminal)).toBe('merged')
  })

  test('begin-isolation 自环：同行 shard/agg 续跑重盖新 iso 基（isolating 原地、伴随列换新）', async () => {
    const id = await seedRun(h, { mergeState: null, status: 'running' })
    await transitionMergeState({
      db: h.db,
      nodeRunId: id,
      event: { kind: 'begin-isolation' },
      extra: { isoWorktreePath: '/iso/old', isoBaseSnapshot: 'sha-old' },
    })
    // 复用行第二次派发：persistIsoBase 重盖 FRESH iso 的基列。
    const r = await transitionMergeState({
      db: h.db,
      nodeRunId: id,
      event: { kind: 'begin-isolation' },
      extra: { isoWorktreePath: '/iso/new', isoBaseSnapshot: 'sha-new' },
    })
    expect(r).toEqual({ from: 'isolating', to: 'isolating' })
    const after = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, id)))[0]!
    expect(after.isoWorktreePath).toBe('/iso/new')
    expect(after.isoBaseSnapshot).toBe('sha-new')
  })

  test('reenter-isolation：同行 wrapper 复活开新一代（merged→isolating / conflict-human→isolating）', async () => {
    const idMerged = await seedRun(h, { mergeState: 'merged' })
    const r1 = await transitionMergeState({
      db: h.db,
      nodeRunId: idMerged,
      event: { kind: 'reenter-isolation' },
    })
    expect(r1).toEqual({ from: 'merged', to: 'isolating' })
    // 新一代照常走完整链：isolating → pending-merge → merged。
    await transitionMergeState({
      db: h.db,
      nodeRunId: idMerged,
      event: { kind: 'mark-pending-merge' },
    })
    await transitionMergeState({ db: h.db, nodeRunId: idMerged, event: { kind: 'mark-merged' } })
    expect(await mergeStateOf(h.db, idMerged)).toBe('merged')

    const idParked = await seedRun(h, { mergeState: 'conflict-human' })
    const r2 = await transitionMergeState({
      db: h.db,
      nodeRunId: idParked,
      event: { kind: 'reenter-isolation' },
    })
    expect(r2).toEqual({ from: 'conflict-human', to: 'isolating' })
  })

  test('行不存在抛 NotFoundError', async () => {
    await expect(
      transitionMergeState({
        db: h.db,
        nodeRunId: mkId(999),
        event: { kind: 'begin-isolation' },
      }),
    ).rejects.toThrow(NotFoundError)
  })
})

describe('RFC-144 transitionMergeState — CAS 竞态', () => {
  test('非 NULL from：竞争写者在 SELECT 与 UPDATE 之间推进行 → ConcurrentMergeStateTransition，竞争者赢', async () => {
    const id = await seedRun(h, { mergeState: 'pending-merge' })
    const db = dbWithCompetingWriter(h.db, () => {
      // 竞争写者（模拟另一条腿的 merge-back）先把行推到 merged。
      h.db.update(nodeRuns).set({ mergeState: 'merged' }).where(eq(nodeRuns.id, id)).run()
    })
    await expect(
      transitionMergeState({ db, nodeRunId: id, event: { kind: 'park-conflict-human' } }),
    ).rejects.toThrow(ConcurrentMergeStateTransition)
    expect(await mergeStateOf(h.db, id)).toBe('merged')
  })

  test('NULL-from 格：谓词走 IS NULL——竞争写者先 begin-isolation → 我方 CAS miss 而非静默双写', async () => {
    const id = await seedRun(h, { mergeState: null, status: 'running' })
    const db = dbWithCompetingWriter(h.db, () => {
      h.db
        .update(nodeRuns)
        .set({ mergeState: 'isolating', isoWorktreePath: '/iso/winner' })
        .where(eq(nodeRuns.id, id))
        .run()
    })
    await expect(
      transitionMergeState({
        db,
        nodeRunId: id,
        event: { kind: 'begin-isolation' },
        extra: { isoWorktreePath: '/iso/loser' },
      }),
    ).rejects.toThrow(ConcurrentMergeStateTransition)
    const after = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, id)))[0]!
    expect(after.mergeState).toBe('isolating')
    expect(after.isoWorktreePath).toBe('/iso/winner')
  })
})

describe('RFC-144 tryTransitionMergeState — 域错误折 false', () => {
  test('非法转移 → false（错误路径写点在 catch 块内，不得掩盖原始 merge 错误）', async () => {
    const id = await seedRun(h, { mergeState: 'merged' })
    expect(
      await tryTransitionMergeState({
        db: h.db,
        nodeRunId: id,
        event: { kind: 'mark-merge-failed', reason: 'late' },
      }),
    ).toBe(false)
    expect(await mergeStateOf(h.db, id)).toBe('merged')
  })

  test('CAS 竞态 → false；行不存在 → false', async () => {
    const id = await seedRun(h, { mergeState: 'pending-merge' })
    const db = dbWithCompetingWriter(h.db, () => {
      h.db.update(nodeRuns).set({ mergeState: 'merged' }).where(eq(nodeRuns.id, id)).run()
    })
    expect(
      await tryTransitionMergeState({ db, nodeRunId: id, event: { kind: 'mark-merged' } }),
    ).toBe(false)
    expect(
      await tryTransitionMergeState({
        db: h.db,
        nodeRunId: mkId(998),
        event: { kind: 'mark-merged' },
      }),
    ).toBe(false)
  })

  test('非域错误原样重抛（基础设施故障不能被吞成 false）', async () => {
    const id = await seedRun(h, { mergeState: 'pending-merge' })
    const db = dbWithCompetingWriter(h.db, () => {
      throw new Error('disk on fire')
    })
    await expect(
      tryTransitionMergeState({ db, nodeRunId: id, event: { kind: 'mark-merged' } }),
    ).rejects.toThrow('disk on fire')
  })
})

describe('RFC-144 abandonSupersededMergeStates — supersede 闭包', () => {
  test('(a) 支：同 (node, iteration) 前代 top-level 的 isolating/pending-merge/conflict-human 全废弃', async () => {
    const a1 = await seedRun(h, { id: mkId(1), mergeState: 'isolating' })
    const a2 = await seedRun(h, { id: mkId(2), mergeState: 'pending-merge' })
    const a3 = await seedRun(h, { id: mkId(3), mergeState: 'conflict-human' })
    const fresh = mkId(10)
    const n = abandonSupersededMergeStates({
      db: h.db,
      taskId: h.taskId,
      nodeId: 'n',
      iteration: 0,
      supersededByRunId: fresh,
    })
    expect(n).toBe(3)
    expect(await mergeStateOf(h.db, a1)).toBe('abandoned')
    expect(await mergeStateOf(h.db, a2)).toBe('abandoned')
    expect(await mergeStateOf(h.db, a3)).toBe('abandoned')
  })

  test('(b) 支：前代父行的子行（shard/aggregator）随父废弃；merged 前代与 NULL 行不动', async () => {
    const oldParent = await seedRun(h, { id: mkId(1), mergeState: 'pending-merge' })
    const oldChildPending = await seedRun(h, {
      id: mkId(2),
      mergeState: 'conflict-human',
      parentNodeRunId: oldParent,
    })
    // 已 merged 的前代（fanout undo 依赖它找「已落 canon 的 delta」）与从未隔离的
    // NULL 行（golden-lock）都必须原样保留。
    const oldMerged = await seedRun(h, { id: mkId(3), mergeState: 'merged' })
    const oldNull = await seedRun(h, { id: mkId(4), mergeState: null })
    const oldChildMerged = await seedRun(h, {
      id: mkId(5),
      mergeState: 'merged',
      parentNodeRunId: oldParent,
    })
    const n = abandonSupersededMergeStates({
      db: h.db,
      taskId: h.taskId,
      nodeId: 'n',
      iteration: 0,
      supersededByRunId: mkId(10),
    })
    expect(n).toBe(2) // oldParent + oldChildPending
    expect(await mergeStateOf(h.db, oldParent)).toBe('abandoned')
    expect(await mergeStateOf(h.db, oldChildPending)).toBe('abandoned')
    expect(await mergeStateOf(h.db, oldMerged)).toBe('merged')
    expect(await mergeStateOf(h.db, oldNull)).toBeNull()
    expect(await mergeStateOf(h.db, oldChildMerged)).toBe('merged')
  })

  test('P1-2 对应格：父行未被取代（最新代）的子行不误伤；id< 边界（自身与更新行不动）', async () => {
    // freshest 父行（id 大于 supersededByRunId 的场景不存在——mint 后代行必然最大；
    // 这里构造「supersededBy 早于现存行」的越界调用，断言零命中）。
    const freshParent = await seedRun(h, { id: mkId(20), mergeState: 'isolating' })
    const freshChild = await seedRun(h, {
      id: mkId(21),
      mergeState: 'pending-merge',
      parentNodeRunId: freshParent,
    })
    const n = abandonSupersededMergeStates({
      db: h.db,
      taskId: h.taskId,
      nodeId: 'n',
      iteration: 0,
      supersededByRunId: mkId(10), // 早于两行 → 都不是「前代」
    })
    expect(n).toBe(0)
    expect(await mergeStateOf(h.db, freshParent)).toBe('isolating')
    expect(await mergeStateOf(h.db, freshChild)).toBe('pending-merge')
  })

  test('隔离维度：不同 nodeId / 不同 iteration 的在途行不受波及', async () => {
    const otherNode = await seedRun(h, {
      id: mkId(1),
      nodeId: 'other',
      mergeState: 'pending-merge',
    })
    const otherIter = await seedRun(h, {
      id: mkId(2),
      iteration: 1,
      mergeState: 'pending-merge',
    })
    const n = abandonSupersededMergeStates({
      db: h.db,
      taskId: h.taskId,
      nodeId: 'n',
      iteration: 0,
      supersededByRunId: mkId(10),
    })
    expect(n).toBe(0)
    expect(await mergeStateOf(h.db, otherNode)).toBe('pending-merge')
    expect(await mergeStateOf(h.db, otherIter)).toBe('pending-merge')
  })

  test('幂等：二次调用返回 0（abandoned 已是终态、不在 from 集）', async () => {
    await seedRun(h, { id: mkId(1), mergeState: 'pending-merge' })
    const first = abandonSupersededMergeStates({
      db: h.db,
      taskId: h.taskId,
      nodeId: 'n',
      iteration: 0,
      supersededByRunId: mkId(10),
    })
    const second = abandonSupersededMergeStates({
      db: h.db,
      taskId: h.taskId,
      nodeId: 'n',
      iteration: 0,
      supersededByRunId: mkId(10),
    })
    expect(first).toBe(1)
    expect(second).toBe(0)
  })

  test('P1-1 对应格：dbTxSync 内注入故障 → abandon 全回滚（与后续 insert 同事务生死与共）', async () => {
    const zombie = await seedRun(h, { id: mkId(1), mergeState: 'pending-merge' })
    expect(() =>
      dbTxSync(h.db, (tx) => {
        const n = abandonSupersededMergeStates({
          db: tx,
          taskId: h.taskId,
          nodeId: 'n',
          iteration: 0,
          supersededByRunId: mkId(10),
        })
        if (n !== 1) throw new Error(`expected 1 abandoned inside tx, got ${n}`)
        throw new Error('simulated crash between abandon and insert')
      }),
    ).toThrow('simulated crash between abandon and insert')
    // 回滚后旧行保持 pending-merge——不存在「已废弃但后代行不存在」的撕裂态。
    expect(await mergeStateOf(h.db, zombie)).toBe('pending-merge')
  })
})

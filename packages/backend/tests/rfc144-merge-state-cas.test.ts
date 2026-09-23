// RFC-144 T2 —— merge_state 的两条写路径：状态机 CAS 迁移，与铸行时的 supersede 闭包。
//
// 为什么这条测试存在：merge_state 此前 19 处裸直写零 CAS（flag-audit §4.4），
// 并发覆盖与非法转移全靠隐式约定。本文件把 CAS 层锁死：
//   ① happy path：事件驱动转移 + iso 伴随列（extra 白名单）与 mergeState 同条
//      UPDATE 原子落库；
//   ② CAS 竞态：SELECT 与 UPDATE 之间插入竞争写者 → concurrent-merge-state-transition
//      ——含 **NULL-from 格**（谓词必须用 IS NULL，`eq(col,null)` 恒 false 会让
//      CAS 永远 miss，这是与 status 机唯一的机械差异）；
//   ③ try 变体：域错误（非法转移/竞态/行不存在）折 false，非域错误重抛；
//   ④ supersede 闭包：(a) 废前代 top-level / (b) 废前代子行闭包 /
//      merged 与 merge-failed 不可误废弃 / id< 边界（新行自身与更新行不动）/
//      **父行未被取代的子行不误伤**（Codex 设计门 P1-2 对应格）/ 幂等 /
//      **同事务原子性**（tx 内注入故障 → insert 回滚，P1-1 对应格）。
//
// RFC-369：④ 的判据集合逐格不变，但「作废」不再由铸造事务写出——铸造只 insert，旧代由读侧推导
// （`derivedSupersededIds` = 生产 SQL 谓词），并在下一次迁移尝试时被拦成非法迁移、收成 abandoned 落库
// （`expectFencedToAbandoned`）。每格断言「铸造没写旧代」+「推导集合 = 改前会被 abandon 的集合」。
//
// RFC-359：判据原本打在 `platform/persistence/sqlite/taskLifecycle.ts` 的
// `transitionMergeState` / `tryTransitionMergeState` / `abandonSupersededMergeStates`
// 上——那三个是**零生产调用方**的 SQLite 孪生实现（生产早已走
// `DrizzleMergeStateLifecyclePersistence` 与 `nodeRunMintProgram`，两者都是
// provider 中立的一份）。孪生已随本批删除，判据整体改打在生产实现上，两个引擎各跑一遍。
// 节点行 id 用定长补零字符串（字典序 = 数值序）而非 ulid()，保证「谁更新」
// 100% 确定——同毫秒 ulid 随机段不保证单调。

import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import { nodeRuns, tasks, workflows } from '@/db/schema'
import type { DatabaseTransaction } from '@/platform/persistence/databaseTransaction'
import { DrizzleMergeStateLifecyclePersistence } from '@/modules/task-execution/infrastructure/mergeStateLifecyclePersistence'
import { createNodeRunMintParticipantInTx } from '@/modules/task-execution/infrastructure/nodeRunMintParticipant'
import { withTaskExecutionWrite } from '@/modules/task-execution/infrastructure/ownedTaskExecution'
import { IllegalMergeStateTransition, type MergeStateOrNull } from '@agent-workflow/shared'
import type { NodeRunStatus } from '@agent-workflow/shared'
import { dbWithCompetingWriter } from './helpers/competingWriter'
import { derivedSupersededIds, expectFencedToAbandoned } from './helpers/nodeRunSupersession'
import { describeEachProvider } from './helpers/eachProvider'

/** 定长补零 id：字典序 = 数值序，供 supersede 的 id< 边界断言。 */
const mkId = (n: number): string => String(n).padStart(26, '0')

const SNAPSHOT = '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}'

async function seedTask(db: ProviderNeutralDatabase): Promise<string> {
  const workflowId = ulid()
  await db.insert(workflows).values({ id: workflowId, name: 'w', definition: SNAPSHOT })
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
  return taskId
}

async function seedRun(
  db: ProviderNeutralDatabase,
  taskId: string,
  opts: {
    id?: string
    nodeId?: string
    iteration?: number
    mergeState?: MergeStateOrNull
    parentNodeRunId?: string | null
    shardKey?: string | null
    status?: NodeRunStatus
  } = {},
): Promise<string> {
  const id = opts.id ?? ulid()
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId: opts.nodeId ?? 'n',
    iteration: opts.iteration ?? 0,
    retryIndex: 0,
    status: opts.status ?? 'done',
    mergeState: opts.mergeState ?? null,
    parentNodeRunId: opts.parentNodeRunId ?? null,
    shardKey: opts.shardKey ?? null,
    startedAt: Date.now() - 10,
  })
  return id
}

async function mergeStateOf(db: ProviderNeutralDatabase, id: string): Promise<string | null> {
  return (await db.select().from(nodeRuns).where(eq(nodeRuns.id, id)))[0]!.mergeState
}

/** 竞争写者版的 merge_state 迁移：persistence 自己开事务，代理保证 UPDATE 前插得进去。 */
function racingPersistence(
  db: ProviderNeutralDatabase,
  sabotage: (tx: DatabaseTransaction) => Promise<void>,
): DrizzleMergeStateLifecyclePersistence {
  return new DrizzleMergeStateLifecyclePersistence(dbWithCompetingWriter(db, sabotage))
}

describeEachProvider('RFC-144 merge_state 迁移 —— happy path', (harness) => {
  test('begin-isolation：NULL→isolating，iso base 伴随列同条 UPDATE 原子落库', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const persistence = new DrizzleMergeStateLifecyclePersistence(db)
    const id = await seedRun(db, taskId, { mergeState: null, status: 'running' })
    const r = await persistence.transition({
      nodeRunId: id,
      event: { kind: 'begin-isolation' },
      extra: { isoWorktreePath: '/iso/x', isoBaseSnapshot: 'sha-base' },
    })
    expect(r).toEqual({ from: null, to: 'isolating' })
    const after = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, id)))[0]!
    expect(after.mergeState).toBe('isolating')
    expect(after.isoWorktreePath).toBe('/iso/x')
    expect(after.isoBaseSnapshot).toBe('sha-base')
  })

  test('全链：NULL→isolating→pending-merge→merged（伴随列逐段 pin）', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const persistence = new DrizzleMergeStateLifecyclePersistence(db)
    const id = await seedRun(db, taskId, { mergeState: null, status: 'running' })
    await persistence.transition({ nodeRunId: id, event: { kind: 'begin-isolation' } })
    const r2 = await persistence.transition({
      nodeRunId: id,
      event: { kind: 'mark-pending-merge' },
      extra: { isoNodeTree: 'sha-tree' },
    })
    expect(r2).toEqual({ from: 'isolating', to: 'pending-merge' })
    const r3 = await persistence.transition({
      nodeRunId: id,
      event: { kind: 'mark-merged', via: 'live' },
    })
    expect(r3).toEqual({ from: 'pending-merge', to: 'merged' })
    const after = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, id)))[0]!
    expect(after.mergeState).toBe('merged')
    expect(after.isoNodeTree).toBe('sha-tree')
  })

  test('冲突链：pending-merge→conflict-human→merged（人工决议）', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const persistence = new DrizzleMergeStateLifecyclePersistence(db)
    const id = await seedRun(db, taskId, { mergeState: 'pending-merge' })
    await persistence.transition({
      nodeRunId: id,
      event: { kind: 'park-conflict-human', via: 'replay' },
    })
    expect(await mergeStateOf(db, id)).toBe('conflict-human')
    await persistence.transition({ nodeRunId: id, event: { kind: 'complete-human-resolution' } })
    expect(await mergeStateOf(db, id)).toBe('merged')
  })

  test('非法转移抛 IllegalMergeStateTransition 且不落库（NULL 上直接 mark-merged / 终态重写）', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const persistence = new DrizzleMergeStateLifecyclePersistence(db)
    const idNull = await seedRun(db, taskId, { mergeState: null })
    await expect(
      persistence.transition({ nodeRunId: idNull, event: { kind: 'mark-merged' } }),
    ).rejects.toThrow(IllegalMergeStateTransition)
    expect(await mergeStateOf(db, idNull)).toBeNull()

    const idTerminal = await seedRun(db, taskId, { mergeState: 'merged' })
    await expect(
      persistence.transition({ nodeRunId: idTerminal, event: { kind: 'abandon', reason: 'x' } }),
    ).rejects.toThrow(IllegalMergeStateTransition)
    expect(await mergeStateOf(db, idTerminal)).toBe('merged')
  })

  test('begin-isolation 自环：同行 shard/agg 续跑重盖新 iso 基（isolating 原地、伴随列换新）', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const persistence = new DrizzleMergeStateLifecyclePersistence(db)
    const id = await seedRun(db, taskId, { mergeState: null, status: 'running' })
    await persistence.transition({
      nodeRunId: id,
      event: { kind: 'begin-isolation' },
      extra: { isoWorktreePath: '/iso/old', isoBaseSnapshot: 'sha-old' },
    })
    // 复用行第二次派发：persistIsoBase 重盖 FRESH iso 的基列。
    const r = await persistence.transition({
      nodeRunId: id,
      event: { kind: 'begin-isolation' },
      extra: { isoWorktreePath: '/iso/new', isoBaseSnapshot: 'sha-new' },
    })
    expect(r).toEqual({ from: 'isolating', to: 'isolating' })
    const after = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, id)))[0]!
    expect(after.isoWorktreePath).toBe('/iso/new')
    expect(after.isoBaseSnapshot).toBe('sha-new')
  })

  test('reenter-isolation：同行 wrapper 复活开新一代（merged→isolating / conflict-human→isolating）', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const persistence = new DrizzleMergeStateLifecyclePersistence(db)
    const idMerged = await seedRun(db, taskId, { mergeState: 'merged' })
    const r1 = await persistence.transition({
      nodeRunId: idMerged,
      event: { kind: 'reenter-isolation' },
    })
    expect(r1).toEqual({ from: 'merged', to: 'isolating' })
    // 新一代照常走完整链：isolating → pending-merge → merged。
    await persistence.transition({ nodeRunId: idMerged, event: { kind: 'mark-pending-merge' } })
    await persistence.transition({ nodeRunId: idMerged, event: { kind: 'mark-merged' } })
    expect(await mergeStateOf(db, idMerged)).toBe('merged')

    const idParked = await seedRun(db, taskId, { mergeState: 'conflict-human' })
    const r2 = await persistence.transition({
      nodeRunId: idParked,
      event: { kind: 'reenter-isolation' },
    })
    expect(r2).toEqual({ from: 'conflict-human', to: 'isolating' })
  })

  test('行不存在抛 node-run-not-found', async () => {
    const db = harness.db
    await seedTask(db)
    const persistence = new DrizzleMergeStateLifecyclePersistence(db)
    await expect(
      persistence.transition({ nodeRunId: mkId(999), event: { kind: 'begin-isolation' } }),
    ).rejects.toMatchObject({ code: 'node-run-not-found' })
  })
})

describeEachProvider('RFC-144 merge_state 迁移 —— CAS 竞态', (harness) => {
  test('非 NULL from：竞争写者在 SELECT 与 UPDATE 之间推进行 → concurrent-merge-state-transition，我方整笔回滚', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const id = await seedRun(db, taskId, { mergeState: 'pending-merge' })
    await expect(
      // 竞争写者（模拟另一条腿的 merge-back）先把行推到 merged。
      racingPersistence(db, async (tx) => {
        await tx.update(nodeRuns).set({ mergeState: 'merged' }).where(eq(nodeRuns.id, id))
      }).transition({ nodeRunId: id, event: { kind: 'park-conflict-human' } }),
    ).rejects.toMatchObject({ code: 'concurrent-merge-state-transition' })
    // 读—改—写整笔在**一个**事务里，CAS miss 让整笔回滚——注入的竞争写也一起回滚，
    // 所以行回到竞态前的 pending-merge。判据锁的是「我方那条 park-conflict-human **没**落库」：
    // 谓词 miss 必须变成一个抛出的冲突，而不是静默地把行推到 conflict-human。
    expect(await mergeStateOf(db, id)).toBe('pending-merge')
  })

  test('NULL-from 格：谓词走 IS NULL——竞争写者先 begin-isolation → 我方 CAS miss 而非静默双写', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const id = await seedRun(db, taskId, { mergeState: null, status: 'running' })
    await expect(
      racingPersistence(db, async (tx) => {
        await tx
          .update(nodeRuns)
          .set({ mergeState: 'isolating', isoWorktreePath: '/iso/winner' })
          .where(eq(nodeRuns.id, id))
      }).transition({
        nodeRunId: id,
        event: { kind: 'begin-isolation' },
        extra: { isoWorktreePath: '/iso/loser' },
      }),
    ).rejects.toMatchObject({ code: 'concurrent-merge-state-transition' })
    // 同上，整笔回滚。关键是 `/iso/loser` **没**落库：NULL-from 的谓词若写成 `eq(col, null)`
    // 就会恒 false——那样这里也会抛冲突，但真正的 NULL→isolating 也永远做不成；
    // 所以 happy path 的 `begin-isolation` 用例与本例必须同时绿，才证明谓词走的是 IS NULL。
    const after = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, id)))[0]!
    expect(after.mergeState).toBeNull()
    expect(after.isoWorktreePath).toBeNull()
  })
})

describeEachProvider('RFC-144 tryTransition —— 域错误折 false', (harness) => {
  test('非法转移 → false（错误路径写点在 catch 块内，不得掩盖原始 merge 错误）', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const persistence = new DrizzleMergeStateLifecyclePersistence(db)
    const id = await seedRun(db, taskId, { mergeState: 'merged' })
    expect(
      await persistence.tryTransition({
        nodeRunId: id,
        event: { kind: 'mark-merge-failed', reason: 'late' },
      }),
    ).toBe(false)
    expect(await mergeStateOf(db, id)).toBe('merged')
  })

  test('CAS 竞态 → false；行不存在 → false', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const id = await seedRun(db, taskId, { mergeState: 'pending-merge' })
    expect(
      await racingPersistence(db, async (tx) => {
        await tx.update(nodeRuns).set({ mergeState: 'merged' }).where(eq(nodeRuns.id, id))
      }).tryTransition({ nodeRunId: id, event: { kind: 'mark-merged' } }),
    ).toBe(false)
    expect(
      await new DrizzleMergeStateLifecyclePersistence(db).tryTransition({
        nodeRunId: mkId(998),
        event: { kind: 'mark-merged' },
      }),
    ).toBe(false)
  })

  test('非域错误原样重抛（基础设施故障不能被吞成 false）', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const id = await seedRun(db, taskId, { mergeState: 'pending-merge' })
    await expect(
      racingPersistence(db, () => Promise.reject(new Error('disk on fire'))).tryTransition({
        nodeRunId: id,
        event: { kind: 'mark-merged' },
      }),
    ).rejects.toThrow('disk on fire')
  })
})

/** 铸一行新 node_run —— 生产铸行链路的唯一入口（RFC-369 起只 insert，不再写旧代）。 */
async function mint(
  db: ProviderNeutralDatabase,
  taskId: string,
  opts: { id: string; nodeId?: string; iteration?: number; shardKey?: string | null },
): Promise<string> {
  return await withTaskExecutionWrite(db, async (tx) =>
    createNodeRunMintParticipantInTx(tx).mint({
      id: opts.id,
      taskId,
      nodeId: opts.nodeId ?? 'n',
      iteration: opts.iteration ?? 0,
      status: 'pending',
      cause: 'initial',
      ...(opts.shardKey === undefined ? {} : { overrides: { shardKey: opts.shardKey } }),
    }),
  )
}

describeEachProvider('RFC-144 铸行即取代 —— supersede 闭包', (harness) => {
  test('(a) 废：同 (node, iteration) 前代 top-level 的 isolating/pending-merge/conflict-human 全废弃', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const a1 = await seedRun(db, taskId, { id: mkId(1), mergeState: 'isolating' })
    const a2 = await seedRun(db, taskId, { id: mkId(2), mergeState: 'pending-merge' })
    const a3 = await seedRun(db, taskId, { id: mkId(3), mergeState: 'conflict-human' })
    await mint(db, taskId, { id: mkId(10) })
    // 铸造不写旧代（AC-1）……
    expect(await mergeStateOf(db, a1)).toBe('isolating')
    expect(await mergeStateOf(db, a2)).toBe('pending-merge')
    expect(await mergeStateOf(db, a3)).toBe('conflict-human')
    // ……旧代由读侧推导为已取代，下一次迁移被拦、收成 abandoned 落库（AC-3 / AC-4）。
    expect(await derivedSupersededIds(db, taskId)).toEqual([a1, a2, a3])
    for (const id of [a1, a2, a3]) await expectFencedToAbandoned(db, id)
  })

  test('(b) 废：前代父行的子行（shard/aggregator）随父废弃；merged 前代与 NULL 行不动', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const oldParent = await seedRun(db, taskId, { id: mkId(1), mergeState: 'pending-merge' })
    const oldChildPending = await seedRun(db, taskId, {
      id: mkId(2),
      mergeState: 'conflict-human',
      parentNodeRunId: oldParent,
    })
    // 已 merged 的前代（fanout undo 依赖它找「已落 canon 的 delta」）与从未隔离的
    // NULL 行（golden-lock）都必须原样保留。
    const oldMerged = await seedRun(db, taskId, { id: mkId(3), mergeState: 'merged' })
    const oldNull = await seedRun(db, taskId, { id: mkId(4), mergeState: null })
    const oldChildMerged = await seedRun(db, taskId, {
      id: mkId(5),
      mergeState: 'merged',
      parentNodeRunId: oldParent,
    })
    await mint(db, taskId, { id: mkId(10) })
    expect(await derivedSupersededIds(db, taskId)).toEqual([oldParent, oldChildPending])
    await expectFencedToAbandoned(db, oldChildPending)
    await expectFencedToAbandoned(db, oldParent)
    expect(await mergeStateOf(db, oldMerged)).toBe('merged')
    expect(await mergeStateOf(db, oldNull)).toBeNull()
    expect(await mergeStateOf(db, oldChildMerged)).toBe('merged')
  })

  test('P1-2 对应格：父行未被取代（最新代）的子行不误伤；id< 边界（自身与更新行不动）', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    // freshest 父行（id 大于新铸行的场景不存在——mint 后代行必然最大；这里构造
    // 「新铸行早于现存行」的越界调用，断言零命中）。
    const freshParent = await seedRun(db, taskId, { id: mkId(20), mergeState: 'isolating' })
    // 子行带 shard（生产里的子行要么带 shard、要么在父行之下的另一帧 / 另一个 nodeId）：同帧、
    // null shard、id 更大的行本身就会按 §3(a) 取代父行——改前的铸造闭包在铸出这样一行时同样会废掉父行。
    const freshChild = await seedRun(db, taskId, {
      id: mkId(21),
      mergeState: 'pending-merge',
      parentNodeRunId: freshParent,
      shardKey: 's1',
    })
    await mint(db, taskId, { id: mkId(10) }) // 早于两行 → 都不是「前代」
    expect(await derivedSupersededIds(db, taskId)).toEqual([])
    expect(await mergeStateOf(db, freshParent)).toBe('isolating')
    expect(await mergeStateOf(db, freshChild)).toBe('pending-merge')
  })

  test('隔离维度：不同 nodeId / 不同 iteration 的在途行不受波及', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const otherNode = await seedRun(db, taskId, {
      id: mkId(1),
      nodeId: 'other',
      mergeState: 'pending-merge',
    })
    const otherIter = await seedRun(db, taskId, {
      id: mkId(2),
      iteration: 1,
      mergeState: 'pending-merge',
    })
    await mint(db, taskId, { id: mkId(10) })
    expect(await derivedSupersededIds(db, taskId)).toEqual([])
    expect(await mergeStateOf(db, otherNode)).toBe('pending-merge')
    expect(await mergeStateOf(db, otherIter)).toBe('pending-merge')
  })

  test('幂等：前代收成 abandoned 终态后不在可取代集，再铸一行也不二次翻面', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const prior = await seedRun(db, taskId, { id: mkId(1), mergeState: 'pending-merge' })
    await mint(db, taskId, { id: mkId(10) })
    await expectFencedToAbandoned(db, prior)
    expect(await derivedSupersededIds(db, taskId)).toEqual([])
    // 第二次铸行：mkId(10) 这一代自身 mergeState 为 NULL（不在可取代集），前代已 abandoned。
    await mint(db, taskId, { id: mkId(11) })
    expect(await derivedSupersededIds(db, taskId)).toEqual([])
    expect(await mergeStateOf(db, prior)).toBe('abandoned')
    expect(await mergeStateOf(db, mkId(10))).toBeNull()
  })

  test('P1-1 对应格：事务内注入故障 → insert 回滚，旧代仍按推导未被取代', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const zombie = await seedRun(db, taskId, { id: mkId(1), mergeState: 'pending-merge' })
    await expect(
      withTaskExecutionWrite(db, async (tx) => {
        await createNodeRunMintParticipantInTx(tx).mint({
          id: mkId(10),
          taskId,
          nodeId: 'n',
          iteration: 0,
          status: 'pending',
          cause: 'initial',
        })
        throw new Error('simulated crash after mint')
      }),
    ).rejects.toThrow('simulated crash after mint')
    // 回滚后新一代不存在 ⇒ 旧行按推导未被取代、保持 pending-merge，入口重放仍会合并它。
    expect(await mergeStateOf(db, zombie)).toBe('pending-merge')
    expect(await derivedSupersededIds(db, taskId)).toEqual([])
    expect(
      (
        await db
          .select()
          .from(nodeRuns)
          .where(eq(nodeRuns.id, mkId(10)))
      ).length,
    ).toBe(0)
  })
})

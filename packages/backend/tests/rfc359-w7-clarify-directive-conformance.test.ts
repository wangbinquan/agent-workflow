// RFC-359 W7 —— `ClarifyDirectiveStore` 的双引擎对拍。
//
// 为什么存在：合一前这一对是 `sqliteClarifyDirectiveStore.ts`（34 行纯转发）+
// `postgresqlClarifyDirectiveStore.ts`（86 行逐行内联抄写）。两份实现在**当时**七条判据上确实
// 一致，但抄写本身就是漂移的前提——同一对里已经漂出一处：PG 那份用裸 `db.transaction`（不走
// `databaseSessionFor`），因此不可重入，外层显式事务回滚带不走它的写（2026-09-06 实测：
// SQLite 回滚后 0 行 / PG 回滚后 1 行）。合一后只剩
// `infrastructure/clarifyDirectiveStore.ts` 一个工厂，装配点两个引擎共用。
//
// 本文件把那七条判据 + 重入语义写成**同一段断言**，`describeEachProvider` 在两个引擎上各跑
// 一遍。任何一侧再长出私有分支，这里立刻红。
//
// 判据来源：`application/ports/clarifyDirectiveStore.ts` 的端口契约，语义注释在
// `infrastructure/taskClarifyDirective.ts`（RFC-122 覆盖、RFC-123 recency、
// RFC-207 per-asker 行与节点级 continue 的「解除全部静音」手势）。

import { expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { taskNodeClarifyDirectives } from '@/db/schema'
import { createClarifyDirectiveStore } from '@/modules/collaboration/infrastructure/clarifyDirectiveStore'
import { describeEachProvider } from './helpers/eachProvider'
import { freshTaskId, seedTask } from './helpers/questionDispatchFixture'

/** 直读表：断言存了什么行，而不只是 store 读回什么。 */
function rowsOf(db: ProviderNeutralDatabase, taskId: string, nodeId: string) {
  return db
    .select()
    .from(taskNodeClarifyDirectives)
    .where(
      and(
        eq(taskNodeClarifyDirectives.taskId, taskId),
        eq(taskNodeClarifyDirectives.nodeId, nodeId),
      ),
    )
}

const byShardKey = <T extends { readonly shardKey: string }>(rows: readonly T[]): T[] =>
  [...rows].sort((left, right) => left.shardKey.localeCompare(right.shardKey))

describeEachProvider('RFC-359 W7 —— 澄清指令存储（ClarifyDirectiveStore）', (harness) => {
  test('缺行返回 null（节点级与 per-asker 都是）', async () => {
    const db = harness.db
    const taskId = freshTaskId()
    await seedTask(db, taskId)
    const store = createClarifyDirectiveStore(db)
    expect(await store.get({ taskId, nodeId: 'asker' })).toBeNull()
    expect(await store.get({ taskId, nodeId: 'asker', shardKey: 'a1' })).toBeNull()
    expect(await store.get({ taskId, nodeId: 'asker', shardKey: null })).toBeNull()
    expect(await store.listNodeDirectives(taskId)).toEqual([])
  })

  test('RFC-207 shardKey 回退：本 shard 行赢，缺席时落到节点级 ""', async () => {
    const db = harness.db
    const taskId = freshTaskId()
    await seedTask(db, taskId)
    const store = createClarifyDirectiveStore(db)

    await store.set({ taskId, nodeId: 'asker', directive: 'stop', setBy: 'u1', now: 1000 })
    // 节点级行对每一种读法都成立：省略 / null / 任意未建行的 shard
    for (const shardKey of [undefined, null, 'a1', 'a2'] as const) {
      expect(await store.get({ taskId, nodeId: 'asker', shardKey })).toEqual({
        directive: 'stop',
        updatedAt: 1000,
      })
    }

    await store.set({
      taskId,
      nodeId: 'asker',
      directive: 'continue',
      setBy: 'u2',
      shardKey: 'a1',
      now: 2000,
    })
    // 本 shard 命中 ⇒ 本 shard 赢（连 updatedAt 一起，RFC-123 的 recency 判据读它）
    expect(await store.get({ taskId, nodeId: 'asker', shardKey: 'a1' })).toEqual({
      directive: 'continue',
      updatedAt: 2000,
    })
    // 别的 shard / 节点级读法仍看到节点级行，不被 per-asker 行污染
    expect(await store.get({ taskId, nodeId: 'asker', shardKey: 'a2' })).toEqual({
      directive: 'stop',
      updatedAt: 1000,
    })
    expect(await store.get({ taskId, nodeId: 'asker' })).toEqual({
      directive: 'stop',
      updatedAt: 1000,
    })
    // 另一个节点不共享回退
    expect(await store.get({ taskId, nodeId: 'other', shardKey: 'a1' })).toBeNull()
  })

  test('listNodeDirectives 只取 shardKey === ""，且只看本任务', async () => {
    const db = harness.db
    const taskId = freshTaskId()
    const otherTask = freshTaskId()
    await seedTask(db, taskId)
    await seedTask(db, otherTask)
    const store = createClarifyDirectiveStore(db)

    await store.set({ taskId, nodeId: 'n1', directive: 'stop', setBy: null, now: 1 })
    await store.set({ taskId, nodeId: 'n2', directive: 'continue', setBy: null, now: 1 })
    // per-asker 行不能出现在画布的节点级视图里（RFC-207 §3.7.5）
    await store.set({
      taskId,
      nodeId: 'n1',
      directive: 'continue',
      setBy: null,
      shardKey: 's1',
      now: 1,
    })
    await store.set({
      taskId,
      nodeId: 'n3',
      directive: 'stop',
      setBy: null,
      shardKey: 's1',
      now: 1,
    })
    await store.set({ taskId: otherTask, nodeId: 'n9', directive: 'stop', setBy: null, now: 1 })

    const listed = [...(await store.listNodeDirectives(taskId))].sort((left, right) =>
      left.nodeId.localeCompare(right.nodeId),
    )
    expect(listed).toEqual([
      { nodeId: 'n1', directive: 'stop' },
      { nodeId: 'n2', directive: 'continue' },
    ])
    expect(await store.listNodeDirectives(otherTask)).toEqual([{ nodeId: 'n9', directive: 'stop' }])
  })

  test('upsert 走 (task,node,shard) 三列复合键：同键原地覆盖、异 shard 并存', async () => {
    const db = harness.db
    const taskId = freshTaskId()
    await seedTask(db, taskId)
    const store = createClarifyDirectiveStore(db)

    await store.set({ taskId, nodeId: 'n1', directive: 'stop', setBy: 'u1', now: 10 })
    // 同键第二次写：directive / setBy / updatedAt 全部就地更新，不新增行
    await store.set({ taskId, nodeId: 'n1', directive: 'continue', setBy: 'u2', now: 20 })
    await store.set({
      taskId,
      nodeId: 'n1',
      directive: 'stop',
      setBy: 'u3',
      shardKey: 's1',
      now: 30,
    })
    expect(
      byShardKey(await rowsOf(db, taskId, 'n1')).map((row) => [
        row.shardKey,
        row.directive,
        row.setBy,
        row.updatedAt,
      ]),
    ).toEqual([
      ['', 'continue', 'u2', 20],
      ['s1', 'stop', 'u3', 30],
    ])
  })

  test('RFC-207 级联删除：只有节点级 continue 才清掉本节点的 per-asker 行', async () => {
    const db = harness.db
    const taskId = freshTaskId()
    const otherTask = freshTaskId()
    await seedTask(db, taskId)
    await seedTask(db, otherTask)
    const store = createClarifyDirectiveStore(db)

    for (const shardKey of ['s1', 's2']) {
      await store.set({ taskId, nodeId: 'n1', directive: 'stop', setBy: null, shardKey, now: 1 })
    }
    await store.set({
      taskId,
      nodeId: 'n2',
      directive: 'stop',
      setBy: null,
      shardKey: 's1',
      now: 1,
    })
    await store.set({
      taskId: otherTask,
      nodeId: 'n1',
      directive: 'stop',
      setBy: null,
      shardKey: 's1',
      now: 1,
    })

    // 节点级 stop 不级联
    await store.set({ taskId, nodeId: 'n1', directive: 'stop', setBy: null, now: 2 })
    expect(byShardKey(await rowsOf(db, taskId, 'n1')).map((row) => row.shardKey)).toEqual([
      '',
      's1',
      's2',
    ])
    // shard 级 continue 不级联（只更新自己那行）
    await store.set({
      taskId,
      nodeId: 'n1',
      directive: 'continue',
      setBy: null,
      shardKey: 's1',
      now: 3,
    })
    expect(byShardKey(await rowsOf(db, taskId, 'n1')).map((row) => row.shardKey)).toEqual([
      '',
      's1',
      's2',
    ])

    // 节点级 continue = 「解除本节点全部静音」：per-asker 行全删，只留 '' 行
    await store.set({ taskId, nodeId: 'n1', directive: 'continue', setBy: 'u9', now: 4 })
    const left = await rowsOf(db, taskId, 'n1')
    expect(left.map((row) => [row.shardKey, row.directive, row.setBy, row.updatedAt])).toEqual([
      ['', 'continue', 'u9', 4],
    ])
    // 级联只作用于本 (task,node)
    expect(await rowsOf(db, taskId, 'n2')).toHaveLength(1)
    expect(await rowsOf(db, otherTask, 'n1')).toHaveLength(1)
    // 级联之后 per-asker 读法回落到节点级 continue（而不是残留的 stop）
    expect(await store.get({ taskId, nodeId: 'n1', shardKey: 's1' })).toEqual({
      directive: 'continue',
      updatedAt: 4,
    })
  })

  test('now 缺省用当前时刻，显式 now 原样落库', async () => {
    const db = harness.db
    const taskId = freshTaskId()
    await seedTask(db, taskId)
    const store = createClarifyDirectiveStore(db)

    const before = Date.now()
    await store.set({ taskId, nodeId: 'n1', directive: 'stop', setBy: null })
    const after = Date.now()
    const stamped = (await rowsOf(db, taskId, 'n1'))[0]!
    expect(stamped.updatedAt).toBeGreaterThanOrEqual(before)
    expect(stamped.updatedAt).toBeLessThanOrEqual(after)

    await store.set({ taskId, nodeId: 'n2', directive: 'stop', setBy: null, now: 424_242 })
    expect((await rowsOf(db, taskId, 'n2'))[0]!.updatedAt).toBe(424_242)
  })

  test('set 是一笔事务：upsert 与级联删除一起可见', async () => {
    const db = harness.db
    const taskId = freshTaskId()
    await seedTask(db, taskId)
    const store = createClarifyDirectiveStore(db)

    await store.set({
      taskId,
      nodeId: 'n1',
      directive: 'stop',
      setBy: null,
      shardKey: 's1',
      now: 1,
    })
    await store.set({ taskId, nodeId: 'n1', directive: 'continue', setBy: null, now: 2 })
    expect((await rowsOf(db, taskId, 'n1')).map((row) => [row.shardKey, row.directive])).toEqual([
      ['', 'continue'],
    ])
  })

  test('set 可重入：在外层显式事务里参与它，外层回滚一起带走', async () => {
    const db = harness.db
    const taskId = freshTaskId()
    await seedTask(db, taskId)
    const store = createClarifyDirectiveStore(db)

    // 合一前 PG 那份走裸 db.transaction：另开连接、独立提交，外层回滚带不走 —— 这条锁住它不复发。
    await expect(
      harness.session.transaction(async () => {
        await store.set({ taskId, nodeId: 'n1', directive: 'stop', setBy: null, now: 1 })
        throw new Error('rfc359-w7-rollback')
      }),
    ).rejects.toThrow('rfc359-w7-rollback')
    expect(await rowsOf(db, taskId, 'n1')).toHaveLength(0)

    // 外层提交时写入照常落库
    await harness.session.transaction(async () => {
      await store.set({ taskId, nodeId: 'n1', directive: 'stop', setBy: null, now: 5 })
    })
    expect((await rowsOf(db, taskId, 'n1')).map((row) => row.updatedAt)).toEqual([5])
  })
})

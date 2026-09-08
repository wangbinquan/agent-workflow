// RFC-359 W5-T19e —— 双引擎 harness 自检。
//
// 锁两件事：① `describeEachProvider` 的引擎解析——缺省双引擎、`AW_TEST_PROVIDERS=sqlite` 只能
// 显式收窄、非法值直接抛；② harness 给每个用例的库是干净的、session 在两个引擎上语义一致。
// 这条文件本身就是「新增功能天然要验证到两种数据库」的最小样板：同一段断言，两个引擎各跑一遍。

import { describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { committedEventFamilyCutovers, tasks, workflows } from '@/db/schema'
import { describeEachProvider, resolveTestProviders } from './helpers/eachProvider'

describe('RFC-359 —— describeEachProvider 的引擎解析', () => {
  test('缺省双引擎；AW_TEST_PROVIDERS 只能显式收窄；非法值直接抛', () => {
    expect(resolveTestProviders({})).toEqual(['sqlite', 'postgresql'])
    expect(resolveTestProviders({ AW_TEST_PROVIDERS: '' })).toEqual(['sqlite', 'postgresql'])
    expect(resolveTestProviders({ AW_TEST_PROVIDERS: 'sqlite' })).toEqual(['sqlite'])
    expect(resolveTestProviders({ AW_TEST_PROVIDERS: ' postgresql , sqlite ' })).toEqual([
      'postgresql',
      'sqlite',
    ])
    expect(resolveTestProviders({ AW_TEST_PROVIDERS: 'sqlite,sqlite' })).toEqual(['sqlite'])
    expect(() => resolveTestProviders({ AW_TEST_PROVIDERS: 'mysql' })).toThrow(/只接受/)
    expect(() => resolveTestProviders({ AW_TEST_PROVIDERS: ' , ' })).toThrow(/至少/)
  })

  test('databaseCount 在注册 describe 之前拒绝非法数量', () => {
    for (const databaseCount of [0, -1, 1.5, NaN, Infinity, -Infinity, 2 ** 53, null, '2']) {
      expect(() =>
        describeEachProvider('invalid count', () => {}, { databaseCount: databaseCount as number }),
      ).toThrow('DescribeEachProviderOptions.databaseCount 必须是正安全整数')
    }
  })
})

async function seedWorkflow(db: ProviderNeutralDatabase): Promise<void> {
  await db.insert(workflows).values({
    id: 'wf_harness',
    name: 'harness',
    description: '',
    definition: '{}',
    version: 1,
    schemaVersion: 4,
  })
}

function taskRow(id: string) {
  return {
    id,
    name: 'harness',
    workflowId: 'wf_harness',
    workflowSnapshot: '{}',
    repoPath: '/tmp/aw-harness',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${id}`,
    status: 'pending' as const,
    inputs: '{}',
    startedAt: 1,
  }
}

describeEachProvider('RFC-359 —— 双引擎 harness 自检', (harness) => {
  test('每个用例从干净库开始：写入只在本用例可见', async () => {
    expect(await harness.db.select({ id: tasks.id }).from(tasks)).toEqual([])
    await seedWorkflow(harness.db)
    await harness.db.insert(tasks).values(taskRow('t_visible'))
    expect(
      (await harness.db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, 't_visible'))).map(
        (row) => row.id,
      ),
    ).toEqual(['t_visible'])
  })

  test('上一个用例的写入已被清掉（顺序无关：任何用例开头都应为空）', async () => {
    expect(await harness.db.select({ id: tasks.id }).from(tasks)).toEqual([])
    expect(await harness.db.select({ id: workflows.id }).from(workflows)).toEqual([])
  })

  test('session.transaction 体内抛错 ⇒ 整笔回滚，跨事件循环 tick 仍成立（两个引擎同一断言）', async () => {
    await seedWorkflow(harness.db)
    await expect(
      harness.session.transaction(async (tx) => {
        await tx.insert(tasks).values(taskRow('t_rolled_back'))
        await new Promise((resolve) => setTimeout(resolve, 2))
        await tx.insert(tasks).values(taskRow('t_rolled_back_2'))
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(await harness.db.select({ id: tasks.id }).from(tasks)).toEqual([])
  })

  test('session.transaction 正常返回 ⇒ 提交', async () => {
    await seedWorkflow(harness.db)
    const inserted = await harness.session.transaction(async (tx) => {
      await tx.insert(tasks).values(taskRow('t_committed'))
      return (await tx.select({ id: tasks.id }).from(tasks)).map((row) => row.id)
    })
    expect(inserted).toEqual(['t_committed'])
    expect((await harness.db.select({ id: tasks.id }).from(tasks)).map((row) => row.id)).toEqual([
      't_committed',
    ])
  })

  test('capabilities 是引擎事实，且 session.engine 与之同一份', () => {
    expect(harness.capabilities).toBe(harness.session.engine)
    expect(harness.capabilities.maxBindParameters).toBe(
      harness.capabilities.isolation === 'exclusive' ? 32_766 : 65_535,
    )
  })

  test('默认仍只有第 0 库，原 db/session/capabilities 都是它的别名', () => {
    expect(harness.database(0).db).toBe(harness.db)
    expect(harness.database(0).session).toBe(harness.session)
    expect(harness.database(0).capabilities).toBe(harness.capabilities)
    expect(() => harness.database(1)).toThrow('ProviderHarness database index 必须在 0..0')
  })
})

describeEachProvider(
  'RFC-359 —— 同一 provider 的两份独立真库',
  (harness) => {
    test('同一主键可保存不同内容，库/session/记录器的作用域彼此独立', async () => {
      const primary = harness.database(0)
      const secondary = harness.database(1)
      expect(primary.db).not.toBe(secondary.db)
      expect(primary.session).not.toBe(secondary.session)
      expect(primary.capabilities).toEqual(secondary.capabilities)
      for (const database of [primary, secondary]) await seedWorkflow(database.db)
      await primary.db.insert(tasks).values({ ...taskRow('same-key'), name: 'primary' })
      await secondary.db.insert(tasks).values({ ...taskRow('same-key'), name: 'secondary' })

      const primaryRecording = harness.recordStatements()
      const secondaryRecording = secondary.recordStatements()
      try {
        expect(
          await primary.db
            .select({ name: tasks.name })
            .from(tasks)
            .where(eq(tasks.name, 'primary')),
        ).toEqual([{ name: 'primary' }])
        expect(secondaryRecording.selects()).toEqual([])
        expect(
          await secondary.db
            .select({ name: tasks.name })
            .from(tasks)
            .where(eq(tasks.name, 'secondary')),
        ).toEqual([{ name: 'secondary' }])
        expect(primaryRecording.selects()).toHaveLength(1)
        expect(secondaryRecording.selects()).toHaveLength(1)
        expect(primaryRecording.selects()[0]).toMatchObject({ values: ['primary'], rows: 1 })
        expect(secondaryRecording.selects()[0]).toMatchObject({ values: ['secondary'], rows: 1 })
        expect(await harness.explain(primaryRecording.selects()[0]!)).not.toBe('')
        expect(await secondary.explain(secondaryRecording.selects()[0]!)).not.toBe('')
      } finally {
        primaryRecording.stop()
        secondaryRecording.stop()
      }
    })

    test('一库事务回滚不带走另一库已提交的同主键行，两侧都成立', async () => {
      for (const index of [0, 1]) await seedWorkflow(harness.database(index).db)
      for (const rollbackIndex of [0, 1]) {
        const rolledBack = harness.database(rollbackIndex)
        const committed = harness.database(1 - rollbackIndex)
        const id = `rollback-${rollbackIndex}`
        await committed.session.transaction(async (tx) => {
          await tx.insert(tasks).values({ ...taskRow(id), name: 'committed elsewhere' })
        })
        const error = new Error(`rollback database ${rollbackIndex}`)
        await expect(
          rolledBack.session.transaction(async (tx) => {
            await tx.insert(tasks).values({ ...taskRow(id), name: 'rolled back here' })
            throw error
          }),
        ).rejects.toBe(error)
        expect(await rolledBack.db.select().from(tasks).where(eq(tasks.id, id))).toEqual([])
        expect(
          await committed.db.select({ name: tasks.name }).from(tasks).where(eq(tasks.id, id)),
        ).toEqual([{ name: 'committed elsewhere' }])
      }
    })

    test('EXPLAIN 在指定真库执行：只存在于附库的表在主库解释失败', async () => {
      const primary = harness.database(0)
      const secondary = harness.database(1)
      // PG 业务客户端不执行 DDL；夹具经自己所选真库的 native/runtime 创建探针。
      await secondary.executeFixtureDdl(
        'create table harness_plan_witness (marker text primary key)',
      )
      try {
        await expect(
          secondary.executeFixtureDdl(
            'create table harness_plan_witness (marker text primary key)',
          ),
        ).rejects.toThrow()
        await secondary.db.run(sql`insert into harness_plan_witness (marker) values (${'child'})`)
        const recording = secondary.recordStatements()
        try {
          expect(
            await secondary.db.all<{ marker: string }>(
              sql`select marker from harness_plan_witness where marker = ${'child'}`,
            ),
          ).toEqual([{ marker: 'child' }])
          const statement = recording.selects()[0]!
          expect(statement).toMatchObject({ values: ['child'], rows: 1 })
          expect(await secondary.explain(statement)).toContain('harness_plan_witness')
          expect(await primary.explain(statement)).toBe('')
          // 默认 DDL 端口也指向主库，失败不会影响附库；原始执行错误必须传播。
          await expect(
            harness.executeFixtureDdl('drop table harness_plan_witness'),
          ).rejects.toThrow()
          expect(await secondary.explain(statement)).toContain('harness_plan_witness')
        } finally {
          recording.stop()
        }
      } finally {
        await secondary.executeFixtureDdl('drop table harness_plan_witness')
      }
    })

    test('database(index) 接受两个合法索引并明确拒绝越界、分数与非有限值', () => {
      expect(harness.database(0)).toBe(harness.database(0))
      expect(harness.database(1)).toBe(harness.database(1))
      for (const index of [-1, 2, 0.5, NaN, Infinity, -Infinity, 2 ** 53]) {
        expect(() => harness.database(index)).toThrow('ProviderHarness database index 必须在 0..1')
      }
    })

    let migrationSeeds: (typeof committedEventFamilyCutovers.$inferSelect)[] | undefined
    for (const round of [1, 2]) {
      test(`每用例各自恢复迁移种子、清空业务写入（见证 ${round}）`, async () => {
        for (const index of [0, 1]) {
          const { db } = harness.database(index)
          expect(await db.select().from(tasks)).toEqual([])
          expect(await db.select().from(workflows)).toEqual([])
          const seeds = await db
            .select()
            .from(committedEventFamilyCutovers)
            .orderBy(committedEventFamilyCutovers.producer, committedEventFamilyCutovers.family)
          expect(seeds.length).toBeGreaterThan(0)
          migrationSeeds ??= seeds
          expect(seeds).toEqual(migrationSeeds)
          // 每次都污染两库；任意测试顺序下，后一个见证仍必须从原迁移快照开始。
          await db.delete(committedEventFamilyCutovers)
          await seedWorkflow(db)
          await db.insert(tasks).values(taskRow('same-key'))
        }
      })
    }
  },
  { databaseCount: 2 },
)

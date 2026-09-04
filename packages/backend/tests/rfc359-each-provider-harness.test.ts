// RFC-359 W5-T19e —— 双引擎 harness 自检。
//
// 锁两件事：① `describeEachProvider` 的引擎解析——缺省双引擎、`AW_TEST_PROVIDERS=sqlite` 只能
// 显式收窄、非法值直接抛；② harness 给每个用例的库是干净的、session 在两个引擎上语义一致。
// 这条文件本身就是「新增功能天然要验证到两种数据库」的最小样板：同一段断言，两个引擎各跑一遍。

import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { tasks, workflows } from '@/db/schema'
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
})

// RFC-359 AC-11（plan §5ef）—— 目录概览的可见计数：六条 `count(*)` 收成一条 `UNION ALL`。
//
// # 为什么这条判据存在
//
// `/api/overview` 是九个 HTTP 端点里**唯一**没过 PostgreSQL 绝对预算的那个
//（run `34816698143`，`scale=full`：PG p95 11.003ms > 10ms）。查询画像把根因钉死了，
// 而且钉的方向与直觉相反：
//
//   · 四条任务计数**全部走 `Index Only Scan / idx_tasks_overview_counts`**，
//     `Actual Total Time` 是 0.014 / 0.017 / 0.025 / 1.571 ms——库里真正干的活不到 1.6ms；
//   · 但这四条语句的 `wallMs` 是 7.0–7.6ms，差出的约 6ms/条全在**客户端侧**
//     （连接获取 / 编译绑定 / 往返 / 解码）；
//   · 该端点共发 **22 条**语句（九端点之最），22 条的 `wallMs` 合计 77.4ms 而端点墙钟
//     15.5ms ⇒ 约 5 路并发。墙钟 ≈（条数 ÷ 并发度）× 均值，**随条数线性增长**。
//
// 所以该端点的正解是**减少语句条数**，不是优化 SQL。本文件锁住其中一半：资源目录那六条。
//
// # 锁两件事，缺一不可
//
// ① **数值与逐表路径逐个相等**——批量那条 `UNION ALL` 的每个分支复用的是同一个
//    `visibleRowsCondition` + `builtinCondition`，可见性阶梯一个字节都不该变。
//    只锁条数不锁数值，把谓词写错也能"优化成功"。
// ② **条数真的降下来了**——只锁数值不锁条数，有人把它改回逐表循环、数值照样对，
//    而这条判据存在的唯一理由（AC-11 那 1ms）就悄悄没了。

import { expect, test } from 'bun:test'
import { ulid } from 'ulid'

import { buildActor } from '@/auth/actor'
import { agents, users, workflows } from '@/db/schema'
import { createResourceCatalogOverviewCountPort } from '@/modules/resource-catalog/infrastructure/resourceCatalogOverview'
import type { CatalogSelectorKind } from '@/modules/resource-catalog/domain/resourceKinds'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'

const OWNER = 'user_w5ef_owner'

const REQUESTS: ReadonlyArray<{ kind: CatalogSelectorKind; excludeBuiltin: boolean }> = [
  { kind: 'agent', excludeBuiltin: true },
  { kind: 'skill', excludeBuiltin: false },
  { kind: 'mcp', excludeBuiltin: false },
  { kind: 'plugin', excludeBuiltin: false },
  { kind: 'workflow', excludeBuiltin: true },
  { kind: 'workgroup', excludeBuiltin: false },
]

const actor = buildActor({
  user: {
    id: OWNER,
    username: 'w5ef-owner',
    displayName: 'W5EF owner',
    role: 'user',
    status: 'active',
  },
  source: 'session',
})

async function seed(harness: ProviderHarness): Promise<void> {
  const now = Date.now()
  await harness.db.insert(users).values({
    id: OWNER,
    username: 'w5ef-owner',
    displayName: 'W5EF owner',
    role: 'user',
    status: 'active',
    passwordHash: null,
    createdAt: now,
    updatedAt: now,
  } as typeof users.$inferInsert)
  // 两个 agent：一个 built-in（该被 excludeBuiltin 排掉）、一个自有。
  for (const [name, builtin] of [
    ['w5ef-builtin', true],
    ['w5ef-mine', false],
  ] as const) {
    await harness.db.insert(agents).values({
      id: ulid(),
      name,
      description: '',
      bodyMd: 'b',
      ownerUserId: builtin ? null : OWNER,
      visibility: builtin ? 'public' : 'private',
      builtin,
      createdAt: now,
      updatedAt: now,
    } as typeof agents.$inferInsert)
  }
  await harness.db.insert(workflows).values({
    id: ulid(),
    name: 'w5ef-flow',
    description: '',
    definition: JSON.stringify({ $schema_version: 6, inputs: [], nodes: [], edges: [] }),
    version: 1,
    ownerUserId: OWNER,
    visibility: 'private',
    builtin: false,
    createdAt: now,
    updatedAt: now,
  } as typeof workflows.$inferInsert)
}

describeEachProvider('RFC-359 §5ef 概览计数批量化（双引擎）', (harness) => {
  test('①批量的每个数值与逐表路径逐个相等（谓词一个字节没变）', async () => {
    await seed(harness)
    const port = createResourceCatalogOverviewCountPort(harness.db)

    const batched = await port.countVisibleMany(actor, REQUESTS)
    for (const request of REQUESTS) {
      const single = await port.countVisible(actor, request.kind, {
        excludeBuiltin: request.excludeBuiltin,
      })
      expect(
        batched.get(request.kind),
        `${request.kind}：批量与逐表不一致 ⇒ UNION 分支的谓词被改坏了`,
      ).toBe(single)
    }
    // 语料非空：全 0 的话上面那圈比较毫无预言力。
    expect(batched.get('agent'), 'built-in 必须被 excludeBuiltin 排掉，自有那条要留下').toBe(1)
    expect(batched.get('workflow')).toBe(1)
  })

  test('②六个维度只发一条语句（这条判据就是那 1ms 的全部理由）', async () => {
    await seed(harness)
    const port = createResourceCatalogOverviewCountPort(harness.db)
    const recording = harness.recordStatements()
    try {
      await port.countVisibleMany(actor, REQUESTS)
      expect(
        recording.selects().length,
        '六个维度不再逐表各发一条——改回循环的话 AC-11 的 overview 预算会重新超',
      ).toBe(1)
    } finally {
      recording.stop()
    }
  })

  test('③无权限的维度不进请求列表 ⇒ 空请求不发任何语句', async () => {
    await seed(harness)
    const port = createResourceCatalogOverviewCountPort(harness.db)
    const recording = harness.recordStatements()
    try {
      expect((await port.countVisibleMany(actor, [])).size).toBe(0)
      expect(recording.selects().length, '空请求不该产生往返').toBe(0)
    } finally {
      recording.stop()
    }
  })
})

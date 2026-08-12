// RFC-284 T3（2026-08-12 系统归一审计 N1 / 决策 D2）——resourcePolicy 表与
// drizzle schema 的一致性守卫。
//
// 为什么存在：RFC-282 交付的 DISABLED_RESOURCE_POLICY 曾含一个 'agent' 条目，
// 其 why 声称「agents.enabled 存在」并被 boot 自检原样输出给运维——实测 agents
// 表根本没有 enabled 列（原注释引的 schema 行属于 runtimes 表）。表驱动的
// 「唯一可读答案」如果基于虚构事实，比没有答案更糟（RFC-280 实现门 P2-D）。
// 本守卫用 drizzle 表对象**反射**（不是 grep 注释）钉死两个不变量：
//   1. 政策表里每个 kind 对应的表都真有 enabled 列——变异实证：把 'agent'
//      加回 DisableableResourceKind/政策表，本测试立刻红（agents 无该列）。
//   2. agents/skills 表确实没有 enabled 列——哪天有人真加了列，这条断言红，
//      提醒把「加列、加消费语义、加政策条目」放进同一个 RFC 一起评审。

import { describe, expect, test } from 'bun:test'
import { getTableColumns } from 'drizzle-orm'
import type { Table } from 'drizzle-orm'
import { agents, mcps, plugins, skills } from '../src/db/schema'
import {
  DISABLED_RESOURCE_POLICY,
  type DisableableResourceKind,
} from '../src/services/execution/resourcePolicy'

// 编译期穷尽：新增 DisableableResourceKind 必须同时在这里给出它的表映射，
// 否则 satisfies 直接编译失败——「新增类型必须表态」的 D 批目标在本表延续。
const KIND_TABLE: Record<DisableableResourceKind, Table> = {
  mcp: mcps,
  plugin: plugins,
} satisfies Record<DisableableResourceKind, Table>

describe('RFC-284 T3 — DISABLED_RESOURCE_POLICY schema guard', () => {
  test('every policy kind maps to a table that really has an `enabled` column', () => {
    for (const kind of Object.keys(DISABLED_RESOURCE_POLICY) as DisableableResourceKind[]) {
      const columns = getTableColumns(KIND_TABLE[kind])
      expect(`${kind}:${'enabled' in columns}`).toBe(`${kind}:true`)
    }
  })

  test('agents and skills have NO enabled column (why they are not in the table)', () => {
    expect('enabled' in getTableColumns(agents)).toBe(false)
    expect('enabled' in getTableColumns(skills)).toBe(false)
  })
})

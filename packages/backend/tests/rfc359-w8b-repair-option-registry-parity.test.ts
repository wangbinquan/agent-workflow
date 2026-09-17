// RFC-359 AC-1（plan §5hn 之后的盘点，第 8 刀第 1 步）—— **两份修复选项注册表的元数据逐格相等**。
//
// 为什么这条测试存在
// ------------------
// 手动修复在两个引擎上是两份独立实现：
//   · SQLite 路由 → `platform/persistence/sqlite/taskLifecycleRepair.ts` 的 `REPAIR_OPTIONS`
//     （逐个手写的 `RepairOptionDef` 字面量，13 个 `lifecycle-repair-*.test.ts` 在跑）；
//   · PostgreSQL 路由 → `postgresqlTaskRouteRepairOperations.ts` 的 `OPTION_DEFINITIONS`
//     （`option()` 模板工厂派生 i18n key，`rfc359-w8-auto-repair-conformance` 在跑）。
//
// **两份各自都有覆盖，但此前没有任何东西比较它们。** 选项的 **id 集合**早就锚在 shared 的
// `REPAIR_OPTION_IDS` 上（SQLite 侧还有一条运行期 ⊆ 守卫），可是元数据没有：
// `labelKey` / `descriptionKey` / `risk` / `destructive` / `revivesExecution` /
// `autoApplyEligible` 这六格是两边分别写的。漂了会怎样——
//   · `risk` / `destructive` 漂：同一个修复在一个部署上弹二次确认、在另一个上一键就执行；
//   · `labelKey` 漂：一侧按钮显示 i18n key 原文（翻译缺键）；
//   · `autoApplyEligible` 漂：自动修复循环在一个部署上会自己动手、另一个不会；
//   · `revivesExecution` 漂：TURN-ENGINE 工作组任务的「不可复活」拒绝在一侧失效。
// 这些全是用户可见的，而且**不会让任何现有测试变红**——两份实现各自都是自洽的。
//
// 本条是纯数据对拍（不连库），所以它也顺便钉住第三件事：两张表都必须**恰好**覆盖 shared
// 分类，不多不少（SQLite 的运行期守卫只查 ⊆，漏一项它不报）。
import { describe, expect, test } from 'bun:test'
import { REPAIR_OPTION_IDS, type LifecycleAlertRule } from '@agent-workflow/shared'

import { REPAIR_OPTIONS } from '@/platform/persistence/sqlite/taskLifecycleRepair'
import { OPTION_DEFINITIONS } from '@/modules/task-execution/infrastructure/postgresqlTaskRouteRepairOperations'

/** 只取元数据那几格——`preflight` / `apply` 是实现，不在本条的比较面里。 */
function metaOf(def: {
  readonly id: string
  readonly rule: string
  readonly labelKey: string
  readonly descriptionKey: string
  readonly risk: string
  readonly destructive: boolean
  readonly revivesExecution?: boolean
  readonly autoApplyEligible?: boolean
}): Record<string, unknown> {
  return {
    id: def.id,
    rule: def.rule,
    labelKey: def.labelKey,
    descriptionKey: def.descriptionKey,
    risk: def.risk,
    destructive: def.destructive,
    // 两边一个用「缺省即 false」、一个用「存在即 true」，归一成布尔再比，
    // 免得 `undefined` vs `false` 这种写法差异冒充成真分叉。
    revivesExecution: def.revivesExecution === true,
    autoApplyEligible: def.autoApplyEligible === true,
  }
}

const RULES = Object.keys(REPAIR_OPTION_IDS) as LifecycleAlertRule[]

describe('RFC-359 第 8 刀 —— 修复选项注册表的两份元数据逐格相等', () => {
  test('两张表都恰好覆盖 shared 分类（不多不少）', () => {
    for (const rule of RULES) {
      const expected = [...REPAIR_OPTION_IDS[rule]].sort()
      expect(
        REPAIR_OPTIONS[rule].map((def) => def.id).sort(),
        `SQLite 的 ${rule} 选项集合与 shared 分类不符`,
      ).toEqual(expected)
      expect(
        Object.values(OPTION_DEFINITIONS)
          .filter((def) => def.rule === rule)
          .map((def) => def.id)
          .sort(),
        `PostgreSQL 的 ${rule} 选项集合与 shared 分类不符`,
      ).toEqual(expected)
    }
  })

  test('逐个选项：六格元数据两侧逐字相等', () => {
    const sqlite: Record<string, unknown> = {}
    const postgresql: Record<string, unknown> = {}
    for (const rule of RULES) {
      for (const def of REPAIR_OPTIONS[rule]) sqlite[def.id] = metaOf(def)
      for (const id of REPAIR_OPTION_IDS[rule]) {
        const def = OPTION_DEFINITIONS[id as keyof typeof OPTION_DEFINITIONS]
        postgresql[id] = metaOf(def)
      }
    }
    expect(
      postgresql,
      '两份修复选项注册表的元数据不一致——同一个修复在两个部署上会显示不同的风险 / 文案 / ' +
        '自动可用性，而两侧各自的测试都不会因此变红（它们只验各自那一份）。',
    ).toEqual(sqlite)
  })

  test('不变量：autoApplyEligible ⇒ 低风险且非破坏性（两侧同时成立）', () => {
    // shared 的 `autoApplyInvariantHolds` 已经对一侧成立；这里再要求**两侧**都成立，
    // 否则自动修复循环在某个部署上会自己动手做一件高风险的事。
    for (const table of [REPAIR_OPTIONS, OPTION_DEFINITIONS]) {
      const defs = Array.isArray(table)
        ? table
        : Object.values(table as Record<string, unknown>).flatMap((value) =>
            Array.isArray(value) ? value : [value],
          )
      for (const raw of defs) {
        const def = raw as {
          id: string
          risk: string
          destructive: boolean
          autoApplyEligible?: boolean
        }
        if (def.autoApplyEligible !== true) continue
        expect(def.risk, `${def.id} 可自动应用却不是 low risk`).toBe('low')
        expect(def.destructive, `${def.id} 可自动应用却是破坏性的`).toBe(false)
      }
    }
  })
})

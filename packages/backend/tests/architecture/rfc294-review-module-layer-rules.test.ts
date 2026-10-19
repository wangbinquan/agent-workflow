// RFC-294 review 2026-08-30 §B2 —— design.md §3「新增常驻规则 1～3」的模块内分层门。
//
// 为什么存在（design/RFC-294-backend-layered-target-architecture/review-2026-08-30.md §B2）：
// design §3 写了 domain 禁 `hono|drizzle|@/db|node:fs|@/ws|@/routes|@/server`、application 禁具体
// DB table 并禁 `infrastructure/**`，但 `.dependency-cruiser.cjs` 只有 routes/transport/util/auth/
// services/circular 六条规则，RFC-317 outbound census 也只盯 `@/services|@/routes|@/ws|@/mcp`
// 与 `drizzle-orm|hono` 包——`@/db/schema`（Drizzle 表）与 `infrastructure/**` 从
// application/engine/domain 被直接 import 无人看守：committed HEAD 上 application 有 17 个文件
// value-import `@/db/schema`、6 个文件 import 自己的 infrastructure；domain 层当前为 0（守卫在零基线上封住）。
//
// 三条规则（与 RFC-317 outbound census 不重叠：drizzle-orm/hono 包级导入仍由后者记账）：
//   domain-adapter-import   domain/** 不得 import adapter / vendor / 进程全局；
//   schema-table-import     application/engine 不得 import `@/db/schema`（表属于 infrastructure）；
//   infrastructure-import   domain/application/engine 不得 import 本模块或他模块的 infrastructure/**。
// 存量逐条入 `MODULE_LAYER_RULE_DEBT`，只降不升；每条点名清偿波次；修掉后必须同批销账。

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

import { backendUnits, isModuleUnit, sourceUnit, type SourceUnit } from './census'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')

import {
  createGateCorpus,
  moduleLayerViolations as detectModuleLayers,
  exactAllowlist,
  type ModuleLayerRule,
  type ModuleLayerViolation,
} from './rfc294Gates'

interface ModuleLayerDebt {
  readonly rule: ModuleLayerRule
  readonly file: string
  readonly specifier: string
  readonly why: string
  readonly removeAfterWave: string
}
export function moduleLayerViolations(units: readonly SourceUnit[]): ModuleLayerViolation[] {
  return detectModuleLayers(createGateCorpus(units))
}

/**
 * 存量分层违规（RFC-376 阶段 B，committed HEAD `2a70c9328` 重算）。
 * 每条一个 `rule|file|specifier`；只降不升。
 */
export const MODULE_LAYER_RULE_DEBT: readonly ModuleLayerDebt[] = [
  {
    rule: 'inbound-context-internal-import',
    file: 'packages/backend/src/modules/knowledge-evolution/inbound/fusionRoutes.ts',
    specifier: '@/modules/task-execution/inbound/directTaskInitiator',
    why: 'RFC-376 Phase B committed baseline; move cross-context assembly and inbound calls behind exact public contracts.',
    removeAfterWave: 'RFC-294 S5/S6',
  },
]

const UNITS = backendUnits(REPO_ROOT).filter(isModuleUnit)

function key(entry: { rule: string; file: string; specifier: string }): string {
  return `${entry.rule}|${entry.file}|${entry.specifier}`
}

describe('RFC-294 review §B2 —— 模块内分层规则（design §3 常驻规则 1～3）', () => {
  test('语料下限：确实扫到了 modules/** 生产源码', () => {
    expect(UNITS.length).toBeGreaterThanOrEqual(300)
  })

  test('分层违规与债务账本逐条相等（新增 ⇒ 红；修掉不销账 ⇒ 红）', () => {
    const observed = moduleLayerViolations(UNITS).map(key).sort()
    const ledger = MODULE_LAYER_RULE_DEBT.map(key).sort()
    const unlisted = observed.filter((item) => !ledger.includes(item))
    const stale = ledger.filter((item) => !observed.includes(item))
    expect(
      unlisted,
      'domain/application/engine 新增了对 @/db/schema、infrastructure/** 或 adapter/vendor 的直接依赖：' +
        '改为 application-owned port + composition 注入；确需暂留则入 MODULE_LAYER_RULE_DEBT 并点名清偿波次',
    ).toEqual([])
    expect(stale, '账本条目对应的违规已修掉：同批删掉该条').toEqual([])
  })

  test('每条债务都点名清偿波次与理由', () => {
    const bad = MODULE_LAYER_RULE_DEBT.filter(
      (entry) => !/(?:W\d|RFC-\d)/.test(entry.removeAfterWave) || entry.why.trim().length < 20,
    ).map(key)
    expect(bad).toEqual([])
  })
})

describe('RFC-294 review §B2 —— 负 fixture：三条规则各自咬得动', () => {
  test('domain 导入 node:fs / @/db 会被报', () => {
    expect(
      moduleLayerViolations([
        sourceUnit(
          'packages/backend/src/modules/probe/domain/probe.ts',
          "import { readFileSync } from 'node:fs'\nimport type { DbClient } from '@/db/client'\n",
        ),
      ]).map((violation) => violation.specifier),
    ).toEqual(['@/db/client', 'node:fs'])
  })

  test('application 导入 @/db/schema 会被报，导入 @/db/txSync 事务合同不报', () => {
    expect(
      moduleLayerViolations([
        sourceUnit(
          'packages/backend/src/modules/probe/application/probe.ts',
          "import { tasks } from '@/db/schema'\nimport type { DbTxSync } from '@/db/txSync'\n",
        ),
      ]).map((violation) => violation.rule),
    ).toEqual(['schema-table-import'])
  })

  test('application / engine 导入 infrastructure 会被报（相对路径与 @/modules 两种写法）', () => {
    expect(
      moduleLayerViolations([
        sourceUnit(
          'packages/backend/src/modules/probe/application/adapters/probe.ts',
          "import { SqliteStore } from '../../infrastructure/sqliteStore'\n",
        ),
        sourceUnit(
          'packages/backend/src/modules/probe/engine/probe.ts',
          "import type { Registry } from '@/modules/probe/infrastructure/registry'\n",
        ),
      ]).map((violation) => `${violation.rule}:${violation.edgeKind}`),
    ).toEqual(['infrastructure-import:value', 'infrastructure-import:type'])
  })

  test('composition / infrastructure 层与合规的 application 文件不报', () => {
    expect(
      moduleLayerViolations([
        sourceUnit(
          'packages/backend/src/modules/probe/composition/probe.ts',
          "import { tasks } from '@/db/schema'\nimport { store } from '../infrastructure/store'\n",
        ),
        sourceUnit(
          'packages/backend/src/modules/probe/application/clean.ts',
          "import type { ProbePort } from './ports/probePort'\n",
        ),
      ]),
    ).toEqual([])
  })
})

// RFC-376 G7 extends the original domain/schema/infrastructure rules without changing their scope.
describe('RFC-376 G7 added layer rules', () => {
  const file = 'packages/backend/src/modules/probe/application/probe.ts'
  test('application composition values fail, but required-port types are erased', () => {
    expect(
      moduleLayerViolations([
        sourceUnit(file, "import { x } from '@/modules/other/composition'"),
      ]).map(key),
    ).toHaveLength(1)
    expect(
      moduleLayerViolations([
        sourceUnit(file, "import type { X } from '@/modules/other/composition/required-ports'"),
      ]),
    ).toEqual([])
    expect(
      moduleLayerViolations([
        sourceUnit(file, "import type { X } from '@/modules/other/composition/other'"),
      ]),
    ).toHaveLength(1)
  })
  test('inbound cannot reach DB or another context internals, but can reach public', () => {
    const path = 'packages/backend/src/modules/probe/inbound/route.ts'
    expect(
      moduleLayerViolations([
        sourceUnit(path, "import '@/db'; import '@/modules/other/inbound/handler'"),
      ]).map((item) => item.rule),
    ).toEqual(['inbound-context-internal-import', 'inbound-db-import'])
    expect(
      moduleLayerViolations([
        sourceUnit(
          path,
          "import '@/modules/other/public/commands'; import '../application/handler'",
        ),
      ]),
    ).toEqual([])
  })
  test('domain fs and process variants, including type/import/export/require syntax, fail', () => {
    const path = 'packages/backend/src/modules/probe/domain/model.ts'
    for (const code of [
      "import 'fs'",
      "import type { X } from 'node:fs/promises'",
      "export * from 'child_process'",
      "const x = require('node:child_process')",
      "const x = import('fs/promises')",
      "type X = import('node:fs').X",
      "import x = require('fs')",
    ])
      expect(moduleLayerViolations([sourceUnit(path, code)])).toHaveLength(1)
    expect(
      moduleLayerViolations([sourceUnit(path, "import type { X } from '../ports/neutral'")]),
    ).toEqual([])
  })
  test('allowlist mutations expose missing and stale layer exceptions', () => {
    const observed = moduleLayerViolations([
      sourceUnit(file, "import '@/modules/other/composition'"),
    ]).map(key)
    expect(exactAllowlist(observed, []).unregistered).toEqual(observed)
    expect(exactAllowlist(observed, [...observed, 'fabricated/expired.ts']).stale).toEqual([
      'fabricated/expired.ts',
    ])
  })
})

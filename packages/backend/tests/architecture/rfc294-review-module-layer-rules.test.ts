// RFC-294 review 2026-08-30 §B2 —— design.md §3「新增常驻规则 1～3」的模块内分层门。
//
// 为什么存在（design/RFC-294-backend-layered-target-architecture/review-2026-08-30.md §B2）：
// design §3 写了 domain 禁 `hono|drizzle|@/db|node:fs|@/ws|@/routes|@/server`、application 禁具体
// DB table 并禁 `infrastructure/**`，但 `.dependency-cruiser.cjs` 只有 routes/transport/util/auth/
// services/circular 六条规则，RFC-317 outbound census 也只盯 `@/services|@/routes|@/ws|@/mcp`
// 与 `drizzle-orm|hono` 包——`@/db/schema`（Drizzle 表）与 `infrastructure/**` 从
// application/engine/domain 被直接 import 无人看守：committed HEAD 上 application 有 17 个文件
// value-import `@/db/schema`、6 个文件 import 自己的 infrastructure，task-execution/domain 还
// import 了 `node:fs`。
//
// 三条规则（与 RFC-317 outbound census 不重叠：drizzle-orm/hono 包级导入仍由后者记账）：
//   domain-adapter-import   domain/** 不得 import adapter / vendor / 进程全局；
//   schema-table-import     application/engine 不得 import `@/db/schema`（表属于 infrastructure）；
//   infrastructure-import   domain/application/engine 不得 import 本模块或他模块的 infrastructure/**。
// 存量逐条入 `MODULE_LAYER_RULE_DEBT`，只降不升；每条点名清偿波次；修掉后必须同批销账。

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

import {
  backendUnits,
  importEdges,
  isModuleUnit,
  layerOf,
  sourceUnit,
  type SourceUnit,
} from './census'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')

export type ModuleLayerRule =
  | 'domain-adapter-import'
  | 'schema-table-import'
  | 'infrastructure-import'

export interface ModuleLayerViolation {
  readonly rule: ModuleLayerRule
  readonly file: string
  readonly specifier: string
  readonly edgeKind: 'type' | 'value'
}

interface ModuleLayerDebt {
  readonly rule: ModuleLayerRule
  readonly file: string
  readonly specifier: string
  readonly why: string
  readonly removeAfterWave: string
}

const DOMAIN_FORBIDDEN =
  /^(?:@\/db(?:\/|$)|drizzle-orm(?:\/|$)|hono(?:\/|$)|node:fs(?:\/|$)|@\/ws(?:\/|$)|@\/routes(?:\/|$)|@\/server(?:\/|$))/
const INFRASTRUCTURE_IMPORT =
  /^(?:(?:\.\.\/)+|\.\/)infrastructure\/|^@\/modules\/[a-z0-9-]+\/infrastructure\//
const FENCED_LAYERS = new Set(['domain', 'application', 'engine'])

export function moduleLayerViolations(units: readonly SourceUnit[]): ModuleLayerViolation[] {
  const seen = new Set<string>()
  const out: ModuleLayerViolation[] = []
  const push = (violation: ModuleLayerViolation): void => {
    const key = `${violation.rule}|${violation.file}|${violation.specifier}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(violation)
  }
  for (const unit of units) {
    const place = layerOf(unit)
    if (place === null || !FENCED_LAYERS.has(place.layer)) continue
    for (const edge of importEdges(unit)) {
      const specifier = edge.specifier
      if (place.layer === 'domain' && DOMAIN_FORBIDDEN.test(specifier)) {
        push({ rule: 'domain-adapter-import', file: unit.path, specifier, edgeKind: edge.kind })
      }
      if (place.layer !== 'domain' && specifier === '@/db/schema') {
        push({ rule: 'schema-table-import', file: unit.path, specifier, edgeKind: edge.kind })
      }
      if (INFRASTRUCTURE_IMPORT.test(specifier)) {
        push({ rule: 'infrastructure-import', file: unit.path, specifier, edgeKind: edge.kind })
      }
    }
  }
  return out.sort((left, right) =>
    `${left.rule}|${left.file}|${left.specifier}`.localeCompare(
      `${right.rule}|${right.file}|${right.specifier}`,
    ),
  )
}

/**
 * 存量分层违规（committed HEAD `625017c08`，review 2026-08-30 采样）。
 * 每条一个 `rule|file|specifier`；只降不升。
 */
export const MODULE_LAYER_RULE_DEBT: readonly ModuleLayerDebt[] = [
  {
    rule: 'domain-adapter-import',
    file: 'packages/backend/src/modules/task-execution/domain/digitalEmployeeHost.ts',
    specifier: 'node:fs',
    why: 'domain 直接读文件系统；纯 domain 不得依赖 node:fs，应移入 infrastructure 或经 application-owned port 注入。',
    removeAfterWave: 'W4-E1',
  },
  {
    rule: 'infrastructure-import',
    file: 'packages/backend/src/modules/code-capability/application/codeMatrixQuery.ts',
    specifier: '@/modules/code-capability/infrastructure/sqliteCapabilityMatrix',
    why: 'application 直接 new 本模块 SQLite infrastructure；应由 composition 注入 port 实现。',
    removeAfterWave: 'W4-E8',
  },
  {
    rule: 'infrastructure-import',
    file: 'packages/backend/src/modules/code-capability/application/codeMatrixQuery.ts',
    specifier: '@/modules/code-capability/infrastructure/sqliteDeliveryChain',
    why: 'application 直接 new 本模块 SQLite infrastructure；应由 composition 注入 port 实现。',
    removeAfterWave: 'W4-E8',
  },
  {
    rule: 'infrastructure-import',
    file: 'packages/backend/src/modules/collaboration/application/adapters/task-execution-human-gate-adapter.ts',
    specifier: '../../infrastructure/sqliteHumanGateOpenParticipant',
    why: 'provider adapter 直接 new SQLite participant/store；应由 composition 注入，adapter 只依赖本域 ports。',
    removeAfterWave: 'W4',
  },
  {
    rule: 'infrastructure-import',
    file: 'packages/backend/src/modules/collaboration/application/adapters/task-execution-human-gate-adapter.ts',
    specifier: '../../infrastructure/sqliteHumanGateOperationStore',
    why: 'provider adapter 直接 new SQLite participant/store；应由 composition 注入，adapter 只依赖本域 ports。',
    removeAfterWave: 'W4',
  },
  {
    rule: 'infrastructure-import',
    file: 'packages/backend/src/modules/digital-employee/application/runtimeService.ts',
    specifier: '../infrastructure/inputUploadStore',
    why: 'application 以 type 形态依赖 infrastructure 实现；应改为 application-owned port 类型。',
    removeAfterWave: 'W4-E9',
  },
  {
    rule: 'infrastructure-import',
    file: 'packages/backend/src/modules/integration/application/mrLaunchGuard.ts',
    specifier: '@/modules/integration/infrastructure/inMemoryWebhookLaunchSupervisor',
    why: 'application 直接 import in-memory infrastructure 实现；应由 composition 注入 port。',
    removeAfterWave: 'W4-B',
  },
  {
    rule: 'infrastructure-import',
    file: 'packages/backend/src/modules/task-execution/application/applySourceTerminationEffect.ts',
    specifier: '../infrastructure/taskLifecycleEventParticipant',
    why: 'application 直接 import infrastructure 实现（registry/participant）；应由 composition 注入 port。',
    removeAfterWave: 'W4-E1',
  },
  {
    rule: 'infrastructure-import',
    file: 'packages/backend/src/modules/task-execution/application/applySourceTerminationEffect.ts',
    specifier: '@/modules/task-execution/infrastructure/inMemoryTaskRuntimeRegistry',
    why: 'application 直接 import infrastructure 实现（registry/participant）；应由 composition 注入 port。',
    removeAfterWave: 'W4-E1',
  },
  {
    rule: 'schema-table-import',
    file: 'packages/backend/src/modules/code-capability/application/codeMatrixQuery.ts',
    specifier: '@/db/schema',
    why: 'legacy history/template compatibility island 的 application 直读 Drizzle 表；W4-E8 收成 exact compatibility surface 或退役。',
    removeAfterWave: 'W4-E8',
  },
  {
    rule: 'schema-table-import',
    file: 'packages/backend/src/modules/code-capability/application/codeMetricsQuery.ts',
    specifier: '@/db/schema',
    why: 'legacy history/template compatibility island 的 application 直读 Drizzle 表；W4-E8 收成 exact compatibility surface 或退役。',
    removeAfterWave: 'W4-E8',
  },
  {
    rule: 'schema-table-import',
    file: 'packages/backend/src/modules/code-capability/application/readinessFacts.ts',
    specifier: '@/db/schema',
    why: 'legacy history/template compatibility island 的 application 直读 Drizzle 表；W4-E8 收成 exact compatibility surface 或退役。',
    removeAfterWave: 'W4-E8',
  },
  {
    rule: 'schema-table-import',
    file: 'packages/backend/src/modules/code-capability/application/resolveRepoEndpoint.ts',
    specifier: '@/db/schema',
    why: 'legacy history/template compatibility island 的 application 直读 Drizzle 表；W4-E8 收成 exact compatibility surface 或退役。',
    removeAfterWave: 'W4-E8',
  },
  {
    rule: 'schema-table-import',
    file: 'packages/backend/src/modules/code-capability/application/templateUpstreamStatus.ts',
    specifier: '@/db/schema',
    why: 'legacy history/template compatibility island 的 application 直读 Drizzle 表；W4-E8 收成 exact compatibility surface 或退役。',
    removeAfterWave: 'W4-E8',
  },
  {
    rule: 'schema-table-import',
    file: 'packages/backend/src/modules/integration/application/mrLaunchGuard.ts',
    specifier: '@/db/schema',
    why: 'integration application 直读 Drizzle 表；W4-B integration slice 把查询下沉 repository/port。',
    removeAfterWave: 'W4-B',
  },
  {
    rule: 'schema-table-import',
    file: 'packages/backend/src/modules/integration/application/mrTerminalControlWorker.ts',
    specifier: '@/db/schema',
    why: 'integration application 直读 Drizzle 表；W4-B integration slice 把查询下沉 repository/port。',
    removeAfterWave: 'W4-B',
  },
  {
    rule: 'schema-table-import',
    file: 'packages/backend/src/modules/task-execution/application/acceptHumanGateDecision.ts',
    specifier: '@/db/schema',
    why: 'task-execution application 直读 Drizzle 表；W4-E1 task application cutover 时下沉 repository/port，application 只依赖本域 ports。',
    removeAfterWave: 'W4-E1',
  },
  {
    rule: 'schema-table-import',
    file: 'packages/backend/src/modules/task-execution/application/applySourceTerminationEffect.ts',
    specifier: '@/db/schema',
    why: 'task-execution application 直读 Drizzle 表；W4-E1 task application cutover 时下沉 repository/port，application 只依赖本域 ports。',
    removeAfterWave: 'W4-E1',
  },
  {
    rule: 'schema-table-import',
    file: 'packages/backend/src/modules/task-execution/application/branchTrace.ts',
    specifier: '@/db/schema',
    why: 'task-execution application 直读 Drizzle 表；W4-E1 task application cutover 时下沉 repository/port，application 只依赖本域 ports。',
    removeAfterWave: 'W4-E1',
  },
  {
    rule: 'schema-table-import',
    file: 'packages/backend/src/modules/task-execution/application/drive/gateContinuationEffectStep.ts',
    specifier: '@/db/schema',
    why: 'task-execution application 直读 Drizzle 表；W4-E1 task application cutover 时下沉 repository/port，application 只依赖本域 ports。',
    removeAfterWave: 'W4-E1',
  },
  {
    rule: 'schema-table-import',
    file: 'packages/backend/src/modules/task-execution/application/localEffectObserver.ts',
    specifier: '@/db/schema',
    why: 'task-execution application 直读 Drizzle 表；W4-E1 task application cutover 时下沉 repository/port，application 只依赖本域 ports。',
    removeAfterWave: 'W4-E1',
  },
  {
    rule: 'schema-table-import',
    file: 'packages/backend/src/modules/task-execution/application/processEffectObserver.ts',
    specifier: '@/db/schema',
    why: 'task-execution application 直读 Drizzle 表；W4-E1 task application cutover 时下沉 repository/port，application 只依赖本域 ports。',
    removeAfterWave: 'W4-E1',
  },
  {
    rule: 'schema-table-import',
    file: 'packages/backend/src/modules/task-execution/application/recoverTaskExecutions.ts',
    specifier: '@/db/schema',
    why: 'task-execution application 直读 Drizzle 表；W4-E1 task application cutover 时下沉 repository/port，application 只依赖本域 ports。',
    removeAfterWave: 'W4-E1',
  },
  {
    rule: 'schema-table-import',
    file: 'packages/backend/src/modules/task-execution/application/resolveNodeActivation.ts',
    specifier: '@/db/schema',
    why: 'task-execution application 直读 Drizzle 表；W4-E1 task application cutover 时下沉 repository/port，application 只依赖本域 ports。',
    removeAfterWave: 'W4-E1',
  },
  {
    rule: 'schema-table-import',
    file: 'packages/backend/src/modules/task-execution/application/submitTaskContinuation.ts',
    specifier: '@/db/schema',
    why: 'task-execution application 直读 Drizzle 表；W4-E1 task application cutover 时下沉 repository/port，application 只依赖本域 ports。',
    removeAfterWave: 'W4-E1',
  },
  {
    rule: 'schema-table-import',
    file: 'packages/backend/src/modules/task-execution/application/terminalizeExecutionIntent.ts',
    specifier: '@/db/schema',
    why: 'task-execution application 直读 Drizzle 表；W4-E1 task application cutover 时下沉 repository/port，application 只依赖本域 ports。',
    removeAfterWave: 'W4-E1',
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
      (entry) => !/^W\d/.test(entry.removeAfterWave) || entry.why.trim().length < 20,
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

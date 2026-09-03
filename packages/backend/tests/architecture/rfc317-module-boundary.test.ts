// RFC-317 T22–T24 / T26 —— 模块边界三条规则（R1 inbound / R2 outbound / R3 模块形状）。
//
// 为什么要有这三条
// ----------------
// RFC-294 定的目标架构里，跨 bounded context 只允许走 exact
// `public/{commands,queries,participants,events,operations,types}` 合同，模块内部与 composition
// 入口对外不可见。这个约束此前**只写在设计文档里**——没有任何机器在数它，于是：
//
//   - **R1（inbound）**：legacy 层（`services/` `routes/` `ws/` `auth/`）直接 import 模块
//     内部或 composition 的边，实测 **94 条**。每一条都等价于把模块的装配面 / 内部结构
//     摊给了调用方，模块此后无法独立演进。
//   - **R2（outbound）**：模块内部反向 import legacy 层的边，实测 **22 条**，全部在
//     `application` 层。方向和 R1 相反，危害相同：模块声称自己是 bounded context，
//     实际仍长在旧的横向平铺层上。
//   - **R3（模块形状）**：目录形状（顶层只允许固定几类、public 必须是 exact 入口）没人守，
//     于是「多一个顶层目录」「public 下多一个非 exact 文件」都能悄悄进来。
//
// 判据形态：**逐条精确相等**（`toEqual`），不是 `<=`。
// 新增一条边 ⇒ 红（要么改对，要么带 why + removeAfterWave 入账）；
// **销账一条边不改账本 ⇒ 也红**——收敛必须留下记录，否则差额会变成下一个人的免费槽位
// （RFC-317 T18 在 rfc217 G5 上实测漏过 3 个）。
//
// 采数走 `census.ts` 的单一实现，与生成 `commons-debt.json` 的是同一份代码。

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, test } from 'bun:test'
import ts from 'typescript'

import {
  backendUnits,
  BOOTSTRAP_FILES,
  inboundBoundaryEdges,
  moduleShapes,
  outboundBoundaryEdges,
  sourceUnit,
} from './census'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')

interface DebtEntry {
  readonly rule: string
  readonly from: string
  readonly specifier: string
  readonly edgeKind: string
  readonly syntax: string
  readonly why: string
  readonly removeAfterWave: string
}

const DEBT = JSON.parse(
  readFileSync(resolve(REPO_ROOT, 'architecture', 'commons-debt.json'), 'utf8'),
) as {
  readonly entries: readonly DebtEntry[]
  // 具名字段而非 Record<string, number>：本仓开了 noUncheckedIndexedAccess，
  // Record 索引出来是 number | undefined，直接喂给 toBe 编译不过。
  readonly baseline: { readonly inboundEdges: number; readonly outboundEdges: number }
}

const UNITS = backendUnits(REPO_ROOT)
const INBOUND = inboundBoundaryEdges(UNITS)
const OUTBOUND = outboundBoundaryEdges(UNITS)

/**
 * 唯一标识一条边：起点文件 + 说明符 + 值/类型 + 语法形态。
 *
 * 参数刻意用**结构化的宽类型**而不是 `Pick<BoundaryEdge, …>`：它同时要吃实测出来的
 * `BoundaryEdge`（`edgeKind` 是窄联合）和账本里读出来的 `DebtEntry`（JSON 解出来是
 * `string`）。用窄联合会让账本那一侧编译不过——而 `bun test` 不做类型检查，这个错
 * 只有 `tsc` 抓得到（本批实测：用例全绿、门禁 typecheck 红）。
 */
const edgeKey = (edge: {
  readonly from: string
  readonly specifier: string
  readonly edgeKind: string
  readonly syntax: string
}): string => `${edge.from} -> ${edge.specifier} [${edge.edgeKind}:${edge.syntax}]`

const ledgerKeys = (rule: string): string[] =>
  DEBT.entries
    .filter((entry) => entry.rule === rule)
    .map((entry) => edgeKey(entry))
    .sort()

describe('RFC-317 T22 —— R1：legacy 层不得 import 模块内部 / composition', () => {
  test('语料非空：backend 源码单元确实扫到了（扫成空时本 describe 零预言力）', () => {
    expect(UNITS.length).toBeGreaterThanOrEqual(500)
  })

  test('inbound 越界边与债务账本**逐条相等**（新增红、销账不改账本也红）', () => {
    expect(
      INBOUND.map(edgeKey).sort(),
      'legacy 层指向模块内部 / composition 的边发生了变化。' +
        '**多**了：要么改走 exact public 合同，要么带 why + removeAfterWave 进 commons-debt.json；' +
        '**少**了：债还掉了，把账本那条一并删除——不删的话差额会变成下一个人的免费槽位',
    ).toEqual(ledgerKeys('R1-inbound-module-internals'))
  })

  test('账本条数与 baseline 记的数字一致（账本自己不能撒谎）', () => {
    expect(ledgerKeys('R1-inbound-module-internals').length).toBe(DEBT.baseline.inboundEdges)
  })

  test('每条 R1 债务都写清了 why 与**具名**清偿波次', () => {
    const bad = DEBT.entries
      .filter((entry) => entry.rule === 'R1-inbound-module-internals')
      .filter(
        (entry) =>
          entry.why.trim().length < 20 ||
          entry.removeAfterWave.trim().length < 6 ||
          !/RFC-\d{3}|W\d/.test(entry.removeAfterWave),
      )
      .map((entry) => edgeKey(entry))
    expect(bad, 'removeAfterWave 必须点名具体 RFC / 波次，不接受「以后再说」').toEqual([])
  })
})

describe('RFC-317 T23 —— R2：模块内部不得反向 import legacy 层', () => {
  test('outbound 越界边与债务账本**逐条相等**', () => {
    expect(
      OUTBOUND.map(edgeKey).sort(),
      '模块反向依赖 legacy 层的边发生了变化。方向与 R1 相反，危害相同：' +
        '模块声称自己是 bounded context，实际仍长在旧的横向平铺层上',
    ).toEqual(ledgerKeys('R2-outbound-module-to-legacy'))
  })

  test('账本条数与 baseline 一致', () => {
    expect(ledgerKeys('R2-outbound-module-to-legacy').length).toBe(DEBT.baseline.outboundEdges)
  })

  test('R2 债务**全部**落在 application 层（B0 实测口径；换层说明形态变了，要重新审）', () => {
    const layers = [...new Set(OUTBOUND.map((edge) => edge.layer))].sort()
    expect(
      layers,
      'B0 采数时 22 条 outbound 债务全在 application 层。出现别的层意味着' +
        'domain / engine 也开始反向依赖 legacy——那比 application 严重得多，必须单独审',
    ).toEqual(['application'])
  })
})

// ---------------------------------------------------------------------------
// T24 —— R3：模块形状
// ---------------------------------------------------------------------------

const SHAPES = moduleShapes(REPO_ROOT)

/** git 追踪面——判定「零文件目录」是不是未追踪残留，不靠猜。 */
function trackedFileCount(context: string): number {
  const result = spawnSync('git', ['ls-files', '--', `packages/backend/src/modules/${context}`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
  if (result.status !== 0) return -1
  return (result.stdout ?? '').split('\n').filter((line) => line.trim().length > 0).length
}

/**
 * public 面为空的模块。**每条必须写清为什么、哪一波清偿**。
 *
 * 「模块没有 public 合同」意味着它对外完全不可用，或者它的消费者正在走内部路径——
 * 后者恰恰是 R1 要抓的形态。
 */
const MODULES_WITHOUT_PUBLIC: Readonly<Record<string, { why: string; removeAfterWave: string }>> = {
  'knowledge-evolution': {
    why:
      'RFC-353 T4：本刀先把 fusion 的纯状态机 / 行映射 / prompt 文本 / 内建工作流图从 ' +
      '`services/fusion.ts` 逐字迁进 domain 层，编排本体还留在 legacy，因此这一刀还没有对外合同。' +
      '刻意不为一轮过渡去公开 domain 符号（`MERGER_BODY` 一类内建播种文本不该成为对外合同）——' +
      '那条 legacy→domain 的过渡边已按 R1 入账为 `KE-01`，与本条同在 T5 清偿：' +
      '编排迁进 application 之后 `public/{commands,queries,participants,types}` 一并落地。',
    removeAfterWave: 'RFC-294 W4-E3（本 RFC T5 内清偿）',
  },
}

/** 非 exact public 入口。与 rfc294-architecture-preflight 的 PUBLIC_SURFACE_PILOT_DEBT 同源。 */
const NON_EXACT_PUBLIC: Readonly<Record<string, readonly string[]>> = {
  integration: ['mrTerminalControl.ts'],
  memory: ['catalog.ts', 'fusion.ts'],
  'task-execution': ['taskRoutes.ts'],
}

describe('RFC-317 T24 —— R3：模块目录形状', () => {
  test('subject 由目录派生且**目录缺失必须抛错**（返回空 = 规则静默失效）', () => {
    expect(SHAPES.length).toBeGreaterThanOrEqual(10)
    expect(() => moduleShapes(resolve(REPO_ROOT, 'no-such-repo-root-xyz'))).toThrow()
  })

  test('没有模块出现计划外的顶层目录', () => {
    const offenders = SHAPES.filter((shape) => shape.unexpectedEntries.length > 0).map(
      (shape) => `${shape.context}: ${shape.unexpectedEntries.join(',')}`,
    )
    expect(
      offenders,
      'RFC-294 规定模块顶层只有 domain / application / engine / ports / inbound / ' +
        'infrastructure / composition / public 这几类。多出来的目录是新的耦合面',
    ).toEqual([])
  })

  test('public 下只有 exact 入口（非 exact 的逐条入账）', () => {
    const actual: Record<string, string[]> = {}
    for (const shape of SHAPES) {
      if (shape.nonExactPublicEntries.length > 0) {
        actual[shape.context] = [...shape.nonExactPublicEntries]
      }
    }
    expect(
      actual,
      'public/ 下只允许 commands / queries / participants / events / operations / types exact 入口。' +
        '别的文件名等于给了消费者一个不受合同约束的入口',
    ).toEqual(NON_EXACT_PUBLIC as Record<string, string[]>)
  })

  test('public 面为空的模块恰好是已入账的那些', () => {
    const empty = SHAPES.filter((shape) => trackedFileCount(shape.context) > 0)
      .filter((shape) => shape.publicEntries.length === 0)
      .map((shape) => shape.context)
      .sort()
    expect(
      empty,
      '模块没有 public 合同 = 它对外不可用，或者消费者正在走内部路径（后者正是 R1 抓的形态）',
    ).toEqual(Object.keys(MODULES_WITHOUT_PUBLIC).sort())
  })

  test('零文件的模块目录必然是**未追踪残留**（git 追踪不了空目录）', () => {
    const contradictions = SHAPES.filter((shape) => shape.fileCount === 0)
      .filter((shape) => trackedFileCount(shape.context) > 0)
      .map((shape) => shape.context)
    expect(
      contradictions,
      '这些模块目录在磁盘上零 TS 文件、git 里却有追踪文件——两者矛盾，说明采数口径坏了',
    ).toEqual([])
  })

  test('未追踪残留目录只报告、不进 subject（否则本地与 CI 的 subject 不一致）', () => {
    const remnants = SHAPES.filter((shape) => shape.fileCount === 0).map((shape) => shape.context)
    if (remnants.length > 0) {
      console.warn(
        `[RFC-317 T24] modules/ 下存在未追踪的空目录残留：${remnants.join(', ')}。` +
          'CI 的干净 checkout 看不到它们，本地能看到——所以它们被排除在形状规则之外。' +
          '建议本地 rmdir 清掉，否则每次采数都要多绕这一步。',
      )
    }
    // 断言的是**判据本身**：残留必须零追踪文件（上一条已证），这里只保证它不炸。
    expect(Array.isArray(remnants)).toBe(true)
  })

  test('每条 R3 豁免都写清了 why 与具名波次', () => {
    const bad = Object.entries(MODULES_WITHOUT_PUBLIC)
      .filter(
        ([, entry]) => entry.why.trim().length < 20 || !/RFC-\d{3}|W\d/.test(entry.removeAfterWave),
      )
      .map(([context]) => context)
    expect(bad).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// T26 —— 三条规则各自的正反 fixture
// ---------------------------------------------------------------------------
//
// 上面每条断言都建立在 census 的边解析上。解析漏掉一种语法形态，越界边根本不进集合，
// `toEqual(账本)` 于是永远成立——与「模块干净」完全同形。fixture 一律内存字符串。

const fixtureUnit = (path: string, text: string) => sourceUnit(path, text)

describe('RFC-317 T26 —— R1 正反 fixture', () => {
  test('legacy 层指向模块内部 / composition ⇒ 报', () => {
    for (const specifier of [
      '@/modules/task-execution/application/foo',
      '@/modules/task-execution/composition',
      '@/modules/task-execution/domain/model',
      '@/modules/task-execution/infrastructure/store',
    ]) {
      const unit = fixtureUnit(
        'packages/backend/src/services/probe.ts',
        `import { x } from '${specifier}'\n`,
      )
      expect(inboundBoundaryEdges([unit]).length, `漏报：${specifier}`).toBe(1)
    }
  })

  test('legacy 层走 exact public 合同 ⇒ 不报（规则不能宽到把正解也拦下）', () => {
    for (const specifier of [
      '@/modules/task-execution/public/commands',
      '@/modules/task-execution/public/queries',
      '@/modules/task-execution/public/types',
    ]) {
      const unit = fixtureUnit(
        'packages/backend/src/services/probe.ts',
        `import { x } from '${specifier}'\n`,
      )
      expect(inboundBoundaryEdges([unit]).length, `误报：${specifier}`).toBe(0)
    }
  })

  test('五种 import 语法都被解析到（漏一种 = 那种写法可以绕过整条规则）', () => {
    const unit = fixtureUnit(
      'packages/backend/src/services/probe.ts',
      "import { a } from '@/modules/task-execution/application/one'\n" +
        "import type { B } from '@/modules/task-execution/domain/two'\n" +
        "export { c } from '@/modules/task-execution/application/three'\n" +
        "import '@/modules/task-execution/composition'\n" +
        "const e = await import('@/modules/task-execution/infrastructure/five')\n",
    )
    expect(inboundBoundaryEdges([unit]).length).toBe(5)
  })

  test('bootstrap 指向 composition 是被允许的（唯一装配点，不算越界）', () => {
    for (const path of BOOTSTRAP_FILES) {
      const unit = fixtureUnit(path, "import { m } from '@/modules/task-execution/composition'\n")
      expect(inboundBoundaryEdges([unit]).length, `bootstrap 被误报：${path}`).toBe(0)
    }
  })
})

describe('RFC-317 T26 —— R2 正反 fixture', () => {
  test('模块内部反向 import legacy 层 ⇒ 报', () => {
    for (const specifier of ['@/services/task', '@/routes/tasks', '@/ws/hub', '@/mcp/server']) {
      const unit = fixtureUnit(
        'packages/backend/src/modules/task-execution/application/probe.ts',
        `import { x } from '${specifier}'\n`,
      )
      expect(outboundBoundaryEdges([unit]).length, `漏报：${specifier}`).toBe(1)
    }
  })

  test('模块内部引用自己 / 别的模块 public ⇒ 不报', () => {
    for (const specifier of [
      '@/modules/task-execution/domain/model',
      '@/modules/integration/public/commands',
      '@/util/logger',
    ]) {
      const unit = fixtureUnit(
        'packages/backend/src/modules/task-execution/application/probe.ts',
        `import { x } from '${specifier}'\n`,
      )
      expect(outboundBoundaryEdges([unit]).length, `误报：${specifier}`).toBe(0)
    }
  })

  test('composition 层指向 legacy 不算 R2（composition 就是装配胶水，允许两边都碰）', () => {
    const unit = fixtureUnit(
      'packages/backend/src/modules/task-execution/composition/wire.ts',
      "import { startTask } from '@/services/task'\n",
    )
    expect(outboundBoundaryEdges([unit]).length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// T25（R12 的一条）—— public 入口里的开放 Record 面，精确入账
// ---------------------------------------------------------------------------
//
// **落地偏离，理由写在这里**：design.md 的 R12 原文写的是「public entrypoint **禁**
// 非字面量键的 `Record`」。实测全仓 public 入口共 13 处 `Record<…>`，其中 4 处键是
// 穷尽联合（`Record<CodeHostEventType, …>`，正解），9 处是 `Record<string, …>`——
// 而这 9 处里绝大多数**本就该开放**：
//   - frontmatter 附加字段（任意 YAML）、泛型 merge 助手的 `Record<string, T>`
//   - `triggerParameters`（用户自定义的触发参数）
//   - 错误 `details` 包
// 对它们下禁令会制造约 89% 的假阳性，逼着后来的人要么给动态载荷编一个假的键联合，
// 要么往账本里塞一堆「我也不知道为什么它是 string 键」的低信息条目——两种都让账本
// 变质。本 RFC 一路在防的正是这个：**判据宽而掺水，和判据窄而漏，坏处不对称**，
// 但「制造假阳性逼人绕过」是最坏的一种，因为它训练所有人学会忽略这条规则。
//
// 改成**精确账本**：现状逐条钉死，新增一处开放 Record 就红。棘轮效力保留（不会再
// 悄悄多出一个开放面），同时不把既有的动态载荷诬告成违规。

interface OpenRecordSite {
  readonly site: string
  readonly why: string
}

/**
 * public 入口里键为 `string` / `number` 的 `Record`。**逐条相等**——新增红、消失也红。
 *
 * `integration/public/events.ts` 那条值得单独说：同一个文件里 34 行用的是
 * `Record<CodeHostEventType, …>`（穷尽），50 行却退回 `Record<string, …>`。
 * 同文件内的这种不一致最可能是穷尽性在某次改动里掉了，是这批里唯一**值得改**的一处。
 */
const OPEN_RECORD_SITES: readonly OpenRecordSite[] = [
  {
    site: 'modules/digital-employee/public/types.ts: Record<string, boolean>',
    why: 'Employee Case 的 executionOptions 键由已发布员工类型声明，通用详情合同无法把所有类型的选项闭合成同一个联合。',
  },
  {
    site: 'modules/digital-employee/public/types.ts: Record<string, string>',
    why: 'Employee Case 的 advancedOptions 键由已发布员工类型声明并按描述符校验，通用详情合同不能预先穷尽类型专属控件。',
  },
  {
    site: 'modules/event-center/public/types.ts: Record<string, string>',
    why: 'triggerParameters —— 用户在触发器上自定义的参数袋，键集合按定义就是开放的。',
  },
  {
    site: 'modules/execution-contract/public/commands.ts: Record<string, T>',
    why: '泛型 merge 助手（patched / existing / 返回值三处同形），对任意 frontmatter 形状工作。',
  },
  {
    site: 'modules/execution-contract/public/commands.ts: Record<string, unknown>',
    why: 'frontmatterExtra —— agent.md frontmatter 的附加字段，任意 YAML，键集合无法闭合。',
  },
  {
    site: 'modules/identity-access/public/types.ts: Record<string, unknown>',
    why: '错误 details 包，随错误类型而变，闭合它等于把每种错误的字段集写进公共类型。',
  },
  {
    site: 'modules/integration/public/participants.ts: Record<string, string>',
    why: 'WorkStartTarget 的 digital-employee 分支 intake.target —— 外部系统（ISSUE / MR 等）带来的标识键值对，键由对端决定，无法在本仓闭合。',
  },
  {
    site: 'modules/integration/public/events.ts: Record<string, { zh-CN, en-US }>',
    why: '**本批唯一值得改的一处**：同文件 34 行已用 Record<CodeHostEventType, …> 穷尽，50 行退回 string 键，疑为穷尽性在某次改动里掉了。修法属 integration 的 owning RFC。',
  },
  {
    site: 'modules/memory/public/fusion.ts: Record<string, string>',
    why: 'Fusion task input 是由 workflow / agent 声明生成的开放命名映射；键来自资源合同，不能由 Memory 模块预先穷尽。',
  },
  {
    site: 'modules/source-control/public/types.ts: Record<string, string | undefined>',
    why: 'Git 子进程环境由运行器、凭据租约与调用方共同扩展，变量名属于开放的进程协议，无法伪装成仓内穷尽键联合。',
  },
  {
    site: 'modules/task-execution/public/commands.ts: Record<string, string>',
    why: 'Workgroup turn outputs 由 workflow 节点声明命名，Task Execution 只传递已验证的结果映射，无法预先穷尽所有输出键。',
  },
]

function publicEntrypointUnits(): ReturnType<typeof backendUnits> {
  return UNITS.filter((unit) => /\/modules\/[^/]+\/public\/[^/]+$/.test(unit.path))
}

/** 归一化一处 Record 的展示形态：`模块路径: Record<键, 值>`（值只留骨架，避免噪声）。 */
function openRecordSites(): string[] {
  const found = new Set<string>()
  for (const unit of publicEntrypointUnits()) {
    const visit = (node: ts.Node): void => {
      if (
        ts.isTypeReferenceNode(node) &&
        ts.isIdentifier(node.typeName) &&
        node.typeName.text === 'Record' &&
        node.typeArguments !== undefined &&
        node.typeArguments.length >= 1
      ) {
        const key = node.typeArguments[0]!
        const open =
          key.kind === ts.SyntaxKind.StringKeyword || key.kind === ts.SyntaxKind.NumberKeyword
        if (open) {
          const value = node.typeArguments[1]
          const valueText =
            value === undefined
              ? '?'
              : value
                  .getText(unit.source)
                  .replace(/\s+/g, ' ')
                  .replace(/readonly /g, '')
          const shape = /^\{/.test(valueText)
            ? `{ ${[...valueText.matchAll(/'([^']+)'\s*:/g)].map((m) => m[1]).join(', ')} }`
            : valueText
          found.add(
            `${unit.path.replace('packages/backend/src/', '')}: Record<${key.getText(unit.source)}, ${shape}>`,
          )
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(unit.source)
  }
  return [...found].sort()
}

describe('RFC-317 T25 —— public 入口的开放 Record 面精确入账', () => {
  test('语料非空：public 入口文件确实扫到了', () => {
    expect(publicEntrypointUnits().length).toBeGreaterThanOrEqual(20)
  })

  test('开放 Record 面与账本逐条相等（新增一处就红）', () => {
    expect(
      openRecordSites(),
      'public 合同里多了一个键集合开放的 Record。开放面本身不必然是错——' +
        '动态载荷（frontmatter / 用户参数 / 错误 details）就该开放——但它必须是一次' +
        '**有记录的决定**：带上 why 进 OPEN_RECORD_SITES，或者把键收成穷尽联合',
    ).toEqual(OPEN_RECORD_SITES.map((entry) => entry.site).sort())
  })

  test('每条开放 Record 都写清了为什么它的键集合无法闭合', () => {
    const bad = OPEN_RECORD_SITES.filter((entry) => entry.why.trim().length < 20).map(
      (entry) => entry.site,
    )
    expect(bad, 'why 必须说明这个键集合为什么开放，不接受空占位').toEqual([])
  })

  test('自证：穷尽键的 Record 不被误报（否则规则会逼人给动态载荷编假联合）', () => {
    const unit = sourceUnit(
      'packages/backend/src/modules/probe/public/types.ts',
      "type K = 'a' | 'b'\nexport type M = Record<K, string>\nexport type N = Record<'x', number>\n",
    )
    const saved = UNITS.length
    expect(saved).toBeGreaterThan(0)
    // 直接对 fixture 跑同一份判据：穷尽键不该进集合
    const found: string[] = []
    const visit = (node: ts.Node): void => {
      if (
        ts.isTypeReferenceNode(node) &&
        ts.isIdentifier(node.typeName) &&
        node.typeName.text === 'Record' &&
        node.typeArguments?.[0] !== undefined
      ) {
        const key = node.typeArguments[0]
        if (key.kind === ts.SyntaxKind.StringKeyword || key.kind === ts.SyntaxKind.NumberKeyword) {
          found.push(key.getText(unit.source))
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(unit.source)
    expect(found, '穷尽键的 Record 被误判成开放面').toEqual([])
  })
})

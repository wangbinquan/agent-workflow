// RFC-317 T42 · findings G-09 —— 注册表的**反向**完备。
//
// `satisfies Record<K, V>` 只挡住一个方向：它逼着表对 K 是全的。它挡不住反过来的
// 那种失效——**一行（或一列、或整张表）是死的**：声明得工工整整、注释写着「单一
// 事实源」，而生产代码从头到尾没读过它一次。这类失效不会让任何测试变红，因为唯一
// 提到它的通常就是断言它自己字面量的那条测试。
//
// 本仓已经为此付过三次代价，每次都是人工发现的：
//   · RFC-247 —— 四个没有任何路由使用的权限点；
//   · RFC-146 —— 四个没有运行期消费者的「愿望清单维度」（limits/orphanReap/gc/shutdown）；
//   · RFC-317 本身 —— `REF_DOMAIN_POLICIES` / `EXPORT_CALL_POLICY` 两张零消费者的表，
//     外加 `NODE_KIND_BEHAVIORS.isProcess` 这一列：它有运行时消费者的**外形**
//     （一个叫 `isProcessNodeKind` 的谓词），但那个谓词自己零生产调用者，
//     测试拿它去断言它读的那一列——一个自洽的闭环，谁都不在外面。
// 只有第一次留下了永久机制。这条守卫把那个机制做成通用的。
//
// ---------------------------------------------------------------------------
// 判据为什么长这样
// ---------------------------------------------------------------------------
//
// 「有没有消费者」有**两层**，两层都必须查，顺序不能反：
//
//  ① **表级**：这个符号在声明文件之外被引用过吗？
//  ② **键级**：每个键各自被读过吗（字符串字面量索引 或 属性访问）？
//
// 只查键级会被一类巧合骗过去：一张**整体没人引用**的表，它的键名往往恰好以别的
// 身份出现在别处（另一张表的键、一个局部变量名）。实测 `REF_DOMAIN_POLICIES`
// ——声明文件外零引用，键级判据却只报出 1 个死键，差一点整张死表就放行了。
//
// 消费也有两种**合法**形态，混为一谈会两头出错：
//
//  · `'direct'`   —— 声明文件之外直接引用。
//  · `{ via: X }` —— 只经由同文件的一个访问器 `X` 出去。本仓有真实例子：
//                    `REPAIR_OPTIONS` → `listRepairOptionsForAlert` → routes/tasks.ts。
//                    这形态**必须两半都验**：X 真的读了这张表，**且** X 自己在
//                    声明文件之外有消费者。只验前半，一张死表配一个恰好活着的
//                    同文件函数就能蒙混；只验后半，`isProcess` 那种「访问器自己
//                    也是死的」就漏了——那正是它当年混进准入标准的方式。

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import {
  declarationReadsSymbol,
  packageSrcUnits,
  registryKeysWithoutConsumer,
  registrySymbolHasConsumer,
  sourceUnit,
  type SourceUnit,
} from './census'
import { NODE_KIND_BEHAVIORS, SYSTEM_CHANNEL_PORTS } from '@agent-workflow/shared'
import { DISABLED_RESOURCE_POLICY } from '@/services/execution/resourcePolicy'
import { SKILL_OP_RECOVERY_REGISTRY } from '@/services/skillOpRegistry'
import { REPAIR_OPTIONS } from '@/services/lifecycleRepair'
import { DAEMON_CADENCE } from '@/services/daemonCadence'
import { INVARIANT_RULES, STUCK_RULES } from '@/services/lifecycleInvariants'

const REPO = resolve(import.meta.dir, '..', '..', '..', '..')

/**
 * 三个包的 `src/` 一起做语料。**跨包是必需的**：`shared/` 的表可能只被 `frontend/`
 * 消费，只扫 backend 会把它误判成死表，然后有人「按守卫」把活表删掉。
 */
const UNITS: readonly SourceUnit[] = [
  ...packageSrcUnits(REPO, 'backend'),
  ...packageSrcUnits(REPO, 'shared'),
  ...packageSrcUnits(REPO, 'frontend'),
]

/** 消费形态。 */
type Consumption = 'direct' | { readonly via: string }

interface RegistryUnderGuard {
  /** 被查的符号（表本身，或「表的维度集合」时仍写表名）。 */
  readonly symbol: string
  readonly declaringFile: string
  /** 要求逐个有消费者的键。 */
  readonly keys: readonly string[]
  readonly consumption: Consumption
  /** 某些键经由同文件访问器消费。键 → 访问器名；访问器同样两半都验。 */
  readonly keyExemptions?: Readonly<Record<string, string>>
  readonly why: string
}

const REGISTRIES: readonly RegistryUnderGuard[] = [
  {
    symbol: 'NODE_KIND_BEHAVIORS',
    declaringFile: 'packages/shared/src/node-kind-behavior.ts',
    keys: Object.keys(NODE_KIND_BEHAVIORS),
    consumption: 'direct',
    why: '每个 NodeKind 一行；调度 / 重试级联 / 前端画布都按 kind 读它。',
  },
  {
    // 同一张表的**列**方向。行活着不代表列活着——`isProcess` 就是行全活、列全死。
    symbol: 'NODE_KIND_BEHAVIORS',
    declaringFile: 'packages/shared/src/node-kind-behavior.ts',
    keys: Object.keys(Object.values(NODE_KIND_BEHAVIORS)[0] ?? {}),
    consumption: 'direct',
    keyExemptions: { isAgent: 'isAgentNodeKind' },
    why: '表的维度（列）。RFC-146 的准入标准就是「每一维都有 grep 可证的运行时消费者」，这条把那句话变成可执行判据。',
  },
  {
    symbol: 'SYSTEM_CHANNEL_PORTS',
    declaringFile: 'packages/shared/src/systemChannelPorts.ts',
    keys: Object.keys(SYSTEM_CHANNEL_PORTS),
    consumption: { via: 'PROMPT_INJECTED_PORT_NAMES' },
    why: '表本身只被同文件的派生常量与 specFor 读；对外的活链是 PROMPT_INJECTED_PORT_NAMES → shared/prompt.ts。',
  },
  {
    symbol: 'DISABLED_RESOURCE_POLICY',
    declaringFile: 'packages/backend/src/services/execution/resourcePolicy.ts',
    keys: Object.keys(DISABLED_RESOURCE_POLICY),
    consumption: 'direct',
    why: '被禁用资源在启动路径上的处置策略。',
  },
  {
    symbol: 'SKILL_OP_RECOVERY_REGISTRY',
    declaringFile: 'packages/backend/src/services/skillOpRegistry.ts',
    keys: Object.keys(SKILL_OP_RECOVERY_REGISTRY),
    consumption: 'direct',
    why: '技能操作的中断恢复表；daemon 重启修复路径按 op 读。',
  },
  {
    symbol: 'REPAIR_OPTIONS',
    declaringFile: 'packages/backend/src/services/lifecycleRepair.ts',
    keys: Object.keys(REPAIR_OPTIONS),
    consumption: { via: 'listRepairOptionsForAlert' },
    why: '每条 lifecycle alert 规则的可选修复动作；路由经 listRepairOptionsForAlert 取，不直接读表。',
  },
  {
    symbol: 'DAEMON_CADENCE',
    declaringFile: 'packages/backend/src/services/daemonCadence.ts',
    keys: Object.keys(DAEMON_CADENCE),
    consumption: 'direct',
    why: 'daemon 各后台任务的节拍；每个键对应一个真实调度点。',
  },
  {
    symbol: 'INVARIANT_RULES',
    declaringFile: 'packages/backend/src/services/lifecycleInvariants.ts',
    keys: [...INVARIANT_RULES],
    consumption: { via: 'runLifecycleInvariants' },
    why: '作为 ownedRules 传给 reconcileLifecycleAlerts，让不变量对账只碰自己的行；消费点在同文件的 daemon 入口函数里。',
  },
  {
    symbol: 'STUCK_RULES',
    declaringFile: 'packages/backend/src/services/lifecycleInvariants.ts',
    keys: [...STUCK_RULES],
    consumption: 'direct',
    why: '同上，但 ownedRules 的消费点在 stuckTaskDetector.ts —— 另一个文件，所以是 direct。',
  },
]

/** 声明文件对应的语料单元。找不到就是路径写错了——fail closed。 */
function declaringUnit(entry: RegistryUnderGuard): SourceUnit {
  const unit = UNITS.find((u) => u.path === entry.declaringFile)
  if (unit === undefined) {
    throw new Error(`${entry.symbol}: declaringFile 不存在于语料 —— ${entry.declaringFile}`)
  }
  return unit
}

/**
 * `{ via: X }` 的两半判据。返回 null 表示这条活链成立，否则返回它断在哪一半。
 */
function brokenAccessorChain(
  entry: RegistryUnderGuard,
  symbol: string,
  accessor: string,
): string | null {
  if (!declarationReadsSymbol({ unit: declaringUnit(entry), declarationName: accessor, symbol })) {
    return `访问器 ${accessor} 并没有读 ${symbol} —— 这条 via 声明是假的（一张死表配了个恰好活着的同文件声明）`
  }
  if (
    !registrySymbolHasConsumer({
      symbol: accessor,
      units: UNITS,
      declaringFile: entry.declaringFile,
    })
  ) {
    return `访问器 ${accessor} 自己零生产消费者 —— 整条链（表 → 访问器 → 外部）是死的，正是 isProcess 当年的形状`
  }
  return null
}

describe('RFC-317 T42 —— 每张注册表都必须真的被生产代码消费', () => {
  test('语料下限：真的扫到了三个包的生产源码', () => {
    // 没有这条，整份守卫可以**真空通过**：下面每条断言的形式都是「死表列表为空」，
    // 而语料为空时死表列表当然为空——路径写错、包改名、walk 出错，全都表现为满绿。
    // 这是本仓 RFC-311 T19 记录过的事故形状，`corpusFloor` 判据就是为它存在的。
    expect(UNITS.length).toBeGreaterThan(900)
  })

  test('表级：每张表要么直接被外部引用，要么有一条真的活着的访问器链', () => {
    const dead: string[] = []
    for (const entry of REGISTRIES) {
      if (entry.consumption === 'direct') {
        const alive = registrySymbolHasConsumer({
          symbol: entry.symbol,
          units: UNITS,
          declaringFile: entry.declaringFile,
        })
        if (!alive) {
          dead.push(
            `${entry.symbol}（${entry.declaringFile}）声明为 direct 消费，但声明文件之外零引用`,
          )
        }
        continue
      }
      const broken = brokenAccessorChain(entry, entry.symbol, entry.consumption.via)
      if (broken !== null) dead.push(`${entry.symbol}：${broken}`)
    }
    expect(dead, '注册表失去了生产消费者——要么接回消费点，要么删掉它').toEqual([])
  })

  test('键级：每个键都被读过（字面量索引 或 属性访问）', () => {
    const dead: string[] = []
    for (const entry of REGISTRIES) {
      const missing = registryKeysWithoutConsumer({
        keys: entry.keys,
        units: UNITS,
        declaringFiles: [entry.declaringFile],
      })
      for (const key of missing) {
        const accessor = entry.keyExemptions?.[key]
        if (accessor === undefined) {
          dead.push(`${entry.symbol}.${key} 没有任何生产消费者`)
          continue
        }
        const broken = brokenAccessorChain(entry, key, accessor)
        if (broken !== null) dead.push(`${entry.symbol}.${key}：${broken}`)
      }
    }
    expect(dead, '注册表的行/列失去了消费者——死行死列会静静地漂移到与实现不符').toEqual([])
  })

  test('每条豁免都必须真的用得上（写了豁免却其实是 direct ⇒ 这条红）', () => {
    // 豁免是**减弱判据**的旋钮。一条用不上的豁免留在表里，等于给后来的人一个
    // 「这个键本来就特殊」的错误印象，也让它真的死掉时不再报警。
    const stale: string[] = []
    for (const entry of REGISTRIES) {
      for (const key of Object.keys(entry.keyExemptions ?? {})) {
        const missing = registryKeysWithoutConsumer({
          keys: [key],
          units: UNITS,
          declaringFiles: [entry.declaringFile],
        })
        if (missing.length === 0) {
          stale.push(`${entry.symbol}.${key} 已有直接消费者，keyExemptions 里的这条该删了`)
        }
      }
      if (entry.consumption !== 'direct') {
        const direct = registrySymbolHasConsumer({
          symbol: entry.symbol,
          units: UNITS,
          declaringFile: entry.declaringFile,
        })
        if (direct) {
          stale.push(`${entry.symbol} 已有直接消费者，consumption 该改回 'direct'`)
        }
      }
    }
    expect(stale, '过期的豁免会让判据静静地变松').toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 负向 fixture —— 证明这条守卫真的会咬人。
// ---------------------------------------------------------------------------
//
// 上面三条跑的是真实语料，而真实语料**证明不了它当前没有触及的性质**：今天仓里
// 恰好没有死表，于是把判据改松（比如把 via 的两半只留一半）不会让任何断言变色。
// 下面用合成语料把每一种失效各钉一条。

const DEAD_TABLE = sourceUnit(
  'packages/x/src/dead.ts',
  `export const DEAD_TABLE = { alpha: 1, beta: 2 } as const
   function readsIt(k: string) { return DEAD_TABLE[k as 'alpha'] }
   export function unrelatedButExported() { return 42 }`,
)
const ELSEWHERE = sourceUnit(
  'packages/x/src/other.ts',
  `import { unrelatedButExported } from './dead'
   export const v = unrelatedButExported()
   export const alsoAlpha = 'alpha'`,
)

describe('RFC-317 T42 负向 fixture —— 判据被改松时必须变红', () => {
  const units = [DEAD_TABLE, ELSEWHERE]
  const declaringFile = 'packages/x/src/dead.ts'

  test('整张表在声明文件之外零引用 ⇒ 表级判据报死', () => {
    expect(
      registrySymbolHasConsumer({ symbol: 'DEAD_TABLE', units, declaringFile }),
      '表级判据没抓住一张零引用的表',
    ).toBe(false)
  })

  test('键名恰好以别的身份出现在别处 ⇒ 键级判据会放行，所以表级判据不可省', () => {
    // `alpha` 在 other.ts 里是个字符串字面量，与这张表毫无关系。键级判据只看得见
    // 「这个名字出现过」，于是只报出 beta。这就是 REF_DOMAIN_POLICIES 差点蒙混的
    // 原理——也正是两层判据顺序不能反的理由。
    expect(
      registryKeysWithoutConsumer({
        keys: ['alpha', 'beta'],
        units,
        declaringFiles: [declaringFile],
      }),
    ).toEqual(['beta'])
  })

  test('复用同一语料索引时，每次查询仍按自己的声明文件排除 self-reference', () => {
    const sharedUnits = [
      DEAD_TABLE,
      ELSEWHERE,
      sourceUnit('packages/x/src/beta-consumer.ts', "export const consumed = 'beta'\n"),
    ]
    expect(
      registryKeysWithoutConsumer({
        keys: ['alpha', 'beta'],
        units: sharedUnits,
        declaringFiles: [declaringFile],
      }),
    ).toEqual([])
    expect(
      registryKeysWithoutConsumer({
        keys: ['alpha', 'beta'],
        units: sharedUnits,
        declaringFiles: ['packages/x/src/beta-consumer.ts'],
      }),
    ).toEqual(['beta'])
  })

  test('via 的前半：访问器没读这张表 ⇒ 报「假 via」', () => {
    expect(
      declarationReadsSymbol({
        unit: DEAD_TABLE,
        declarationName: 'unrelatedButExported',
        symbol: 'DEAD_TABLE',
      }),
      '一个恰好活着的同文件导出被当成了这张表的访问器',
    ).toBe(false)
  })

  test('via 的后半：访问器读了表但自己零外部消费者 ⇒ 报「链是死的」', () => {
    // `readsIt` 确实读了 DEAD_TABLE……但它自己没被任何外部文件引用。
    // 这正是 `isProcess → isProcessNodeKind → 只有测试` 的形状。
    expect(
      declarationReadsSymbol({
        unit: DEAD_TABLE,
        declarationName: 'readsIt',
        symbol: 'DEAD_TABLE',
      }),
    ).toBe(true)
    expect(
      registrySymbolHasConsumer({ symbol: 'readsIt', units, declaringFile }),
      'via 的后半判据失效——一条整体死掉的访问器链被放行了',
    ).toBe(false)
  })
})

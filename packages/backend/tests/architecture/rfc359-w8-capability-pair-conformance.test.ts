// RFC-359 W8 —— **能力级**的成对适配器账本：按「端口类型」配对，不按文件名配对。
//
// 这条账本存在的理由：既有两本账本有一处结构性盲区
// ================================================
// `rfc359-w5-provider-pair-conformance.test.ts` 靠**文件名引擎前缀 + 同目录**配对
// （`sqliteFoo.ts` ↔ `postgresqlFoo.ts`）。它自己的头注释已经声明了收窄：「同目录才算一对」。
// 但真正的盲区比那还大一层——**一侧的文件名里可以根本没有引擎前缀，两侧的名字可以本来就不同**。
// 实例（本 RFC W8 才发现，此前对两本账本双双隐形）：
//
//   `AdminBackupCoordinatorPort` / `AdminRestoreCoordinatorPort`
//     · SQLite     —— `modules/system-operations/infrastructure/legacyPlatformRecoveryAdapter.ts`
//                     （名字里没有 `sqlite`；转调 `platform/persistence/sqlite/systemProviderRestore.ts`）
//     · PostgreSQL —— `modules/system-operations/infrastructure/postgresqlAdminRestoreCoordinator.ts`
//
// 两侧不同目录、不同名字（`systemProviderRestore` vs `providerRestore`），所以**任何按名字
// 配对的判据都抓不到它**——不是把 `classify()` 放宽就能解决的。而 T17 那本账本只清点
// provider 命名文件的**落位**：它看得见 `postgresqlAdminRestoreCoordinator.ts` 这个「独苗」，
// 却看不见它有孪生兄弟。于是这一族长期是**两份实现、两套各自的单引擎测试、零跨 provider 对拍**，
// 而它承载的是**灾难恢复**。
//
// 换判据：从「名字」换到「类型」（本仓第三次做同一个动作）
// ------------------------------------------------------
// `docs/dev-gotchas.md` 记过两次同类修复：RFC-349 的 PostgreSQL 陷阱守卫把「文件名前缀」
// 换成「按类型可达派生」；`rfc317-ledger-highwater` 把「名字词汇表」换成「名字 ∪ 等值断言」。
// 两次都是同一个动作——**判据从「叫什么」换成「是什么」**。这里第三次：
//
//   **一对 = 一个端口类型 + 它在两个 provider 上各自的实现。**
//
// 端口是模块自己声明的能力契约（`application/ports/**` 与 `*Port.ts`），它**不随文件改名而变**。
// 把 `legacyPlatformRecoveryAdapter.ts` 改成任何名字、挪到任何目录，只要它还
// `: AdminRestoreCoordinatorPort`，这条判据照样把它和 PG 那份配成一对。这就是「不会因为改个
// 文件名就失效」的含义。
//
// 三本账本的分工（量的是三件不同的事，别互相替代）
// ------------------------------------------------
//   · **T17** —— provider 命名文件的**落位**（在不在该在的家里）。看不见配对。
//   · **W5 成对账本** —— 按**文件名**发现的对（今天 11 对）+ 其中没有对拍的对数。
//     它能看见 `platform/persistence/LogicalSource` 这种「没有 ports 声明、纯靠命名成对」的对，
//     **本账本看不见那些**（它们不经过任何 `application/ports/` 端口）。
//   · **本账本** —— 按**端口类型**发现的对（今天 12 对），并把其中 **W5 结构上看不见的那些**
//     （`NAME_BLIND_CAPABILITY_PAIRS`，今天 4 对）单独立账、上棘轮。
//
// 两本账本**互不包含**：W5 有 11 对，本账本有 12 对，交集是 8 对。所以两本都要留着——
// 本账本只对**名字盲**的那 4 对逐字记账（其余 8 对交给 W5，避免双重记账，也避免与并行
// 合一的刀互相踩），并对**总对数**上一条只降不升的松棘轮。
//
// 判据的已知误判面（读账本前必须知道，纪律同 W5）
// ----------------------------------------------
//   · **假阴性 · 没有端口声明的对**：两份实现直接互为孪生、中间没有 `application/ports/` 契约
//     （`LogicalSource` / `LogicalTarget` / `ResourcePackageMaintenance`），本账本看不见。
//     那正是 W5 的地盘，两本合起来才是全集。
//   · **假阴性 · 组合根分派**：`composition/` 被排除在「实现点」之外——组合根**绑定**端口，
//     不**实现**端口。一个真在组合根里内联实现的适配器会被漏掉（今天没有这种写法）。
//   · **假阳性 · 一个文件实现多个端口**：`postgresqlTaskExecutionRuntimeParticipants.ts` 一个文件
//     实现好几个端口，于是同一份分叉被记成好几对。这是**有意**的：账本的单位是**能力**不是文件，
//     一份实现同时欠着几个能力的对拍，就该记几笔。
//   · **见证判据比 W5 宽一档**：W5 要求见证测试用 `describeEachProvider`。本账本不能要求它——
//     `describeEachProvider` 的轴是**数据库连接**，而能力对拍未必落在那条轴上（灾难恢复那一对
//     整段状态在文件系统上，套进去会变成两种生产里不存在的组合）。所以这里的见证判据是
//     「一个测试文件对两侧各有至少一条**值 import**」——`import type` 与字符串 / 正则里的
//     提名都不算（源码文本守卫因此被正确排除：`rfc349-code-capability-provider-boundary.test.ts`
//     把两侧名字写在 roster 数组里，它不构造任何一份实现，不是见证）。
//     残余假阳性（把两侧都 import 进来却只断言一侧）与 W5 同档，今天两条见证都是真行为矩阵。

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const SRC = resolve(import.meta.dir, '..', '..', 'src')
const TESTS = resolve(import.meta.dir, '..')

/** 两棵树各读一遍；给足余量的显式超时，别让慢 runner 变成 flaky。 */
const TIMEOUT_MS = 120_000

// ---------------------------------------------------------------------------
// 判据本体：纯函数（输入是「文件 → 源码」的映射，不碰文件系统），供真实树与内存 fixture 共用
// ---------------------------------------------------------------------------

export type ProviderSide = 'sqlite' | 'postgresql'

export interface SourceFile {
  /** `src` / `tests` 相对路径，POSIX 分隔符。 */
  readonly path: string
  readonly source: string
}

export interface CapabilityPair {
  /** 端口类型名 —— 一对的身份。改文件名不影响它。 */
  readonly port: string
  /** 声明该端口的文件（`src` 相对路径）。 */
  readonly declaredIn: string
  readonly sqlite: readonly string[]
  readonly postgresql: readonly string[]
  /** W5 的「同目录 + 去掉引擎前缀后同名」判据能不能看见这一对。 */
  readonly nameBlind: boolean
  /** 见证测试（`tests` 相对路径，字典序）；空 = 没有对拍。 */
  readonly witnesses: readonly string[]
}

/** 端口的家：模块声明的能力契约。 */
const PORT_FILE = /(^|\/)application\/ports\//
const PORT_FILE_SUFFIX = /Port\.ts$/

/** 组合根**绑定**端口，不**实现**端口——排除，否则每个 provider 分派都被记成一份实现。 */
const COMPOSITION_FILE = /(^|\/)composition(\/|\.ts$)/

/**
 * 「我只服务一个引擎」的自述式文件名前缀（与 W5 同一条，`(?=[A-Z])` 排除中立目录入口）。
 * 这里**只用来判 `nameBlind`**（W5 看不看得见这一对），不用来发现对。
 */
const PROVIDER_PREFIX = /^(legacySqlite|legacyPostgresql|sqlite|postgresql)(?=[A-Z])/

/**
 * provider 专属的平台原语。一个文件**直接 import** 其中之一，就自述了它服务哪个引擎——
 * 这条信号看的是**依赖**，与文件叫什么无关。
 */
const IMPORT_ANCHOR: Readonly<Record<ProviderSide, RegExp>> = {
  postgresql:
    /from\s+['"][^'"]*(?:platform\/persistence\/postgresql[A-Z]|\/postgresql[A-Z][^'"]*)['"]/,
  sqlite:
    /from\s+['"](?:bun:sqlite|[^'"]*(?:platform\/persistence\/sqlite\/|\/sqlite\/)[^'"]*)['"]/,
}

/** 住在 provider 专属目录 / 带 provider 专属文件名的第二条独立信号。 */
const LOCATION_ANCHOR: Readonly<Record<ProviderSide, RegExp>> = {
  postgresql: /(^|\/)postgresql[A-Z]/,
  sqlite: /(^|\/)(?:sqlite|legacySqlite)(?:\/|[A-Z])/,
}

/**
 * 值 import（口径与 W5 一致）。`import type …` 被排除：只借类型不构造实现，跑不到任何一行。
 */
const VALUE_IMPORT =
  /(?:^|\n)\s*import\s+(?!type\s)[\s\S]{0,600}?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g

/**
 * 从一个端口声明文件里取出**行为契约**的名字。
 *
 * 只认 `export interface`，且接口体里至少有一条**调用签名**（方法 / 函数类型属性 / 箭头类型）。
 * 纯数据的 DTO 虽然也住在 `ports/` 目录里（`ChildWorkflowLaunchRequest` 之类），
 * 但它不是「一件能被两个引擎各实现一遍的事」——把它算进来只会把账本灌成噪音。
 */
export function declaredPorts(source: string): string[] {
  const out: string[] = []
  for (const match of source.matchAll(/^export\s+interface\s+([A-Z][A-Za-z0-9_]*)[^{]*\{/gm)) {
    const start = match.index! + match[0].length
    let depth = 1
    let cursor = start
    while (cursor < source.length && depth > 0) {
      const char = source[cursor]
      if (char === '{') depth += 1
      else if (char === '}') depth -= 1
      cursor += 1
    }
    const body = source.slice(start, cursor - 1)
    const hasCallSignature =
      /^\s*(?:readonly\s+)?[A-Za-z_][A-Za-z0-9_]*\s*\??\s*(?:\(|:\s*\()/m.test(body) ||
      body.includes('=>')
    if (hasCallSignature) out.push(match[1]!)
  }
  return out
}

/** 这个文件有没有把某个值绑定到端口类型上（= 它实现了这个端口）。 */
export function implementsPort(source: string, port: string): boolean {
  if (!source.includes(port)) return false
  return new RegExp(
    `(?::\\s*(?:readonly\\s+)?${port}\\b)|(?:implements\\s+[^{]*\\b${port}\\b)|(?:extends\\s+${port}\\b)`,
  ).test(source)
}

/** 这个文件自述服务哪个引擎；两条信号任一命中即可，两条都命中（既 PG 又 SQLite）则不判边。 */
export function providerSideOf(file: SourceFile): ProviderSide | null {
  const sides = (['sqlite', 'postgresql'] as const).filter(
    (side) => IMPORT_ANCHOR[side].test(file.source) || LOCATION_ANCHOR[side].test(`/${file.path}`),
  )
  return sides.length === 1 ? sides[0]! : null
}

/** W5 的判据：两侧存不存在「同目录 + 去掉引擎前缀后同名」的文件对。 */
export function w5CanSee(sqlite: readonly string[], postgresql: readonly string[]): boolean {
  const stem = (path: string): string => {
    const cut = path.lastIndexOf('/')
    const directory = path.slice(0, cut)
    const base = path.slice(cut + 1).replace(/\.ts$/, '')
    return `${directory}/${base.replace(PROVIDER_PREFIX, '')}`
  }
  const stems = new Set(sqlite.map(stem))
  return postgresql.map(stem).some((key) => stems.has(key))
}

function valueImports(source: string): string[] {
  return [...source.matchAll(VALUE_IMPORT)].map((match) => match[1] ?? match[2] ?? match[3] ?? '')
}

/** 一条值 import 的说明符指不指向这个 `src` 相对模块。 */
function importsModule(specifiers: readonly string[], module: string): boolean {
  const withoutExtension = module.replace(/\.ts$/, '')
  const tail = withoutExtension.slice(withoutExtension.lastIndexOf('/') + 1)
  return specifiers.some((specifier) => {
    const normalized = specifier.replace(/\.ts$/, '')
    if (normalized.endsWith(`/${withoutExtension}`) || normalized === `@/${withoutExtension}`) {
      return true
    }
    // 相对说明符：末段唯一即可（`src` 下同名文件极少，且下面还要求两侧都命中）。
    return normalized.startsWith('.') && normalized.endsWith(`/${tail}`)
  })
}

/** 判据本体。`sources` 是 `src` 树，`tests` 是 `tests` 树。 */
export function findCapabilityPairs(
  sources: readonly SourceFile[],
  tests: readonly SourceFile[],
): CapabilityPair[] {
  const ports = new Map<string, string>()
  for (const file of sources) {
    if (!PORT_FILE.test(`/${file.path}`) && !PORT_FILE_SUFFIX.test(file.path)) continue
    for (const port of declaredPorts(file.source)) ports.set(port, file.path)
  }

  const testImports = tests.map((file) => ({
    path: file.path,
    specifiers: valueImports(file.source),
  }))

  const pairs: CapabilityPair[] = []
  for (const [port, declaredIn] of [...ports].sort((a, b) => a[0].localeCompare(b[0]))) {
    const sides: Record<ProviderSide, string[]> = { sqlite: [], postgresql: [] }
    for (const file of sources) {
      if (PORT_FILE.test(`/${file.path}`) || COMPOSITION_FILE.test(`/${file.path}`)) continue
      if (!implementsPort(file.source, port)) continue
      const side = providerSideOf(file)
      if (side !== null) sides[side].push(file.path)
    }
    if (sides.sqlite.length === 0 || sides.postgresql.length === 0) continue
    sides.sqlite.sort()
    sides.postgresql.sort()
    const witnesses = testImports
      .filter(
        ({ specifiers }) =>
          sides.sqlite.some((module) => importsModule(specifiers, module)) &&
          sides.postgresql.some((module) => importsModule(specifiers, module)),
      )
      .map(({ path }) => path)
      .sort()
    pairs.push({
      port,
      declaredIn,
      sqlite: sides.sqlite,
      postgresql: sides.postgresql,
      nameBlind: !w5CanSee(sides.sqlite, sides.postgresql),
      witnesses,
    })
  }
  return pairs
}

/** 账本行的渲染（一对一行，可机械复算）。 */
export function renderPair(pair: CapabilityPair): string {
  const status =
    pair.witnesses.length === 0 ? 'unverified' : `verified by ${pair.witnesses.join(', ')}`
  return `${pair.declaredIn}:${pair.port}: ${pair.sqlite.join(' ')} + ${pair.postgresql.join(' ')} — ${status}`
}

// ---------------------------------------------------------------------------
// 账本：**W5 结构上看不见的**能力对（其余交给 W5，避免双重记账）
// ---------------------------------------------------------------------------

/**
 * `<端口声明文件>:<端口>: <sqlite 侧实现> + <postgresql 侧实现> — <状态位>`，按端口字典序。
 *
 * 这两对的共同点：两侧的名字对不上，所以**按名字配对的账本永远看不到它们**。
 * 状态位 `verified by …` = 存在一个测试文件对两侧各有至少一条值 import；否则 `unverified`。
 */
export const NAME_BLIND_CAPABILITY_PAIRS: readonly string[] = [
  // 灾难恢复两对：SQLite 侧的文件名里**根本没有引擎前缀**（`legacyPlatformRecoveryAdapter`），
  // 且两侧不同目录——按名字配对的账本永远看不到它们。
  // RFC-359 W8 已补上行为对拍（备份收据形状 / 暂存往返 / 409 冲突 / 暂存中途失败 /
  // 标记损坏 / 隔离清单），并据此把 SQLite 侧抬齐到 PostgreSQL 侧。
  'modules/system-operations/application/ports/adminBackupCoordinator.ts:AdminBackupCoordinatorPort: modules/system-operations/infrastructure/legacyPlatformRecoveryAdapter.ts + modules/system-operations/infrastructure/postgresqlAdminBackupCoordinator.ts — verified by rfc359-w8-system-operations-recovery-conformance.test.ts',
  'modules/system-operations/application/ports/adminRestoreCoordinator.ts:AdminRestoreCoordinatorPort: modules/system-operations/infrastructure/legacyPlatformRecoveryAdapter.ts + modules/system-operations/infrastructure/postgresqlAdminRestoreCoordinator.ts — verified by rfc359-w8-system-operations-recovery-conformance.test.ts',
]

/**
 * W5 看不见的能力对数。**只降不升**——合一掉一对、或改名让 W5 也能看见，都算进展。
 *
 * RFC-359 W12：代码矩阵与度量两对已合一，两个引擎共用有界批量算法与同一 composer。
 * W8 对拍继续驱动实际查询，保留计数数值化、拒绝结果和空矩阵/扩容时的恒定语句数断言。
 */
export const NAME_BLIND_PAIR_COUNT = 2

/** 其中「连一份对拍都没有」的对数。**只降不升**——补一份对拍就减一。 */
export const NAME_BLIND_UNVERIFIED_COUNT = 0

/**
 * 按端口类型发现的**全部**能力对数（含 W5 也看得见的那 8 对）。
 *
 * 这里用**松棘轮**（`<=`）而不是逐字相等：其余 8 对由 W5 逐字记账，并行的合一刀随时会把
 * 它们合掉，逐字钉死会让别人的进展在这里红成「回归」。
 */
export const CAPABILITY_PAIR_CEILING = 10

// ---------------------------------------------------------------------------

function walk(root: string, base = root, out: SourceFile[] = []): SourceFile[] {
  for (const name of readdirSync(root)) {
    const path = join(root, name)
    if (statSync(path).isDirectory()) walk(path, base, out)
    else if (path.endsWith('.ts')) {
      out.push({
        path: path.slice(base.length + 1).replaceAll('\\', '/'),
        source: readFileSync(path, 'utf8'),
      })
    }
  }
  return out
}

describe('RFC-359 W8 —— 能力级成对适配器账本', () => {
  const pairs = findCapabilityPairs(walk(SRC), walk(TESTS))
  const nameBlind = pairs.filter((pair) => pair.nameBlind)

  test(
    '名字盲的能力对逐字对账',
    () => {
      expect(nameBlind.map(renderPair)).toEqual([...NAME_BLIND_CAPABILITY_PAIRS])
    },
    TIMEOUT_MS,
  )

  test('名字盲对数只降不升', () => {
    expect(nameBlind).toHaveLength(NAME_BLIND_PAIR_COUNT)
    expect(NAME_BLIND_CAPABILITY_PAIRS).toHaveLength(NAME_BLIND_PAIR_COUNT)
  })

  test('名字盲对里「没有对拍」的对数只降不升', () => {
    const unverified = nameBlind.filter((pair) => pair.witnesses.length === 0)
    expect(unverified).toHaveLength(NAME_BLIND_UNVERIFIED_COUNT)
    expect(NAME_BLIND_CAPABILITY_PAIRS.filter((row) => row.endsWith('— unverified'))).toHaveLength(
      NAME_BLIND_UNVERIFIED_COUNT,
    )
  })

  test('按端口发现的总对数不增长', () => {
    expect(pairs.length).toBeLessThanOrEqual(CAPABILITY_PAIR_CEILING)
  })

  test('两本账本互不包含——所以两本都要留着', () => {
    // 有 W5 看得见、本账本也看得见的（交集），也有只有本账本看得见的（名字盲）。
    // 如果哪天名字盲清零，这条会红——那正是该退役本账本的信号，届时显式删除而不是让它空转。
    expect(nameBlind.length).toBeGreaterThan(0)
    expect(pairs.length).toBeGreaterThan(nameBlind.length)
  })

  test('灾难恢复那一对确实是被两本既有账本同时漏掉的那一对', () => {
    const recovery = pairs.filter((pair) => pair.declaredIn.includes('system-operations'))
    expect(recovery.map((pair) => pair.port).sort()).toEqual([
      'AdminBackupCoordinatorPort',
      'AdminRestoreCoordinatorPort',
    ])
    // 判据不看名字：SQLite 那一侧的文件名里连 `sqlite` 三个字母都没有。
    for (const pair of recovery) {
      expect(pair.sqlite).toEqual([
        'modules/system-operations/infrastructure/legacyPlatformRecoveryAdapter.ts',
      ])
      expect(pair.sqlite.some((path) => /(^|\/)sqlite[A-Z]/.test(path))).toBe(false)
      expect(pair.nameBlind).toBe(true)
      expect(pair.witnesses.length).toBeGreaterThan(0)
    }
  })
})

// ---------------------------------------------------------------------------
// 判据自身的取证：内存 fixture，不碰真实树。改坏判据这里立刻红。
// ---------------------------------------------------------------------------

describe('RFC-359 W8 —— 判据本体', () => {
  const PORT = 'application/ports/thing.ts'
  const portSource = 'export interface ThingPort {\n  run(): Promise<void>\n}\n'

  test('端口 = 有调用签名的 interface；纯数据 DTO 不算端口', () => {
    expect(declaredPorts(portSource)).toEqual(['ThingPort'])
    expect(declaredPorts('export interface Row {\n  readonly id: string\n}\n')).toEqual([])
    expect(declaredPorts('export interface Fn {\n  readonly go: () => void\n}\n')).toEqual(['Fn'])
  })

  test('配对靠端口类型，**不靠文件名**——两侧改成任意名字照样成对', () => {
    const pairs = findCapabilityPairs(
      [
        { path: PORT, source: portSource },
        {
          // 名字里没有任何引擎前缀，只靠 import 自述服务 SQLite。
          path: 'infrastructure/somethingEntirelyElse.ts',
          source: `import { x } from '@/platform/persistence/sqlite/thing'\nexport const a: ThingPort = x`,
        },
        {
          path: 'infrastructure/anotherName.ts',
          source: `import { y } from '@/platform/persistence/postgresqlDatabaseClient'\nexport const b: ThingPort = y`,
        },
      ],
      [],
    )
    expect(pairs).toHaveLength(1)
    expect(pairs[0]!.port).toBe('ThingPort')
    expect(pairs[0]!.nameBlind).toBe(true)
    expect(pairs[0]!.witnesses).toEqual([])
  })

  test('W5 看得见的对（同目录 + 同词干）被标成 nameBlind: false', () => {
    const pairs = findCapabilityPairs(
      [
        { path: PORT, source: portSource },
        { path: 'infrastructure/sqliteThing.ts', source: `export const a: ThingPort = 1 as never` },
        {
          path: 'infrastructure/postgresqlThing.ts',
          source: `export const b: ThingPort = 1 as never`,
        },
      ],
      [],
    )
    expect(pairs).toHaveLength(1)
    expect(pairs[0]!.nameBlind).toBe(false)
  })

  test('只有一侧实现 —— 不成对（那是落位债，归 T17）', () => {
    const pairs = findCapabilityPairs(
      [
        { path: PORT, source: portSource },
        {
          path: 'infrastructure/postgresqlThing.ts',
          source: `export const b: ThingPort = 1 as never`,
        },
      ],
      [],
    )
    expect(pairs).toEqual([])
  })

  test('组合根绑定端口不算实现', () => {
    const pairs = findCapabilityPairs(
      [
        { path: PORT, source: portSource },
        {
          path: 'composition/wire.ts',
          source: `import { p } from '@/platform/persistence/postgresqlRuntime'\nexport const b: ThingPort = p`,
        },
        { path: 'infrastructure/sqliteThing.ts', source: `export const a: ThingPort = 1 as never` },
      ],
      [],
    )
    expect(pairs).toEqual([])
  })

  test('见证要值 import 两侧；import type 与源码文本守卫都不算', () => {
    const sources: SourceFile[] = [
      { path: PORT, source: portSource },
      { path: 'infrastructure/sqliteThing.ts', source: `export const a: ThingPort = 1 as never` },
      {
        path: 'infrastructure/postgresqlThing.ts',
        source: `export const b: ThingPort = 1 as never`,
      },
    ]
    const witnessOf = (source: string): readonly string[] =>
      findCapabilityPairs(sources, [{ path: 'probe.test.ts', source }])[0]!.witnesses

    // 值 import 两侧 = 见证。
    expect(
      witnessOf(
        `import { a } from '@/infrastructure/sqliteThing'\nimport { b } from '@/infrastructure/postgresqlThing'`,
      ),
    ).toEqual(['probe.test.ts'])
    // 只 import 一侧 —— 那是拿同一份实现跑两遍，证明不了这一对的任何事。
    expect(witnessOf(`import { a } from '@/infrastructure/sqliteThing'`)).toEqual([])
    // 只借类型 —— 跑不到任何一行。
    expect(
      witnessOf(
        `import type { A } from '@/infrastructure/sqliteThing'\nimport type { B } from '@/infrastructure/postgresqlThing'`,
      ),
    ).toEqual([])
    // 源码文本守卫：两侧的名字只出现在字符串 roster 里，不构造任何实现。
    expect(
      witnessOf(`const roster = ['sqliteThing.ts', 'postgresqlThing.ts']\nvoid roster`),
    ).toEqual([])
  })

  test('两条自述信号各自独立：改文件名不失效，改 import 也不失效', () => {
    // 只有 import 自述（文件名中立）。
    expect(
      providerSideOf({
        path: 'infrastructure/neutralName.ts',
        source: `import { c } from '@/platform/persistence/postgresqlDatabaseClient'`,
      }),
    ).toBe('postgresql')
    // 只有落位自述（没有任何 provider import）。
    expect(
      providerSideOf({
        path: 'platform/persistence/sqlite/thing.ts',
        source: 'export const a = 1',
      }),
    ).toBe('sqlite')
    // 两侧都自述 —— 不判边（避免把中立/桥接文件强塞进某一侧）。
    expect(
      providerSideOf({
        path: 'platform/persistence/sqlite/bridge.ts',
        source: `import { c } from '@/platform/persistence/postgresqlDatabaseClient'`,
      }),
    ).toBeNull()
  })
})

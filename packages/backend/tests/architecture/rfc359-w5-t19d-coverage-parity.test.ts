// RFC-359 W5-T19d —— 成对适配器的**覆盖对等**账本（只降不升）。
//
// 事故形态：覆盖倒挂 ⇒ PostgreSQL 侧**静默变弱**
// ------------------------------------------------
// 一个 port 落成两份实现之后，两侧的测试注意力几乎从来不是对半分的。SQLite 侧被几十个套件
// 天天跑，PostgreSQL 侧一条行为判据都没有——于是它可以**长期比 SQLite 弱而没有任何东西转红**：
// 漏引用完整性复核、漏幂等回放、漏状态校验，全都要等到 W4 把两侧合一时才第一次被看见
// （`design/dual-provider-parity-audit-2026-09-04.md` 的 12 条 P0 全是这么漏过去的）。
// 换句话说，**倒挂本身就是缺陷的孵化器**：哪一侧没人看，哪一侧就会长出分歧。
//
// 本轮实做撞到的两个实例，就是这条守卫的来由：
//   - `rfc328-durable-ownership.test.ts` —— 1495 行的正确性矩阵（耐久归属 / 效应围栏 / 意图回放 /
//     终态维护），**全部只跑 SQLite**：它 import 的是 `sqliteTaskExecutionRecovery` /
//     `sqliteTaskExecutionContext` / `sqliteLocalEffectObserver`，PG 侧的同名实现零行为覆盖；
//   - **Skill 三对** —— 合一前覆盖是 **52 : 6** 的倒挂（`plan.md` §W4 甲类表：
//     「SQLite / legacy 侧 52 个套件，PG 侧 6 个」，且 PG 那 6 个「多为源码形状锁」）。
//     两侧归一化相似度只有 7%——不是同一份逻辑的两种写法，是两套机器。
//
// 为什么是**代理判据**，不是真行覆盖率
// ------------------------------------
// 先量过 `bun test --coverage`：它确实能按文件给行覆盖（lcov 的 `DA:` / `LF:` / `LH:`，
// 函数体内逐行，且 `--isolate` 下能跨测试文件聚合）。真覆盖率仍然做不成常驻守卫，三条硬伤：
//   1. **PG 侧的行覆盖需要一个真 PostgreSQL**。没有 `AW_TEST_POSTGRESQL_URL` 时 PG 适配器的
//      覆盖恒为 0，判据退化成同义反复；而 macOS lane 是显式的 sqlite-only lane（起不了服务容器），
//      它**永远**测不出对等。守卫在半数 lane 上零预言力，不如不做。
//   2. **backend 在 CI 上是四分片**，每片只看到四分之一的测试，per-shard lcov 是残缺视图；
//      要一份可比的数只能新造「四片 lcov 合并」的 CI 管道——那是 T21 之后的事，不是本条的前置。
//   3. 未被 import 的文件**根本不出现在 lcov 里**（实测：没人 import 的模块整条记录缺席，
//      不是 0%）。而「PG 侧零覆盖」恰恰就是这个形态——最该报的那一格，报告里没有行。
// 所以本条按 plan §5 T19d 的「过渡期」定位取零运行代价的代理判据，真覆盖率留到 T21
// （四分片各带 postgres 服务容器）之后再谈。
//
// 判据：两个通道，口径与 `scripts/tests-referencing.sh` 对齐
// ---------------------------------------------------------
// `scripts/tests-referencing.sh` 是本仓「谁引用了这个实现」的既有单一工具，RFC-359 的
// 52:6 / 13:3 两组数就是用它数出来的。这里沿用同一口径，并拆成两个通道：
//   - **ref**（引用）：测试文件按标识符边界提到该侧的**模块名**或它的**任一导出符号**。
//     这就是 `tests-referencing.sh` 数出来的那个数。
//   - **drive**（驱动）：测试文件有一条**值 import**（非 `import type`）直接落到该侧模块上
//     ——也就是它真能把这份实现构造出来跑。**源码形状锁只 `readFileSync` + 正则，drive 记 0**，
//     于是「PG 侧 3 个，多为源码形状锁」这种虚高会被这一列当场拆穿。
// 两个通道一起看才有意义：ref 高 drive 低 = 一堆人提到它、没人跑它。
//
// **判据的已知偏斜**（读这份账本排合一优先级时必须知道）：薄壳对（SQLite 侧只是 legacy 机器上的
// 一层壳）的 SQLite 行为不在 `sqliteX.ts` 里，而在它下面的 legacy 实现里，测试也多经由组合根
// 接进去；于是这类对的 SQLite 列会**系统性偏低**，个别对甚至显得 PG 更高。反过来，把判据放宽成
// 「静态可达」则完全失效——量过：`TaskOwnershipPersistence` 两侧各 832，因为按 provider 分派的
// 组合根把两侧一起 import 了，可达 ≠ 执行，倒挂被抹成假对等。两害相权取偏斜可解释的那个，
// 并在这里写明，别拿单行数字当结论。
//
// 机制同 RFC-317 T17 / `rfc359-sync-transaction-highwater.test.ts`：**逐字相等，只降不升**。
// 倒挂加深了红——有人又往已经偏斜的那侧加判据；倒挂收敛了也红——把账本一起改小，
// 让每一次补齐都留下一次有署名的提交记录。

import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, normalize, resolve } from 'node:path'

const SRC = resolve(import.meta.dir, '..', '..', 'src')
const TESTS = resolve(import.meta.dir, '..')

/** 「我只服务一个引擎」的自述式文件名前缀，后接大写字母（`sqliteFoo.ts` / `postgresqlFoo.ts`）。 */
const PROVIDER_PREFIX = /^(sqlite|postgresql)(?=[A-Z])/

/**
 * `<目录>/<去掉引擎前缀的名字>: sqlite <ref>/<drive>, postgresql <ref>/<drive>`，按路径字典序。
 *
 * `ref` = 提到该侧模块名或其导出符号的测试文件数；`drive` = 有值 import 能真正构造它的测试文件数。
 * 只降不升：任何一格变了都要改这份账本。
 */
export const COVERAGE_PARITY_LEDGER: readonly string[] = [
  'modules/intent/infrastructure/IntentApplyArtifactLifecycle: sqlite 3/1, postgresql 4/3',
  // RFC-359 W11：PostgreSQL 侧 +1 ref / +1 drive
  // （`rfc359-w11-atomic-apply-neutral-transaction-conformance.test.ts` 值 import 了那台编排机，
  // 给它此前没有的**事务边界原子性**补上双引擎判据）。倒挂**收窄**：18 vs 3 → 18 vs 4。
  // W12：真实恢复对拍的 SQLite 臂直接调用 convergeIntentApplyJournal，PG 臂经完整
  // convergence 根调用其实现；仅前者增加本文件的直接引用，两个引擎执行同一套 DB/FS 判据。
  'modules/intent/infrastructure/IntentApplyOperations: sqlite 20/3, postgresql 5/3',
  // RFC-359 W8：两侧各 +1 ref / +1 drive（`rfc359-w8-resource-package-maintenance-conformance.test.ts`
  // 是 `describeEachProvider`，一条 body 同时驱动两侧的 journal + 恢复端口）。
  // RFC-359 W9：两侧各 +1 ref / +1 drive —— `rfc359-w9-resource-package-skill-recovery-conformance.test.ts`
  // 同时驱动两侧的恢复端口（判据缺口 13b 的对拍）。两侧同步上涨，倒挂没有加深。
  // W12：journal 合一后 oracle 改 import 中立文件，剩余 artifact 两侧各少一条直接引用。
  'modules/resource-catalog/infrastructure/ResourcePackageMaintenance: sqlite 3/2, postgresql 3/3',
  // RFC-359 W8：两侧各 +1 ref —— `rfc359-w8-runtime-participants-conformance.test.ts` 的
  // 不合一判定用源码文本钉住了「drive 里两侧各挂一台子任务启动引擎」这条锚点。
  'modules/task-execution/infrastructure/ChildExecutionLaunchOperations: sqlite 6/2, postgresql 8/1',
  // RFC-359 W8：双引擎对拍 `rfc359-w8-source-termination-conformance.test.ts` 把两侧各 +1/+1。
  // RFC-359 W10：SQLite 侧再 +1 ref / +1 drive —— 三笔 `dbTxSync` 转成中立事务之后，
  // `rfc359-w10-task-execution-sync-transaction-cutover.test.ts` 在**两个引擎上都构造这一个**
  // SQLite 命名的参与者（它跑得动 PostgreSQL 正是转换成功的判据），于是它的引用/驱动数上涨。
  // 倒挂随之从 +1 变成 +2，但方向是「弱侧 PG 的那份原生重写更该退役」，不是新债。
  // W12：共用 atom 的真实回滚、终态 CAS 赢家、提交后停止回归，两侧各加 1 ref/drive。
  'modules/task-execution/infrastructure/SourceTerminationParticipant: sqlite 5/4, postgresql 3/2',
  // W12：真实执行夹具提升到 providerRuntime 整体装配，底层 PG participants / launch 的
  // 直接 import 各少一条，但 factory 的返回对象驱动同一真实任务；不以直接引用数冒充行为覆盖。
  'modules/task-execution/infrastructure/TaskExecutionRuntimeParticipants: sqlite 9/3, postgresql 5/1',
  'modules/task-execution/infrastructure/TaskRouteLaunchOperations: sqlite 2/1, postgresql 5/1',
  // RFC-359 W8：两侧各 +1 ref / +1 drive（`rfc359-w8-task-route-capability-parity.test.ts`
  // 是 `describeEachProvider`，一条 body 同时驱动两侧），倒挂差额不变。
  'modules/task-execution/infrastructure/TaskRouteOperations: sqlite 7/2, postgresql 9/2',
  // RFC-359 W8：两侧各 +1 ref / +1 drive（`rfc359-w8-logical-source-conformance.test.ts`），
  // 倒挂差额不变（下面观察名单里那条随之从 `7 vs 4` 变成 `8 vs 5`）。
  'platform/persistence/LogicalSource: sqlite 8/4, postgresql 5/3',
]

/** plan §5 T19d 的「阈值」：两侧 ref 差到这个数就算倒挂，要么补测试、要么进下面的观察名单。 */
export const REFERENCE_GAP_THRESHOLD = 3

/**
 * ref 差 >= `REFERENCE_GAP_THRESHOLD` 的对，`<对>: <sqlite ref> vs <postgresql ref>`，按路径字典序。
 * 这是「先合谁」的排序依据：倒挂越深，合一时撞出行为差异的概率越大（D19b 实证）。
 */
export const INVERTED_PAIRS: readonly string[] = [
  // RFC-359 W11：18 vs 3 → 18 vs 4（PG 侧补了事务边界的双引擎判据）。仍在观察名单内。
  'modules/intent/infrastructure/IntentApplyOperations: 20 vs 5',
  'modules/task-execution/infrastructure/TaskExecutionRuntimeParticipants: 9 vs 5',
  'modules/task-execution/infrastructure/TaskRouteLaunchOperations: 2 vs 5',
  'platform/persistence/LogicalSource: 8 vs 5',
]

interface Side {
  readonly refs: number
  readonly drives: number
}

interface Scan {
  /** 扫到的 backend 源文件数——语料下限的分母（RFC-317 T13：扫空 = 假绿）。 */
  readonly sourceFiles: readonly string[]
  /** 扫到的测试文件数（不含 `architecture/`）——同上。 */
  readonly testFiles: readonly string[]
  /** 全树 provider 命名的实现文件数——判据「还咬得动」的证据（账本清空后仍非零）。 */
  readonly providerNamed: number
  /** `<对>: sqlite <ref>/<drive>, postgresql <ref>/<drive>`，字典序。 */
  readonly rows: readonly string[]
  /** ref 差 >= 阈值的对，字典序。 */
  readonly inverted: readonly string[]
}

function listTypescript(base: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(base, dir), { withFileTypes: true })) {
      const rel = dir === '' ? entry.name : `${dir}/${entry.name}`
      if (entry.isDirectory()) walk(rel)
      else if (entry.name.endsWith('.ts')) out.push(rel)
    }
  }
  walk('')
  return out
}

/** 顶层导出的具名符号。needle 用它而非「首字母大写的模块名」，才能咬到 `openSqliteLogicalSource` 这种。 */
const EXPORTED_SYMBOL =
  /^export\s+(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:class|function|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm

const IDENTIFIER_CHAR = /[A-Za-z0-9_$]/

/**
 * 按**标识符边界**匹配：`sqliteTaskExecutionRecovery` 不得被
 * `sqliteTaskExecutionRecoveryPersistence`（另一个模块）满足，否则一侧会被邻居的引用虚抬。
 */
export function mentionsIdentifier(text: string, needle: string): boolean {
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
    const before = at > 0 ? (text[at - 1] ?? '') : ''
    const after = at + needle.length < text.length ? (text[at + needle.length] ?? '') : ''
    if (!IDENTIFIER_CHAR.test(before) && !IDENTIFIER_CHAR.test(after)) return true
  }
  return false
}

/** `import type` 不算 drive——只借类型不构造实现，跑不到任何一行。 */
const VALUE_IMPORT =
  /(?:^|\n)\s*import\s+(?!type\s)[\s\S]{0,600}?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)|\brequire\(\s*['"]([^'"]+)['"]\s*\)/g

/** 把一个测试文件里的值 import 解析成 `src` 相对路径集合（解析不到 `src` 的一律丢弃）。 */
function valueImportsOfTest(rel: string, text: string): Set<string> {
  const from = join(TESTS, rel)
  const out = new Set<string>()
  VALUE_IMPORT.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = VALUE_IMPORT.exec(text)) !== null) {
    const specifier = match[1] ?? match[2] ?? match[3] ?? match[4]
    if (specifier === undefined) continue
    let base: string
    if (specifier.startsWith('@/')) base = join(SRC, specifier.slice(2))
    else if (specifier.startsWith('.')) base = normalize(join(dirname(from), specifier))
    else continue
    for (const candidate of [`${base}.ts`, join(base, 'index.ts'), base]) {
      if (candidate.endsWith('.ts') && existsSync(candidate)) {
        out.add(candidate.slice(SRC.length + 1))
        break
      }
    }
  }
  return out
}

let cached: Scan | undefined

/** 两棵树各读一遍，五个用例共用（全树扫描必须缓存，否则 CI 上按秒累加）。 */
function scan(): Scan {
  if (cached !== undefined) return cached

  const sourceFiles = listTypescript(SRC)
  // `architecture/` 整体排除：守卫的账本按路径点名 provider 文件，却一行都不驱动它们
  // ——把它们计进来会给每一侧均匀加一份噪声，还会让本文件扫到自己。
  const testFiles = listTypescript(TESTS).filter((rel) => !rel.startsWith('architecture/'))

  const pairs = new Map<string, { sqlite?: string; postgresql?: string }>()
  let providerNamed = 0
  for (const rel of sourceFiles) {
    const cut = rel.lastIndexOf('/')
    const directory = cut < 0 ? '' : rel.slice(0, cut)
    const base = rel.slice(cut + 1).replace(/\.ts$/, '')
    const prefix = PROVIDER_PREFIX.exec(base)?.[1]
    if (prefix === undefined) continue
    providerNamed += 1
    const key = `${directory}/${base.slice(prefix.length)}`
    const slot = pairs.get(key) ?? {}
    slot[prefix === 'sqlite' ? 'sqlite' : 'postgresql'] = rel
    pairs.set(key, slot)
  }

  const texts = new Map<string, string>()
  const imports = new Map<string, Set<string>>()
  for (const rel of testFiles) {
    const text = readFileSync(join(TESTS, rel), 'utf8')
    texts.set(rel, text)
    imports.set(rel, valueImportsOfTest(rel, text))
  }

  const measure = (implementation: string): Side => {
    const base = implementation.slice(implementation.lastIndexOf('/') + 1).replace(/\.ts$/, '')
    const needles = new Set<string>([base])
    for (const symbol of readFileSync(join(SRC, implementation), 'utf8').matchAll(
      EXPORTED_SYMBOL,
    )) {
      const name = symbol[1]
      if (name !== undefined) needles.add(name)
    }
    const all = [...needles]
    let refs = 0
    let drives = 0
    for (const rel of testFiles) {
      if (all.some((needle) => mentionsIdentifier(texts.get(rel) ?? '', needle))) refs += 1
      if (imports.get(rel)?.has(implementation) === true) drives += 1
    }
    return { refs, drives }
  }

  const rows: string[] = []
  const inverted: string[] = []
  for (const [key, slot] of [...pairs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (slot.sqlite === undefined || slot.postgresql === undefined) continue
    const sqlite = measure(slot.sqlite)
    const postgresql = measure(slot.postgresql)
    rows.push(
      `${key}: sqlite ${sqlite.refs}/${sqlite.drives}, postgresql ${postgresql.refs}/${postgresql.drives}`,
    )
    if (Math.abs(sqlite.refs - postgresql.refs) >= REFERENCE_GAP_THRESHOLD) {
      inverted.push(`${key}: ${sqlite.refs} vs ${postgresql.refs}`)
    }
  }

  cached = {
    sourceFiles,
    testFiles,
    providerNamed,
    rows,
    inverted,
  }
  return cached
}

describe('RFC-359 W5-T19d —— 成对适配器的覆盖对等（高水位，只降不升）', () => {
  test('语料非空：两棵树都扫到了，且 provider 命名匹配器仍咬得动（扫空 / 不咬 = 假绿）', () => {
    expect(
      scan().sourceFiles.length,
      '扫到的 backend 源文件太少——扫描根多半失效了，此刻这条守卫零预言力。',
    ).toBeGreaterThanOrEqual(1_500)
    expect(
      scan().testFiles.length,
      '扫到的 backend 测试文件太少——扫描根多半失效了，两个通道都会一起归零。',
    ).toBeGreaterThanOrEqual(1_500)
    expect(
      scan().providerNamed,
      '全树一个 provider 命名的实现文件都没扫到——前缀匹配器已经不咬人了。' +
        '账本清空后这条守卫会变成永久假绿，先修匹配器再说。',
    ).toBeGreaterThanOrEqual(40)
  }, 30_000)

  test('客户端机制对仍被识别（配对判据失效不能让账本静默变空）', () => {
    expect(
      scan().rows.some((row) => row.startsWith('platform/persistence/LogicalSource:')),
      '两侧已登记的 LogicalSource 客户端机制没有配上，先检查扫描根与前缀匹配器。',
      // RFC-359 W12：自动修复合一使 10 → 9。固定债务下限会阻止真实收敛，改用必须保留的
      // 客户端机制对作正向锚点；整树语料地板与精确账本继续独立生效。
    ).toBe(true)
  }, 30_000)

  test('逐对的两侧引用 / 驱动数与账本逐字相等（倒挂加深了红，收敛了也红）', () => {
    expect(
      [...scan().rows],
      '成对适配器的覆盖对等与账本不符。口径见文件头：`ref` = 提到该侧模块名或导出符号的测试文件数' +
        '（同 `scripts/tests-referencing.sh`），`drive` = 有值 import 能真正构造它的测试文件数' +
        '（源码形状锁记 0）。' +
        '**倒挂加深**（一侧涨 / 另一侧跌）说明又在给已经被盯着的那一侧加判据——那一侧越强，' +
        '另一侧就越是在无人看管地漂移，正是 dual-provider-parity-audit-2026-09-04 里 12 条 P0 的孵化方式；' +
        '优先把判据写成 `describeEachProvider`，让一条测试同时喂到两侧。' +
        '**倒挂收敛**（补齐了弱侧、或两侧合一了）也要改账本，让这次补齐留下一次有署名的提交记录。',
    ).toEqual([...COVERAGE_PARITY_LEDGER])
  }, 30_000)

  test(`两侧引用差 >= ${String(REFERENCE_GAP_THRESHOLD)} 的对与观察名单逐字相等（新的深度倒挂即红）`, () => {
    expect(
      [...scan().inverted],
      `两侧引用差 >= ${String(REFERENCE_GAP_THRESHOLD)} 的对与观察名单不符。` +
        '**多**了一对说明有个 port 的两侧注意力刚刚拉开到阈值以上——这是「先合谁」的信号，' +
        '不是记账问题：弱侧此刻正在无人看管地漂移。' +
        '**少**了一对说明补齐或合一发生了，把它从名单里删掉。',
    ).toEqual([...INVERTED_PAIRS])
  }, 30_000)

  test('两份账本都按路径字典序、无重复（清点稳定的前提）', () => {
    for (const [name, ledger] of [
      ['COVERAGE_PARITY_LEDGER', COVERAGE_PARITY_LEDGER],
      ['INVERTED_PAIRS', INVERTED_PAIRS],
    ] as const) {
      const paths = ledger.map((row) => row.slice(0, row.indexOf(': ')))
      expect(new Set(paths).size, `${name} 里有重复的对`).toBe(paths.length)
      expect([...paths].sort(), `${name} 没有按路径字典序排列`).toEqual(paths)
    }
  }, 30_000)

  test('标识符边界匹配的负 fixture：邻居模块的引用不得被算到本模块头上', () => {
    // 真语料之外的独立证明——匹配器一旦被放宽成裸 `includes`，这条当场红。
    expect(
      mentionsIdentifier("from '@/x/sqliteTaskExecutionRecovery'", 'sqliteTaskExecutionRecovery'),
    ).toBe(true)
    expect(
      mentionsIdentifier(
        "from '@/x/sqliteTaskExecutionRecoveryPersistence'",
        'sqliteTaskExecutionRecovery',
      ),
      '邻居模块 `…RecoveryPersistence` 的引用被算成了 `…Recovery` 的——一侧会被虚抬，倒挂就此测不准。',
    ).toBe(false)
    expect(mentionsIdentifier('new SqliteRealtimeStore(db)', 'SqliteRealtimeStore')).toBe(true)
    expect(mentionsIdentifier('legacySqliteRealtimeStore', 'SqliteRealtimeStore')).toBe(false)
  }, 30_000)
})

// RFC-359 W5 —— 成对 provider 适配器的「合一进度 + 对拍覆盖」账本（两个量各自只降不升）。
//
// 这条账本回答的问题：**还剩多少个真分叉，其中哪些连对拍都没有**
// ==============================================================
// 「一件事落成两份实现」是 RFC-359 要消灭的形态：`sqliteX.ts` 与 `postgresqlX.ts` 同住一个目录、
// 去掉引擎前缀后同名——它们服务同一个端口，却是两台机器。**成对共存的对数**是「还剩多少分叉」
// 最直接的度量，也是 RFC-359 汇报进度该用的数：今天 26 对。
//
// 与既有两条守卫的分工（三条量的是三件不同的事，别互相替代）
// ----------------------------------------------------------
//   - `rfc359-w5-t17-provider-file-location.test.ts` —— 清点「`platform/persistence/` 之外的
//     **provider 命名文件数**」（136）。那个数**回答不了「还剩多少对」**：136 里混着大量
//     **没有孪生兄弟的独苗**（只有 SQLite 版、或只有 PG 版），它们是落位债，不是分叉债。
//     反过来 T17 也看不见本账本里的 `platform/persistence/LogicalSource` / `LogicalTarget`
//     两对——那两对住在 T17 认可的「家」里，落位合法，分叉却照样存在。
//   - `rfc359-w5-t19d-coverage-parity.test.ts` —— 清点每一对**两侧各自的** ref / drive **计数**，
//     量的是「注意力倒挂」（一侧 16 个套件、另一侧 2 个）。它算的是**每侧分别**有多少测试，
//     两侧都很高也完全可能**一条跨引擎对拍都没有**：`platform/events/committed/Persistence`
//     在 T19d 里是 `sqlite 6/6, postgresql 4/2`，看着很均衡，本账本里却是 `unverified`。
//   - **本条** —— 只两个量：**对数**（26）与其中**没有双引擎对拍的对数**（25）。
//
// 状态位：这一对有没有「同一批断言在两个引擎上各跑一遍」的测试
// ------------------------------------------------------------
// 判据（纯语法，逐条可复跑）：存在一个 `packages/backend/tests/` 下的测试文件，同时满足
//   ① 它 **import 了 `describeEachProvider` 这个绑定**（`tests/helpers/eachProvider.ts`）**并调用它**
//      ——该 harness 把同一段 body 在 SQLite 内存库与真 PostgreSQL 上各注册一遍；
//   ② 它对这一对的**两侧模块各有一条值 import**（`import type` 不算——只借类型跑不到任何一行）。
// ②要求「两侧都有」不是苛刻，是这个 harness 的形状决定的：`describeEachProvider` **有意不把
// provider 名交给 body**，所以一份真的对拍测试只能把两侧都 import 进来、再按
// `harness.capabilities.isolation` 分派（`rfc359-w4-d28a-task-ownership-conformance.test.ts`
// 就是这个形状）。反过来，一个只 import 单侧的双引擎块，等于拿同一份实现去跑两个引擎——
// 它证明不了这一对的任何事。满足即 `verified by <见证测试>`，否则 `unverified`。
//
// 为什么这个状态位是关键：**「没合一」与「连对拍都没有」是两种严重程度不同的债**
// ------------------------------------------------------------------------------
// 本轮 26 对的只读对账反复查出同一形态——PG 那份长期**零行为覆盖**，于是悄悄比 SQLite 弱
// （漏引用完整性复核、漏幂等回放、漏状态校验），直到合一那一刻才第一次被看见。两个实例：
//   - **技能目录三对**：合一前覆盖是 **52 : 6** 的倒挂（SQLite / legacy 侧 52 个套件，PG 侧 6 个，
//     且那 6 个多为源码形状锁）。合一时（W4-D23a）一跑就照出「PG 侧整条略过引用完整性复核」。
//   - **`rfc328-durable-ownership.test.ts`**：1495 行的耐久归属正确性矩阵，**全部只跑 SQLite**；
//     PG 侧那 444 行 owner CAS / 租约 / 撤销 / 恢复逻辑当时零行为覆盖。这一对后来正是靠
//     `rfc359-w4-d28a-task-ownership-conformance.test.ts` 补上对拍，成了今天账本里**唯一**的
//     `verified`——它同时证明了这条路走得通：**合一之前先补对拍**，用实测差异代替纸面对账。
// 所以排合一优先级时，`unverified` 的那些不是「等着合就行」，而是**合一时最可能炸出行为差**的那些。
//
// 棘轮（RFC-317 T17 机制，两个量各自钉死）
// ----------------------------------------
//   - **对数只降不升**：新增一对红——要么写成中立端口 + 单份实现，要么把新增写进账本并说明；
//     合一掉一对也红——把账本一起改小，让每一次销账留下一次有署名的提交记录。
//   - **`unverified` 数只降不升**：补上一份对拍红（把那一行改成 `verified by …`）；
//     把一份对拍删掉 / 改成单引擎，`unverified` 会涨——同样红，且红在正确的地方。
//   两个量都在下面用独立断言显式钉死，不只靠账本逐字相等兜——数字自己也要在源码里看得见。
//
// 判据的已知误判面（读这份账本前必须知道）
// ----------------------------------------
//   - **假阴性 · 组合根分派**：若一份对拍测试从 `composition/` 工厂取适配器、而那个工厂在内部
//     按 provider 分派，测试文件里不会出现任何一侧的模块名，这一对会被记成 `unverified`。
//     这是**有意接受**的偏斜：T19d 已经量过，把判据放宽成「静态可达」会让两侧同时可达
//     （`TaskOwnershipPersistence` 两侧各 832），信号被彻底抹平。宁可低估，不要抹平。
//   - **假阴性 · 非 harness 的对拍**：`rfc349-dual-provider-behavior-oracle.test.ts` 确实在一份
//     transcript 里同时驱动了 `ResourcePackageMaintenance` 与 `platform/events/committed/Persistence`
//     的两侧，但它跑的是**脚本化的 SQL runtime**、不是真 PostgreSQL，也不走 `describeEachProvider`。
//     这两对仍记 `unverified`：脚本 mock 照不出方言 / 语义漂移，而漂移正是本账本要防的东西。
//   - **假阳性 · 只 import 不驱动**：一个双引擎测试可能把两侧都值 import 进来却只断言某个纯函数。
//     `import type` 已被排除，残余风险小；今天唯一的 `verified` 是一份真正的行为矩阵。
//   - **同目录才算一对**：判据要求两侧同目录。W55 前 `db/sqliteMigrator.ts` 与
//     `platform/persistence/postgresqlMigrator.ts` 因跨目录未计入；W55 将前者全文逐字移入
//     后者目录后首次识别，须补录而不排除。这条同目录定义保持不变，可机械复算。

import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, normalize, resolve } from 'node:path'

const SRC = resolve(import.meta.dir, '..', '..', 'src')
const TESTS = resolve(import.meta.dir, '..')

/** 两棵树各读一遍（~3700 个文件）；给足余量的显式超时，别让慢 runner 变成 flaky。 */
const TIMEOUT_MS = 120_000

/**
 * 「我只服务一个引擎」的自述式文件名前缀。
 *
 * `(?=[A-Z])` 是必须的：没有它，`sqlite.ts` / `postgresql.ts` 这种**中立命名的目录入口**
 * 会被当成前缀匹配，凭空造出 stem 为空的「对」。含 `legacy*` 两支是为将来——今天没有
 * `legacySqliteX` 与 `postgresqlX` 同目录同名的组合，但那同样是一处分叉，判据不该看不见它。
 */
const PROVIDER_PREFIX = /^(legacySqlite|legacyPostgresql|sqlite|postgresql)(?=[A-Z])/

/** 双引擎 harness 的绑定必须是 import 进来的（注释里提一嘴、字符串里写一遍都不算）。 */
const HARNESS_BINDING = /import\s*\{[^}]*\bdescribeEachProvider\b[^}]*\}\s*from/

/** 且真的被调用——只 import 不用，等于没有对拍。 */
const HARNESS_CALL = /\bdescribeEachProvider\s*\(/

/**
 * 值 import（口径与 `rfc359-w5-t19d-coverage-parity.test.ts` 的 `drive` 通道一致）。
 * `import type …` 被 `(?!type\s)` 排除：只借类型不构造实现，跑不到任何一行。
 */
const VALUE_IMPORT =
  /(?:^|\n)\s*import\s+(?!type\s)[\s\S]{0,600}?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g

/**
 * `<目录>/<去掉引擎前缀的名字>: <sqlite 侧前缀> + <postgresql 侧前缀> — <状态位>`，按 pair 路径字典序。
 *
 * 状态位 `verified by <测试>` = 存在同时满足上面①②的双引擎对拍测试；`unverified` = 没有。
 * **对数只降不升，`unverified` 数也只降不升**（两个量在下面各有一条独立断言钉死）。
 */
export const PROVIDER_PAIR_CONFORMANCE_LEDGER: readonly string[] = [
  'modules/intent/infrastructure/IntentApplyArtifactLifecycle: sqlite + postgresql — verified by rfc359-w7-intent-apply-artifact-conformance.test.ts',
  'modules/intent/infrastructure/IntentApplyOperations: sqlite + postgresql — verified by rfc359-w7-intent-apply-operations-conformance.test.ts',
  // RFC-359 W8：判**不合**——`ArtifactRecovery` 那半边是两套落盘工件格式（缺口已由
  // `rfc359-w5-artifact-format-portability.test.ts` 的 12 格矩阵钉住），`JournalPort` 那半边的
  // 事务包装也不是冗余（SQLite 的 `dbTxSync` 兜着跨上下文事务守卫）。只补对拍，理由见对拍文件头。
  // RFC-359 W9：这一对多了第二份双引擎对拍——W8 那份问的是「哪些 journal 行会被收、收完账面
  // 什么样」，W9 这份问的是门后的**落盘结果**：崩溃到收敛之间账面代际变了（用户又发了一版 /
  // 删了技能 / 库更旧），live 目录里最后是哪一代内容。判据缺口 13b 就是被它照出来并销掉的。
  'modules/resource-catalog/infrastructure/ResourcePackageMaintenance: sqlite + postgresql — verified by rfc359-w8-resource-package-maintenance-conformance.test.ts, rfc359-w9-resource-package-skill-recovery-conformance.test.ts',
  'modules/task-execution/infrastructure/ChildExecutionLaunchOperations: sqlite + postgresql — verified by rfc359-w8-child-launch-conformance.test.ts',
  // RFC-359 W12：共同流程和每目标事务 atom 已合一，两个 applyOne 副本退役。
  // 留下两侧既有的提交后事件/停止位置与 SQLite 无 driver 收尾机制，真实对拍继续锁定。
  'modules/task-execution/infrastructure/SourceTerminationParticipant: sqlite + postgresql — verified by rfc359-w12-source-termination-atom.test.ts, rfc359-w8-source-termination-conformance.test.ts',
  // RFC-359 W8：判**不合**（两台 children 引擎 + 两个 registry，见对拍文件头注释），只补对拍。
  'modules/task-execution/infrastructure/TaskExecutionRuntimeParticipants: sqlite + postgresql — verified by rfc359-w8-runtime-participants-conformance.test.ts',
  // RFC-359 W12：TaskLifecycleAutoRepairCommand 已合为中立循环；PG 自动修复借用人工修复的
  // 原选项/前置检查/执行引擎，第三份 S4 算法同时删除。W8 对拍继续锁用户可见结果与副作用。
  'modules/task-execution/infrastructure/TaskRouteLaunchOperations: sqlite + postgresql — verified by rfc359-w7-task-route-conformance.test.ts',
  // RFC-359 W8：这一对多了第二份双引擎对拍——W7 只驱动到各方法的**前置门**为止，W8 补的是
  // 门后的语义（retry 的三道前置门 / sync 的 canceled 回滚 / delete 的父链排序列重算）。
  'modules/task-execution/infrastructure/TaskRouteOperations: sqlite + postgresql — verified by rfc359-w7-task-route-conformance.test.ts, rfc359-w8-task-route-capability-parity.test.ts',
  // RFC-359 W8：判**读出 / 编码面该合、冻结围栏面不该合**（两侧都是活的生产代码，逐条见对拍
  // 文件头）。本刀只补对拍并把两条实测差异按强侧抬齐（SQLite 关闭后的裸驱动错误、PG 的引用式
  // 快照判等）；围栏本身是文件代号 vs 活跃生成代两台机器，作为能力差异留在账本里。
  'platform/persistence/LogicalSource: sqlite + postgresql — verified by rfc359-w8-logical-source-conformance.test.ts',
  // RFC-359 W8：仍记 unverified，**理由已查清并落档**，不是「还没做」。
  // 本守卫认的见证是机械的：`describeEachProvider` + **两侧实现各有一条值 import**
  // （`witnessesPair`）——即对拍必须真的驱动两个实现，不能只观察它们的结果。
  // 对迁移器，「驱动 PG 侧」意味着再跑一次 `migratePostgresqlSchema`，而它的 schema 名
  // （`agent_workflow`）是写死的：在测试里重跑会打到 harness 共用的那个 schema 上，
  // 破坏同集群其他测试文件的库（PG 的 advisory lock 还是集群级的，见 docs/dev-gotchas.md）。
  // 换句话说，缺的不是意愿，是**迁移器暂时不支持在隔离 schema 上被驱动**。
  //
  // 与此同时，AC-1 判据要的「用户可见契约那一层」已经有了：
  // `tests/rfc359-w8-migrator-conformance.test.ts`（双引擎）拿
  // `buildLogicalSchemaContract()` 的花名册去问**活库**——每张声明的表、每一列都取一遍，
  // 两个引擎逐字相同。它锁住了迁移器对应用的全部承诺（「跑完之后库真的实现了这份 schema」），
  // 只是不满足本守卫的机械判据，所以状态位不动。放宽 `witnessesPair` 去迁就它是错的：
  // 那条判据挡的正是「拿一个不驱动实现的测试冒充对拍」。
  'platform/persistence/Migrator: sqlite + postgresql — unverified',
]

/** 还成对共存的 provider 适配器对数。**只降不升**——降到 0 就是 RFC-359 的合一完工线。 */
export const PROVIDER_PAIR_COUNT = 10

/** 其中「连一份双引擎对拍都没有」的对数。**只降不升**——补一份对拍就减一。 */
export const UNVERIFIED_PAIR_COUNT = 1

// ---------------------------------------------------------------------------
// 判据本体：纯函数（输入是路径 / 测试事实，不碰文件系统），供真实树与内存 fixture 共用
// ---------------------------------------------------------------------------

export type ProviderSide = 'sqlite' | 'postgresql'

export interface ProviderPair {
  /** `<目录>/<去掉引擎前缀的名字>` —— 一对的身份。 */
  readonly key: string
  /** 该侧的 `src` 相对路径，字典序。 */
  readonly sqlite: readonly string[]
  readonly postgresql: readonly string[]
  /** 该侧实际用到的前缀（`sqlite` / `legacySqlite` / 两者），字典序，用于账本行的可读形态。 */
  readonly sqlitePrefixes: readonly string[]
  readonly postgresqlPrefixes: readonly string[]
}

/** 一个测试文件的两个事实：跑不跑双引擎 harness，以及它**值** import 了哪些 `src` 文件。 */
export interface TestUnit {
  /** `packages/backend/tests/` 相对路径。 */
  readonly path: string
  readonly dualEngine: boolean
  /** `src` 相对路径集合。 */
  readonly imports: ReadonlySet<string>
}

interface ProviderFile {
  readonly path: string
  readonly key: string
  readonly side: ProviderSide
  readonly prefix: string
}

function classify(path: string): ProviderFile | null {
  const slash = path.lastIndexOf('/')
  const directory = slash < 0 ? '' : path.slice(0, slash)
  const base = path.slice(slash + 1)
  if (!base.endsWith('.ts')) return null
  const stem = base.slice(0, -'.ts'.length)
  const matched = PROVIDER_PREFIX.exec(stem)
  if (matched === null) return null
  const prefix = matched[1] ?? ''
  return {
    path,
    key: `${directory}/${stem.slice(prefix.length)}`,
    side: prefix.toLowerCase().includes('postgresql') ? 'postgresql' : 'sqlite',
    prefix,
  }
}

/**
 * 同目录、去掉引擎前缀后同名、且两侧都在的那些——「真分叉」。
 *
 * 独苗（只有一侧）**不算一对**：它可能是某个引擎特有的设施，也可能是还没写第二份，
 * 两者都不是「两份实现会漂」这个问题。那类落位债由 T17 的账本负责。
 */
export function providerPairs(sourcePaths: readonly string[]): ProviderPair[] {
  const grouped = new Map<string, ProviderFile[]>()
  for (const path of sourcePaths) {
    const file = classify(path)
    if (file === null) continue
    const bucket = grouped.get(file.key)
    if (bucket === undefined) grouped.set(file.key, [file])
    else bucket.push(file)
  }
  const pairs: ProviderPair[] = []
  for (const [key, files] of grouped) {
    const sqlite = files.filter((file) => file.side === 'sqlite')
    const postgresql = files.filter((file) => file.side === 'postgresql')
    if (sqlite.length === 0 || postgresql.length === 0) continue
    pairs.push({
      key,
      sqlite: sqlite.map((file) => file.path).sort(),
      postgresql: postgresql.map((file) => file.path).sort(),
      sqlitePrefixes: [...new Set(sqlite.map((file) => file.prefix))].sort(),
      postgresqlPrefixes: [...new Set(postgresql.map((file) => file.prefix))].sort(),
    })
  }
  return pairs.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
}

/** 这份测试能不能算这一对的双引擎对拍见证：跑 harness + 两侧各有一条值 import。 */
export function witnessesPair(unit: TestUnit, pair: ProviderPair): boolean {
  if (!unit.dualEngine) return false
  return (
    pair.sqlite.some((path) => unit.imports.has(path)) &&
    pair.postgresql.some((path) => unit.imports.has(path))
  )
}

/** 账本行：`<对>: <sqlite 前缀> + <postgresql 前缀> — <状态位>`，按对的路径字典序。 */
export function conformanceRows(
  sourcePaths: readonly string[],
  tests: readonly TestUnit[],
): string[] {
  return providerPairs(sourcePaths).map((pair) => {
    const witnesses = tests
      .filter((unit) => witnessesPair(unit, pair))
      .map((unit) => unit.path)
      .sort()
    const shape = `${pair.sqlitePrefixes.join('/')} + ${pair.postgresqlPrefixes.join('/')}`
    const status = witnesses.length === 0 ? 'unverified' : `verified by ${witnesses.join(', ')}`
    return `${pair.key}: ${shape} — ${status}`
  })
}

/** 账本行是不是「还没有对拍」那一档——两个量各自钉死时要数它。 */
export function isUnverifiedRow(row: string): boolean {
  return row.endsWith('— unverified')
}

// ---------------------------------------------------------------------------
// 真实树采数（模块级 const：一次读盘，全部用例共用；也是语料下限的来源）
// ---------------------------------------------------------------------------

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

/** `packages/backend/src` 下全部 `.ts`（相对 `src`）。语料下限的分母之一。 */
const SOURCE_FILES: readonly string[] = listTypescript(SRC)

/** `packages/backend/tests` 下全部 `.ts`（相对 `tests`）。语料下限的分母之二。 */
const TEST_FILES: readonly string[] = listTypescript(TESTS)

/** 把一条 import specifier 解析成 `src` 相对路径；解析不到 `src` 里的一律丢弃。 */
function resolveIntoSrc(fromTest: string, specifier: string): string | null {
  let base: string
  if (specifier.startsWith('@/')) base = join(SRC, specifier.slice(2))
  else if (specifier.startsWith('.'))
    base = normalize(join(dirname(join(TESTS, fromTest)), specifier))
  else return null
  for (const candidate of [`${base}.ts`, join(base, 'index.ts'), base]) {
    if (!candidate.endsWith('.ts')) continue
    if (!candidate.startsWith(`${SRC}/`)) continue
    if (existsSync(candidate)) return candidate.slice(SRC.length + 1)
  }
  return null
}

function readTestUnits(paths: readonly string[]): TestUnit[] {
  return paths.map((rel) => {
    const text = readFileSync(join(TESTS, rel), 'utf8')
    const imports = new Set<string>()
    VALUE_IMPORT.lastIndex = 0
    let matched: RegExpExecArray | null
    while ((matched = VALUE_IMPORT.exec(text)) !== null) {
      const specifier = matched[1] ?? matched[2] ?? matched[3]
      if (specifier === undefined) continue
      const resolved = resolveIntoSrc(rel, specifier)
      if (resolved !== null) imports.add(resolved)
    }
    return {
      path: rel,
      dualEngine: HARNESS_BINDING.test(text) && HARNESS_CALL.test(text),
      imports,
    }
  })
}

const TEST_UNITS: readonly TestUnit[] = readTestUnits(TEST_FILES)

/** 真的跑双引擎 harness 的测试文件——判据「还咬得动」的活体证据。 */
const DUAL_ENGINE_TESTS: readonly TestUnit[] = TEST_UNITS.filter((unit) => unit.dualEngine)

/** 全树 provider 命名的实现文件——账本清空后它仍非零，前缀匹配器塌了会立刻被看见。 */
const PROVIDER_NAMED_SOURCES: readonly string[] = SOURCE_FILES.filter(
  (path) => classify(path) !== null,
)

const SCANNED_ROWS: readonly string[] = conformanceRows(SOURCE_FILES, TEST_UNITS)

describe('RFC-359 W5 —— 成对 provider 适配器：合一进度 + 对拍覆盖', () => {
  test(
    '语料非空：两棵树都扫到了，前缀匹配器与 harness 判据都还咬得动（扫空 = 假绿）',
    () => {
      expect(
        SOURCE_FILES.length,
        '扫到的 backend 源文件太少——扫描根多半失效了，此刻这条守卫零预言力。',
      ).toBeGreaterThanOrEqual(1500)
      expect(
        TEST_FILES.length,
        '扫到的 backend 测试文件太少——扫描根多半失效了，状态位会整列塌成 unverified。',
      ).toBeGreaterThanOrEqual(1500)
      // 业务文件会随合一持续减少，不能拿债务数充当语料分母。上面锁完整源码树，
      // 这里以始终存在的驱动本体证明前缀匹配器仍能识别真实文件。
      expect(PROVIDER_NAMED_SOURCES).toContain('platform/persistence/postgresqlDatabaseClient.ts')
      expect(
        DUAL_ENGINE_TESTS.length,
        '一个跑 `describeEachProvider` 的测试都没认出来——harness 判据失效了；' +
          '此时全部状态位都会假装成 unverified，账本会以「大家都没对拍」的形态假红/假绿。',
      ).toBeGreaterThanOrEqual(40)
    },
    TIMEOUT_MS,
  )

  test(
    '每一对的路径 + 对拍状态位与账本逐字相等（增了是新分叉 / 掉了对拍，减了是收敛）',
    () => {
      expect(
        SCANNED_ROWS,
        '成对适配器的清单或对拍状态位与账本不符。' +
          '**多了一对**说明有人又把一件事写成了两份实现——改用中立端口 + 单份实现；' +
          '确有理由就把新增写进 `PROVIDER_PAIR_CONFORMANCE_LEDGER` 并说明为什么。' +
          '**少了一对**说明合一发生了——把账本一起改小，让这次销账留下一次有署名的提交记录。' +
          '**状态位从 unverified 变成 verified** 说明补上了双引擎对拍——同样改账本，' +
          '并把 `UNVERIFIED_PAIR_COUNT` 一起减一。' +
          '**状态位倒退回 unverified**（或见证测试改名 / 被删）是这条守卫最该拦下的事：' +
          '先确认那份对拍是不是被降级成了单引擎测试。',
      ).toEqual([...PROVIDER_PAIR_CONFORMANCE_LEDGER])
    },
    TIMEOUT_MS,
  )

  test(
    '两个量各自钉死：对数只降不升、unverified 数也只降不升',
    () => {
      expect(
        SCANNED_ROWS.length,
        `成对共存的 provider 适配器还剩 ${String(SCANNED_ROWS.length)} 对，账本记的是 ` +
          `${String(PROVIDER_PAIR_COUNT)}。这个数是 RFC-359 的合一进度，只降不升，降到 0 是完工线。`,
      ).toBe(PROVIDER_PAIR_COUNT)
      expect(
        SCANNED_ROWS.filter(isUnverifiedRow).length,
        `没有任何双引擎对拍的对还剩 ${String(SCANNED_ROWS.filter(isUnverifiedRow).length)} 对，` +
          `账本记的是 ${String(UNVERIFIED_PAIR_COUNT)}。这个数与对数各自独立：` +
          '「这对还没合一」和「这对连对拍都没有」是两种严重程度不同的债，' +
          '后者合一时最可能炸出行为差（技能三对 52:6 倒挂、rfc328 的 1495 行只跑 SQLite，都是这么漏过去的）。',
      ).toBe(UNVERIFIED_PAIR_COUNT)
    },
    TIMEOUT_MS,
  )

  test('账本按 pair 路径字典序、无重复，且两个计数常量与账本自洽（清点稳定的前提）', () => {
    const keys = PROVIDER_PAIR_CONFORMANCE_LEDGER.map((row) => row.slice(0, row.indexOf(':')))
    expect(new Set(keys).size, '账本里有重复的 pair').toBe(keys.length)
    expect([...keys].sort(), '账本没有按 pair 路径字典序排列').toEqual(keys)
    expect(PROVIDER_PAIR_CONFORMANCE_LEDGER.length, '`PROVIDER_PAIR_COUNT` 与账本行数对不上').toBe(
      PROVIDER_PAIR_COUNT,
    )
    expect(
      PROVIDER_PAIR_CONFORMANCE_LEDGER.filter(isUnverifiedRow).length,
      '`UNVERIFIED_PAIR_COUNT` 与账本里 unverified 的行数对不上',
    ).toBe(UNVERIFIED_PAIR_COUNT)
  })
})

// ---------------------------------------------------------------------------
// 自变异：判据自己必须有牙齿（RFC-317 T14 / T21 形态）
// ---------------------------------------------------------------------------
//
// 上面每条断言都建立在 `providerPairs` / `witnessesPair` / `conformanceRows` 之上。
// 这三个函数一旦判错，本守卫会用与「全部合规」完全相同的形态绿掉。fixture 一律**内存字面量**
// ——不落磁盘、不读真实树，也就不会被并发改动的工作树影响。

/** 伪造的一棵 `src`：一对真孪生 + 三种「长得像但不是一对」的诱饵。 */
const FIXTURE_SOURCES: readonly string[] = [
  'modules/demo/infrastructure/postgresqlFoo.ts',
  'modules/demo/infrastructure/sqliteFoo.ts',
  // 独苗：只有一侧 —— 是落位债（T17），不是分叉债
  'modules/demo/infrastructure/sqliteOnlyHere.ts',
  'modules/demo/infrastructure/postgresqlOnlyThere.ts',
  // 跨目录同名 —— 判据要求同目录，不成对
  'modules/other/infrastructure/postgresqlOnlyHere.ts',
  // 中立命名的目录入口 —— `(?=[A-Z])` 必须挡住，否则会造出 stem 为空的假对
  'platform/persistence/sqlite.ts',
  'platform/persistence/postgresql.ts',
  // 完全无关的中立实现
  'modules/demo/infrastructure/drizzleFoo.ts',
]

const FIXTURE_SQLITE = 'modules/demo/infrastructure/sqliteFoo.ts'
const FIXTURE_POSTGRESQL = 'modules/demo/infrastructure/postgresqlFoo.ts'

const FIXTURE_CONFORMANCE_TEST: TestUnit = {
  path: 'fixture-foo-conformance.test.ts',
  dualEngine: true,
  imports: new Set([FIXTURE_SQLITE, FIXTURE_POSTGRESQL]),
}

const FIXTURE_SINGLE_ENGINE_TEST: TestUnit = {
  path: 'fixture-foo-single-engine.test.ts',
  dualEngine: false,
  imports: new Set([FIXTURE_SQLITE, FIXTURE_POSTGRESQL]),
}

const FIXTURE_HALF_TEST: TestUnit = {
  path: 'fixture-foo-half.test.ts',
  dualEngine: true,
  imports: new Set([FIXTURE_SQLITE]),
}

describe('RFC-359 W5 —— 判据自变异（内存 fixture，不碰真实树）', () => {
  test('成对判据：同目录同名的两侧才算一对；独苗 / 跨目录 / 中立入口都不算', () => {
    expect(providerPairs(FIXTURE_SOURCES).map((pair) => pair.key)).toEqual([
      'modules/demo/infrastructure/Foo',
    ])
  })

  test('变异①：多伪造一对 sqliteBar / postgresqlBar，对数就多一 —— 真实树上等价于账本必红', () => {
    const mutated = [
      ...FIXTURE_SOURCES,
      'modules/demo/infrastructure/sqliteBar.ts',
      'modules/demo/infrastructure/postgresqlBar.ts',
    ]
    expect(providerPairs(mutated).map((pair) => pair.key)).toEqual([
      'modules/demo/infrastructure/Bar',
      'modules/demo/infrastructure/Foo',
    ])
  })

  test('变异②：给这一对补上双引擎对拍，状态位翻面、unverified 少一 —— 账本必须跟着改小', () => {
    const before = conformanceRows(FIXTURE_SOURCES, [])
    expect(before).toEqual(['modules/demo/infrastructure/Foo: sqlite + postgresql — unverified'])
    expect(before.filter(isUnverifiedRow).length).toBe(1)

    const after = conformanceRows(FIXTURE_SOURCES, [FIXTURE_CONFORMANCE_TEST])
    expect(after).toEqual([
      'modules/demo/infrastructure/Foo: sqlite + postgresql — verified by fixture-foo-conformance.test.ts',
    ])
    expect(after.filter(isUnverifiedRow).length).toBe(0)
  })

  test('状态位不被冒领：单引擎测试、以及只 import 半边的双引擎块，都不算对拍', () => {
    expect(witnessesPair(FIXTURE_CONFORMANCE_TEST, providerPairs(FIXTURE_SOURCES)[0]!)).toBe(true)
    expect(witnessesPair(FIXTURE_SINGLE_ENGINE_TEST, providerPairs(FIXTURE_SOURCES)[0]!)).toBe(
      false,
    )
    expect(witnessesPair(FIXTURE_HALF_TEST, providerPairs(FIXTURE_SOURCES)[0]!)).toBe(false)
    expect(
      conformanceRows(FIXTURE_SOURCES, [FIXTURE_SINGLE_ENGINE_TEST, FIXTURE_HALF_TEST]),
    ).toEqual(['modules/demo/infrastructure/Foo: sqlite + postgresql — unverified'])
  })

  test('legacy 前缀也成对：`legacySqliteX` 与 `postgresqlX` 同目录同名同样是一处分叉', () => {
    const legacy = [
      'modules/demo/infrastructure/legacySqliteBaz.ts',
      'modules/demo/infrastructure/postgresqlBaz.ts',
    ]
    expect(conformanceRows(legacy, [])).toEqual([
      'modules/demo/infrastructure/Baz: legacySqlite + postgresql — unverified',
    ])
  })

  test('harness 判据只认 import 进来的绑定 + 真调用（注释 / 字符串里提一嘴不算）', () => {
    const commentOnly = '// 以后改用 describeEachProvider(name, body)\ndescribe("x", () => {})\n'
    const stringOnly = "const hint = 'describeEachProvider('\n"
    const real =
      "import { describeEachProvider } from './helpers/eachProvider'\n" +
      "describeEachProvider('x', (harness) => {})\n"
    for (const text of [commentOnly, stringOnly]) {
      expect(HARNESS_BINDING.test(text) && HARNESS_CALL.test(text)).toBe(false)
    }
    expect(HARNESS_BINDING.test(real) && HARNESS_CALL.test(real)).toBe(true)
  })
})

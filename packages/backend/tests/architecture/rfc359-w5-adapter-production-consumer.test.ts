// RFC-359 W5 —— provider 适配器必须有**生产消费者**（高水位账本，只降不升）。
//
// # 这条守卫锁的是什么：死适配器伪装成 provider 对等
//
// RFC-359 的目标是「以后不允许再出现两种数据库一个好一个不好的分支」。W5-T17（provider 命名
// 文件只许住在 `platform/persistence/`）与 W5-T19（不许按 provider 名分叉）各堵一条**制造**
// 分叉的路，但它们都看不见本条要堵的这一种：**抽了 provider 面，却只接了一侧**。
//
// 形状是这样的：一个 port 落成 `createSqliteFoo` / `createPostgresqlFoo`（或
// `composeSqliteFoo` / `composePostgresqlFoo`）两个具名入口，看上去 provider 对等、两边都有；
// 实际上组合根只装配了其中一份，另一份**零生产调用方**，只剩 `composition.ts` 里
// `export { … } from …` 再导出一层，加上几个直接 import 它的测试。于是：
//   · **读代码的人被骗**——「两个 provider 都实现了」这个印象是假的，一侧根本不在跑；
//   · **测试也被骗**——测试直接 import 那份死实现并断言它的行为，绿得理直气壮，
//     可它证明的东西与生产上真正执行的那条路径**毫无关系**（对拍守卫也会把它当成对等的另一半）；
//   · **修复会漏**——真实能力在别处（下面账本每条都写清），修那里的人不会想到还有一份同名孪生
//     躺着，孪生于是永远停在写下它的那天，成为下一次「一个好一个不好」的种子。
// 本轮实测两条最典型：`createSqliteReviewRepairParticipant` / `createSqliteClarifyRepairParticipant`
// ——PG 那份在 `modules/task-execution/composition/providerRuntime.ts:370-371` 真装配了，SQLite 那份
// 生产零调用方；而 SQLite 侧同一件事的真实能力在
// `platform/persistence/sqlite/taskLifecycleRepair/options-{R1,C1}.ts`（经 `taskLifecycleRepair.ts:84/86` 注册）。
// 也就是说这不是「一个 port 两份实现」，是「一个 port 一份实现 + 一份摆设」。
//
// # 被判集合：动词表是实测出来的，不是拍的
//
// 判的是 `src` 下的**顶层导出声明**：
//   · **适配器工厂** —— 名字形如 `<构造动词>[形容词]<Provider>…`，构造动词表
//     = `create` / `compose` / `open` / `bind`；
//   · **适配器类** —— `class (Legacy)?(Sqlite|Postgresql)…`，`*Error` 除外
//     （错误类型是跨层传递的值，不是被装配的实现，「没人 new」是常态）。
//
// 动词表按全仓实测确定。把「所有 `<小写动词><Provider><大写>` 形态的导出函数」按动词分组后：
//   · `create` **118** 个 / 8 死、`compose` **94** 个 / 9 死 —— 两个真正的构造动词，占全部
//     provider 具名导出函数的绝大多数。`compose` 的 94 个命中里**零个**是「只有同文件消费者」的
//     内部助手，信噪比与 `create` 一样干净，没有理由只收其一：只看 `create` 的话，把一份死适配器
//     改名成 `composeXxx` 就绕过去了，而实测里 `compose` 侧的死法比 `create` 还多一个。
//   · `open` **4** 个 / 0 死 —— `open{Sqlite,Postgresql}Logical{Source,Target}` 一族，全在
//     `platform/persistence/`，每个都返回一个活的适配器句柄（开账时账本里的
//     `createSqliteLogicalTarget` 就是被 `openPostgresqlLogicalTarget` 顶掉的那份，W8 已删）。
//     人口小但语义纯粹、零噪音，收进来今天不加任何一条债，只是把改名逃逸的口堵上。
//   · `bind` **1** 个 / 0 死 —— 只有 `bindPostgresqlResourcePackageTransactionReader`，
//     把 port 绑到 transaction+actor 上返回实现，形状与 `createSqliteTaskAuthorizationParticipantInTx`
//     同类；它的唯一消费者在**同文件**（`postgresqlResourcePackageMutationParticipants.ts:1339`），
//     那是真装配、不是噪音（本判据把同文件装配算作消费，见下）。人口 1 但零噪音，同样收进来。
//   · 其余动词**一律不收**，因为它们不是「构造适配器」而是「对适配器做一件事」：
//     `commit`(6) / `is`(4) / `resolve`(4) / `run`(4) / `assert`(3) / `with`(3) / `verify`(3) /
//     `check`(2) / `retry`(2) / `render`(2) / `read`(2) / `canView`(2) / `canEdit`(2) /
//     `get`(2) / `find`(2)，以及 `migrate` / `compile` / `vacuum` / `checkpoint` / `lock` 等
//     各 1 个。它们「没有消费者」多半意味着别的事（谓词退役、诊断入口暂缺），把它们混进来只会
//     让账本从 18 条涨到 60+ 条不同性质的混合物，信号被噪音淹没。**宁可窄而准。**
//
// **形容词中缀**（`[A-Za-z]*?`）是必需的，不是宽松：实测 `createAuthorizedSqliteIntentPersistence`
// / `createAuthorizedPostgresqlIntentPersistence` / `openReadonlySqliteDatabase` 三个货真价实的
// 适配器工厂把品牌放在形容词后面，严格前缀会**整批漏掉**它们（它们今天都活着，所以漏掉不加债，
// 但那正是下一个人给死适配器改名的现成通路）。反过来，类名判据**保持严格前缀**：实测把类名也放宽
// 成允许中缀后，被判集合一个都没多——本仓没有品牌在中间的适配器类，放宽就是没有证据的扩张。
//
// # 什么算消费
//
// 该符号在 `src` 里出现在**值位置**——`createSqliteFoo(db)`、`new SqliteFoo()`，以及
// `input.createBackup ?? createPostgresqlProviderBackup` 这种把工厂当值注入的形状
// （`modules/system-operations/infrastructure/postgresqlAdminBackupCoordinator.ts:23` 就是它，
// 漏掉它会当场误报一条活着的适配器）。声明文件**自己**也算：
// `platform/persistence/databaseTransaction.ts:319-321` 的 `databaseSessionFor` 就在同文件里
// 按 provider 选实现，那是真装配。
//
// **不算消费的**：
//   · `export { X } from './x'` / `export * from './x'` —— 纯再导出转发。这正是两条实测死适配器
//     在 `modules/collaboration/composition.ts:11,13` 的全部「引用」，放过它这条守卫就等于没写；
//   · `import { X } from './x'` 的 import 绑定本身（真正的使用点会在别处被数到）；
//   · 类型位置（`typeof X`、`import type`）—— 拿一份死实现当类型模板不构成装配；
//   · 属性名 `obj.createSqliteFoo` 与字符串 `'createSqliteFoo'`。后者不是假设：开账当天
//     `composeSqliteResourceCatalogOverviewQuery` **唯一**的引用就是一条源码锁里的字符串
//     （`tests/rfc349-resource-catalog-provider-contributions.test.ts:28` 的 `toContain('…')`）
//     ——一条守卫按名字钉着一个没有任何调用方的函数。W8 销账时那条锁翻成了 `not.toContain`，
//     函数与字符串一起走；但判据必须继续把字符串排除在消费之外，否则下一个同形的就看不见了；
//   · **测试**。语料只有 `src`：「只有测试在调它」正是本守卫要报的那种死法。
//
// 判据用 AST 不用正则，是本仓写死的教训（`docs/dev-gotchas.md`）：判「某名字有没有被调用」
// 只能用 AST——正则分不清调用与再导出、分不清值位置与类型位置、也分不清注释与代码。
//
// # 账本的两种性质：`改指` 与 `纯死代码`
//
// 18 条债不是同一回事，处置也不同，所以每条理由**必须**以两个标记之一开头（有测试钉住）：
//   · `改指：` —— 这件事在生产上**确实有人在干**，只是走了别的路；本条是过时孪生。
//     处置是把还引用它的测试 / 源码锁改指真实那份，再删。
//   · `纯死代码：` —— 全仓（含测试）**零引用**，没有任何东西依赖它。处置是直接删。
//     开账当天 8 条属于这一类，其中 `server.ts::composeSqliteProviderAppDeps` 与
//     `modules/collaboration/infrastructure/postgresqlReviewMutationScope.ts::PostgresqlReviewMutationScopeResolver`
//     连一行测试都没有——它们已经不是「抽象层错位」，是纯死代码（这两条至今仍在账本里，
//     原因写在各自条目里：删它们要动的文件当时被并发改动持有）。
//
// # 为什么是高水位而不是 0
//
// 开账当天实测 242 个 provider 适配器声明里有 **18 个**零生产消费者（随后随本波新写的
// W7 组合根测试涨到 19 条：那些测试直接 import 了几份死适配器，恰好证明「只有测试在调它」
// 就是本守卫要报的死法）。此刻钉 0 会让守卫从落地第一天就红、等于没有防守能力。
// 所以按 RFC-317 T17 的棘轮形态逐条登记，**只降不升**。
//
// RFC-359 W8 死代码清理批销掉 15 条，账本 19 → 4：删掉的 15 份适配器（含它们的装配点、
// 源码文本锁与级联死掉的中立包装）在 src 里已不存在，还引用它们的测试全部改指了生产在跑的那一份。
// 剩下的 4 条不是「删不动」而是「当时轮不到」——`modules/collaboration/**`、`server.ts`、
// 以及 `rfc359-w5-t17-provider-file-location.test.ts` 的账本当时都被并发改动持有，
// 逐条理由写在各自条目末尾。棘轮规则照旧：
//   · **增**了红 —— 又多了一份「看着对等、其实没接」的摆设；要么接上，要么删掉，
//     要么写进账本并说明它的真实能力在哪；
//   · **减**了也红 —— 收敛发生了；把账本一起改小，让每一次销账都留下一次有署名的提交记录。

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

import ts from 'typescript'

import { packageSrcUnits, sourceUnit, type SourceUnit } from './census'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')

/** 账本键与 fixture 路径共用的前缀：账本写相对 `src` 的路径，读起来才与仓内习惯一致。 */
const SRC_PREFIX = 'packages/backend/src/'

/**
 * 适配器**工厂**：`<构造动词>[形容词]<Provider><大写>`。
 *
 * 动词表与形容词中缀的实测依据见文件头；两者都刻意小而准，不做对称性扩张。
 */
const ADAPTER_FACTORY = /^(create|compose|open|bind)[A-Za-z]*?(Legacy)?(Sqlite|Postgresql)[A-Z]/

/**
 * 适配器**类**：品牌必须在开头。实测放宽成允许中缀后被判集合一个都没多，
 * 放宽就是没有证据的扩张。`*Error` 由调用方另行排除。
 */
const ADAPTER_CLASS = /^(Legacy)?(Sqlite|Postgresql)[A-Z]/

/** 账本理由的两种性质标记，见文件头「账本的两种性质」。 */
const DISPOSITION_MARKERS = ['改指：', '纯死代码：'] as const

export interface ProviderAdapterDeclaration {
  /** `<相对 src 的路径>::<符号>`，账本与报错都用它。 */
  readonly key: string
  readonly symbol: string
}

function isExported(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined
  return (modifiers ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
}

function relativeToSrc(path: string): string {
  return path.startsWith(SRC_PREFIX) ? path.slice(SRC_PREFIX.length) : path
}

/**
 * 一份语料里全部 provider 适配器**声明**（工厂 / 类），按 `key` 字典序。
 *
 * 只看**顶层语句**：嵌套函数不可能带 `export`，深走一遍只会把局部同名声明也卷进来。
 */
export function providerAdapterDeclarations(
  units: readonly SourceUnit[],
): ProviderAdapterDeclaration[] {
  const found: ProviderAdapterDeclaration[] = []
  const record = (unit: SourceUnit, symbol: string): void => {
    found.push({ key: `${relativeToSrc(unit.path)}::${symbol}`, symbol })
  }
  for (const unit of units) {
    for (const statement of unit.source.statements) {
      if (!isExported(statement)) continue
      if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
        if (ADAPTER_FACTORY.test(statement.name.text)) record(unit, statement.name.text)
        continue
      }
      if (ts.isClassDeclaration(statement) && statement.name !== undefined) {
        const name = statement.name.text
        if (ADAPTER_CLASS.test(name) && !name.endsWith('Error')) record(unit, name)
        continue
      }
      if (!ts.isVariableStatement(statement)) continue
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue
        if (!ADAPTER_FACTORY.test(declaration.name.text)) continue
        const initializer = declaration.initializer
        // `export const createSqliteFoo = createFoo` 是 re-export 别名的另一种写法
        // （一份中立实现两个具名绑定）——那是 RFC-359 的目标形态，不是适配器声明。
        if (
          initializer !== undefined &&
          (ts.isArrowFunction(initializer) ||
            ts.isFunctionExpression(initializer) ||
            ts.isClassExpression(initializer))
        ) {
          record(unit, declaration.name.text)
        }
      }
    }
  }
  return found.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
}

/** 该标识符是否落在类型位置（`typeof X`、类型实参、`import type` 的右手等）。 */
function inTypePosition(node: ts.Node): boolean {
  let cursor: ts.Node | undefined = node.parent
  while (cursor !== undefined) {
    if (ts.isTypeNode(cursor)) return true
    cursor = cursor.parent
  }
  return false
}

/** import / export 子句里的名字：转发，不是使用。 */
function isModuleForwarding(node: ts.Identifier): boolean {
  const parent = node.parent
  return (
    ts.isImportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isExportSpecifier(parent)
  )
}

/** 声明名 / 属性名 / 形参名：都不是「引用了那个符号」。 */
function isNamePosition(node: ts.Identifier): boolean {
  const parent = node.parent
  if (ts.isFunctionDeclaration(parent) && parent.name === node) return true
  if (ts.isClassDeclaration(parent) && parent.name === node) return true
  if (ts.isVariableDeclaration(parent) && parent.name === node) return true
  if (ts.isParameter(parent) && parent.name === node) return true
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true
  if (ts.isMethodDeclaration(parent) && parent.name === node) return true
  if (ts.isPropertyDeclaration(parent) && parent.name === node) return true
  return false
}

/**
 * 一次遍历建好「符号 → 生产消费站点」索引：`<相对 src 的路径>:<行号>:<call|value>`。
 *
 * 只索引传入的 `names`——全量索引 1800 个文件的每个标识符没有必要，且会让报错信息里
 * 混进与本守卫无关的符号。
 */
function productionConsumers(
  units: readonly SourceUnit[],
  names: ReadonlySet<string>,
): ReadonlyMap<string, string[]> {
  const index = new Map<string, string[]>()
  for (const unit of units) {
    const visit = (node: ts.Node): void => {
      if (
        ts.isIdentifier(node) &&
        names.has(node.text) &&
        !isModuleForwarding(node) &&
        !isNamePosition(node) &&
        !inTypePosition(node)
      ) {
        const parent = node.parent
        const kind =
          (ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === node
            ? 'call'
            : 'value'
        const { line } = unit.source.getLineAndCharacterOfPosition(node.getStart(unit.source))
        const sites = index.get(node.text) ?? []
        sites.push(`${relativeToSrc(unit.path)}:${line + 1}:${kind}`)
        index.set(node.text, sites)
      }
      ts.forEachChild(node, visit)
    }
    visit(unit.source)
  }
  return index
}

/** 零生产消费者的 provider 适配器，按 `key` 字典序。 */
export function adaptersWithoutProductionConsumer(units: readonly SourceUnit[]): string[] {
  const declarations = providerAdapterDeclarations(units)
  const consumers = productionConsumers(
    units,
    new Set(declarations.map((declaration) => declaration.symbol)),
  )
  return declarations
    .filter((declaration) => (consumers.get(declaration.symbol) ?? []).length === 0)
    .map((declaration) => declaration.key)
}

const UNITS: readonly SourceUnit[] = packageSrcUnits(REPO_ROOT, 'backend')
const DECLARATIONS: readonly ProviderAdapterDeclaration[] = providerAdapterDeclarations(UNITS)

/**
 * `[<相对 src 的路径>::<符号>, <处置标记> + 它的真实能力在哪]`，**按 key 字典序**。只降不升。
 *
 * 「真实能力在哪」不是记账装饰，是这条账本存在的理由：删掉一份摆设之前，你必须先知道
 * 生产上到底是谁在干这件事，否则删除会变成一次盲改。处置标记的语义见文件头。
 */
export const DEAD_PROVIDER_ADAPTER_DEBT: readonly (readonly [string, string])[] = [
  [
    'modules/collaboration/infrastructure/postgresqlReviewMutationScope.ts::PostgresqlReviewMutationScopeResolver',
    '纯死代码：全仓零引用（连测试都没有）。同一件事的实现是中立的 ' +
      '`modules/collaboration/infrastructure/reviewMutationScope.ts:11::DatabaseReviewMutationScopeResolver`，' +
      '由 `services/reviewMutationCoordinator.ts:75` new 出来，两个引擎共用一份。' +
      'RFC-359 W8 清理批未动它：并发波次里 collaboration 整个 bounded context 由别人持有，' +
      '且删掉这个文件要同批改 `rfc359-w5-t17-provider-file-location` 的账本（当时也在别人手上）。',
  ],
  [
    'modules/task-execution/infrastructure/sqliteTaskAuthorization.ts::createSqliteTaskAuthorizationParticipantInTx',
    '改指：真实能力在中立的 `modules/task-execution/infrastructure/taskAuthorization.ts:82::createTaskAuthorizationParticipantInTx`，' +
      '被 `modules/task-execution/infrastructure/workgroupTaskRoomTaskParticipant.ts:83` 与 ' +
      '`modules/collaboration/infrastructure/legacySqliteReview.ts:3544` 调用。' +
      '本文件只剩这两个导出、两个都死，销账等于删掉整个 provider 命名文件——' +
      '那要同批把 `rfc359-w5-t17-provider-file-location.test.ts` 的 `PROVIDER_NAMED_FILE_DEBT` 改小；' +
      'RFC-359 W8 清理批跑时那份账本正被别的并发改动持有，故整条推迟。',
  ],
  [
    'modules/task-execution/infrastructure/sqliteTaskAuthorization.ts::createSqliteTaskAuthorizationQueries',
    '改指：真实能力是中立的 ' +
      '`modules/task-execution/infrastructure/taskAuthorization.ts:88::createTaskAuthorizationQueries`，' +
      'RFC-359 W7 合 collaboration 两对时 `modules/collaboration/infrastructure/legacySqliteClarifyRounds.ts:287` ' +
      '已改指它，本工厂生产消费者归零。与上一条同文件、同批处置（同上：受 T17 账本占用推迟）。',
  ],
  [
    'server.ts::composeSqliteProviderAppDeps',
    '纯死代码：全仓零引用（连测试都没有）。它只是同文件 `composeProviderAppDeps`（`server.ts:1265`）的同义包装；' +
      'PG bootstrap 走并列的 `composePostgresqlAppDeps`（`server.ts:1436` → `cli/postgresqlDaemonApplication.ts:2158`），' +
      'SQLite bootstrap 走的是另一个函数 `composeSqliteAppDeps`（`server.ts:1785`，经 `server.ts:3248` 的 `createComposedApp`），' +
      '从不经过本函数。RFC-359 W8 清理批未动它：`server.ts` 当时正被并发改动持有。',
  ],
]

describe('RFC-359 W5 —— provider 适配器必须有生产消费者', () => {
  test('语料非空：确实扫到了整棵 backend 源码树（扫成 0 说明扫描根失效，此刻零预言力）', () => {
    expect(UNITS.length).toBeGreaterThanOrEqual(1500)
  })

  // 这是**语料下限**，不是棘轮：它只回答「动词表还咬得动吗」，答案坏掉时是 0 或个位数。
  // 分母本身会随 RFC-359 收敛一路变小（开账当天 242 → W7 成对合一后 203 → W8 死代码清理批 188），
  // 所以这个门槛只能跟着**往下**调，不许往上——往上会把「收敛成功」判成红。真正证明判据没坏的是
  // 文件末尾那三条自变异 fixture（伪造源码喂给两个决定过程），它们与真实语料的大小完全无关；
  // 分母哪天真的走到零，删掉这条即可，fixture 仍然守着。
  test('被判集合非空：动词表确实咬到了一大批 provider 适配器声明（咬成 0 = 判据失效）', () => {
    expect(
      DECLARATIONS.length,
      '一个 provider 适配器工厂 / 类都没扫到——要么命名约定变了（`<create|compose|open|bind>' +
        '[形容词]<Provider>…` / `class <Provider>…`），要么动词表被改坏；此刻账本再准也毫无预言力。' +
        '注意：数字掉到门槛以下**未必**是判据坏了——RFC-359 每合一批适配器分母就小一截，' +
        '确认是收敛就把门槛跟着调低（只降不升），并在注释里记下这一档的实测值。',
    ).toBeGreaterThanOrEqual(150)
  })

  test('零生产消费者的适配器与账本逐字相等（增了是新摆设，减了是收敛，都要改账本）', () => {
    expect(
      adaptersWithoutProductionConsumer(UNITS),
      '「零生产消费者」的 provider 适配器与账本不符。\n' +
        '**增**了：又多了一份「看着 provider 对等、其实没人装配」的摆设。三条出路——把它接进组合根、' +
        '直接删掉（真实能力在别处，测试 / 源码锁改指那里）、或写进账本并说明它的真实能力在哪。\n' +
        '注意：`export { X } from …` 的再导出、字符串里的同名文本、以及「只有测试在 import 它」' +
        '都**不算**消费，这正是本守卫的对象。\n' +
        '**减**了：收敛发生了——把账本一起改小，让这次减少留下一次有署名的提交记录。',
    ).toEqual(DEAD_PROVIDER_ADAPTER_DEBT.map(([key]) => key))
  })

  test('账本按 key 字典序、无重复（清点稳定的前提）', () => {
    const keys = DEAD_PROVIDER_ADAPTER_DEBT.map(([key]) => key)
    expect(new Set(keys).size, '账本里有重复条目').toBe(keys.length)
    expect([...keys].sort(), '账本必须按 key 字典序——扫描结果是排好序的').toEqual(keys)
  })

  test('每条都标明处置性质（改指 / 纯死代码）并指到具体源码（不接受「以后再说」）', () => {
    const bad = DEAD_PROVIDER_ADAPTER_DEBT.filter(
      ([, why]) =>
        !DISPOSITION_MARKERS.some((marker) => why.startsWith(marker)) ||
        why.trim().length < 40 ||
        !why.includes('.ts'),
    ).map(([key]) => key)
    expect(
      bad,
      '每条账本必须以 `改指：`（真实能力在别处、把引用改过去再删）或 `纯死代码：`（全仓零引用、直接删）' +
        '开头，并给出可复跑的源码锚（`path/to/file.ts:line`）——两者处置完全不同，' +
        '没有这个区分，后来人只能对着一堆一样长的说明重新调查一遍',
    ).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 负 fixture（RFC-317 T14）—— 证明判据今天还咬得动，且咬的不是转发
// ---------------------------------------------------------------------------
//
// 上面的账本是「现状」，它挡不住第三种失效：语料还在、账本还对，但判据把再导出当成了消费
// （于是所有死适配器一夜之间"全都有消费者"、账本该清空——一次看起来像大胜利的假绿），
// 或者动词表被"整理"掉一支（`compose` 一走，9 条债当场蒸发）。
// 下面每条都把**伪造源码**喂给两个决定过程，完全不碰真实语料。

/** 四个构造动词各一 + 形容词中缀一例 + 四个不该入账的同前缀符号。 */
const FIXTURE_DECLARATIONS = `
export function createSqliteFixtureThing(db: Db): Thing {
  return { db }
}
export function composeSqliteFixtureQuery(db: Db): Query {
  return { db }
}
export function openPostgresqlFixtureTarget(db: Db): Target {
  return { db }
}
export function bindPostgresqlFixtureReader(tx: Tx): Reader {
  return { tx }
}
export function createAuthorizedSqliteFixturePersistence(db: Db): Persistence {
  return { db }
}
export class SqliteFixtureStore {
  constructor(private readonly db: Db) {}
}
export class SqliteFixtureError extends Error {}
export class DrizzleSqliteFixtureRepository {}
export function canViewSqliteFixtureResource(): boolean {
  return true
}
export const createSqliteFixtureAlias = createFixtureThing
`

/** 纯转发 + 字符串 + 属性名 + 类型位置：**一条都不算**消费。 */
const FIXTURE_NON_CONSUMERS = `
export { createSqliteFixtureThing } from './thing'
export * from './thing'
import { SqliteFixtureStore, composeSqliteFixtureQuery } from './thing'
export const NAME = 'composeSqliteFixtureQuery'
export const LOCK = 'openPostgresqlFixtureTarget'
export type FixtureFactory = typeof createSqliteFixtureThing
export function pluck(bag: Bag): unknown {
  return bag.bindPostgresqlFixtureReader
}
export function shape(store: SqliteFixtureStore): SqliteFixtureStore {
  return store
}
`

/** 真的调它 / new 它 / 把它当值注入：三种都算消费。 */
const FIXTURE_CONSUMERS = `
import { SqliteFixtureStore, createSqliteFixtureThing } from './thing'
export function compose(db: Db, tx: Tx, override?: FixtureFactory) {
  const make = override ?? createSqliteFixtureThing
  return {
    thing: make(db),
    query: composeSqliteFixtureQuery(db),
    target: openPostgresqlFixtureTarget(db),
    reader: bindPostgresqlFixtureReader(tx),
    persistence: createAuthorizedSqliteFixturePersistence(db),
    store: new SqliteFixtureStore(db),
  }
}
`

/** 被判集合：五个工厂 + 一个类，按 key 字典序。 */
const FIXTURE_EXPECTED_DECLARATIONS = [
  '__fixture__/thing.ts::SqliteFixtureStore',
  '__fixture__/thing.ts::bindPostgresqlFixtureReader',
  '__fixture__/thing.ts::composeSqliteFixtureQuery',
  '__fixture__/thing.ts::createAuthorizedSqliteFixturePersistence',
  '__fixture__/thing.ts::createSqliteFixtureThing',
  '__fixture__/thing.ts::openPostgresqlFixtureTarget',
]

function fabricated(files: readonly (readonly [string, string])[]): SourceUnit[] {
  return files.map(([name, text]) => sourceUnit(`${SRC_PREFIX}__fixture__/${name}`, text))
}

describe('RFC-359 W5 —— 判据自变异（fixture 全部伪造，不碰真实语料）', () => {
  test('四个构造动词与形容词中缀都咬得到；错误类 / 中缀品牌类 / 谓词 / 别名常量都不入', () => {
    expect(
      providerAdapterDeclarations(fabricated([['thing.ts', FIXTURE_DECLARATIONS]])).map(
        ({ key }) => key,
      ),
    ).toEqual(FIXTURE_EXPECTED_DECLARATIONS)
  })

  test('只有再导出 / import 绑定 / 字符串 / 属性名 / 类型位置 ⇒ 仍判为零生产消费者', () => {
    expect(
      adaptersWithoutProductionConsumer(
        fabricated([
          ['thing.ts', FIXTURE_DECLARATIONS],
          ['forward.ts', FIXTURE_NON_CONSUMERS],
        ]),
      ),
    ).toEqual(FIXTURE_EXPECTED_DECLARATIONS)
  })

  test('真的调它 / new 它 / 当值注入 ⇒ 判为有消费者（否则活着的适配器会被误报）', () => {
    expect(
      adaptersWithoutProductionConsumer(
        fabricated([
          ['thing.ts', FIXTURE_DECLARATIONS],
          ['forward.ts', FIXTURE_NON_CONSUMERS],
          ['compose.ts', FIXTURE_CONSUMERS],
        ]),
      ),
    ).toEqual([])
  })
})

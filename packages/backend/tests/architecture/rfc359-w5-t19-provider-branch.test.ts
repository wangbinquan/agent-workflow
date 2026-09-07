// RFC-359 W5-T19 —— **按 provider 名分叉**的高水位账本（只降不升）。
//
// # 为什么这个形状要被消灭：判能力，不判品牌
//
// RFC-359 的目标是「以后不允许再出现两种数据库一个好一个不好的分支」。制造这种分支最省事的
// 写法就是直接问品牌名——`if (provider === 'postgresql') … else …`。它坏在**没有 forcing
// function**：第三个 provider 进来时，它会静默落进 `else`，继承 SQLite 的行为，而编译器一声不吭。
// `platform/persistence/providerTraits.ts` 的文件头记着这条的实测——在 `1e5a47893` 上给
// `DatabaseProvider` 加第三个成员，只产生 **4 个编译错**（全在 schema 投影里），当时的
// **31 处 provider 分叉一个都没报**；其中两处正好是 RFC-349 花了一整个 session 在 PostgreSQL 上
// 修的缺陷类（布尔 DDL 默认值渲染成 SQLite 的 '1'/'0'、可重试写分类用 SQLite 的错误码）。
//
// 正解本仓已经建好了，一共三个入口，各自都带「新 provider 必须先回答」的闭集纪律：
//   · `engineOf(tx)` / `EngineCapabilities`（`platform/persistence/capabilities.ts`）——
//     实现只说「锁这个聚合根」「认领时跳过已锁的行」「这个错误是不是唯一冲突」，每个引擎各渲染一次；
//   · `databaseProviderTraits(provider)`（`providerTraits.ts`）——
//     `satisfies Record<DatabaseProvider, …>`，加一个 provider 就必须逐字段作答；
//   · 装配期按 provider 选一次实现（组合根），而不是在业务代码里逐处再问一遍。
// 所以「矩阵缺一项」的正确动作是**给矩阵加一项并补两侧测试**，不是就地写一条 `provider === …`。
//
// # 为什么 `storage === 'embedded-file'` 也在语料里
//
// 它比品牌名好一档——问的是「有没有本地文件」这个**能力**，新 provider 靠声明作答；
// RFC-349 那句「Ask this instead of `provider === 'sqlite'`」（`providerTraits.ts:27`）就是当时的修法。
// 但它不是 RFC-359 的终点：在本仓它的值域恰好只有两个成员、且与品牌名一一对应（sqlite ⇔
// embedded-file、postgresql ⇔ external-server；`docs/audit-backlog.md` 里 RFC-024 那条为归因排除
// 逐处论证过这组等价）。也就是说今天它仍然是**同一张真值表的另一种拼法**，一条二分支——终点是
// 判能力（`engineOf(tx)` / capabilities），不是判「哪一种存储形态」。账本因此如实把它记下来。
//
// # 白名单：`platform/persistence/`
//
// 能力矩阵、traits 决策表、schema 投影、事务原语**必须**知道 provider 名——它们是「把品牌翻译成
// 能力」的那一层，也是唯一被允许知道的地方。白名单只给这一个目录，其余全 `src` 入账。
//
// # 豁免：穷尽性围栏（按**形状**豁免，不按文件名豁免）
//
// `if (p !== 'sqlite' && p !== 'postgresql') return unhandledDatabaseProvider(p)` 这种写法**不计债**。
// 它的目的与本 RFC **同向**：`unhandledDatabaseProvider(value: never)` 的参数是 `never`
// （`platform/persistence/databaseProviders.ts:25`），第三个 provider 一进 `DATABASE_PROVIDERS`，
// 残差就变宽、这行**停止编译**——正是「不许静默落进 else」。它不是「一个走好路一个走差路」。
// 而且一条永远清不到零的棘轮会退化成噪音，让真正的债淹没在里面。
//
// 判据是 AST 形状，**不是** `main.ts` / `cli/migrate.ts` 的文件名白名单（那样换个文件就绕过去了）：
//   · 该比较（穿过 `&&` / `||` / 括号）是某个 `if` 的条件、或某个 `?:` 的条件；**且**
//   · **条件为真时走的那一支**（`if` 的 then、`?:` 的 whenTrue）**只做一件事**——
//     `return` / `throw` / 直接求值一个 `unhandledDatabaseProvider(…)` 调用（允许包一层单语句 block）。
//
// 「条件为真时」这半句是判据的承重墙，不能松成「任一支」。`provider === 'postgresql' ? pgImpl
// : provider === 'sqlite' ? sqliteImpl : unhandledDatabaseProvider(provider)`（
// `modules/task-execution/composition/taskExecutionPersistence.ts:235`）里，第二个比较的 **else**
// 恰好就是那个围栏——按「任一支」判会把一条**货真价实的双实现派发**整个放过去。
// 同理「只做一件事」也不能松：`if (p === 'postgresql') { doPgThing(); return unhandled(p) }`
// 会被判为计债，因为围栏后面藏了真实分支。
//
// 已知的保守面：`if (p === 'sqlite' || p === 'postgresql') { …正文… } else { return unhandled(p) }`
// 这种**反着写**的围栏今天全仓 0 处，判据不放行它（它守的是正文那一支）。真出现了再谈放宽——
// 方向选保守，宁可多记一行债，不可少咬一条分叉。
//
// # 语料：只扫 `packages/backend/src`
//
// 这是**有意收窄**，不是漏扫。`packages/frontend/src/components/settings/DatabaseMigrationSection.tsx`
// 有 3 处、`packages/shared/src/schemas/databaseMigration.ts` 有 1 处按 provider 名判断，但它们问的是
// **「这套系统现在跑在哪个数据库上」**——迁移向导本来就要把这件事显示给用户看，那是产品语义，
// 不是业务逻辑里的引擎分叉，永远清不到零。计入它们会制造与穷尽围栏同类的噪音。
// 测试也不在语料里：测试内按 provider 分叉是 W5-T19f 的独立棘轮，两条各管各的。
//
// # 两份账本：合一债 vs 搬家债
//
// 与 W5-T17 同一套区分（它也分 `PROVIDER_NAMED_FILE_DEBT` / `PROVIDER_NAMED_DIRECTORY_DEBT`）：
//   · `PROVIDER_BRANCH_DEBT` —— **合一债**。销账方式是把分叉改成按能力提问，或收进组合根装配一次。
//   · `PROVIDER_BRANCH_RELOCATION_DEBT` —— **搬家债**。这些代码功能上**就是**「把品牌翻译成能力」
//     的那一层（今天只有 schema 投影 `db/providerSchema.ts`），只是住错了地方；销账方式是**搬进
//     `platform/persistence/`**，不是重写。两者混在一份账本里会让人以为投影层要被改掉。
//
// # 为什么现在是高水位、不是 0
//
// RFC-359 的 W4（各 context 的 provider 对合一）还在收敛，组合根与迁移控制面上的分叉要等它落地
// 才谈得上清零。所以这里先按 RFC-317 T17 的机制立**高水位棘轮**：
//   · **只降不升**——新增一处就红，逼你要么走能力矩阵，要么把新增写进账本并说明为什么；
//   · **逐字相等**——收敛了也红，把账本一起改小，让每一次减少都留下一次有署名的提交记录。
//
// # 判据用 AST，不用正则
//
// 这不是洁癖，是本仓实测过的坑（`docs/dev-gotchas.md`：正则剥注释会吃掉真代码；判某名字有没有被
// 调用只能用 AST）。在本文件的语料上：一条朴素的行正则在白名单外报 38 行，其中 **3 行是纯注释**
// （`main.ts:103` / `main.ts:176` 的 residual-fence 说明、`cli/doctor.ts:134`）——它们恰恰是**在讲
// 这条规则本身**，却会被记成违规；同时它**漏掉** `main.ts:107` / `main.ts:180` / `cli/migrate.ts:26`
// 这类一行两处的比较，也漏掉 `server.ts:1042` 那条根本没有 `===` 的条件类型。AST 判据两头都准。
//
// # 已知盲区（**没有**覆盖，将来出现要补判据）
//
// **常量间接**：`const PG = 'postgresql'; if (provider === PG)`。判据只认字面量直接出现在比较里，
// 绑到常量再比较就看不见了——补它需要常量传播。今天全仓 0 命中（唯一的
// `let activeProvider: DatabaseProvider = 'sqlite'` 是 `db/providerSchema.ts` 的当前投影状态，
// 不是拿来比较的常量），所以暂不补。**这是盲区声明，不是「已覆盖」**：谁哪天看见这种写法，
// 该做的是给判据加常量传播，而不是以为棘轮已经管住了。

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

import ts from 'typescript'

import { packageSrcUnits, sourceUnit, type SourceUnit } from './census'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')
const SRC_PREFIX = 'packages/backend/src/'

/**
 * 「provider 品牌名」的词表。前两个是 provider 本名，后两个是本仓与它一一对应的等价真值表
 * （见文件头）。词表刻意小而闭：宽泛匹配（`/sqlite/i`）会把 `sqliteTaskOwnership` 这类文件名、
 * 类型名、import 路径全卷进来，那不是分叉。
 */
const PROVIDER_VOCABULARY: ReadonlySet<string> = new Set([
  'sqlite',
  'postgresql',
  'embedded-file',
  'external-server',
])

/** 唯一允许知道 provider 名的目录（相对 `src`）：把品牌翻译成能力的那一层。 */
const PROVIDER_AWARE_PREFIX = 'platform/persistence/'

/** 穷尽性围栏的落点。见文件头「豁免」一节。 */
const EXHAUSTIVENESS_FENCE = 'unhandledDatabaseProvider'

/** 相等 / 不等四种都算——`!==` 是 `===` 的补集，放过它等于放过一半。 */
const COMPARISON_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
])

/** 值位置的字符串字面量，或类型位置的字面量类型（`'postgresql'` 作为 `extends` 的右手）。 */
function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteralLike(node)) return node.text
  if (ts.isLiteralTypeNode(node) && ts.isStringLiteralLike(node.literal)) return node.literal.text
  return null
}

function isProviderLiteral(node: ts.Node): boolean {
  const text = literalText(node)
  return text !== null && PROVIDER_VOCABULARY.has(text)
}

function callsFence(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false
  const target = node.expression
  if (ts.isIdentifier(target)) return target.text === EXHAUSTIVENESS_FENCE
  if (ts.isPropertyAccessExpression(target)) return target.name.text === EXHAUSTIVENESS_FENCE
  return false
}

/**
 * 这一支**只做**「把控制权交给穷尽性围栏」这一件事吗？
 *
 * 允许 `return f()` / `throw f()` / 裸 `f()` / 单语句 block 包一层；**不允许**围栏前面还挂着别的
 * 语句——那说明围栏后面藏了真实分支，整支就不再是 fail-loud 交接。
 */
function isFenceOnlyBranch(branch: ts.Node): boolean {
  if (ts.isBlock(branch)) {
    return branch.statements.length === 1 && isFenceOnlyBranch(branch.statements[0]!)
  }
  if (ts.isReturnStatement(branch) || ts.isThrowStatement(branch)) {
    return branch.expression !== undefined && callsFence(branch.expression)
  }
  if (ts.isExpressionStatement(branch)) return callsFence(branch.expression)
  return callsFence(branch)
}

/**
 * 这个比较是一道穷尽性围栏吗（⇒ 不计债）？
 *
 * 从比较处向上穿过 `&&` / `||` / 括号，找到它所属的 `if` 条件或 `?:` 条件，然后只看
 * **条件为真时走的那一支**。`!` 会翻转分支语义，遇到它直接放弃豁免（保守方向）。
 */
function isExhaustivenessFence(comparison: ts.Node): boolean {
  let node: ts.Node = comparison
  let parent = node.parent
  while (parent !== undefined) {
    if (ts.isParenthesizedExpression(parent)) {
      node = parent
      parent = parent.parent
      continue
    }
    if (
      ts.isBinaryExpression(parent) &&
      (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        parent.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ) {
      node = parent
      parent = parent.parent
      continue
    }
    if (ts.isIfStatement(parent) && parent.expression === node) {
      return isFenceOnlyBranch(parent.thenStatement)
    }
    if (ts.isConditionalExpression(parent) && parent.condition === node) {
      return isFenceOnlyBranch(parent.whenTrue)
    }
    return false
  }
  return false
}

/**
 * 一个文件里所有**计债的**「按 provider 名分叉」站点，形如 `<行号>:<形态>:<源码片段>`。
 *
 * 三种形态，都是「provider 字面量出现在**条件位置**」：
 *   · `equality` —— `provider === 'sqlite'` / `!== 'postgresql'` / `storage === 'embedded-file'`，
 *     含 `?:`、`&&`、`if`、赋给布尔变量等一切下游用法（比较本身就是谓词，位置不必再限）。
 *     落到 `unhandledDatabaseProvider` 的穷尽性围栏在此处被剔除，判据见文件头；
 *   · `case` —— `switch (provider) { case 'postgresql': … }`。今天全仓 0 处，正好在零基线上封住：
 *     不封的话，把 `if/else` 改写成 `switch` 就是一条免检的复辟通路；
 *   · `conditional-type` —— `T extends 'postgresql' ? PgModule : Module`（`server.ts:1042`）。
 *     类型级的分叉同样是「两个 provider 两套实现」，只是编译期发生。
 *
 * 注释与普通字符串里的同名文本**不算**——它们根本不在 AST 的这些位置上，这正是不用正则的理由。
 * 对象字面量 `{ provider: 'sqlite' }`、类型联合 `'sqlite' | 'postgresql'`、以及
 * `DATABASE_PROVIDER_TRAITS[provider]` 这种**按表取值**的正解形状，也都不算。
 */
export function providerBranchSites(unit: SourceUnit): string[] {
  const source = unit.source
  const sites: string[] = []
  const record = (kind: string, node: ts.Node): void => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
    const text = node.getText(source).replace(/\s+/g, ' ').slice(0, 100)
    sites.push(`${line + 1}:${kind}:${text}`)
  }
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && COMPARISON_OPERATORS.has(node.operatorToken.kind)) {
      if (
        (isProviderLiteral(node.left) || isProviderLiteral(node.right)) &&
        !isExhaustivenessFence(node)
      ) {
        record('equality', node)
      }
    } else if (ts.isCaseClause(node) && isProviderLiteral(node.expression)) {
      record('case', node)
    } else if (ts.isConditionalTypeNode(node) && isProviderLiteral(node.extendsType)) {
      record('conditional-type', node)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return sites
}

/** `packages/backend/src` 下的全部生产源文件。只扫 backend 的理由见文件头。 */
const UNITS: readonly SourceUnit[] = packageSrcUnits(REPO_ROOT, 'backend')

/**
 * **合一债**：`<相对 src 的路径>: <分叉站点数>`，按路径字典序。只降不升。
 *
 * 开账当天（RFC-359 W5-T19）实测 **16 个文件 / 31 处**（另有搬家债 1 处、白名单内 12 处、
 * 穷尽性围栏 7 处不计）。按去处分三堆，各自的收敛方向不同：
 *   · **组合根 / CLI**（`main.ts` 4、`cli/*` 9、`server.ts` 1）——「装配期按 provider 选一次实现」
 *     本该只发生一次，今天迁移子命令的入参校验、doctor 的体检分支、backfill 的重打包各问了一遍。
 *     W5-T19c（启动序列恰有一个调用方、`cli/start.ts` 无 provider 执行分支）正对着这一堆。
 *   · **迁移控制面**（system-operations 7）——源侧 / 目标侧这个轴 `providerTraits.migrationRole`
 *     已经声明过了，这些站点是它落地前的手写版本。
 *   · **W4 在收敛的 provider 对**（task-execution 6、后台维护 4）——随各 context 合一一起清。
 */
export const PROVIDER_BRANCH_DEBT: readonly string[] = [
  'cli/database.ts: 2',
  'cli/dbCompact.ts: 1',
  'cli/doctor.ts: 3',
  'cli/migrate.ts: 1',
  'cli/start.ts: 2',
  'main.ts: 4',
  'modules/system-operations/composition.ts: 2',
  'modules/system-operations/infrastructure/databaseMigrationCoordinator.ts: 1',
  'modules/system-operations/infrastructure/databaseMigrationDaemonAdmission.ts: 2',
  'modules/system-operations/infrastructure/postgresqlProviderBackup.ts: 2',
  'modules/task-execution/composition/taskExecutionPersistence.ts: 2',
  'platform/background/maintenanceService.ts: 3',
  'platform/background/maintenanceWorkerSupervisor.ts: 1',
  'server.ts: 1',
]

/**
 * **搬家债**：功能上就是「把品牌翻译成能力」的那一层，只是住在白名单目录之外。
 *
 * 销账方式是**搬进 `platform/persistence/`**，不是重写——把它和合一债混在一份账本里，会让人
 * 以为 schema 投影本身要被改掉。今天只有一条：`db/providerSchema.ts` 按 provider 选
 * `PgColumn` / `SQLiteColumn` 的类型判定，它离白名单只差一个目录。
 */
export const PROVIDER_BRANCH_RELOCATION_DEBT: readonly string[] = ['db/providerSchema.ts: 1']

/** 相对 `src` 的路径 + 计债站点数，按路径字典序；白名单目录已剔除。 */
function scan(): string[] {
  return UNITS.map((unit) => ({
    rel: unit.path.slice(SRC_PREFIX.length),
    count: providerBranchSites(unit).length,
  }))
    .filter((row) => row.count > 0 && !row.rel.startsWith(PROVIDER_AWARE_PREFIX))
    .map((row) => `${row.rel}: ${row.count}`)
    .sort()
}

describe('RFC-359 W5-T19 —— 按 provider 名分叉只降不升', () => {
  test('语料非空：确实扫到了整棵 backend 源码树（扫成 0 说明扫描根失效，此刻零预言力）', () => {
    expect(
      UNITS.length,
      '扫到的 backend 源文件太少——扫描根多半失效了，此刻这条守卫零预言力。',
    ).toBeGreaterThanOrEqual(1500)
  })

  test('白名单目录确实还在、且确实是 provider 感知的（白名单指空目录 = 白名单失效）', () => {
    const aware = UNITS.filter(
      (unit) =>
        unit.path.slice(SRC_PREFIX.length).startsWith(PROVIDER_AWARE_PREFIX) &&
        providerBranchSites(unit).length > 0,
    )
    expect(
      aware.length,
      `${PROVIDER_AWARE_PREFIX} 下一处 provider 分叉都没有了。要么白名单前缀写错（此刻它豁免不了` +
        '任何东西，账本随时可能被一次目录改名整批"清零"），要么翻译层真的搬走了——后者请把前缀改到新家。',
    ).toBeGreaterThanOrEqual(3)
  })

  test('逐文件分叉站点数与两份账本的并集逐字相等（增了是新的品牌分叉，减了是收敛，都要改账本）', () => {
    const expected = [...PROVIDER_BRANCH_DEBT, ...PROVIDER_BRANCH_RELOCATION_DEBT].sort()
    expect(
      scan(),
      '「按 provider 名分叉」的逐文件站点数与账本不符。\n' +
        '**增**了：不要问品牌，问能力——事务内用 `engineOf(tx)`（行锁 / 认领子句 / advisory lock /\n' +
        'NULL 排序 / LIKE 大小写与转义 / 错误分类），引擎无关的静态差异用\n' +
        '`databaseProviderTraits(provider)`（storage / booleanLiteral / classifyRetryable /\n' +
        'migrationRole），选实现只在组合根选一次。矩阵缺一项就**给矩阵加一项并补两侧测试**，\n' +
        '不要在实现里就地写 `provider === …`。若新增的是**穷尽性围栏**（条件为真时只 return/throw\n' +
        '一个 `unhandledDatabaseProvider(…)`），它本就不计债——照那个形状写即可，不必登记。\n' +
        '确有理由（组合根装配 / 迁移控制面）就把新增写进 `PROVIDER_BRANCH_DEBT` 并说明为什么它\n' +
        '不能靠能力回答；若它只是住错了目录、销账方式是搬进 `platform/persistence/`，写进\n' +
        '`PROVIDER_BRANCH_RELOCATION_DEBT`。\n' +
        '**减**了：收敛发生了——把账本一起改小，让这次减少留下一次有署名的提交记录。',
    ).toEqual(expected)
  })

  test('两份账本各自按路径字典序、无重复，且彼此不重叠（清点稳定的前提）', () => {
    const pathsOf = (ledger: readonly string[]): string[] =>
      ledger.map((row) => row.slice(0, row.lastIndexOf(':')))
    for (const [name, ledger] of [
      ['PROVIDER_BRANCH_DEBT', PROVIDER_BRANCH_DEBT],
      ['PROVIDER_BRANCH_RELOCATION_DEBT', PROVIDER_BRANCH_RELOCATION_DEBT],
    ] as const) {
      const paths = pathsOf(ledger)
      expect(new Set(paths).size, `${name} 里有重复路径`).toBe(paths.length)
      expect([...paths].sort(), `${name} 没有按路径字典序排列`).toEqual(paths)
    }
    const overlap = pathsOf(PROVIDER_BRANCH_RELOCATION_DEBT).filter((path) =>
      pathsOf(PROVIDER_BRANCH_DEBT).includes(path),
    )
    expect(overlap, '同一个文件不能同时记在合一债与搬家债里——销账方式只能有一种').toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 负 fixture（RFC-317 T14）—— 证明 matcher 今天还咬得动，以及它咬的不是注释
// ---------------------------------------------------------------------------
//
// 上面的账本是「现状」，它挡不住第三种失效：语料还在、账本还对，但判据漏掉了一种语法形态。
// 下面每条都把一段**伪造源码**喂给 `providerBranchSites`，完全不碰真实语料。

/** 三种形态各一处：等值比较、`switch` 的 case、条件类型。 */
const FABRICATED_BRANCHES = `
type Pick<P> = P extends 'postgresql' ? PgStore : Store
export function choose(provider: string, storage: string, kind: string): string {
  if (provider === 'postgresql') return 'pg'
  if (provider !== 'sqlite') return 'other'
  if (storage === 'embedded-file') return 'file'
  const external = storage !== 'external-server'
  switch (kind) {
    case 'sqlite':
      return 'lite'
    default:
      return external ? 'x' : 'y'
  }
}
`

/** 同样的文本，但只出现在注释、模板注释与普通字符串里——一处都不该报。 */
const FABRICATED_PROSE = `
// Residual fence for every \`provider.provider === 'sqlite' ? … : …\` below.
/**
 * Ask this instead of \`provider === 'postgresql'\` whenever the question is
 * really "is there a local file?" — see \`storage === 'embedded-file'\`.
 */
export const NOTE = "provider === 'sqlite' is the shape RFC-359 removes"
export const HINT = \`storage !== 'external-server'\`
`

/** 正解形状：按表取值、对象字面量的值、类型联合。一处都不该报。 */
const FABRICATED_CAPABILITY_SHAPES = `
import { databaseProviderTraits } from '@/platform/persistence/providerTraits'
import { engineOf } from '@/platform/persistence/databaseTransaction'
export type Provider = 'sqlite' | 'postgresql'
const TRAITS = { sqlite: { storage: 'embedded-file' }, postgresql: { storage: 'external-server' } }
export function ok(provider: Provider, tx: unknown): unknown {
  const traits = databaseProviderTraits(provider)
  const chosen = TRAITS[provider]
  return [traits, chosen, engineOf(tx as never), { provider: 'sqlite' }]
}
`

/** 四种穷尽性围栏（block / 单行 return / throw / `?:` 的 whenTrue）——一处都不该计债。 */
const FABRICATED_FENCES = `
export function a(p: Provider): string {
  if (p !== 'sqlite' && p !== 'postgresql') {
    return unhandledDatabaseProvider(p)
  }
  return 'ok'
}
export function b(p: Provider): string {
  if (p !== 'postgresql') return unhandledDatabaseProvider(p)
  return 'pg'
}
export function c(p: Provider): string {
  if (p !== 'sqlite') throw unhandledDatabaseProvider(p)
  return 'lite'
}
export const d = (p: Provider): string =>
  p !== 'sqlite' && p !== 'postgresql' ? unhandledDatabaseProvider(p) : 'ok'
`

/** 围栏**没有**罩住的比较：裸分支、藏在围栏前的真实语句、以及 `?:` 里 else 才是围栏的派发。 */
const FABRICATED_FENCE_LOOKALIKES = `
export function bare(p: Provider): string {
  if (p === 'postgresql') return 'pg'
  return 'lite'
}
export function smuggled(p: Provider): string {
  if (p === 'postgresql') {
    doPgOnlyThing()
    return unhandledDatabaseProvider(p)
  }
  return 'lite'
}
export function dispatch(p: Provider, db: unknown): unknown {
  return p === 'postgresql'
    ? createPostgresql(db)
    : p === 'sqlite'
      ? createSqlite(db)
      : unhandledDatabaseProvider(p)
}
`

describe('RFC-359 W5-T19 —— 判据自证：咬得动分叉，不咬注释，也不咬穷尽围栏', () => {
  test('三种分叉形态各被抓到（等值 / case / 条件类型；漏掉任一种就是一条免检复辟通路）', () => {
    const kinds = providerBranchSites(
      sourceUnit('fabricated/provider-branch.ts', FABRICATED_BRANCHES),
    ).map((site) => site.split(':')[1])
    expect(kinds.filter((kind) => kind === 'equality')).toHaveLength(4)
    expect(kinds.filter((kind) => kind === 'case')).toHaveLength(1)
    expect(kinds.filter((kind) => kind === 'conditional-type')).toHaveLength(1)
  })

  test('注释与普通字符串里的同名文本不报（正则式假阳的那一半）', () => {
    expect(
      providerBranchSites(sourceUnit('fabricated/provider-prose.ts', FABRICATED_PROSE)),
      '判据把散文当成了代码——本仓 main.ts / providerTraits.ts 的文件头里就写着这些字样，' +
        '它们讲的正是这条规则本身',
    ).toEqual([])
  })

  test('按表取值 / 类型联合 / 对象字面量的值不报（正解形状不该被判红）', () => {
    expect(
      providerBranchSites(
        sourceUnit('fabricated/provider-capability.ts', FABRICATED_CAPABILITY_SHAPES),
      ),
      'traits 表与能力矩阵是本 RFC 要人**改成**的形状，判据把它们也算成分叉的话，' +
        '账本就永远清不了零',
    ).toEqual([])
  })

  test('四种穷尽性围栏全部豁免（block / 单行 return / throw / ?: 的 whenTrue）', () => {
    expect(
      providerBranchSites(sourceUnit('fabricated/provider-fence.ts', FABRICATED_FENCES)),
      '穷尽性围栏与本 RFC 同向（第三个 provider 一进来就停止编译），计它的债会让棘轮永远清不到零、' +
        '退化成噪音',
    ).toEqual([])
  })

  test('长得像围栏但不是的三种照计（裸分支 / 围栏前藏真实语句 / else 才是围栏的派发）', () => {
    const sites = providerBranchSites(
      sourceUnit('fabricated/provider-fence-lookalike.ts', FABRICATED_FENCE_LOOKALIKES),
    )
    expect(
      sites,
      '豁免判据被放宽了：它必须只放行「条件为真时只做一件事——交给 ' +
        'unhandledDatabaseProvider」的那一支。放宽成「任一支带围栏」会把 ' +
        'taskExecutionPersistence.ts 那种货真价实的双实现派发整个放过去。',
    ).toHaveLength(4)
  })
})

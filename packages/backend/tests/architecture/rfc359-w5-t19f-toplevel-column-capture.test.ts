// RFC-359 W5-T19f —— PostgreSQL 执行面上禁止**模块顶层**捕获 `@/db/schema` 的表列（只降不升）。
//
// 机制：`@/db/schema` 导出的不是表，是**按 provider 投影的 Proxy 门面**
// -------------------------------------------------------------------------
// `db/schema.ts` 里的每张表都由 `providerAwareSqliteTable`（`db/providerSchema.ts`）造出来：
// 一个 Proxy，`get` 陷阱按**当时激活的 provider**（`selectDatabaseSchemaProvider` /
// `currentDatabaseSchemaProvider`）把属性解析到 SQLite 或 PostgreSQL 那一份具体列对象上。
// 也就是说 `tasks` 与 `tasks.id` 的**正确性依赖于「什么时候读它」**，而不是「读到了什么名字」。
//
// 于是 `const COLUMNS = { createdAt: memories.createdAt, … }` 这种写在**模块作用域**的捕获，
// 求值时刻是**模块加载时**——那时进程往往还没选 provider（缺省 sqlite，测试进程里几乎必然）。
// RFC-359 W4-B4a 在真 PostgreSQL 上第一次跑就撞到它：捕获到 SQLite 列之后，PG 侧
// `bigint({ mode: 'number' })` 的 mapper 整个丢失，`createdAt` / `version` / `approvedAt`
// 这些数值列以**字符串**回到调用方——**不报错**，只是结果错（P1）。老的
// `postgresqlMemoryInjectionReadStore.ts` 同病，长期无人可见；W4-D10 又在 mission 列表页的
// **游标**上撞了同一形状（游标是 bigint，原样回成字符串后翻页判据全错）。
//
// W4-D10 之后 `columnFacadeFor` 把列也做成了访问时解析的 Proxy，最坏后果被兜了一层；但这条
// 纪律没有因此作废，理由有三：
//   ① 兜底只覆盖「经由表门面的 `get` 取到列」这一条路。顶层常量一旦被
//      `Object.entries(表)` / `getTableColumns(表)` 这类**枚举**取值（表门面没有 `ownKeys` /
//      `getOwnPropertyDescriptor` 陷阱），拿到的仍是 SQLite 的具体列对象，兜底当场失效；
//   ② 顶层捕获让「这段代码在哪个 provider 上跑」变成**加载顺序**的函数——这正是 RFC-359 要
//      消灭的那类「两个引擎一个好一个不好」的隐式分支，且它不会以异常的形式暴露；
//   ③ 兜底本身是 provider 门面的实现细节，业务代码不该把正确性押在它身上。
// 规矩因此是**形状级**的：列引用只在**查询函数体内**取（`function projection() { return { … } }`
// 每次调用再取），不要在模块作用域缓存表列 / 投影对象。见 `docs/dev-gotchas.md`
// §「模块顶层常量捕获 `@/db/schema` 的列会绕过 provider 投影」。
//
// 判据为什么必须是 AST 而不是正则
// -------------------------------------------------------------------------
// 本守卫要判的**恰恰是位置**：同一段 `{ id: tasks.id }`，写在模块顶层是违规，写在函数体内是
// 正解。文本判据分不开这两者（也分不开注释与代码），只会把「把取列挪进函数体」这个唯一正确的
// 修法也判成红——那会逼着人绕开守卫而不是修代码。所以这里用 `typescript` 的 AST：
//   · **顶层** = 不在任何函数体内（function / 箭头 / 方法 / 构造器 / getter / setter），
//     且不在**实例**字段初始化式里（那是构造时求值）；`static` 字段初始化式**算**顶层。
//   · **来自 `@/db/schema`** = 顺着 import 声明解析标识符来源（含 `import * as ns` 与相对路径
//     `./schema`），不靠名字猜——叫 `tasks` 的局部对象不该被误判。
//   · **类型位置不算**：`typeof tasks.$inferSelect` 是类型查询，零运行时求值。
//
// 账本为什么是高水位而不是 exact 0
// -------------------------------------------------------------------------
// **先对齐计划原文，免得下一个人以为守卫写错了**：`design/RFC-359-database-provider-unification/plan.md`
// §5 W5-T19f 写的是「存量逐条改为函数内取列后钉 0」——那句话把「0」当成了**起点**。实测不是：
// 本守卫**上线当天的存量就是 83 处 / 8 个文件**。计划写下时还没做这次全语料 AST 清点，估低了。
// 所以 T19f 的「钉 0」是**终点**，本文件是通往它的棘轮；账本清空的那一天再把断言换成 exact 0。
//
// 这 83 处全是 RFC-311 那一轮为「列表页别读重列」抽出来的投影常量
// （`DISPATCH_RUN_COLUMNS` / `SUMMARY_COLUMNS` / `TASK_LIST_COLUMNS` …）。修法是机械的
// （常量改成函数、调用点加一对括号），但它们分属 6 个 bounded context、和别的在制品重叠，
// 一次性改完必然在并发工作树上撞车。所以本轮**只上守卫、不做迁移**：先把「还剩多少」变成
// 可计数、可防守的量。机制同 `rfc359-sync-transaction-highwater.test.ts`：逐文件计数、
// **逐字相等**——**增**了红（有人又在顶层钉了一个 provider），**减**了也红（收敛发生了，
// 把账本一起改小，让每一次减少留下一次有署名的提交记录）。长期目标是 0。
//
// 计数粒度是**列引用数**（83），不是**捕获点常量数**（8）。这是刻意的：按常量数计，往一个
// 已经欠着债的 `TASK_LIST_COLUMNS` 里再塞 5 列就免检通过了——那等于给存量债发扩容许可证。
// 按列计，任何一次「多钉一列」都当场红。

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

import ts from 'typescript'

import { postgresqlExecutionSurface, type PostgresqlSurfaceFile } from './postgresqlSurface'

const SRC_ROOT = resolve(import.meta.dir, '..', '..', 'src')

// ---------------------------------------------------------------------------
// 判据（纯函数：只吃「相对 src 的路径 + 源码文本」，不碰磁盘，负 fixture 直接喂它）
// ---------------------------------------------------------------------------

export type CaptureForm =
  /** `const X = { a: 表.列 }` —— 顶层读到了一个具体列。 */
  | 'column'
  /** 顶层 `select({ … })` / `.select({ … })` —— 整个投影对象被钉在加载时的 provider 上。 */
  | 'projection'
  /** `const { 列 } = 表` —— 解构同样是一次顶层取值。 */
  | 'destructure'

export interface TopLevelColumnCapture {
  /** 1 起算的行号，配合 `path` 直接能跳过去改。 */
  readonly line: number
  readonly form: CaptureForm
  /** 违规表达式的源码文本（截断），失败信息里直接可读。 */
  readonly text: string
}

/** drizzle 的投影入口。顶层出现即意味着投影对象在加载时定型。 */
const PROJECTION_CALLEES: ReadonlySet<string> = new Set(['select', 'selectDistinct'])

/**
 * `specifier` 从 `fromPath` 出发是不是解析到 `db/schema`？
 *
 * 别名 `@/db/schema` 与相对路径（`db/client.ts` 里的 `./schema`）都要认——只匹配别名的话，
 * `db/` 目录内部的文件会整体逃出判据。
 */
export function resolvesToDatabaseSchema(fromPath: string, specifier: string): boolean {
  const bare = specifier.replace(/\.ts$/u, '')
  if (bare === '@/db/schema') return true
  if (!bare.startsWith('.')) return false
  const directory = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : ''
  const stack: string[] = []
  for (const segment of [...directory.split('/'), ...bare.split('/')]) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') stack.pop()
    else stack.push(segment)
  }
  return stack.join('/') === 'db/schema'
}

interface SchemaBindings {
  /** `import { tasks } from '@/db/schema'` —— 标识符本身就是表门面。 */
  readonly tables: ReadonlySet<string>
  /** `import * as schema from '@/db/schema'` —— `schema.tasks` 才是表门面。 */
  readonly namespaces: ReadonlySet<string>
}

function schemaBindings(path: string, source: ts.SourceFile): SchemaBindings {
  const tables = new Set<string>()
  const namespaces = new Set<string>()
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue
    if (!resolvesToDatabaseSchema(path, statement.moduleSpecifier.text)) continue
    const clause = statement.importClause
    // `import type { … }` 整条是类型：零运行时求值，不可能捕获到列。
    if (clause === undefined || clause.isTypeOnly) continue
    if (clause.name !== undefined) tables.add(clause.name.text)
    const bindings = clause.namedBindings
    if (bindings === undefined) continue
    if (ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text)
    else
      for (const element of bindings.elements)
        if (!element.isTypeOnly) tables.add(element.name.text)
  }
  return { tables, namespaces }
}

function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  )
}

/**
 * **实例**字段初始化式在构造时求值，与函数体同类；`static` 字段在类定义时求值，是货真价实的
 * 模块加载期。两者形状相同、时机不同，判据必须分开——否则要么放过 static、要么误伤实例字段。
 */
function isDeferredClassField(node: ts.Node): boolean {
  return (
    ts.isPropertyDeclaration(node) &&
    !(node.modifiers ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)
  )
}

/** `expression` 是否求值成一张 schema 表门面（`tasks` 或 `schema.tasks`）。 */
function isSchemaTableReference(expression: ts.Expression, bindings: SchemaBindings): boolean {
  if (ts.isIdentifier(expression)) return bindings.tables.has(expression.text)
  return (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    bindings.namespaces.has(expression.expression.text)
  )
}

/**
 * 该文件里**模块顶层**对 `@/db/schema` 表列的全部捕获点，按出现顺序。
 *
 * 空数组 = 合规。判据完全由本函数承担，守卫与负 fixture 喂的是同一份实现——各留一份拷贝的话，
 * fixture 证明的只是拷贝还活着。
 */
export function topLevelSchemaColumnCaptures(
  path: string,
  text: string,
): readonly TopLevelColumnCapture[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const bindings = schemaBindings(path, source)
  const captures: TopLevelColumnCapture[] = []
  const report = (node: ts.Node, form: CaptureForm): void => {
    captures.push({
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      form,
      text: node.getText(source).replace(/\s+/gu, ' ').slice(0, 120),
    })
  }

  const visit = (node: ts.Node, deferred: boolean): void => {
    // 类型位置零运行时求值：`typeof tasks.$inferSelect` / `(typeof tasks.$inferSelect)[K]`
    // 是本仓投影常量旁边的常客，把它们判成违规会让「修完了」也红。
    if (ts.isTypeNode(node)) return
    const nowDeferred = deferred || isFunctionLike(node) || isDeferredClassField(node)
    if (!nowDeferred) {
      if (
        (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
        isSchemaTableReference(node.expression, bindings)
      ) {
        report(node, 'column')
      } else if (
        ts.isVariableDeclaration(node) &&
        ts.isObjectBindingPattern(node.name) &&
        node.initializer !== undefined &&
        isSchemaTableReference(node.initializer, bindings)
      ) {
        report(node, 'destructure')
      } else if (ts.isCallExpression(node)) {
        const callee = node.expression
        const name = ts.isIdentifier(callee)
          ? callee.text
          : ts.isPropertyAccessExpression(callee)
            ? callee.name.text
            : null
        if (name !== null && PROJECTION_CALLEES.has(name)) report(node, 'projection')
      }
    }
    ts.forEachChild(node, (child) => {
      visit(child, nowDeferred)
    })
  }
  ts.forEachChild(source, (node) => {
    visit(node, false)
  })
  return captures
}

// ---------------------------------------------------------------------------
// 账本
// ---------------------------------------------------------------------------

/**
 * `<相对 src 的路径>: <模块顶层捕获点数>`，按路径字典序。**只降不升**。
 *
 * 修法（全部 8 条同一个）：把 `const X = { a: 表.列 }` 改成 `function xColumns() { return { a: 表.列 } }`，
 * 调用点写 `db.select(xColumns())`。列在每次查询时才取，于是永远跟着**当前**激活的 provider。
 */
export const TOPLEVEL_COLUMN_CAPTURE_DEBT: readonly string[] = [
  'auth/infrastructure/tokenCallAudit.ts: 2',
  'modules/collaboration/infrastructure/legacySqliteTaskQuestionDispatch.ts: 23',
  'modules/development-automation/infrastructure/missionReadModels.ts: 18',
  'modules/identity-access/infrastructure/userAccessPersistence.ts: 5',
  'modules/resource-catalog/infrastructure/mcpRepository.ts: 5',
  'modules/resource-catalog/infrastructure/pluginRepository.ts: 5',
  'modules/task-execution/infrastructure/nodeRunRuntimePersistence.ts: 3',
  'modules/task-execution/infrastructure/postgresqlTaskRouteOperations.ts: 22',
]

/**
 * 语料：**会在 PostgreSQL 上执行 SQL 的全部后端源文件**，与 RFC-349 三条陷阱守卫共用
 * `postgresqlSurface.ts` 的类型可达判据（命名前缀 + PG 客户端 / 中立句柄的类型痕迹）。
 * 手写文件清单会在下一次合一时立刻过期——那正是 RFC-349 语料事故的成因。
 */
const SURFACE: readonly PostgresqlSurfaceFile[] = postgresqlExecutionSurface(SRC_ROOT)

/** 语料里真的 import 了 `@/db/schema` 的那些——本守卫的实际扫描面。 */
const SCHEMA_CONSUMERS: readonly PostgresqlSurfaceFile[] = SURFACE.filter((file) =>
  /(^|[^\w])(from\s+['"](@\/db\/schema|\.{1,2}\/(?:[\w./-]*\/)?schema)['"])/u.test(file.text),
)

interface Scan {
  /** `<路径>: <捕获点数>`，字典序——与账本逐字比对的那一面。 */
  readonly rows: readonly string[]
  /** 逐条 `路径:行号 [形态] 表达式`——失败信息里直接可动手的那一面。 */
  readonly detail: string
}

let cached: Scan | undefined

/**
 * 全语料只解析一遍（273 个文件的 AST），两个用例共用。
 *
 * `rows` 与 `detail` 必须同源：`expect(…, message)` 的 message 是**先算后传**的，
 * 让明细走第二次扫描等于每次绿跑都白付一遍全语料解析的钱。
 */
function scan(): Scan {
  if (cached !== undefined) return cached
  const rows: string[] = []
  const detail: string[] = []
  for (const file of SURFACE) {
    const captures = topLevelSchemaColumnCaptures(file.path, file.text)
    if (captures.length === 0) continue
    rows.push(`${file.path}: ${String(captures.length)}`)
    for (const capture of captures) {
      detail.push(`  ${file.path}:${String(capture.line)} [${capture.form}] ${capture.text}`)
    }
  }
  cached = { rows: rows.sort(), detail: detail.join('\n') }
  return cached
}

describe('RFC-359 W5-T19f —— PG 执行面禁止模块顶层捕获 schema 表列（高水位，只降不升）', () => {
  test('语料非空：PG 执行面与它的 schema 消费者都还在（扫成 0 时本守卫零预言力）', () => {
    expect(
      SURFACE.length,
      'PG 执行面塌了 ⇒ 本守卫会因为「没有语料」而永久假绿（同 rfc349-postgresql-surface-guard 的立意）',
    ).toBeGreaterThanOrEqual(100)
    expect(
      SCHEMA_CONSUMERS.length,
      '语料里一个 `@/db/schema` 消费者都没有 ⇒ import 解析或语料判据其一失效了',
    ).toBeGreaterThanOrEqual(60)
  })

  test('逐文件顶层捕获点数与账本逐字相等（增了是新钉的 provider，减了是收敛，都要改账本）', () => {
    expect(
      [...scan().rows],
      '模块顶层捕获 `@/db/schema` 表列的点数与账本不符。\n' +
        '**增**了说明有人又在模块作用域缓存了表列 / 投影对象——那是按 provider 投影的 Proxy 门面，' +
        '在模块**加载时**取值会把这段代码钉死在当时激活的 provider 上（缺省 sqlite），' +
        "PostgreSQL 侧 `bigint({ mode: 'number' })` 的 mapper 随之丢失、数值列以字符串静默回流（W4-B4a / W4-D10 实撞）。\n" +
        '**修法**：把取列挪进函数体内——`const X = { a: 表.列 }` 改成 ' +
        '`function xColumns() { return { a: 表.列 } }`，调用点写 `db.select(xColumns())`；' +
        '顶层 `select({ … })` 同理，整条查询构造进函数体。\n' +
        '**减**了说明迁移发生了——把账本一起改小，让这次减少留下一次有署名的提交记录。\n' +
        `当前实测明细：\n${scan().detail}`,
    ).toEqual([...TOPLEVEL_COLUMN_CAPTURE_DEBT])
  })

  test('账本按路径字典序、无重复（清点稳定的前提）', () => {
    const paths = TOPLEVEL_COLUMN_CAPTURE_DEBT.map((row) => row.slice(0, row.lastIndexOf(':')))
    expect(new Set(paths).size, '账本里有重复路径').toBe(paths.length)
    expect([...paths].sort(), '账本没有按路径字典序排列').toEqual(paths)
  })
})

// ---------------------------------------------------------------------------
// 负 fixture：把捏造的源码喂回**同一份**判据
// ---------------------------------------------------------------------------
//
// 上面那条逐字相等的绿有三种来源，断言层面同形：真的没变；语料塌了（上一条挡）；
// **判据不咬了**——AST 漏掉一种语法形态、import 解析被改坏、`isTypeNode` 早退把整棵树跳过。
// 下面每条 fixture 都不碰真实语料，两个方向各钉一遍。
//
// 尤其是「同样的代码写在函数体内 ⇒ 不报」这一组：本守卫判的是**位置**，正确修法就是把代码
// 原样搬进函数体。判据一旦退化成文本匹配，修完了还是红，人只会绕开它。

interface Fixture {
  readonly name: string
  readonly path: string
  readonly source: string
  readonly forms: readonly CaptureForm[]
}

const IMPORT = "import { tasks, nodeRuns } from '@/db/schema'\n"

const FIXTURES: readonly Fixture[] = [
  {
    name: '顶层 `const X = { a: 表.列 }` ⇒ 报（这就是 W4-B4a 撞到的那个形状）',
    path: 'modules/x/infrastructure/foo.ts',
    source: `${IMPORT}const P = { id: tasks.id, name: tasks.name }\n`,
    forms: ['column', 'column'],
  },
  {
    name: '**同样的代码写在函数体内 ⇒ 不报**（唯一正确的修法不能被判成红）',
    path: 'modules/x/infrastructure/foo.ts',
    source: `${IMPORT}function projection() {\n  return { id: tasks.id, name: tasks.name }\n}\n`,
    forms: [],
  },
  {
    name: '箭头函数体内 ⇒ 不报',
    path: 'modules/x/infrastructure/foo.ts',
    source: `${IMPORT}export const load = (db) => db.select({ id: tasks.id }).from(tasks)\n`,
    forms: [],
  },
  {
    name: '类方法体内 ⇒ 不报',
    path: 'modules/x/infrastructure/foo.ts',
    source: `${IMPORT}class R {\n  load() {\n    return { id: tasks.id }\n  }\n}\n`,
    forms: [],
  },
  {
    name: '**实例**字段初始化式 ⇒ 不报（构造时求值，与函数体同类）',
    path: 'modules/x/infrastructure/foo.ts',
    source: `${IMPORT}class R {\n  private readonly p = { id: tasks.id }\n}\n`,
    forms: [],
  },
  {
    name: '`static` 字段初始化式 ⇒ 报（类定义时求值，就是模块加载期）',
    path: 'modules/x/infrastructure/foo.ts',
    source: `${IMPORT}class R {\n  static readonly P = { id: tasks.id }\n}\n`,
    forms: ['column'],
  },
  {
    name: '注释里写同样的文本 ⇒ 不报（正向检查不得被注释满足）',
    path: 'modules/x/infrastructure/foo.ts',
    source: `${IMPORT}// 以前这里是 const P = { id: tasks.id }，已挪进函数体\nexport const N = 1\n`,
    forms: [],
  },
  {
    name: '字符串字面量里写同样的文本 ⇒ 不报',
    path: 'modules/x/infrastructure/foo.ts',
    source: `${IMPORT}export const HINT = 'const P = { id: tasks.id }'\n`,
    forms: [],
  },
  {
    name: '顶层 `select({ … })` ⇒ 报（投影对象钉在加载时的 provider 上）',
    path: 'modules/x/infrastructure/foo.ts',
    source: `${IMPORT}const Q = db.select({ id: tasks.id }).from(tasks)\n`,
    forms: ['projection', 'column'],
  },
  {
    name: '顶层解构 `const { id } = 表` ⇒ 报',
    path: 'modules/x/infrastructure/foo.ts',
    source: `${IMPORT}const { id, status } = nodeRuns\n`,
    forms: ['destructure'],
  },
  {
    name: '同名但**不是**来自 `@/db/schema` 的局部对象 ⇒ 不报（顺 import 解析，不靠名字猜）',
    path: 'modules/x/infrastructure/foo.ts',
    source: "import { tasks } from '@/services/taskCache'\nconst P = { id: tasks.id }\n",
    forms: [],
  },
  {
    name: '`import type` 进来的表 ⇒ 不报（类型位置零运行时求值）',
    path: 'modules/x/infrastructure/foo.ts',
    source: "import type { tasks } from '@/db/schema'\ntype Row = typeof tasks.$inferSelect\n",
    forms: [],
  },
  {
    name: '值 import + 顶层**类型查询** ⇒ 不报（投影常量旁边的常客，误伤会让「修完了」也红）',
    path: 'modules/x/infrastructure/foo.ts',
    source: `${IMPORT}type Row = Pick<typeof tasks.$inferSelect, 'id'>\ntype Cell = (typeof nodeRuns.$inferSelect)['id']\n`,
    forms: [],
  },
  {
    name: '相对路径 import（`db/` 目录内部）⇒ 照样解析得到（只认别名的话这一类整体逃逸）',
    path: 'db/somethingStore.ts',
    source: "import { tasks } from './schema'\nconst P = { id: tasks.id }\n",
    forms: ['column'],
  },
  {
    name: '`import * as schema` 的 `schema.tasks.id` ⇒ 报；`schema.tasks` 本身只是表门面 ⇒ 不报',
    path: 'modules/x/infrastructure/foo.ts',
    source:
      "import * as schema from '@/db/schema'\nconst T = schema.tasks\nconst P = { id: schema.tasks.id }\n",
    forms: ['column'],
  },
  {
    name: '顶层拿的是**表**而不是列 ⇒ 不报（表门面身份稳定，不是本守卫的对象）',
    path: 'modules/x/infrastructure/foo.ts',
    source: `${IMPORT}const T = tasks\n`,
    forms: [],
  },
  {
    name: "元素访问 `表['列']` ⇒ 报（属性访问的等价写法，不能从这个口子溜走）",
    path: 'modules/x/infrastructure/foo.ts',
    source: `${IMPORT}const P = { id: tasks['id'] }\n`,
    forms: ['column'],
  },
  {
    name: '嵌在顶层数组 / 调用参数里的列 ⇒ 照样报（`const O = [desc(表.列), 表.列]`）',
    path: 'modules/x/infrastructure/foo.ts',
    source: `${IMPORT}const ORDER = [desc(tasks.createdAt), tasks.id] as const\n`,
    forms: ['column', 'column'],
  },
]

describe('RFC-359 W5-T19f —— 判据自变异：捏造的源码证明它两个方向都真的在判', () => {
  test('fixture 语料非空（fixture 表被清空时本 describe 零预言力）', () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(15)
    expect(FIXTURES.filter((fixture) => fixture.forms.length === 0).length).toBeGreaterThanOrEqual(
      8,
    )
    expect(FIXTURES.filter((fixture) => fixture.forms.length > 0).length).toBeGreaterThanOrEqual(6)
  })

  for (const fixture of FIXTURES) {
    test(`topLevelSchemaColumnCaptures：${fixture.name}`, () => {
      const captures = topLevelSchemaColumnCaptures(fixture.path, fixture.source)
      expect(
        captures.map((capture) => capture.form),
        `${fixture.name} —— 实测：${JSON.stringify(captures)}`,
      ).toEqual([...fixture.forms])
    })
  }

  test('模块解析：别名 / 相对路径 / 非 schema 三个方向各钉一遍', () => {
    expect(resolvesToDatabaseSchema('modules/x/infrastructure/foo.ts', '@/db/schema')).toBe(true)
    expect(resolvesToDatabaseSchema('db/client.ts', './schema')).toBe(true)
    expect(resolvesToDatabaseSchema('modules/x/infrastructure/foo.ts', '../../../db/schema')).toBe(
      true,
    )
    expect(resolvesToDatabaseSchema('modules/x/infrastructure/foo.ts', '@/db/query')).toBe(false)
    expect(
      resolvesToDatabaseSchema('modules/x/infrastructure/foo.ts', './schema'),
      '模块自己目录下的 `schema.ts`（例如 intent 的校验 schema）不是数据库 schema',
    ).toBe(false)
  })
})

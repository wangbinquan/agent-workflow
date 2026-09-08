// RFC-359 W5-T19c（design §7 守卫 4 / §11.3 守卫 4）—— 启动序列**恰有一个调用方**，
// 且两个 daemon 入口里**没有 provider 执行分支**。
//
// 挡的是什么
// ---------
// RFC-359 之前，PostgreSQL 走的是自己那条永不返回的 `servePostgresqlDaemon`，SQLite 在
// `startCommand` 尾部另有一段手写的 `Bun.serve` + `shutdown()`。**同一件事两种写法**，于是
// 「PG daemon 从来没跑过技能启动屏障 / 从来没注册终态工作区回收策略 / 从来没恢复过被打断的
// 任务删除」这类 P0 不是被谁写错的，而是**新步骤只加进了其中一条路径**——补审逐条列出的
// 那九组缺口全部是这个形状（design §6）。W3-T14/T16 把两条路合成一条：
// `main.ts` → `startCommand` → `composeDaemonProviderSession`（按 provider **查表**）
// → `{composeSqlite|composePostgresql}ProviderSession` → `serveDaemon`。
//
// 这条守卫钉住「合成之后不许再分叉」的两个可数事实：
//
// (a) **启动序列恰有一个调用方**：boot 链上每个函数的**调用点数**逐字相等（`STARTUP_SEQUENCE_CALL_SITES`）。
//     再复制一条启动路径必然要再调一次其中某个函数——多一个就红。少一个也红：函数被改名 /
//     删除时数到 0 绝不能被读成「收敛了」（RFC-317 T13「零与合规同形」）。
// (b) **入口里没有 provider 执行分支**：`cli/start.ts` 与 `cli/postgresqlDaemonApplication.ts`
//     里按 provider 轴决定**执行流程**的条件，逐条记账、只降不升
//     （`PROVIDER_EXECUTION_BRANCH_DEBT`）。
//
// 「选装配」与「分执行流程」的界线（本守卫的判据，逐条可复核）
// -------------------------------------------------------
// **选装配是合法的**——启动序列必须知道拿哪个 provider 去 compose，否则什么都装不起来。
// 合法的三种形状，判据一个都不计入：
//   1. **查表**：`{ sqlite: …, postgresql: … } satisfies Record<DatabaseProvider, …>` 是对象
//      字面量的**属性名**，不是条件；少一个 provider 直接编译不过，正是设计要的形状。
//   2. **收窄 / 打标**：`requireDatabaseProviderRuntime(x, 'postgresql')`、`provider: 'sqlite'`
//      —— provider 字面量出现在**实参 / 属性值**上，不是比较。
//   3. **拒绝装配**：`if (<provider 轴> !== '<字面量>') { throw … }` —— 分支体**只有 throw**。
//      它的全部后果是「这个 provider 不许被装成会话」，没有任何 boot 步骤因此少跑一步。
//
// **分执行流程是不合法的**——判据：一个 provider 轴上的判别式，只要它的后果不是「只 throw」，
// 就记一笔。典型形态就是今天账本里那一条：某个 boot 步骤**只在一个 provider 上跑**，另一个
// provider 要么另写一份（行为漂移），要么干脆没有——这正是 design §6 那九组缺口的成因。
//
// 具体到 AST 上：
//   · **判别式** = 等值比较（`===`/`!==`/`==`/`!=`），一侧是 provider 轴的字面量
//     （`'sqlite'`/`'postgresql'` 身份轴，或特征表 `providerTraits.ts` 的
//     `'embedded-file'`/`'external-server'` 存储轴、`'source'`/`'target'` 迁移角色轴），
//     另一侧的源码文本提到该轴（`provider` / `storage` / `migrationRole`）；
//     以及 `switch (<provider 轴>) { case '<字面量>': }` 的每个 case。
//   · **豁免**（= 选装配）当且仅当：该判别式（可穿过 `!` / `&&` / `||` / 括号）是某个 `if`
//     的条件，且它 then / else 两侧的语句**全是 throw**。
//   · 其余一律计入——**包括 `return`-only 的 early-return**（`if (…!== 'x') return` 后面接一串
//     boot 步骤，效果与「这一段 PG 不跑」完全相同，不是拒绝装配）、三元、switch，以及
//     被提出去的布尔（`const isSqlite = p.provider === 'sqlite'`，判据看比较本身、不看 `if`）。
//
// 为什么用 AST 而不是正则：注释里写 `provider === 'sqlite'`、字符串里写 `"provider === 'sqlite'"`
// 都**不**是比较，正则会把它们判红，逼着后来的人为了消红去改注释。下面「负向 fixture」那组
// 用例把这两条、以及上面每一条判据边界都各钉了一遍。
//
// 与既有守卫的分工：`rfc359-w3-t14-serve-daemon.test.ts` 是 W3 落地时的**文本**锁（一个
// `Bun.serve`、一个 `serveDaemon` 定义、关闭参与者集合相等）；本文件是 W5 的**结构**锁——
// 全仓 AST 数调用点、逐条分类 provider 判别式，两者互补不重叠。

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')
const BACKEND_SRC = resolve(REPO_ROOT, 'packages', 'backend', 'src')

/** 全仓源码扫描根——启动路径只可能从这三处长出来。 */
const CORPUS_ROOTS: readonly string[] = ['packages', 'scripts', 'e2e']
const CORPUS_SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  'test-results',
  'playwright-report',
])

/**
 * boot 链上被钉住调用点数的函数。
 *
 * 收在这四个上不是随手选的：它们各自是**复制一条启动路径时绕不开的一步**——
 * 进程入口（`startCommand`）、provider 会话的唯一门（`composeDaemonProviderSession`）、
 * PG 侧那份完整装配（`composePostgresqlDaemonApplication`）、以及永不返回的监听 + 关机
 * 序列（`serveDaemon`）。
 *
 * 刻意**不**收 `createDaemonProviderBootstrap`：它是 bootstrap **对象**的工厂，
 * `rfc349-daemon-provider-bootstrap.test.ts` 正常地在单测里构造它四次；那不是启动路径，
 * 而真正的门（会话装配）已经被 `composeDaemonProviderSession` 的 exact 2 钉住了。
 */
const STARTUP_SEQUENCE_ENTRYPOINTS: readonly string[] = [
  'composeDaemonProviderSession',
  'composePostgresqlDaemonApplication',
  'serveDaemon',
  'startCommand',
]

/**
 * `<函数> @ <相对仓库根的路径>: <调用点数>`，按行字典序。**逐字相等**。
 *
 * 多一行 / 数字变大 ⇒ 有人又开了一条启动路径：boot 步骤会再一次只加进其中一条，
 * 正是 RFC-359 要消灭的形态。要新增必须在 review 里说清为什么这条路径不能并进现有序列。
 * 数字变小 / 少一行 ⇒ 收敛或改名，把这里一起改，让变化留下一次有署名的提交记录。
 */
const STARTUP_SEQUENCE_CALL_SITES: readonly string[] = [
  'composeDaemonProviderSession @ packages/backend/src/cli/start.ts: 2',
  'composePostgresqlDaemonApplication @ packages/backend/src/cli/start.ts: 1',
  'serveDaemon @ packages/backend/src/cli/start.ts: 1',
  'startCommand @ packages/backend/src/main.ts: 1',
]

/**
 * 两个 provider 会话装配器**只许被查表引用、不许被直接调用**。
 *
 * 它们是「选装配」的两个叶子：`composeDaemonProviderSession` 的
 * `satisfies Record<DatabaseProvider, …>` 表把它们各引用一次，运行时按
 * `composers[provider](input)` 取。任何一处**具名调用**都意味着有人在表之外又开了一条
 * 「这个 provider 走这边」的路——那就是 provider 执行分支，只是换了个写法。
 */
const PROVIDER_SESSION_COMPOSERS: readonly string[] = [
  'composePostgresqlProviderSession',
  'composeSqliteProviderSession',
]

/** `<函数> @ <路径>: <定义处之外的引用数>`。逐字相等。 */
const PROVIDER_SESSION_COMPOSER_REFERENCES: readonly string[] = [
  'composePostgresqlProviderSession @ packages/backend/src/cli/start.ts: 1',
  'composeSqliteProviderSession @ packages/backend/src/cli/start.ts: 1',
]

/** (b) 的被扫面：两个 daemon 入口文件。 */
const DAEMON_ENTRY_FILES: readonly string[] = [
  'packages/backend/src/cli/start.ts',
  'packages/backend/src/cli/postgresqlDaemonApplication.ts',
]

/**
 * `<路径> | <归一化后的判别式源码>`，按行字典序。**只降不升 + 逐字相等**。
 *
 * 今天只剩一条：**冷恢复**。`applyPendingRestoreIfAny` 把 staged restore 目录放在 db 文件
 * 旁边——那是 embedded-file 的做法，所以它在 `storage === 'embedded-file'` 的分支里；
 * PostgreSQL 的同一件事在 `composePostgresqlDaemonApplication` 里另写成
 * `core.systemOperations.applyPendingRestore()`。也就是说「daemon 启动时消化一次 staged
 * restore」这一步**在两个 provider 上是两处代码、两种形状、两个位置**，正是本守卫要收敛的
 * 那类分叉。正解是一个中立的 boot-restore 端口 + 两个适配器，由中立序列调用一次；届时这条
 * 记账连同 `if` 一起删掉，账本改成空表。
 *
 * **只降不升**：多一条就红——新的 boot 步骤要么两个 provider 都跑，要么走端口 + 适配器，
 * 不许再写成「入口里按 provider 拐一下」。
 */
const PROVIDER_EXECUTION_BRANCH_DEBT: readonly string[] = [
  "packages/backend/src/cli/start.ts | databaseProviderTraits(bootGenerationPayload.provider).storage === 'embedded-file'",
]

// ---------------------------------------------------------------------------
// 判据（纯函数；扫描与负向 fixture 共用同一份实现）
// ---------------------------------------------------------------------------

function parse(label: string, text: string): ts.SourceFile {
  return ts.createSourceFile(label, text, ts.ScriptTarget.Latest, true)
}

function portable(path: string): string {
  return path.split(sep).join('/')
}

interface DirectoryEntry {
  readonly name: string
  isDirectory(): boolean
}

function readEntries(dir: string): DirectoryEntry[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/** 全仓 `.ts` / `.tsx` 源文件绝对路径。 */
export function listRepoSources(roots: readonly string[] = CORPUS_ROOTS): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readEntries(dir)) {
      if (entry.name.startsWith('.')) continue
      if (CORPUS_SKIP_DIRS.has(entry.name)) continue
      const child = join(dir, entry.name)
      if (entry.isDirectory()) walk(child)
      else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(child)
    }
  }
  for (const root of roots) {
    const abs = resolve(REPO_ROOT, root)
    try {
      if (statSync(abs).isDirectory()) walk(abs)
    } catch {
      // 扫描根不存在——由语料下限用例报出来，不在这里静默
    }
  }
  return out.sort()
}

/** `name(` 形态的**具名调用**次数（成员调用 `x.name()` 不算：那是别的对象的方法）。 */
export function namedCallCount(text: string, name: string, label = 'entry.ts'): number {
  const source = parse(label, text)
  let count = 0
  const walk = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    ) {
      count += 1
    }
    ts.forEachChild(node, walk)
  }
  walk(source)
  return count
}

/** 该名字被**定义**了几次（函数声明 / `const name = …`）。改名或删除时用它区分「收敛」与「判据瞎了」。 */
export function declarationCount(text: string, name: string, label = 'entry.ts'): number {
  const source = parse(label, text)
  let count = 0
  const walk = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) count += 1
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      count += 1
    }
    ts.forEachChild(node, walk)
  }
  walk(source)
  return count
}

/** 定义处之外的标识符引用数（`import` 说明符与声明名都不算）。 */
export function referenceCount(text: string, name: string, label = 'entry.ts'): number {
  const source = parse(label, text)
  let count = 0
  const walk = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === name) {
      const parent = node.parent as ts.Node | undefined
      const isDeclarationName =
        parent !== undefined &&
        ((ts.isFunctionDeclaration(parent) && parent.name === node) ||
          (ts.isVariableDeclaration(parent) && parent.name === node) ||
          (ts.isImportSpecifier(parent) && parent.name === node))
      if (!isDeclarationName) count += 1
    }
    ts.forEachChild(node, walk)
  }
  walk(source)
  return count
}

/** provider 三根轴上的字面量。 */
const PROVIDER_AXIS_LITERALS: ReadonlySet<string> = new Set([
  // 身份轴（`DatabaseProvider`）
  'sqlite',
  'postgresql',
  // 存储形态轴（`DatabaseStorageShape`）
  'embedded-file',
  'external-server',
  // 迁移角色轴（`DatabaseProviderTraits.migrationRole`）
  'source',
  'target',
])

/**
 * 判别式的另一侧必须真的在问 provider——否则 `'source'` / `'target'` 这种通用词会把
 * 一堆无关比较拖进来。三个词覆盖今天全部形态：`…provider`、`traits.storage`、
 * `traits.migrationRole`。
 */
const PROVIDER_AXIS_SUBJECT = /provider|storage|migrationRole/i

export interface ProviderCondition {
  /** 归一化（折叠空白）后的判别式源码——账本行的稳定身份，不随行号漂移。 */
  readonly text: string
  readonly line: number
  /** true = 选装配（只 throw 的拒绝装配）；false = 分执行流程，计入账本。 */
  readonly assembly: boolean
}

function isAxisLiteral(node: ts.Node): boolean {
  return ts.isStringLiteralLike(node) && PROVIDER_AXIS_LITERALS.has(node.text)
}

/** 分支体是否「只有 throw」——空体不算（`if (…) {}` 什么都没拒绝）。 */
function throwsOnly(statement: ts.Statement | undefined): boolean {
  if (statement === undefined) return true
  if (ts.isThrowStatement(statement)) return true
  if (ts.isBlock(statement)) {
    return statement.statements.length > 0 && statement.statements.every(throwsOnly)
  }
  return false
}

/**
 * 该判别式是否处在「拒绝装配」的位置：可穿过 `!` / `&&` / `||` / 括号向上找到某个 `if` 的
 * 条件，且这个 `if` 的 then / else 全是 throw。
 */
function isAssemblyRefusal(node: ts.Node): boolean {
  let current: ts.Node = node
  let parent = current.parent as ts.Node | undefined
  while (parent !== undefined) {
    if (ts.isParenthesizedExpression(parent)) {
      current = parent
    } else if (
      ts.isPrefixUnaryExpression(parent) &&
      parent.operator === ts.SyntaxKind.ExclamationToken
    ) {
      current = parent
    } else if (
      ts.isBinaryExpression(parent) &&
      (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        parent.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ) {
      current = parent
    } else if (ts.isIfStatement(parent) && parent.expression === current) {
      return throwsOnly(parent.thenStatement) && throwsOnly(parent.elseStatement)
    } else {
      return false
    }
    parent = current.parent as ts.Node | undefined
  }
  return false
}

function collectProviderConditions(root: ts.Node, source: ts.SourceFile): ProviderCondition[] {
  const found: ProviderCondition[] = []
  const record = (node: ts.Node, text: string, assembly: boolean): void => {
    found.push({
      text: text.replace(/\s+/gu, ' ').trim(),
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      assembly,
    })
  }
  const walk = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind
      const isEquality =
        operator === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        operator === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        operator === ts.SyntaxKind.EqualsEqualsToken ||
        operator === ts.SyntaxKind.ExclamationEqualsToken
      if (isEquality) {
        const sides: readonly (readonly [ts.Node, ts.Node])[] = [
          [node.left, node.right],
          [node.right, node.left],
        ]
        for (const [literal, subject] of sides) {
          if (isAxisLiteral(literal) && PROVIDER_AXIS_SUBJECT.test(subject.getText(source))) {
            record(node, node.getText(source), isAssemblyRefusal(node))
            break
          }
        }
      }
    }
    if (
      ts.isCaseClause(node) &&
      isAxisLiteral(node.expression) &&
      ts.isCaseBlock(node.parent) &&
      ts.isSwitchStatement(node.parent.parent) &&
      PROVIDER_AXIS_SUBJECT.test(node.parent.parent.expression.getText(source))
    ) {
      // switch 的 case 永远算执行分支：拒绝装配写不成 case，而「按 provider 选装配」
      // 的正解是 `satisfies Record<DatabaseProvider, …>` 查表（少一个 provider 编译不过），
      // switch 没有这个强制力。
      record(
        node,
        `switch (${node.parent.parent.expression.getText(source)}) case ${node.expression.getText(source)}`,
        false,
      )
    }
    ts.forEachChild(node, walk)
  }
  walk(root)
  return found
}

/** 文件里全部 provider 判别式（含已豁免的）。 */
export function providerConditions(text: string, label = 'entry.ts'): ProviderCondition[] {
  const source = parse(label, text)
  return collectProviderConditions(source, source)
}

/** 计入账本的那些（= 分执行流程）。 */
export function providerExecutionBranches(text: string, label = 'entry.ts'): ProviderCondition[] {
  return providerConditions(text, label).filter((condition) => !condition.assembly)
}

/** `main.ts` 命令分发里 `case 'start':` 那一支的子树。 */
function startCaseClause(source: ts.SourceFile): ts.CaseClause | null {
  let found: ts.CaseClause | null = null
  const walk = (node: ts.Node): void => {
    if (
      found === null &&
      ts.isCaseClause(node) &&
      ts.isStringLiteralLike(node.expression) &&
      node.expression.text === 'start'
    ) {
      found = node
      return
    }
    ts.forEachChild(node, walk)
  }
  walk(source)
  return found
}

/** `case 'start':` 那一支里的 provider 判别式 + `startCommand` 具名调用数。 */
export function startDispatchShape(
  text: string,
  label = 'main.ts',
): {
  readonly found: boolean
  readonly conditions: ProviderCondition[]
  readonly startCommandCalls: number
} {
  const source = parse(label, text)
  const clause = startCaseClause(source)
  if (clause === null) return { found: false, conditions: [], startCommandCalls: 0 }
  let calls = 0
  const walk = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'startCommand'
    ) {
      calls += 1
    }
    ts.forEachChild(node, walk)
  }
  walk(clause)
  return {
    found: true,
    conditions: collectProviderConditions(clause, source),
    startCommandCalls: calls,
  }
}

// ---------------------------------------------------------------------------
// 扫描（一次算完，多条用例共用）
// ---------------------------------------------------------------------------

interface Scan {
  /** 枚举到的全部源文件（**存数组而不是个数**：语料下限断言要落在 `.length` 上，
   *  RFC-317 T13 的 `corpusFloor` 判据只认「在数东西 + 数的东西追得到文件枚举」）。 */
  readonly corpusFiles: readonly string[]
  readonly parsedFiles: number
  readonly callSiteRows: string[]
  readonly composerCallRows: string[]
  readonly composerReferenceRows: string[]
  readonly declarations: ReadonlyMap<string, string[]>
}

let cachedScan: Scan | null = null

function scan(): Scan {
  if (cachedScan !== null) return cachedScan
  const names = [...STARTUP_SEQUENCE_ENTRYPOINTS, ...PROVIDER_SESSION_COMPOSERS]
  const files = listRepoSources()
  const calls = new Map<string, number>()
  const references = new Map<string, number>()
  const declarations = new Map<string, string[]>()
  for (const name of names) declarations.set(name, [])
  let parsedFiles = 0
  for (const file of files) {
    // 枚举与读取之间文件可能消失（本仓是多 session 共享工作树，别人正在写盘）。
    // 跳过读不到的文件是**安全方向**：少读一个文件只会让调用点数偏小、逐字相等断言转红，
    // 不会把「多出来的启动路径」变绿；而让 ENOENT 直接抛出去只是把并发噪声报成守卫失败。
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const present = names.filter((name) => text.includes(name))
    if (present.length === 0) continue
    parsedFiles += 1
    const rel = portable(relative(REPO_ROOT, file))
    for (const name of present) {
      const callCount = namedCallCount(text, name, rel)
      if (callCount > 0) calls.set(`${name} @ ${rel}`, callCount)
      if (declarationCount(text, name, rel) > 0) declarations.get(name)!.push(rel)
      if (PROVIDER_SESSION_COMPOSERS.includes(name)) {
        const refs = referenceCount(text, name, rel)
        if (refs > 0) references.set(`${name} @ ${rel}`, refs)
      }
    }
  }
  const rows = (source: ReadonlyMap<string, number>, only: readonly string[]): string[] =>
    [...source.entries()]
      .filter(([key]) => only.includes(key.slice(0, key.indexOf(' @ '))))
      .map(([key, count]) => `${key}: ${count}`)
      .sort()
  cachedScan = {
    corpusFiles: files,
    parsedFiles,
    callSiteRows: rows(calls, STARTUP_SEQUENCE_ENTRYPOINTS),
    composerCallRows: rows(calls, PROVIDER_SESSION_COMPOSERS),
    composerReferenceRows: rows(references, PROVIDER_SESSION_COMPOSERS),
    declarations,
  }
  return cachedScan
}

/**
 * 显式预算，不吃 bun 的 5s 缺省。判据要读完 packages / scripts / e2e 下的全部 `.ts`
 * （2026-09-07 实测 5,827 个文件、本机 0.3s），成本随仓库单调上涨；CI 上四个分片同机并行、
 * I/O 争抢时会显著变慢（同形状的 RFC-317 T72 实测 CI macOS 5.6s 越过 5s 缺省而假红）。
 * 留一个数量级的余量：受压 runner 不假红，真跑飞也藏不住。
 */
const CORPUS_SCAN_TIMEOUT_MS = 60_000

describe('RFC-359 W5-T19c —— 语料下限（扫空 = 假绿）', () => {
  test(
    '全仓源码枚举没断，且确实解析到了含启动函数名的文件',
    () => {
      const result = scan()
      expect(
        result.corpusFiles.length,
        'packages / scripts / e2e 的源码枚举断了——下面所有「调用点数」断言此刻零预言力',
      ).toBeGreaterThan(3000)
      expect(
        result.parsedFiles,
        '没有任何文件含启动函数名——判据的被测面没了',
      ).toBeGreaterThanOrEqual(3)
    },
    CORPUS_SCAN_TIMEOUT_MS,
  )

  test(
    '每个被钉住的启动函数都还存在且只定义一次（改名 / 删除 ⇒ 红，不许被读成「收敛了」）',
    () => {
      const result = scan()
      const broken = [...result.declarations.entries()]
        .filter(([, files]) => files.length !== 1)
        .map(([name, files]) => `${name}: ${files.length} 处定义（${files.join(', ') || '无'}）`)
      expect(
        broken,
        '启动函数被改名 / 删除 / 复制了一份定义。**0 处定义绝不能当成 0 个调用点**——' +
          '那会把「判据瞎了」读成「启动路径收敛了」，正是 RFC-317 T13 的「零与合规同形」。',
      ).toEqual([])
    },
    CORPUS_SCAN_TIMEOUT_MS,
  )

  test('两个 daemon 入口文件读得到、解析得动、体量对得上', () => {
    for (const rel of DAEMON_ENTRY_FILES) {
      const text = readFileSync(resolve(REPO_ROOT, rel), 'utf8')
      expect(text.split('\n').length, `${rel} 体量异常，可能读错了文件`).toBeGreaterThan(300)
      expect(parse(rel, text).statements.length, `${rel} 解析不出顶层语句`).toBeGreaterThan(0)
    }
  })

  test('判别式判据在真文件上确实识别得出东西（识别到 0 = 判据瞎了）', () => {
    const start = readFileSync(resolve(BACKEND_SRC, 'cli', 'start.ts'), 'utf8')
    expect(
      providerConditions(start, 'cli/start.ts').length,
      'cli/start.ts 里一个 provider 判别式都没识别出来。' +
        '这个文件里至少有两处「拒绝装配」的 provider 收窄；识别成 0 说明判据失效，' +
        '此时「没有执行分支」的绿是假绿。',
    ).toBeGreaterThanOrEqual(2)
  })
})

describe('RFC-359 W5-T19c (a) —— 启动序列恰有一个调用方', () => {
  test(
    '调用点数逐字相等（多一处 = 又复制了一条启动路径）',
    () => {
      expect(
        scan().callSiteRows,
        '启动序列的调用点数变了。**多**了一处 ⇒ 有人又开了一条启动路径：' +
          'RFC-359 之前 PG 与 SQLite 各有一条 boot 序列，后果是新 boot 步骤只加进其中一条，' +
          'design §6 那九组 P0 缺口全部是这个形状——请并进 `startCommand` 那一条序列，' +
          'provider 差异走 `composeDaemonProviderSession` 的查表；' +
          '确有理由再开一条，就在 review 里逐条说清并改这张表。' +
          '**少**了一处 ⇒ 收敛或改名，把这张表一起改小，让变化留下一次有署名的提交记录。',
      ).toEqual([...STARTUP_SEQUENCE_CALL_SITES])
    },
    CORPUS_SCAN_TIMEOUT_MS,
  )

  test(
    'provider 会话装配器只被查表引用、零具名调用',
    () => {
      const result = scan()
      expect(
        result.composerCallRows,
        '有人直接具名调用了 provider 会话装配器。它们只许经 `composeDaemonProviderSession` 的 ' +
          '`satisfies Record<DatabaseProvider, …>` 表取用——那张表少一个 provider 就编译不过，' +
          '而一处具名调用等于在表外又写了一条「这个 provider 走这边」，就是 provider 执行分支换了个写法。',
      ).toEqual([])
      expect(
        result.composerReferenceRows,
        '两个 provider 会话装配器的引用点数变了：它们各自只该在查表里出现一次。',
      ).toEqual([...PROVIDER_SESSION_COMPOSER_REFERENCES])
    },
    CORPUS_SCAN_TIMEOUT_MS,
  )

  test('账本自身：无重复行、按字典序（清点稳定的前提）', () => {
    for (const ledger of [STARTUP_SEQUENCE_CALL_SITES, PROVIDER_SESSION_COMPOSER_REFERENCES]) {
      expect(new Set(ledger).size, '账本里有重复行').toBe(ledger.length)
      expect([...ledger].sort()).toEqual([...ledger])
    }
  })
})

describe('RFC-359 W5-T19c (b) —— 入口里没有 provider 执行分支', () => {
  test('两个 daemon 入口的执行分支逐条相等、只降不升', () => {
    const rows = DAEMON_ENTRY_FILES.flatMap((rel) =>
      providerExecutionBranches(readFileSync(resolve(REPO_ROOT, rel), 'utf8'), rel).map(
        (condition) => `${rel} | ${condition.text}`,
      ),
    ).sort()
    expect(
      rows,
      '两个 daemon 入口里按 provider 决定**执行流程**的条件变了。\n' +
        '**多**了一条 ⇒ 又有一个 boot 步骤只在一个 provider 上跑。选装配是合法的' +
        '（查表 / 收窄实参 / `if (…) { throw }` 拒绝装配都不计入），但「这一步 PG 不跑」不是选装配：' +
        '请把它做成一个 provider 中立的端口 + 两个适配器，由中立序列调用一次。\n' +
        '**少**了一条 ⇒ 收敛发生了，把这张表一起改小（这条棘轮只降不升）。\n' +
        '判据只看 AST：注释与字符串里写同样的文本不会被算进来。',
    ).toEqual([...PROVIDER_EXECUTION_BRANCH_DEBT])
    expect(
      rows.length,
      'provider 执行分支只许减少——这条是 RFC-317 式高水位棘轮',
    ).toBeLessThanOrEqual(PROVIDER_EXECUTION_BRANCH_DEBT.length)
  })

  test('PostgreSQL 入口钉 0：它整份就是一个 provider 的装配，内部不许再按 provider 拐', () => {
    const rel = 'packages/backend/src/cli/postgresqlDaemonApplication.ts'
    expect(
      providerConditions(readFileSync(resolve(REPO_ROOT, rel), 'utf8'), rel),
      'PG 装配入口里出现了 provider 判别式。这份文件被调用时 provider 已经选定，' +
        '里面再按 provider 拐一下只可能是把「另一个 provider 的行为」偷渡进来。',
    ).toEqual([])
  })

  test("命令分发的 `case 'start':` 那一支：一次 startCommand、零 provider 判别式", () => {
    const shape = startDispatchShape(
      readFileSync(resolve(BACKEND_SRC, 'main.ts'), 'utf8'),
      'main.ts',
    )
    expect(
      shape.found,
      "main.ts 里找不到 `case 'start':` —— 命令分发变形了，本条已失去被测面",
    ).toBe(true)
    expect(shape.startCommandCalls, "`case 'start':` 必须恰好调用一次 startCommand").toBe(1)
    expect(
      shape.conditions,
      "命令分发的 `case 'start':` 里出现了 provider 判别式。daemon 起哪个 provider 由" +
        '`resolveDatabaseProviderRuntime` 读代际指针决定、由 `composeDaemonProviderSession` 查表装配；' +
        '在分发处按 provider 拐一下等于在 `startCommand` 之外又开了半条启动路径。' +
        '（`user` / `package` / `doctor` 子命令自己的 provider 分叉走 `resolveCommandProvider`，' +
        '不在 daemon 启动序列上，由 W5-T19 那条全仓守卫管。）',
    ).toEqual([])
  })

  test('账本自身：无重复行、按字典序', () => {
    expect(new Set(PROVIDER_EXECUTION_BRANCH_DEBT).size).toBe(PROVIDER_EXECUTION_BRANCH_DEBT.length)
    expect([...PROVIDER_EXECUTION_BRANCH_DEBT].sort()).toEqual([...PROVIDER_EXECUTION_BRANCH_DEBT])
  })
})

describe('RFC-359 W5-T19c 负向 fixture —— 判据自证', () => {
  test('注释里的 provider 比较不算（AST 看不见注释，正则会误报）', () => {
    const text = [
      "// 历史：这里曾经是 if (provider === 'sqlite') { … } else { … }",
      "/* provider === 'postgresql' 时走另一条 boot 序列 */",
      'export const x = 1',
    ].join('\n')
    expect(providerConditions(text)).toEqual([])
  })

  test('字符串字面量里的 provider 比较不算', () => {
    const text = [
      'const message = "provider === \'sqlite\' 是被禁止的写法"',
      "throw new Error(`provider !== 'postgresql'`)",
    ].join('\n')
    expect(providerConditions(text)).toEqual([])
  })

  test('执行分支被计入：boot 步骤只在一个 provider 上跑', () => {
    const text = "if (databaseProviderTraits(p).storage === 'embedded-file') { await recover() }"
    const branches = providerExecutionBranches(text)
    expect(branches.map((c) => c.text)).toEqual([
      "databaseProviderTraits(p).storage === 'embedded-file'",
    ])
  })

  test('拒绝装配被放过：分支体只有 throw', () => {
    const text = "if (config.database.provider !== 'postgresql') { throw new Error('mismatch') }"
    expect(providerExecutionBranches(text)).toEqual([])
    expect(providerConditions(text).map((c) => c.assembly)).toEqual([true])
  })

  test('`return`-only 的 early-return **计入**：那不是拒绝装配，是「这一段某个 provider 不跑」', () => {
    const text = "function boot(p) { if (p.provider !== 'sqlite') return; seedDemo(); healJobs() }"
    expect(providerExecutionBranches(text).map((c) => c.text)).toEqual(["p.provider !== 'sqlite'"])
  })

  test('空分支体不算「拒绝装配」（什么都没拒绝）', () => {
    expect(providerExecutionBranches("if (p.provider === 'sqlite') {}").length).toBe(1)
  })

  test('穿过 `!` / `&&` / 括号仍能认出「只 throw」的拒绝装配', () => {
    const text = "if (!(p.provider === 'postgresql') && ready) { throw new Error('nope') }"
    expect(providerExecutionBranches(text)).toEqual([])
  })

  test('被提出去的布尔也计入（判据看比较本身，不看它写在哪个 if 里）', () => {
    const text = "const isSqlite = p.provider === 'sqlite'\nif (isSqlite) { runLegacyBoot() }"
    expect(providerExecutionBranches(text).map((c) => c.text)).toEqual(["p.provider === 'sqlite'"])
  })

  test('三元与 switch 也计入（选装配的正解是 `satisfies Record<DatabaseProvider, …>` 查表）', () => {
    const ternary = "const step = p.provider === 'sqlite' ? sqliteBoot : pgBoot"
    expect(providerExecutionBranches(ternary).map((c) => c.text)).toEqual([
      "p.provider === 'sqlite'",
    ])
    const switched =
      "switch (runtime.provider) { case 'sqlite': await a(); break; default: await b() }"
    expect(providerExecutionBranches(switched).map((c) => c.text)).toEqual([
      "switch (runtime.provider) case 'sqlite'",
    ])
  })

  test('查表 / 收窄实参 / provider 打标都不算判别式（选装配是合法的）', () => {
    const text = [
      'const composers = { sqlite: composeSqlite, postgresql: composePostgresql }',
      "const narrowed = requireDatabaseProviderRuntime(input.provider, 'sqlite')",
      "return Object.freeze({ provider: 'postgresql', db })",
      'return composers[input.provider.provider](input)',
    ].join('\n')
    expect(providerConditions(text)).toEqual([])
  })

  test('轴外的同名字面量不算（判别式另一侧必须真的在问 provider）', () => {
    const text = [
      "if (event.kind === 'source') { archive() }",
      "if (repo.storage === 'embedded-file') { vacuum() }",
    ].join('\n')
    // 第一条：`event.kind` 不提 provider 轴 ⇒ 放过；第二条：文本含 `storage` ⇒ 计入（宁可多报）。
    expect(providerConditions(text).map((c) => c.text)).toEqual([
      "repo.storage === 'embedded-file'",
    ])
  })

  test("`case 'start':` 判据只看那一支（别的子命令的 provider 分叉不算）", () => {
    const text = [
      'switch (command) {',
      "  case 'user': { if (p.provider === 'sqlite') { legacy() } break }",
      "  case 'start': { await startCommand(opts); break }",
      '}',
    ].join('\n')
    const shape = startDispatchShape(text)
    expect(shape.found).toBe(true)
    expect(shape.startCommandCalls).toBe(1)
    expect(shape.conditions).toEqual([])
  })

  test("`case 'start':` 里真的拐了 provider ⇒ 认得出来", () => {
    const text = [
      'switch (command) {',
      "  case 'start': { if (p.provider === 'postgresql') { await pgStart() } else { await startCommand(opts) } break }",
      '}',
    ].join('\n')
    const shape = startDispatchShape(text)
    expect(shape.conditions.map((c) => c.text)).toEqual(["p.provider === 'postgresql'"])
  })

  test('具名调用计数只认 `name(`，成员调用不算', () => {
    const text = 'serveDaemon({})\nawait serveDaemon({})\nobj.serveDaemon()\nconst f = serveDaemon'
    expect(namedCallCount(text, 'serveDaemon')).toBe(2)
  })
})

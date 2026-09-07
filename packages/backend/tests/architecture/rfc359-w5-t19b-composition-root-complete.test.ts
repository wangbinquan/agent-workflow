// RFC-359 W5-T19b —— 组合根「全量装配」的高水位账本（只降不升）。
//
// **为什么组合根必须一次交全。** RFC-294 的裁决是 **bootstrap 唯一装配**：一个 provider 的
// 组合根（`cli/**` 里的 daemon 入口 + `server.ts` 这个 HTTP 侧装配点 + 各 bounded context 的
// `composition*`）把每一个依赖**在装配那一刻**交进去，之后运行期只使用、不再补。
// 这不是洁癖——依赖一旦允许「先留空、
// 以后再补」，就出现了一段**装配未完成但已经可被调用**的窗口，而这个窗口的行为由「谁先跑到」
// 决定，两个 provider 的 daemon 各自跑到的顺序又不一样。于是同一份业务代码在 SQLite daemon
// 上拿到的是真依赖、在 PostgreSQL daemon 上拿到的是占位，**行为分叉发生在装配期，测不出来**。
//
// **这条守卫防的是什么复辟。** RFC-359 W1-T1 修掉过一批实锤：PG daemon 里挂着一串
// `*-not-bound` holder，它们被交给了下游、下游照常调用，于是每个 tick 抛
// `deferred-question-dispatcher-not-bound`——反问派发在 PostgreSQL 上**从未工作过**，
// 而 SQLite 上一切正常（`design/dual-provider-parity-audit-2026-09-04.md` P0-7；现场残迹见
// `src/cli/postgresqlDaemonApplication.ts` 与 `src/modules/collaboration/infrastructure/
// taskDagCollaborationOperations.ts` 顶部的注释）。这种缺陷的特征是**只在生产、只在一个引擎、
// 只在某条 tick 路径上**暴露：装配期不报错，类型上完全合法，单测各测各的也都绿。
// 唯一能挡住它的地方就是「不允许把占位交出去」本身。
//
// **三种形态**（都按 AST 判，注释里出现同样文本不算——本仓教训：正则剥注释会吃掉真代码）：
//   - `marker`  —— 字符串字面量含 `not-bound` / `not-composed`。这是本仓给占位失败起的错误码，
//                  `'task-drive-coordinator-not-bound'` / `'mcp-catalog-not-composed'` 是原型。
//                  **不限于 `throw`**：`cli/package.ts` 把它当命令输出返回，同样是「没装配」。
//                  也是唯一能覆盖 `const ref: {current: T|null}` 这类**对象盒 holder** 的形态
//                  （`cli/start.ts` 的 `developmentAutomationRef`），结构式判据够不着它。
//   - `prose`   —— `new Error(<字面量>)` 且文案是「… is / are not bound|composed」。只认
//                  `Error` 实参，所以 `employeeTypePackage.ts` 里那些含 "not bound" 的 **prompt
//                  文案**不会误伤；`'… is already bound'`（重复 bind 守卫，正当）也不匹配。
//   - `holder`  —— **结构式**：`let x: T | null = null` 声明为空、之后被赋值，且它的
//                  「为空就抛」分支落在**嵌套闭包里**（depth ≥ 1）。嵌套是关键——它把
//                  「装配槽被交出去、调用时才炸」和普通的「TS 收窄不了、直线代码里兜一句 throw」
//                  分开（后者如 `webhookAdmission.ts` 的 `resourceSnapshot`、`taskDagScope.ts`
//                  的 `f`，不是债）。这一条的作用是**防改名逃逸**：把错误码从 `-not-bound`
//                  改成别的词，marker 会漏，结构还在。
//                  它刻意保守：先 `const selected = ref` 再判 `selected === null` 这种**别名**
//                  不追（`postgresqlDaemonApplication.ts:968`），那处由 marker 兜住。
//
// **为什么现在是高水位而不是 0。** W4 还在收敛，存量占位分布在两个 daemon 入口与若干 context
// 的组合根上，一次性拆完等于重排整条装配序。所以本轮**只上守卫、不做迁移**：机制同 RFC-317 T17
// 与 `rfc359-sync-transaction-highwater.test.ts`——逐文件列出各形态计数，与实测**逐字相等**。
// **增**了红：有人又往组合根里塞了一个「以后再补」的占位。**减**了也红：收敛发生了，
// 把账本一起改小，让每一次拆除都留下一次有署名的提交记录。长期目标仍然是 0。

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import ts from 'typescript'

const SRC = resolve(import.meta.dir, '..', '..', 'src')

/**
 * `<相对 src 的路径>: marker=N, prose=N, holder=N`，按路径字典序。只降不升。
 *
 * 拆除姿势：把依赖变成组合根的**构造参数**（必填字段 / 构造器实参），让「没装配」在
 * 类型层就不可表达；确有装配环（A 要 B、B 要 A）时，把环打在**接口**而不是实例上——
 * 先造出双方都依赖的那个纯端口，再由 bootstrap 把两个实例一次性交齐。
 */
export const COMPOSITION_ROOT_PLACEHOLDER_DEBT: readonly string[] = [
  // W12：realtime policy 改为构造参数，两个根都交齐词法闭包，不再有 bind 步骤。
  // SQLite 根的 scheduler / collaboration / MCP / development 与 PG maintenance status
  // 空槽同步拆除；明确传 catalogBinding/runtime 的返回类型保证相应成员存在。
  // 下面 W11 的“本刀不碰 SQLite 根”是当时的分工记录，相关占位本轮已退役。
  // RFC-359 W11 分类结论（未销账，留给下一刀）：这一条**不是**声明位置造成的假占位。
  // `createDaemonRealtimePolicyBinding()` 有两个组合根消费它（PG daemon 与 SQLite daemon 入口），
  // 两处都把 `.policy` 先交给 provider core、待 Resource Catalog / Memory / transport 三个 owner
  // 建好之后才 `bind`——真的是跨阶段的环。拆它要同时改两个根，而 SQLite 那个根这一刀不许碰，
  // 于是只能整条留着（单改一侧等于把两个 daemon 的装配序拆成两种形状，比现状更糟）。
  // RFC-359 W5-T19b 销账：`cli/package.ts: marker=1` —— `packageCommand` 的 `bootstrapFactory`
  // 从可选变必填，缺省时那句「把没装配当成一种命令输出返回给用户」（`identity-access-runtime-not-composed`）
  // 随之删除。这处占位的代价是**实测到的**：`tests/rfc271-cli.test.ts` 的「--plan 与 --on-conflict
  // 同时给 ⇒ 报错」本意走到「user not found」，却因为不传 factory 在那一句就返回了，
  // 断言因一个无关理由变绿；必填之后那条用例才真的走到它要测的路径。
  // RFC-359 W11 销账：`cli/postgresqlDaemonApplication.ts` marker 9 → 4、holder 3 → 0。
  // 拆掉的五处是**同一形状**：一个装配环被打在「可空的实例槽 + 进门一句 throw」上，而环的
  // 两端其实同处一个函数作用域——`collaborationContext`（记忆读已评审产物 ↔ 评审上下文吃记忆的
  // 蒸馏命令面）、`mcpCatalogRef`（运行时测试查 MCP ↔ MCP 目录的删除/对账走运行时测试）、
  // `taskDriveCoordinatorRef`（启动内核要协调器 ↔ 协调器要执行提供者的生命周期端口）、
  // `taskExecutionProviderRef`（多余的别名：同一个 `const taskExecutionProvider` 在下面
  // `failureReporter` 里本来就直接用）、`developmentAutomationRef`（终态观察者回调 automation ↔
  // automation 的两个 launcher 要观察者）。
  // 改法是把环打在**词法作用域**上：闭包直接引用同一作用域里那个 `const`，只在运行期取值。
  // 于是可空槽与那五句 throw 一起消失，且「装配漏了一步」在类型层不可表达——实测：删掉
  // `const boundCollaborationContext = …` 那一行 ⇒ TS2304「Cannot find name 'boundCollaborationContext'」，
  // 删掉 `const boundTaskDriveCoordinator = …` ⇒ TS2304「Cannot find name 'boundTaskDriveCoordinator'」，
  // 而原来的形状是删掉 `xxxRef = …` 那一行照样编译通过、跑到才炸（正是 W1-T1 修掉的那类缺陷）。
  // 剩下的 4 处 marker 不是同一回事：`postgresql-memory-catalog-not-composed` /
  // `postgresql-digital-employee-runtime-not-composed` 是**工厂返回类型的可选字段**造成的假占位
  // （两个根都必然传了那半输入，缺口在 `modules/memory/composition.ts` 与
  // `modules/digital-employee/composition.ts` 的签名上，各加一个重载即可，本刀路径域外）；
  // `postgresql-task-launch-kernel-not-composed` 同理，落在 task-execution 的 provider runtime 上；
  // `intent-resource-catalog-context-not-bound` **根本不是装配缺口**——它是 `contextFor` 往
  // WeakMap 里登记 actor、`resolveActor` 再取回来的**每请求**旁路，取不到说明来了一个不是本
  // 目录铸出来的 context，与「依赖没装配」无关，只是错误码里恰好带 `not-bound` 才被本守卫计入
  // （同 `taskEngineApplication.ts` 留下那 2 处的理由）。
  // 行为判据见 `tests/rfc359-w11-composition-root-lexical-binding.test.ts`。
  'cli/postgresqlDaemonApplication.ts: marker=1, prose=0, holder=0',
  'cli/start.ts: marker=2, prose=0, holder=1',
  // RFC-359 W5-T19b 销账：`commandContext.ts` prose 6 → 5，且
  // `reviewNodeReviewerDependencies.ts: prose=1` 整行消失 —— `CollaborationCommandDependencies.reviewTaskAccess`
  // 从 `?:` 改成必填。这个槽从来没有第二个来源：两个工厂都是 `createReviewTaskAccessPort(input.db)`
  // 现造，全仓无任何调用方传过它（`createCollaborationCommandContextFromPersistence` 亦无外部调用方，
  // `CollaborationCommandDependencies` 只在本文件内出现）。留成可空的代价是同一个缺口兜两次、还兜出
  // 两种话术：`requireReviewTaskAccess` 抛 `collaboration task access is not composed`，而
  // `reviewNodeReviewerDependencies.ts` 私藏的那份逐字同构副本抛 `collaboration review task access is
  // not composed`。必填之后缺口在类型层不可表达（实测：删掉工厂里那行 ⇒ TS2345「not assignable to
  // parameter of type 'CollaborationCommandDependencies'」），两句兜底与那份副本一起删除。
  // 行为判据见 `tests/rfc359-w5-t19b-collaboration-composed-review-access.test.ts`（双引擎 + 变异表）。
  'modules/collaboration/composition/commandContext.ts: marker=0, prose=5, holder=0',
  // RFC-359 W11 销账：`modules/development-automation/composition/activityOperations.ts:
  // marker=1, holder=1` 整行消失 —— `createDevelopmentActivityWorkerBinding()`（先造 `operations`
  // 交给下游、再补一句 `.bind(worker)`、`operations` 进门 `if (worker === null) throw
  // 'development-activity-worker-not-bound'`）换成 `composeDevelopmentActivityOperations(worker)`，
  // worker 是必填实参。这个延迟在**两个**组合根上都是多余的：PG 根紧接着下一行就 bind，
  // SQLite 根在 `composeSqliteApiRouteMounts` 里 bind 完立刻取 `operations` 用（此前还要
  // 经 `SqliteComposedAppDeps` 绕一圈把空槽传过来，那两个字段随之删除）。
  // 必填之后缺口在类型层不可表达（实测：删掉调用点那个实参 ⇒ TS2554「Expected 1 arguments,
  // but got 0」），RFC-317 T54 的 once 守卫防的「第二次 bind 静默覆盖第一次」也无从发生。
  // `tests/rfc344-operation-catalog.test.ts` 那条用例随之改锁新契约（operations 就地落到交进
  // 来的那台 worker 上、两次装配互不串台）。
  // RFC-359 W5-T19b 销账：`modules/digital-employee/composition.ts: prose=1` —— 那句
  // `'digital employee runtime is not composed'` 是**声明位置**造成的假占位：`runtimeDocument`
  // 的 7 个使用点全在 `runtimeService === null ? null : {…}` 的非 null 分支里（同批箭头里
  // `runtimeService.launchCase(…)` 本来就直接调、不判空），只是它自己声明在分支外、收窄够不着。
  // 改成显式接收已收窄的 service（`documentForCase(service, caseId)`），缺口无处可表达。
  // RFC-359 W12：WorkStart 的 deferred holder 与 bind 一起删除。两个 daemon 根用完整的
  // 词法闭包引用后声明的模块，SQLite 的返回类型显式持有 HTTP 员工模块的 workStart 端口；
  // 重复挂载不会覆盖已装配实例，实际调用仍落到原 HTTP 实例，与 OS worker 生命周期分开。
  // RFC-359 W5-T19b 销账：`modules/task-execution/composition.ts: prose=1` ——
  // `TaskExecutionModule.persistence?` 这个空槽与 `claimPersisted` 进门那句
  // `'task-execution persistence is not composed'` 一起拆成两个类型：基类不再持有空槽，
  // `claimPersisted` 只长在 `ProviderTaskExecutionModule` 上。要持久化认领的能力，就得先拿到
  // 一个持有持久化的模块；这个要求沿装配链一路上浮到 `SelectedPostgresqlTaskExecutionProviderRuntime`
  // （SQLite 那一支用进程级单例、走同步 `claim(db)`，两支不再共用一个「可能没装配」的槽）。
  'modules/task-execution/composition/nodeMechanics.ts: marker=1, prose=0, holder=0',
  // RFC-359 W5-T19b 收敛：`taskEngineApplication.ts` marker 11 → 2 —— `driveTaskEngineApplication`
  // 的形参从 `RunTaskOptions`（九个装配依赖全可选 + 进门九句 `throw new Error('X-not-composed')`
  // + 一次自我收窄）改成 `BoundRunTaskOptions`，九句 throw 一起消失。三个调用点（PG / SQLite 两个
  // runtime participants + 测试 topology）本来就逐个显式交齐这九项，一字未改。
  // 剩下的 2 处不是同一回事，故意留着：`identity-access-runtime-not-composed` 走的是
  // `failRuntimeTask` 的领域收场（不是裸抛），而把 `identityAccess` 改必填实测会连坐 254 处
  // 编译错误（绝大多数是 legacy 测试夹具）；`dynamic-workflow-operations-not-composed` 是
  // **条件依赖**的 fail-closed（只有选了 dynamic-workflow 生成引擎的任务才需要它），
  // 不是「装配未完成」，只是错误码里恰好带 `not-composed` 才被本守卫计入。
  'modules/task-execution/composition/taskEngineApplication.ts: marker=2, prose=0, holder=0',
  // RFC-359 W11 销账：`server.ts` marker 6 → 1、holder 2 → 0。五处里三处是与 PG 根同一形状的
  // 词法环（`composeFallbackDevelopmentAutomation` 的 `automationRef`、`agentCatalogRef`、
  // `mcpCatalogRef`），改成直接闭包引用同作用域的 `const`；`collaborationContext` 同理，顺带
  // 把 `let … = deps.x` + `??=` 收成一个带显式类型标注的 `const`（标注是这个环的约束点：
  // 两边互相引用时推断转不出来，TS7022）。第五处 `task-execution-read-models-not-composed` 是
  // **关联不上的条件**造成的假占位：runtime 只在 `deps.taskExecutionReadModels === undefined` 时
  // 才装配，所以 `deps.taskExecutionReadModels ?? taskExecutionRuntime?.readModels` 的 undefined
  // 分支不可达，tsc 却关联不起这两个条件；把读模型提到 runtime 之前先定下来再交进去（
  // `composeTaskExecutionRuntime` 原样回传它，见 `composition/runtimeAssembly.ts`），空档消失。
  // 剩下的 1 处 `intent-resource-catalog-context-not-bound` 与 PG 根那处同源，是每请求的
  // WeakMap 旁路、不是装配缺口，理由见上面 PG 那条。
  // **顺带记一条守卫盲点**：`server.ts:2525` 有一处与 PG 根 `digitalEmployee.runtime === null`
  // 逐字同构的兜底，只因文案写成 `'task catalog requires the digital employee runtime'`
  // 而不带 `not-bound|not-composed`，marker 与 prose 两条判据都咬不到它。改名逃逸不是假想。
  'server.ts: marker=1, prose=0, holder=0',
]

const MARKER = /not-bound|not-composed/
const PROSE =
  /\b(?:is|are|was|were)\s+not\s+(?:yet\s+)?(?:bound|composed)\b|未绑定|尚未绑定|未装配|尚未装配|未组装/

/**
 * 扫描面：daemon 入口目录 `cli/**` + HTTP 侧装配点 `server.ts` + 任意 context 的
 * `composition.ts` / `composition/**`。
 *
 * **`server.ts` 是按名字点进来的**，因为它事实上就是 HTTP 侧的组合根——只是不叫
 * `composition*`。按目录/文件名划扫描面会正好把它漏掉，而它身上曾经挂着与账本里
 * 一模一样的形态：两个晚绑定 holder（MCP 目录与代理目录，后者与 `cli/start.ts` 里
 * 那个同款）+ 五句进门 throw。RFC-359 W11 把它们拆到只剩一处
 * `intent-resource-catalog-context-not-bound`（那处是每请求的 WeakMap 旁路，不是装配
 * 缺口）——**但扫描面不能因此收窄**：这个文件仍然在装配依赖并把它交给下游，
 * 而 `cli/start.ts` 里同款的 holder 一个没少。
 * 命名不是判据，装配职责才是：谁在装配依赖并把它交给下游，谁就进扫描面。
 */
const NAMED_ROOTS: ReadonlySet<string> = new Set(['server.ts'])

function isCompositionRoot(rel: string): boolean {
  if (NAMED_ROOTS.has(rel)) return true
  const segments = rel.split('/')
  if (segments[0] === 'cli') return true
  return segments.some(
    (segment, index) =>
      segment === 'composition' || (index === segments.length - 1 && segment === 'composition.ts'),
  )
}

/** 组合根语料——语料下限的分母（RFC-317 T13：扫空 = 假绿）。 */
export function compositionRootFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(SRC, dir), { withFileTypes: true })) {
      const rel = dir === '' ? entry.name : `${dir}/${entry.name}`
      if (entry.isDirectory()) walk(rel)
      else if (entry.name.endsWith('.ts') && isCompositionRoot(rel)) out.push(rel)
    }
  }
  walk('')
  return out.sort()
}

const isFunctionLike = (node: ts.Node): boolean =>
  ts.isFunctionDeclaration(node) ||
  ts.isFunctionExpression(node) ||
  ts.isArrowFunction(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isGetAccessorDeclaration(node) ||
  ts.isSetAccessorDeclaration(node) ||
  ts.isConstructorDeclaration(node)

/** 字面量文本；模板串取其静态片段（占位符对判据无意义）。注释永远取不到——这正是用 AST 的理由。 */
function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteralLike(node)) return node.text
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((span) => span.literal.text).join('')
  }
  return null
}

const isNullish = (node: ts.Node): boolean =>
  node.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(node) && node.text === 'undefined')

/** `expr` 是否在判 `name` 是否为空（`x === null` / `x == undefined` / `!x` / `x` / 及其 &&‖ 组合）。 */
function testsNullish(expr: ts.Expression, name: string): boolean {
  if (ts.isParenthesizedExpression(expr)) return testsNullish(expr.expression, name)
  if (ts.isBinaryExpression(expr)) {
    const operator = expr.operatorToken.kind
    if (
      operator === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      operator === ts.SyntaxKind.EqualsEqualsToken ||
      operator === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      operator === ts.SyntaxKind.ExclamationEqualsToken
    ) {
      const { left, right } = expr
      if (ts.isIdentifier(left) && left.text === name && isNullish(right)) return true
      if (ts.isIdentifier(right) && right.text === name && isNullish(left)) return true
      return false
    }
    if (
      operator === ts.SyntaxKind.AmpersandAmpersandToken ||
      operator === ts.SyntaxKind.BarBarToken
    ) {
      return testsNullish(expr.left, name) || testsNullish(expr.right, name)
    }
    return false
  }
  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.ExclamationToken) {
    return ts.isIdentifier(expr.operand) && expr.operand.text === name
  }
  return ts.isIdentifier(expr) && expr.text === name
}

/** 本层（不进入更内层函数）是否直接抛——嵌套函数里的 throw 属于它自己的调用时机。 */
function throwsInPlace(node: ts.Node | undefined): boolean {
  if (node === undefined) return false
  if (ts.isThrowStatement(node)) return true
  let found = false
  const walk = (inner: ts.Node): void => {
    if (found || isFunctionLike(inner)) return
    if (ts.isThrowStatement(inner)) {
      found = true
      return
    }
    ts.forEachChild(inner, walk)
  }
  ts.forEachChild(node, walk)
  return found
}

/** `let x: T | null = null` / `let x: T | undefined`：声明时为空、类型允许空。 */
function declaresEmptySlot(declaration: ts.VariableDeclaration): boolean {
  const startsEmpty = declaration.initializer === undefined || isNullish(declaration.initializer)
  if (!startsEmpty) return false
  if (declaration.type === undefined) {
    return declaration.initializer !== undefined && isNullish(declaration.initializer)
  }
  if (!ts.isUnionTypeNode(declaration.type)) return false
  return declaration.type.types.some(
    (member) =>
      member.kind === ts.SyntaxKind.UndefinedKeyword ||
      member.kind === ts.SyntaxKind.NullKeyword ||
      (ts.isLiteralTypeNode(member) && member.literal.kind === ts.SyntaxKind.NullKeyword),
  )
}

interface PlaceholderCounts {
  marker: number
  prose: number
  holder: number
}

function countPlaceholders(rel: string): PlaceholderCounts {
  const source = ts.createSourceFile(
    rel,
    readFileSync(join(SRC, rel), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  )
  const counts: PlaceholderCounts = { marker: 0, prose: 0, holder: 0 }

  const visit = (node: ts.Node): void => {
    const literal = literalText(node)
    if (literal !== null && MARKER.test(literal)) counts.marker += 1

    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Error'
    ) {
      const argument = node.arguments?.[0]
      const message = argument === undefined ? null : literalText(argument)
      if (message !== null && PROSE.test(message) && !MARKER.test(message)) counts.prose += 1
    }

    if (ts.isVariableStatement(node) && node.declarationList.flags & ts.NodeFlags.Let) {
      for (const declaration of node.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaresEmptySlot(declaration)) continue
        const name = declaration.name.text

        // 声明所在的作用域根：最近的外层函数，没有就是整个文件。
        let scopeRoot: ts.Node = node
        while (scopeRoot.parent !== undefined && !isFunctionLike(scopeRoot)) {
          scopeRoot = scopeRoot.parent
        }

        let assignedLater = false
        let failsClosedInClosure = false
        const scan = (inner: ts.Node, depth: number): void => {
          if (
            ts.isBinaryExpression(inner) &&
            inner.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isIdentifier(inner.left) &&
            inner.left.text === name
          ) {
            assignedLater = true
          }
          if (depth > 0) {
            if (ts.isIfStatement(inner) && testsNullish(inner.expression, name)) {
              if (throwsInPlace(inner.thenStatement) || throwsInPlace(inner.elseStatement)) {
                failsClosedInClosure = true
              }
            }
            if (ts.isConditionalExpression(inner) && testsNullish(inner.condition, name)) {
              if (ts.isThrowStatement(inner.whenTrue) || ts.isThrowStatement(inner.whenFalse)) {
                failsClosedInClosure = true
              }
            }
          }
          ts.forEachChild(inner, (child) => scan(child, isFunctionLike(inner) ? depth + 1 : depth))
        }
        // 作用域根自己若是函数，它的直系语句仍算 depth 0（直线代码，不是逃逸闭包）。
        scan(scopeRoot, isFunctionLike(scopeRoot) ? -1 : 0)

        if (assignedLater && failsClosedInClosure) counts.holder += 1
      }
    }

    ts.forEachChild(node, visit)
  }
  visit(source)
  return counts
}

function scan(): string[] {
  const rows: string[] = []
  for (const rel of compositionRootFiles()) {
    const { marker, prose, holder } = countPlaceholders(rel)
    if (marker + prose + holder === 0) continue
    rows.push(`${rel}: marker=${marker}, prose=${prose}, holder=${holder}`)
  }
  return rows.sort()
}

describe('RFC-359 W5-T19b —— 组合根全量装配（占位与晚绑定 holder 只降不升）', () => {
  test('语料非空：确实扫到了组合根（扫成 0 说明扫描根或过滤器失效，此刻零预言力）', () => {
    const files = compositionRootFiles()
    expect(files.length).toBeGreaterThanOrEqual(150)
    // 三部分都要在：塌了任意一块，那一块此刻不设防而账本还是绿的。
    expect(
      files.some((rel) => rel.startsWith('cli/')),
      '扫描面丢了 cli/ 这一块',
    ).toBe(true)
    expect(
      files.some((rel) => rel.includes('composition')),
      '扫描面丢了 composition 这一块',
    ).toBe(true)
    // `server.ts` 是唯一按名字点进来的根：改名 / 拆分都会让它悄悄掉出扫描面，
    // 而它身上真的挂着债——所以这里点名断言，不靠上面两条模式匹配兜底。
    for (const named of NAMED_ROOTS) {
      expect(files, `扫描面丢了按名字点入的组合根 ${named}`).toContain(named)
    }
  })

  test('逐文件占位计数与账本逐字相等（增了是新占位，减了是拆除，都要改账本）', () => {
    expect(
      scan(),
      '组合根的占位计数（marker / prose / holder）与账本不符。\n' +
        '**增**了：有人往组合根里放了一个「装配时先留空、运行期再补」的依赖——' +
        '那正是 RFC-359 W1-T1 修掉的形状（PG daemon 每 tick 抛 `*-not-bound`，' +
        '同一段业务在 SQLite 上却一直正常）。改法是把依赖变成组合根的构造参数，' +
        '让「没装配」在类型层不可表达；装配环打在接口而不是实例上。' +
        '确有理由保留就把新增写进账本并说明为什么这个槽必须晚绑。\n' +
        '**减**了：拆除发生了——把账本一起改小，让这次收敛留下一次有署名的提交记录。',
    ).toEqual([...COMPOSITION_ROOT_PLACEHOLDER_DEBT])
  })

  test('账本按路径字典序、无重复（清点稳定的前提）', () => {
    const paths = COMPOSITION_ROOT_PLACEHOLDER_DEBT.map((row) => row.slice(0, row.indexOf(': ')))
    expect(new Set(paths).size, '账本里有重复路径').toBe(paths.length)
    expect([...paths].sort()).toEqual(paths)
  })
})

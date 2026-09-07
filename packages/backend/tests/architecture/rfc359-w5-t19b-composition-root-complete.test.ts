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
  'cli/daemonRealtimePolicy.ts: marker=1, prose=0, holder=1',
  'cli/package.ts: marker=1, prose=0, holder=0',
  'cli/postgresqlDaemonApplication.ts: marker=9, prose=0, holder=3',
  'cli/start.ts: marker=10, prose=0, holder=5',
  'modules/collaboration/composition/commandContext.ts: marker=0, prose=6, holder=0',
  'modules/collaboration/composition/reviewNodeReviewerDependencies.ts: marker=0, prose=1, holder=0',
  'modules/development-automation/composition/activityOperations.ts: marker=1, prose=0, holder=1',
  'modules/digital-employee/composition.ts: marker=0, prose=1, holder=0',
  'modules/integration/composition.ts: marker=0, prose=1, holder=1',
  'modules/task-execution/composition.ts: marker=0, prose=1, holder=0',
  'modules/task-execution/composition/nodeMechanics.ts: marker=1, prose=0, holder=0',
  'modules/task-execution/composition/taskEngineApplication.ts: marker=11, prose=0, holder=0',
  'server.ts: marker=6, prose=0, holder=2',
]

const MARKER = /not-bound|not-composed/
const PROSE =
  /\b(?:is|are|was|were)\s+not\s+(?:yet\s+)?(?:bound|composed)\b|未绑定|尚未绑定|未装配|尚未装配|未组装/

/**
 * 扫描面：daemon 入口目录 `cli/**` + HTTP 侧装配点 `server.ts` + 任意 context 的
 * `composition.ts` / `composition/**`。
 *
 * **`server.ts` 是按名字点进来的**，因为它事实上就是 HTTP 侧的组合根——只是不叫
 * `composition*`。按目录/文件名划扫描面会正好把它漏掉，而它身上挂着与账本里
 * 一模一样的形态（`intent-resource-catalog-context-not-bound`、两个
 * `mcpCatalogRef` / `agentCatalogRef` 晚绑定 holder，后者与 `cli/start.ts` 里
 * 那个同款）。命名不是判据，装配职责才是：谁在装配依赖并把它交给下游，谁就进扫描面。
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

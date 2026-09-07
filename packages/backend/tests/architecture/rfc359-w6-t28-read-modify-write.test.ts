// RFC-359 W6-T28 —— 事务内「读—改—写、中间不锁」的高水位账本（只降不升）。
//
// 这条守卫挡的是什么
// ---------------------------------------------------------------------------
// design §10.1 的原话：**一份实现必须按两个引擎里更弱的隔离写**。SQLite 的写事务是
// `BEGIN IMMEDIATE`——全库独占，于是「先 SELECT 读出一行、在内存里算出新值、再 UPDATE 写回」
// 这种形状在它上面**碰巧**永远正确：读和写之间没有任何别的写者能挤进来。同一段代码搬到
// PostgreSQL 的 READ COMMITTED 上就是标准的**丢更新**：两笔事务各读到 `revision = 7`，
// 各算出 8，各写回 8，第二次覆盖第一次，两次业务操作只留下一次的效果，**且不报任何错**。
//
// 正解只有两种（design §10.1）：
//   · `engineOf(tx).lockAggregateRoot(tx, 表, 表.id, id)` —— PG 渲染 `select … for update`
//     取聚合根行锁，SQLite 上是 no-op（它本来就独占）。读之前先锁，读—改—写整段被串行化。
//   · **CAS 谓词** —— 把读到的旧值写进 UPDATE 的 `where`（`where(and(eq(t.id, id),
//     eq(t.revision, current.revision)))`），命中 0 行即冲突。乐观并发，同样是正确形状。
// 本仓两种正解都有大量既有用例，账本外的代码就是靠它们才没进账本。
//
// 「合一时必须改形状，不能原样搬」——plan.md §5b W6-T28 的原话。这条账本把「还剩多少」
// 变成可计数、可防守的量：**增**了红（又搬了一处 SQLite-only 的形状过来），**减**了也红
// （收敛发生了，把账本一起改小，让每一次减少留下一次有署名的提交记录）。
//
// ---------------------------------------------------------------------------
// 判据：刻意窄。窄而真咬人，好过宽而满是误报
// ---------------------------------------------------------------------------
// 「读—改—写」的可靠识别做不到低误报——本仓大量**正确**代码长得跟它很像（读一行只为
// 校验存在性 / 权限，然后写入与读值无关的新内容）。所以这里只认一个能确信的子集：
//
//   **读出的值被用于计算写回同一张表的新值，而 UPDATE 的 `where` 里不含该值。**
//
// 逐条拆开（全部走 AST，不是文本——注释里出现 `lockAggregateRoot` 不算数）：
//
//   ① **事务作用域** = 任何**形参名为 `tx` / `transaction`** 的函数体。本仓的事务句柄
//      恒定这两个名字，于是这一条同时罩住两种形态：`session.transaction(async (tx) => …)` /
//      `dbTxSync(db, (tx) => …)` / `runResourceCatalogTransaction(db, async (tx) => …)` 这类
//      **回调**，以及 `function fooTx(tx, input)` 这类**接过句柄的助手**。按 opener 名字
//      枚举做不到后者，而助手里恰恰躺着相当一部分债（`reserveAggregateSequenceTx` 即是）。
//   ② **读** = 同一作用域里 `const X = [await] …select(…)…from(表)…` 且 `表` 是标识符。
//   ③ **写** = 同一作用域里、位置在读**之后**的 `…update(同一个表).set({ … })`。
//      `.set(…)` **必须是对象字面量**：不是字面量就读不出「写了哪几列」，也就无从判断
//      CAS，宁可整条放过（见下「放弃的形态」）。
//   ④ **读值流进了写值**：`.set({…})` 的子树引用了读变量，或引用了同作用域内**由它派生**
//      的局部（`const next = current.revision + 1` → `set({ revision: next })`）。派生传播
//      **不穿过另一次数据库读**——`const old = tx.select()…where(eq(t.id, intent.taskId))`
//      里的 `intent` 只是查询键，`old` 不是「由 intent 算出来的值」。少了这一条，
//      `sqliteTaskOwnership` / `postgresqlTaskOwnershipPersistence` 两处正确的 CAS 会被误报
//      （实测，是本判据成型过程中最先撞到的假阳）。
//   ⑤ **没有串行化手段**：作用域里没有出现 `lockAggregateRoot` / `advisoryLock` /
//      `claimRows`，没有裸 `for update` 模板，
//      没有 owner 行 CAS 围栏（`fenceTaskWrite` / `assertTaskOwner*Tx`——它们对同一任务的
//      并发写手就是一把锁：都要 CAS 推进同一行 owner 的 revision，第二个必然落空），
//      且 opener 不是 `serializable` / `withTaskExecutionSerializable` /
//      `withPostgresqlTaskAggregateTransaction`（前两者抬到 SERIALIZABLE，后者在事务头对
//      task 行取聚合根锁——RFC-359 W11 起它走的正是 `lockAggregateRoot`，T20 账本上那笔
//      「裸写 for update 而不是调 capabilities」的债随之销掉）。
//   ⑥ **没有 CAS 谓词**：`where(…)` 既不引用读变量（含派生名），写进 `.set({…})` 的列名
//      也不出现在 `where(…)` 对同一张表的列引用里。第二半是必需的——`legacy/workflow.ts`
//      的 `set({ version: currentRow.version + 1 }).where(and(eq(w.id, id),
//      eq(w.version, expectedVersion)))` 是**教科书式乐观并发**，只是 CAS 的右值写的是
//      请求带来的 `expectedVersion`（此前已断言等于 `currentRow.version`）而不是读变量本身。
//      只看「where 里有没有读变量」会把它误报掉。
//
// **放弃的形态**（都属于「读—改—写」的大类，但可靠识别不到，宁缺毋滥）：
//   · **读—判—写**（读一行只为断言状态，再写入与读值无关的新内容）。它同样是 PG 上的
//     TOCTOU，但正确写法往往把判据挪进 `where` 的字面量（`eq(t.status, 'pending')`），
//     与「完全没设防」在 AST 上区分不开，扫出来 90+ 条里绝大多数是噪音。
//   · **`.set(<函数调用>)`**：读不出写了哪几列 ⇒ 判不了 CAS。真实例子
//     `updateAgentPersistenceValues(current, patch, …)`，它其实是带 CAS 的正确代码。
//   · **跨函数**：读在 A、写在 B、锁在调用方 C。本守卫只在单个作用域内配对。
//   · **`delete`**：没有 `.set(…)`，第 ④ 条判据无从谈起。
//   · **解构绑定的读**（`const [row] = await tx.select()…`）与非标识符表达式的表名。
//
// ---------------------------------------------------------------------------
// 今天的 20 处（W6-T28 的工作清单，逐条改成 lockAggregateRoot 或补 CAS 谓词）
// ---------------------------------------------------------------------------
// 行号是落账当天的快照，会漂；表名与变量名不会。
//
//   modules/resource-catalog/infrastructure/mcpRuntimeTestPersistence.ts  8 处（原 10，W8-T28 减 2）
//     :160  mcpRuntimeTestTurns   captureEventBytes = turn.eventBytes + payloadBytes（累加器）
//     :1311 :1446 :1477 :1736 :1873 :1944
//           mcpRuntimeTestSessions  sessionVersion = 读到的行.sessionVersion + 1（版本自增）
//     :1695 mcpRuntimeTestTurns   cancelRequestedAt = turn.cancelRequestedAt ?? fenceAt
//     —— 剩下这 8 处**逐处实测判过不可达**，见 `tests/rfc359-w8-t28-mcp-runtime-lost-update.test.ts`
//        的头注释与其中两条「不可达证据」：它们全部位于 `runResourceCatalogTransaction` 里，而它
//        等于 `databaseSessionFor(db).serializable(...)`——PG 上是 SERIALIZABLE + 40001 整笔重放，
//        SQLite 上是 BEGIN IMMEDIATE 独占，丢更新在这里发生不了（把 opener 降成
//        `session.transaction` 后那两条证据**只在 PostgreSQL 上**立刻红）。本守卫的 opener 判据
//        只认 `serializable` 这个名字，认不出 `runResourceCatalogTransaction` 这层包装，所以仍记账。
//        原 `:644 :685`（acceptMessage）**是可达的**、且用户看得到：两个标签页同时发消息时两笔
//        事务读到同一个 turnSeq，都插 `seq = n + 1`，PG 上后一笔撞唯一键抛 23505（不是 40001、
//        不被重试）冒成 500，SQLite 上则是干净的 409。W8-T28 已按 §10.1 加 `lockAggregateRoot` 修掉。
//   modules/collaboration/infrastructure/clarifyRounds.ts     1 处
//     :605  clarifyRounds —— 读出 draftAnswersJson 反序列化、塞一条、整个写回（JSON 合并）
//   modules/intent/infrastructure/postgresqlIntentApplyOperations.ts      1 处
//     :349  intentSessions —— commitSeq / contextManifestJson 由 sessionRow 算出后写回
//     —— **不可达**（W8-T28 实测判定）：`apply` 的每一条入口都先过
//        `applyLock.run(sessionId, …)`（`application/sessionApplyLock.ts`，同 sessionId 排成一条
//        Promise 链），而 daemon 是 flock 单实例的单进程。同一个 session 的两笔 apply 因此不可能
//        同时进这笔事务；不同 session 各写各的行。SQLite provider 走的是同一把锁、同一个算法。
//   platform/events/committed/sqliteStore.ts                              1 处
//     :198  committedEventAggregateHeads —— lastSeq = (head.lastSeq ?? 0) + 1（序号分配）
//     —— **不可达且即将退役**（W8-T28 实测判定）：`reserveAggregateSequenceTx` 的句柄类型是
//        `DbTxSync`＝bun:sqlite 的**同步**事务面，PostgreSQL 客户端根本产生不出这种句柄，这条
//        代码在 PG 上一次都不会执行；SQLite 上它在 `BEGIN IMMEDIATE` 独占里。provider-中立的
//        那一份 append（`platform/events/committed/append.ts`）早已改用
//        `engineOf(tx).advisoryLock`。本文件只为两个还挂在 `dbTxSync` 上的参与者
//        （`collaborationCommittedEventParticipant.ts` / `taskLifecycleEventParticipant.ts`）活着，
//        随它们迁到 `DatabaseSession` 一起删；不给一段即将退役的代码加锁。
//
// ---------------------------------------------------------------------------
// W8-T28 这一刀（可达的 6 处已修，账本相应减 5 个文件）
// ---------------------------------------------------------------------------
// 判据只有一条：**两笔并发能不能让用户看到错的结果**。能，就先写一条把错结果演出来的双引擎
// 用例（`tests/rfc359-w8-t28-lost-update.test.ts`，L1–L6），再按 §10.1 加 `lockAggregateRoot`。
// 六处的变异验证结论一致：**去掉锁后只在 PostgreSQL 上红，SQLite 上前后都绿**——SQLite 会话是
// 进程内单写者租约 + `BEGIN IMMEDIATE`，这一族债在它上面结构性不成立。
//
//   modules/digital-employee/infrastructure/runtimeStore.ts               2 处 → 0
//     blockCase / terminateCase —— revision = current.revision + 1，且 `state` 判据来自同一次读。
//     错结果：并发 terminate + block 后，「终止」已回 200，案件却带着 terminalKind 变回可 resume
//     的 blocked；两笔并发 terminate 则让案件行与生命周期事件说两种终止原因（事件的 id/dedupeKey
//     由 (caseId, revision) 决定，后一条被去重悄悄丢掉）。
//     （同文件的 recordMetering / replaceCaseMembers 早就先 lockAggregateRoot，是正解范本）
//   modules/event-center/infrastructure/eventStore.ts                     2 处 → 0
//     :1228 :1362 observerActivations —— nextScanAt 由 activation.wakeEpoch 决定；
//           where 只围 leaseEpoch，而 wakeEpoch 是**不持租约**的 nudge 路径在写。
//     错结果：跑到一半来的 nudge 被结算抹掉，下一次扫描被推到整整一个 poll 间隔之后。
//   modules/memory/infrastructure/memoryCatalogOperations.ts              1 处 → 0
//     :711  memories —— version = max(被 supersede 行的 version) + 1，`status === 'candidate'`
//     的裁决判据也来自同一次读。错结果：两个管理员同时批准 / 拒绝同一条候选记忆，**双双拿到
//     200**，库里只留后写的那个。
//   modules/task-execution/infrastructure/taskRecoveryOperations.ts       1 处 → 0
//     :669  tasks —— autoRecoveryAttempts 滑动窗口计数自增。错结果：auto-repair 与
//     heartbeat-kill 两条 loop 同时盯上一个任务时计数少记，用户配的
//     `maxAutoRecoveriesPerWindow` 闸门永不跳闸，任务被无限自动重跑。
//   services/taskDelete.ts                                                1 处 → 0
//     :321  tasks —— branchStartedAt = max(parent.startedAt, MAX(子.branchStartedAt))。
//     每任务写锁按**被删的**那个 taskId 分片，同父的两个兄弟同时删走的是两把不同的锁。
//     错结果：父行的物化列永久停在已删子树的时间戳上，默认任务列表（按物化列排序）与任一
//     过滤视图（现算）从此行序不同且永不收敛——正是这段代码原本要闭合的 bug 换了个入口复发。

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import ts from 'typescript'

const SRC = resolve(import.meta.dir, '..', '..', 'src')

// ---------------------------------------------------------------------------
// 判据（纯函数：只吃「路径 + 源码文本」，不碰磁盘，负 fixture 直接喂它）
// ---------------------------------------------------------------------------

/** 事务句柄的形参名。本仓恒定这两个。 */
const TX_HANDLE_NAMES: ReadonlySet<string> = new Set(['tx', 'transaction'])

/** 出现其一即认为该事务作用域已经把并发写手串起来了。 */
const SERIALIZING_CALLEES: ReadonlySet<string> = new Set([
  'lockAggregateRoot',
  'advisoryLock',
  'claimRows',
  // owner 行 CAS 围栏：同任务的并发写手都要推进同一行 owner 的 revision，第二个落空。
  'fenceTaskWrite',
  'assertTaskOwnerTx',
  'assertTaskOwnerlessTx',
  'assertPostgresqlTaskOwnerTx',
  'assertPostgresqlTaskOwnerlessTx',
])

/** 这些 opener 自带更强的隔离：抬到 SERIALIZABLE，或在事务头就锁了聚合根行。 */
const SERIALIZING_OPENERS: ReadonlySet<string> = new Set([
  'serializable',
  'withTaskExecutionSerializable',
  'withPostgresqlTaskAggregateTransaction',
])

const READ_CALLEES: ReadonlySet<string> = new Set(['select', 'selectDistinct'])
const DB_CHAIN_CALLEES: ReadonlySet<string> = new Set([
  'select',
  'selectDistinct',
  'update',
  'insert',
  'delete',
])

type FunctionNode =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration

/** 一处「读—改—写、中间不锁」。`table` / `readVariable` 稳定，`line` 会随编辑漂。 */
export interface ReadModifyWriteSite {
  /** UPDATE 所在行（1 起算）。 */
  readonly line: number
  /** 被读又被写的那张表（drizzle 表标识符）。 */
  readonly table: string
  /** 读出来的那个变量名。 */
  readonly readVariable: string
  /** 读所在行（1 起算）。 */
  readonly readLine: number
}

function isFunctionNode(node: ts.Node): node is FunctionNode {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  )
}

function calleeName(node: ts.CallExpression): string | null {
  const target = node.expression
  if (ts.isIdentifier(target)) return target.text
  if (ts.isPropertyAccessExpression(target)) return target.name.text
  return null
}

function takesTransactionHandle(fn: FunctionNode): boolean {
  return fn.parameters.some((parameter) => {
    if (ts.isIdentifier(parameter.name)) return TX_HANDLE_NAMES.has(parameter.name.text)
    if (ts.isObjectBindingPattern(parameter.name)) {
      return parameter.name.elements.some(
        (element) => ts.isIdentifier(element.name) && TX_HANDLE_NAMES.has(element.name.text),
      )
    }
    return false
  })
}

/** 流式链的顶：`tx.update(t)` → `tx.update(t).set({…}).where(…).run()`。 */
function chainRoot(call: ts.CallExpression): ts.Node {
  let node: ts.Node = call
  for (;;) {
    const parent: ts.Node | undefined = node.parent
    if (parent === undefined) return node
    if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
      node = parent
      continue
    }
    if (ts.isCallExpression(parent) && parent.expression === node) {
      node = parent
      continue
    }
    return node
  }
}

interface ChainCall {
  readonly method: string
  readonly call: ts.CallExpression
}

/** 链上每一段 `.m(…)`。`await` / 括号透明。 */
function chainCalls(root: ts.Node): ChainCall[] {
  const out: ChainCall[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isAwaitExpression(node) || ts.isParenthesizedExpression(node)) {
      visit(node.expression)
      return
    }
    if (ts.isCallExpression(node)) {
      const method = calleeName(node)
      if (method !== null) out.push({ method, call: node })
      const target = node.expression
      if (ts.isPropertyAccessExpression(target)) visit(target.expression)
      return
    }
    if (ts.isPropertyAccessExpression(node)) visit(node.expression)
  }
  visit(root)
  return out.reverse()
}

/** `from(表)` / `update(表)` 的表名——只认光秃秃一个标识符。 */
function tableArgument(call: ts.CallExpression | undefined): string | null {
  const argument = call?.arguments[0]
  if (argument !== undefined && ts.isIdentifier(argument)) return argument.text
  return null
}

function referencesAny(node: ts.Node | undefined, names: ReadonlySet<string>): boolean {
  if (node === undefined) return false
  let hit = false
  const visit = (child: ts.Node): void => {
    if (hit) return
    if (ts.isIdentifier(child) && names.has(child.text)) {
      hit = true
      return
    }
    ts.forEachChild(child, visit)
  }
  visit(node)
  return hit
}

/** `.set({ a: …, b })` 写了哪几列。 */
function writtenColumns(setArgument: ts.ObjectLiteralExpression): ReadonlySet<string> {
  const out = new Set<string>()
  for (const property of setArgument.properties) {
    if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)) {
      out.add(property.name.text)
    } else if (ts.isShorthandPropertyAssignment(property)) {
      out.add(property.name.text)
    }
  }
  return out
}

/** `where(…)` 里对目标表的列引用（`表.列`）。 */
function fencedColumns(whereArguments: readonly ts.Node[], table: string): ReadonlySet<string> {
  const out = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === table
    ) {
      out.add(node.name.text)
    }
    ts.forEachChild(node, visit)
  }
  for (const argument of whereArguments) visit(argument)
  return out
}

interface ScopedRead {
  readonly variable: string
  readonly table: string
  readonly position: number
  readonly line: number
  readonly scope: ts.Node
}

interface ScopedWrite {
  readonly table: string
  readonly position: number
  readonly line: number
  readonly scope: ts.Node
  readonly setArgument: ts.ObjectLiteralExpression
  readonly whereArguments: readonly ts.Node[]
}

/**
 * 一个文件里全部「读—改—写、中间不锁」的位置。判据见文件头注释；纯函数，负 fixture 直接喂它。
 */
export function readModifyWriteSites(path: string, text: string): ReadModifyWriteSite[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

  // ① 事务作用域：形参里有事务句柄的函数体。
  const scopes: ts.Node[] = []
  const serialized = new Set<ts.Node>()
  const collectScopes = (node: ts.Node): void => {
    if (isFunctionNode(node) && takesTransactionHandle(node) && node.body !== undefined) {
      scopes.push(node.body)
      const parent: ts.Node | undefined = node.parent
      const opener = parent !== undefined && ts.isCallExpression(parent) ? calleeName(parent) : null
      if (opener !== null && SERIALIZING_OPENERS.has(opener)) serialized.add(node.body)
    }
    ts.forEachChild(node, collectScopes)
  }
  collectScopes(source)
  if (scopes.length === 0) return []

  const enclosingScope = (node: ts.Node): ts.Node | null => {
    let current: ts.Node | undefined = node
    while (current !== undefined) {
      if (scopes.includes(current)) return current
      current = current.parent
    }
    return null
  }

  const reads: ScopedRead[] = []
  const writes: ScopedWrite[] = []
  /** 作用域 → (局部名 → 初始化式)。**不含**数据库调用的初始化式，见判据 ④。 */
  const locals = new Map<ts.Node, Map<string, ts.Node>>()

  const visit = (node: ts.Node): void => {
    // ⑤ 串行化手段
    if (ts.isCallExpression(node)) {
      const name = calleeName(node)
      if (name !== null && SERIALIZING_CALLEES.has(name)) {
        const scope = enclosingScope(node)
        if (scope !== null) serialized.add(scope)
      }
    }
    if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      if (/\bfor\s+update\b/i.test(node.getText(source))) {
        const scope = enclosingScope(node)
        if (scope !== null) serialized.add(scope)
      }
    }

    // ② 读 + 派生传播的种子表
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      const scope = enclosingScope(node)
      if (scope !== null) {
        const chain = chainCalls(node.initializer)
        const isDatabaseChain = chain.some((entry) => DB_CHAIN_CALLEES.has(entry.method))
        if (!isDatabaseChain) {
          const known = locals.get(scope) ?? new Map<string, ts.Node>()
          known.set(node.name.text, node.initializer)
          locals.set(scope, known)
        }
        const table = tableArgument(chain.find((entry) => entry.method === 'from')?.call)
        if (chain.some((entry) => READ_CALLEES.has(entry.method)) && table !== null) {
          reads.push({
            variable: node.name.text,
            table,
            position: node.getStart(source),
            line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
            scope,
          })
        }
      }
    }

    // ③ 写
    if (ts.isCallExpression(node) && calleeName(node) === 'update') {
      const table = tableArgument(node)
      const scope = table === null ? null : enclosingScope(node)
      if (scope !== null && table !== null) {
        const chain = chainCalls(chainRoot(node))
        const setArgument = chain.find((entry) => entry.method === 'set')?.call.arguments[0]
        if (setArgument !== undefined && ts.isObjectLiteralExpression(setArgument)) {
          writes.push({
            table,
            position: node.getStart(source),
            line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
            scope,
            setArgument,
            whereArguments: chain
              .filter((entry) => entry.method === 'where')
              .flatMap((entry) => [...entry.call.arguments]),
          })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)

  /** 读变量 + 同作用域内由它派生的局部名（判据 ④）。 */
  const derivedFrom = (scope: ts.Node, seed: string): ReadonlySet<string> => {
    const names = new Set<string>([seed])
    const known = locals.get(scope) ?? new Map<string, ts.Node>()
    for (let round = 0; round < known.size + 1; round += 1) {
      let grew = false
      for (const [name, initializer] of known) {
        if (names.has(name)) continue
        if (referencesAny(initializer, names)) {
          names.add(name)
          grew = true
        }
      }
      if (!grew) break
    }
    return names
  }

  const out: ReadModifyWriteSite[] = []
  for (const write of writes) {
    if (serialized.has(write.scope)) continue
    const candidates = reads.filter(
      (read) =>
        read.table === write.table && read.position < write.position && read.scope === write.scope,
    )
    if (candidates.length === 0) continue

    // ⑥ CAS：写进 set 的列出现在 where 对同一张表的列引用里。
    const fenced = fencedColumns(write.whereArguments, write.table)
    if ([...writtenColumns(write.setArgument)].some((column) => fenced.has(column))) continue

    const offending = candidates.filter((read) => {
      const names = derivedFrom(write.scope, read.variable)
      if (!referencesAny(write.setArgument, names)) return false // ④ 读值没流进写值
      // ⑥ CAS 的另一半：where 直接带上了读到的旧值。
      return !write.whereArguments.some((argument) => referencesAny(argument, names))
    })
    const first = offending[0]
    if (first === undefined) continue
    out.push({
      line: write.line,
      table: write.table,
      readVariable: first.variable,
      readLine: first.line,
    })
  }
  return out.sort((left, right) => left.line - right.line)
}

// ---------------------------------------------------------------------------
// 语料 + 账本
// ---------------------------------------------------------------------------

/** 扫到的全部 backend 源文件——语料下限的分母（RFC-317 T13：扫空 = 假绿）。 */
const CORPUS_FILES: readonly string[] = (() => {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(SRC, dir), { withFileTypes: true })) {
      const rel = dir === '' ? entry.name : `${dir}/${entry.name}`
      if (entry.isDirectory()) walk(rel)
      else if (entry.name.endsWith('.ts')) out.push(rel)
    }
  }
  walk('')
  return out.sort()
})()

/** `<相对 src 的路径>: <未加锁的读—改—写处数>`，按路径字典序。只降不升。 */
export const READ_MODIFY_WRITE_DEBT: readonly string[] = [
  'modules/intent/infrastructure/postgresqlIntentApplyOperations.ts: 1',
  // W8-T28：`acceptMessage` 的两处已按 §10.1 取会话聚合根行锁修掉（10 → 8）。剩下 8 处实测不可达，
  // 理由见上面清单里那段与 `tests/rfc359-w8-t28-mcp-runtime-lost-update.test.ts` 的头注释。
  'modules/resource-catalog/infrastructure/mcpRuntimeTestPersistence.ts: 8',
  'platform/events/committed/sqliteStore.ts: 1',
]

interface ScannedFile {
  readonly path: string
  readonly sites: readonly ReadModifyWriteSite[]
}

function scan(): ScannedFile[] {
  const out: ScannedFile[] = []
  for (const rel of CORPUS_FILES) {
    const sites = readModifyWriteSites(rel, readFileSync(join(SRC, rel), 'utf8'))
    if (sites.length > 0) out.push({ path: rel, sites })
  }
  return out
}

const SCANNED = scan()

function ledgerRows(scanned: readonly ScannedFile[]): string[] {
  return scanned.map((file) => `${file.path}: ${String(file.sites.length)}`).sort()
}

function detail(scanned: readonly ScannedFile[]): string {
  return scanned
    .flatMap((file) =>
      file.sites.map(
        (site) =>
          `  ${file.path}:${String(site.line)} —— update(${site.table}) 写回 ` +
          `${site.readVariable}@${String(site.readLine)} 读到的值`,
      ),
    )
    .join('\n')
}

// ---------------------------------------------------------------------------
// 守卫
// ---------------------------------------------------------------------------

describe('RFC-359 W6-T28 —— 事务内「读—改—写、中间不锁」只降不升', () => {
  test('语料非空：确实扫到了整棵 backend 源码树（扫成 0 说明扫描根失效，此刻零预言力）', () => {
    expect(CORPUS_FILES.length).toBeGreaterThanOrEqual(1500)
  }, 60_000)

  test('逐文件处数与账本逐字相等（增了是新搬来的 SQLite-only 形状，减了是收敛，都要改账本）', () => {
    expect(
      ledgerRows(SCANNED),
      '事务内「读—改—写、中间不锁」的逐文件处数与账本不符。\n' +
        '**增**了说明有人把一段只在 SQLite 的 `BEGIN IMMEDIATE` 独占下才碰巧正确的形状搬了过来——' +
        '在 PostgreSQL 的 READ COMMITTED 上它是丢更新，而且不报任何错。两种正解任选其一：\n' +
        '  · 读之前先 `await engineOf(tx).lockAggregateRoot(tx, 表, 表.id, id)`（PG 渲染 ' +
        '`select … for update`，SQLite 上 no-op）；\n' +
        '  · 或补 CAS 谓词：把读到的旧值写进 UPDATE 的 `where`' +
        '（`where(and(eq(表.id, id), eq(表.revision, 读到的.revision)))`），命中 0 行即冲突。\n' +
        '**减**了说明收敛发生了——把账本一起改小，让这次减少留下一次有署名的提交记录。\n' +
        '当前扫描结果逐条：\n' +
        detail(SCANNED),
    ).toEqual([...READ_MODIFY_WRITE_DEBT])
  }, 60_000)

  test('账本按路径字典序、无重复（清点稳定的前提）', () => {
    const paths = READ_MODIFY_WRITE_DEBT.map((row) => row.slice(0, row.lastIndexOf(':')))
    expect(new Set(paths).size, '账本里有重复路径').toBe(paths.length)
    expect([...paths].sort()).toEqual(paths)
  }, 30_000)
})

// ---------------------------------------------------------------------------
// 负 fixture：判据自己必须有牙齿（RFC-317 T14）
// ---------------------------------------------------------------------------
//
// 语料下限挡的是「扫了个寂寞」；这一节挡的是另一半——语料还在，但 matcher 不咬了。
// 三段伪造源码：一段真债、两段正解，喂给 `readModifyWriteSites` 自己。全部内存字符串，
// 不落磁盘、不依赖仓里某个文件恰好保持某形状。

/** 真债：读出 revision，算出 revision + 1 写回，既没锁也没 CAS。 */
const DEBT_FIXTURE = `
export function bump(tx: Tx, id: string) {
  return session.transaction(async (tx) => {
    const current = await tx.select().from(cases).where(eq(cases.id, id)).get()
    if (current === undefined) throw new NotFoundError('nope')
    const next = current.revision + 1
    await tx.update(cases).set({ state: 'blocked', revision: next }).where(eq(cases.id, id)).run()
  })
}
`

/** 正解 A：读之前先取聚合根行锁。 */
const LOCKED_FIXTURE = `
export function bump(tx: Tx, id: string) {
  return session.transaction(async (tx) => {
    await engineOf(tx).lockAggregateRoot(tx, cases, cases.id, id)
    const current = await tx.select().from(cases).where(eq(cases.id, id)).get()
    if (current === undefined) throw new NotFoundError('nope')
    const next = current.revision + 1
    await tx.update(cases).set({ state: 'blocked', revision: next }).where(eq(cases.id, id)).run()
  })
}
`

/** 正解 B：乐观并发——把读到的旧 revision 写进 where。 */
const CAS_FIXTURE = `
export function bump(tx: Tx, id: string) {
  return session.transaction(async (tx) => {
    const current = await tx.select().from(cases).where(eq(cases.id, id)).get()
    if (current === undefined) throw new NotFoundError('nope')
    const next = current.revision + 1
    const changed = await tx
      .update(cases)
      .set({ state: 'blocked', revision: next })
      .where(and(eq(cases.id, id), eq(cases.revision, current.revision)))
      .returning({ id: cases.id })
      .get()
    if (changed === undefined) throw new ConflictError('stale')
  })
}
`

describe('RFC-359 W6-T28 —— 判据的负 fixture（matcher 不咬了 ⇒ 违规集合同样回到空）', () => {
  test('真债被报出：读出 revision、算出新值写回，既没锁也没 CAS', () => {
    const sites = readModifyWriteSites('fixture-debt.ts', DEBT_FIXTURE)
    expect(sites.map((site) => `${site.table}<-${site.readVariable}`)).toEqual(['cases<-current'])
  }, 30_000)

  test('正解 A 不被报出：读之前 lockAggregateRoot', () => {
    expect(readModifyWriteSites('fixture-locked.ts', LOCKED_FIXTURE)).toEqual([])
  }, 30_000)

  test('正解 B 不被报出：where 带上读到的旧 revision（CAS 谓词）', () => {
    expect(readModifyWriteSites('fixture-cas.ts', CAS_FIXTURE)).toEqual([])
  }, 30_000)
})

// RFC-359 W8-T29 —— 「先查存在、再插入唯一键表，且本文件不归一唯一冲突」的高水位账本（只降不升）。
//
// 这条守卫挡的是什么
// ---------------------------------------------------------------------------
// design §10.1.1 的那一类 provider 分叉。形状是：
//
//   在一笔事务里 **先读一眼某张带唯一约束的表**（「有没有同名的？」「当前最大序号是多少？」），
//   按读到的结果决定写什么，**再往同一张表 insert**。
//
// SQLite 上这写法**碰巧**永远正确：`createSqliteDatabaseSession` 是进程内单写者租约 +
// `BEGIN IMMEDIATE` 全库独占（`platform/persistence/databaseTransaction.ts`），两笔写事务之间
// 没有任何交错窗口，于是前置检查恒命中，用户拿到干净的 409 / 域内错误。
// PostgreSQL 上没有这个前提：两个用户并发时前置检查**双双落空**，两笔都走到 insert，后一笔撞
// 唯一索引抛 **23505**。23505 不是 40001，`retryPostgresqlSerialization` 的判据不认它，于是裸驱动
// 错误一路冒到 HTTP 边界变成 **500**——本该是「已存在，请换个名字」的地方，用户看到「服务器内部错误」。
// 这正是本 RFC 要消灭的「一个引擎好、一个引擎不好」。
//
// ---------------------------------------------------------------------------
// 什么才算修好：判据是「输家会不会重新读一遍」，不是「有没有加锁」
// ---------------------------------------------------------------------------
// W8 实测把三种收场分得很清（每一条都有变异验证，见
// `tests/rfc359-w8-t29-unique-insert-conflict.test.ts` 的头注释与变异表）：
//
//   · **SERIALIZABLE 打开的事务**（`.serializable()` / `withTaskExecutionSerializable` /
//     `runResourceCatalogTransaction`）——**安全**。PG 的 SSI 会先把两笔认成读写依赖环、给输家
//     40001，而 `serializable()` 的重试单位是**整笔事务**：重跑时取的是新快照，前置检查这才命中，
//     收敛回 SQLite 的那条域内错误。实测 240/240 干净（`taskContinuationAdmission`），
//     20/20 干净（users 微实验）。
//     **注意 SSI 认得出它的前提**：两笔事务**读过它们要插的那张表**——那次读留下的谓词锁（SIREAD）
//     才让插入成为可检测的读写冲突。判据来自**另一张**表时 SSI 无处挂冲突，btree 直接抛 23505
//     （实测：同一段代码把前置读换成读别的表，PG 立刻 20/20 全红）。本守卫的判据只认前一种形状，
//     所以它**照不到** `mcpRuntimeTestPersistence.appendEvent` 那种「读 A 表算序号、插 B 表」的债。
//
//   · **READ COMMITTED 打开的事务**（`.transaction()`，PG 的缺省）——**要在读之前先串行化**。
//     READ COMMITTED 每条语句取新快照，所以一把在读**之前**取的锁就够了：
//     `engineOf(tx).advisoryLock(tx, key)`（PG 渲染 `pg_advisory_xact_lock`，SQLite no-op）或
//     `engineOf(tx).lockAggregateRoot(...)`。输家等到锁之后那一条 SELECT 会看见赢家已提交的行。
//     实测两处：`repositoryWorkspaceStore.createRepositoryGroup` 与
//     `platform/events/committed/append.ts` 的 `reserveAggregateSequence`——**把那行 advisoryLock
//     删掉，PG 当场全红（裸 23505）、SQLite 前后都绿**。
//
//   · **唯一冲突归一**——`engineOf(tx).classifyError(err) === 'unique-violation'` /
//     `uniqueViolationTarget(err)`，把驱动错误翻译回自己的闭合错误合同。范本：
//     `legacy/skillOperations.ts` 的 `acquireOpLocks`（PK 冲突 → `ConflictError('skill-operation-busy')`，
//     变异验证：去掉它，**两个引擎**当场都抛裸约束错）。序号自增那一子类还要配
//     `runCatalogTransactionRetryingUniqueViolations`（换一笔事务重来，新快照才读得到对方）。
//
// **行锁在 SERIALIZABLE 下救不了这类形状**（design §10.1 勘误）：`FOR UPDATE` 只让输家排队等锁，
// 等到之后**不重取快照**，醒来算出同一个值再撞一次。这条守卫因此不把 `lockAggregateRoot` 的出现
// 当成「已修好」——它只数形状，修没修好由上面三条判据人工判定并写进 why。
//
// ---------------------------------------------------------------------------
// 判据（纯函数，只吃「路径 + 源码文本」；负 fixture 直接喂它）
// ---------------------------------------------------------------------------
//   ① **带唯一约束的表**：`db/schema.ts` 里 `sqliteTable(name, cols, extras)` 的 `extras` 声明了
//      `uniqueIndex(...)` 或复合 `primaryKey(...)`。单列 `.primaryKey()` 不算——那一类的 id 由
//      ULID 铸出，撞不上。今天 124 张（全部 184 张表）。
//   ② **事务作用域** = 形参名为 `tx` / `transaction` 的函数体。与 W6-T28 账本同一条，理由也一样：
//      它同时罩住 `session.transaction(async (tx) => …)` 这类回调与 `function fooTx(tx, …)` 这类
//      接过句柄的助手，后者里恰恰躺着相当一部分债。
//   ③ **插入** = 该作用域里的 `…insert(表)`，且链上**没有** `onConflictDo*`——带 upsert 的插入
//      本来就把冲突当成正常分支处理，不会抛。
//   ④ **同作用域先读同一张表** = 位置在插入**之前**的 `…select(…)…from(同一个表)`。这是「先查存在」
//      这半句的机器表达，也是把「无脑 insert」（没有前置检查、冲突本来就是预期）排除掉的那一条。
//   ⑤ **本文件没有唯一冲突归一** = 全文不出现 `classifyError` / `uniqueViolationTarget`。粒度是
//      **文件**而不是作用域：归一常常写成文件里的一个私有助手（`isUniqueViolation`），按作用域判会
//      把它们全报成债。
//
// **已知假阳性来源**（下面账本逐条注明，不要因为「看着像债」就去改代码）：
//   · **归一 / 串行化住在调用方，不在本文件**。`skillVersion.ts` 是最典型的一例：版本号自增确实是
//     这个形状，但同一条路径在 `stageSkillVersion` 里先经 `beginOperation` → `acquireOpLocks` 拿了
//     `skill_operation_locks` 的排他行，而那处的 PK 冲突**已经**归一成 409；第二个并发保存根本走不到
//     版本插入。跨函数的事实这条判据看不见（它只在单个作用域内配对）。
//   · **同理，锁在别的函数里**：`append.ts:235` 的 `committedEvents` 插入前，序号是
//     `reserveAggregateSequence` 分配的，advisory lock 在那个函数里取——本作用域里看不到。
//   · **单写者的启动 / 播种路径**：`demoResourceCatalogSeed.ts`（演示数据播种）与内置工作流播种在
//     daemon 启动时跑，只有一个写者，并发无从谈起。
//   · **同步事务面**：`dbTxSync` / `DbTxSync` 句柄是 bun:sqlite 的**同步**执行面，PostgreSQL 客户端
//     根本产生不出这种句柄，那些代码在 PG 上一次都不会执行（`platform/events/committed/sqliteStore.ts`
//     整份即是）。它们随同步面退役一起消失，账本里等 `rfc359-sync-transaction-highwater` 归零。

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import ts from 'typescript'

const SRC = resolve(import.meta.dir, '..', '..', 'src')

// ---------------------------------------------------------------------------
// AST 基础件（与 rfc359-w6-t28-read-modify-write 同形；两条判据谈论的是同一族链式写法）
// ---------------------------------------------------------------------------

/** 事务句柄的形参名。本仓恒定这两个。 */
const TX_HANDLE_NAMES: ReadonlySet<string> = new Set(['tx', 'transaction'])

/** 出现其一即认为本文件已经把驱动的唯一冲突翻译成了自己的错误合同。 */
const NORMALIZER_NAMES: ReadonlySet<string> = new Set(['classifyError', 'uniqueViolationTarget'])

const READ_CALLEES: ReadonlySet<string> = new Set(['select', 'selectDistinct'])

/** 事务打开方式——只进诊断输出，**不进判据**（见头注释「什么才算修好」）。 */
const SERIALIZING_OPENERS: ReadonlySet<string> = new Set([
  'serializable',
  'withTaskExecutionSerializable',
  'withPostgresqlSerializableTaskExecution',
  'withPostgresqlTaskAggregateTransaction',
  'runResourceCatalogTransaction',
])

/** 读之前把并发写手串起来的手段——同样只进诊断输出。 */
const SERIALIZING_CALLEES: ReadonlySet<string> = new Set([
  'advisoryLock',
  'lockAggregateRoot',
  'claimRows',
  'fenceTaskWrite',
  'assertTaskOwnerTx',
  'assertTaskOwnerlessTx',
  'assertPostgresqlTaskOwnerTx',
  'assertPostgresqlTaskOwnerlessTx',
])

type FunctionNode =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration

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

/** 流式链的顶：`tx.insert(t)` → `tx.insert(t).values(…).onConflictDoNothing()`。 */
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

/** `from(表)` / `insert(表)` 的表名——只认光秃秃一个标识符。 */
function tableArgument(call: ts.CallExpression | undefined): string | null {
  const argument = call?.arguments[0]
  if (argument !== undefined && ts.isIdentifier(argument)) return argument.text
  return null
}

// ---------------------------------------------------------------------------
// ① 带唯一约束的表
// ---------------------------------------------------------------------------

/**
 * `db/schema.ts` 里声明了 `uniqueIndex(...)` 或**复合** `primaryKey(...)` 的表名集合。
 * 纯函数（吃 schema 源码文本），负 fixture 直接喂它。
 */
export function uniqueConstrainedTables(schemaText: string): ReadonlySet<string> {
  const source = ts.createSourceFile(
    'schema.ts',
    schemaText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const out = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === 'sqliteTable'
    ) {
      // 第三个实参是 extras 回调（`(t) => ({ …uniqueIndex / primaryKey… })`）。
      const extras = node.initializer.arguments[2]
      if (extras !== undefined) {
        let declared = false
        // 局部名字**刻意不叫 `scan`**：RFC-317 T14 的负 fixture 判据按名字解析被调用者，
        // 与本文件顶层的 `scan()`（它读磁盘）撞名会让这个纯函数被误判成「碰了语料」，
        // 于是整条负 fixture 一条都认不出来（实测踩过）。
        const visitExtras = (child: ts.Node): void => {
          if (declared) return
          if (ts.isCallExpression(child)) {
            const name = calleeName(child)
            if (name === 'uniqueIndex' || name === 'primaryKey') {
              declared = true
              return
            }
          }
          ts.forEachChild(child, visitExtras)
        }
        visitExtras(extras)
        if (declared) out.add(node.name.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}

// ---------------------------------------------------------------------------
// ②–⑤ 插入点
// ---------------------------------------------------------------------------

/** 一处「先查存在、再插入唯一键表、且本文件不归一」。`table` 稳定，`line` 会随编辑漂。 */
export interface UnnormalizedUniqueInsertSite {
  /** insert 所在行（1 起算）。 */
  readonly line: number
  /** 被读又被插的那张表（drizzle 表标识符）。 */
  readonly table: string
  /** 前置读所在行（1 起算）。 */
  readonly readLine: number
  /**
   * 诊断用，**不进判据**：这笔事务是怎么打开的。`<caller>` 表示本作用域是接过句柄的助手，
   * 打开方式在调用方——那种情况下要人工去看调用方是不是 SERIALIZABLE。
   */
  readonly opener: string
  /**
   * 诊断用，**不进判据**：`opener` 是否把隔离抬到了 SERIALIZABLE。为真时 PG 的 SSI 会给输家
   * 40001、整笔重放，这一族形状随之收敛（前提见头注释：两笔都读过要插的那张表）。
   */
  readonly openerSerializes: boolean
  /** 诊断用，**不进判据**：本作用域里在读之前调过串行化手段（advisoryLock / 行锁 / owner CAS）。 */
  readonly serializedBeforeRead: boolean
}

export function unnormalizedUniqueInsertSites(
  path: string,
  text: string,
  uniqueTables: ReadonlySet<string>,
): UnnormalizedUniqueInsertSite[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

  // ② 事务作用域 + 打开方式
  const scopes: ts.Node[] = []
  const openerOf = new Map<ts.Node, string>()
  const collectScopes = (node: ts.Node): void => {
    if (isFunctionNode(node) && takesTransactionHandle(node) && node.body !== undefined) {
      scopes.push(node.body)
      const parent: ts.Node | undefined = node.parent
      const opener = parent !== undefined && ts.isCallExpression(parent) ? calleeName(parent) : null
      openerOf.set(node.body, opener ?? '<caller>')
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

  interface Positioned {
    readonly table: string
    readonly position: number
    readonly line: number
    readonly scope: ts.Node
  }
  const reads: Positioned[] = []
  const inserts: Positioned[] = []
  /** 作用域 → 串行化调用的最早位置（诊断用）。 */
  const serializedAt = new Map<ts.Node, number>()

  const lineOf = (node: ts.Node): number =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node)
      if (name !== null && SERIALIZING_CALLEES.has(name)) {
        const scope = enclosingScope(node)
        if (scope !== null) {
          const at = node.getStart(source)
          const known = serializedAt.get(scope)
          if (known === undefined || at < known) serializedAt.set(scope, at)
        }
      }
      if (name !== null && READ_CALLEES.has(name)) {
        const chain = chainCalls(chainRoot(node))
        const table = tableArgument(chain.find((entry) => entry.method === 'from')?.call)
        const scope = table === null ? null : enclosingScope(node)
        if (scope !== null && table !== null) {
          reads.push({ table, position: node.getStart(source), line: lineOf(node), scope })
        }
      }
      // ③ 插入：表带唯一约束、链上没有 onConflictDo*
      if (name === 'insert') {
        const table = tableArgument(node)
        const scope = table === null ? null : enclosingScope(node)
        if (scope !== null && table !== null && uniqueTables.has(table)) {
          const chain = chainCalls(chainRoot(node))
          if (!chain.some((entry) => entry.method.startsWith('onConflictDo'))) {
            inserts.push({ table, position: node.getStart(source), line: lineOf(node), scope })
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)

  const out: UnnormalizedUniqueInsertSite[] = []
  for (const insert of inserts) {
    // ④ 同作用域、位置在前、同一张表的读
    const precedingRead = reads.find(
      (read) =>
        read.table === insert.table &&
        read.scope === insert.scope &&
        read.position < insert.position,
    )
    if (precedingRead === undefined) continue
    const lockedAt = serializedAt.get(insert.scope)
    const opener = openerOf.get(insert.scope) ?? '<caller>'
    out.push({
      line: insert.line,
      table: insert.table,
      readLine: precedingRead.line,
      opener,
      openerSerializes: SERIALIZING_OPENERS.has(opener),
      serializedBeforeRead: lockedAt !== undefined && lockedAt < precedingRead.position,
    })
  }
  return out.sort((left, right) => left.line - right.line)
}

/** 本文件是否已经把驱动的唯一冲突翻译成自己的错误合同（判据 ⑤，文件粒度）。 */
export function normalizesUniqueViolations(text: string): boolean {
  return [...NORMALIZER_NAMES].some((name) => new RegExp(`\\b${name}\\b`).test(text))
}

/**
 * 判据的**完整**入口：⑤ 的文件级前置过滤 + ②③④ 的作用域内配对。全树扫描与负 fixture 走的是
 * 这同一个函数——各留一份拷贝的话，fixture 证明的只是拷贝还活着（RFC-317 T14 的原话）。
 */
export function uniqueInsertDebtSites(
  path: string,
  text: string,
  uniqueTables: ReadonlySet<string>,
): UnnormalizedUniqueInsertSite[] {
  if (normalizesUniqueViolations(text)) return []
  return unnormalizedUniqueInsertSites(path, text, uniqueTables)
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

const UNIQUE_TABLES = uniqueConstrainedTables(readFileSync(join(SRC, 'db/schema.ts'), 'utf8'))

/**
 * `<相对 src 的路径>: <处数>`，按路径字典序。**只降不升。**
 *
 * 逐条 why + removeWhen（复核结论见
 * `tests/rfc359-w8-t29-unique-insert-conflict.test.ts` 与 design §10.1.1）：
 *
 *   modules/collaboration/infrastructure/humanGateOpenParticipant.ts: 1
 *     :406 taskQuestions（`uniq_task_questions_identity`）。
 *     why —— 假阳性：作用域是接过句柄的助手，事务在 `humanGateTaskLifecyclePersistence.parkPrepared`
 *       由 `withTaskExecutionSerializable` 打开（= SERIALIZABLE + 40001 整笔重放），而且同一身份的
 *       第二笔 open 在 `humanGateOperationJournal.beginTx` 就被挡下（该处先
 *       `lockAggregateRoot(tasks)` 再查活跃操作 → `human-gate-operation-conflict`）。
 *     removeWhen —— 该文件迁到 `.transaction()`（READ COMMITTED）时必须在读之前补串行化；
 *       在那之前这条只是形状登记。
 *   modules/collaboration/infrastructure/legacySqliteTaskCollab.ts: 1
 *     :435 taskCollaborators（复合主键）。why —— 同步事务面（`dbTxSync`），PG 上不可达。
 *     removeWhen —— 随 `rfc359-sync-transaction-highwater` 归零一起消失。
 *   modules/digital-employee/infrastructure/runtimeStore.ts: 5
 *     :556 employeeCaseMembers / :883 employeeInvocations / :934 employeeChannels /
 *     :1263 employeeCaseInbox / :1618 employeeAttentionBindings。
 *     why —— **本轮未复核可达性**（不在 W8 Tier A 清单内）。opener 是 `.transaction()`
 *       = READ COMMITTED，其中 :556 读前已 `lockAggregateRoot`，其余四处没有——按头注释的判据
 *       它们是这份账本里**最像真债**的一批，下一刀优先。
 *     removeWhen —— 逐处按「两笔并发能不能让用户看到 500」实测；能就在读之前补
 *       `advisoryLock` / `lockAggregateRoot`，不能就把理由写实。
 *   modules/event-center/infrastructure/eventStore.ts: 2
 *     :419 observerActivations（复合主键）/ :758 eventDeliveries
 *     （`event_deliveries_event_subscription_unique`）。
 *     why —— 同上：`.transaction()` 且读前无锁，**未复核**。
 *     removeWhen —— 同上。
 *   modules/integration/infrastructure/verifiedWebhookDeliveryPersistence.ts: 2
 *     :185 webhookMrControlEffects / :226 webhookDeliveries。
 *     why —— 读之前已在同作用域取过串行化（`serializedBeforeRead`），形状登记而已。
 *     removeWhen —— 那把锁被拿掉时这条要重新判。
 *   modules/intent/infrastructure/postgresqlIntentApplyOperations.ts: 1
 *     :177 intentApplyJournal（`uniq_intent_apply_journal_mutation`）。
 *     why —— 同 session 的 apply 由 `application/sessionApplyLock.ts` 的 `applyLock` 串成一条
 *       Promise 链，daemon 又是 flock 单实例；同一 session 的两笔 apply 进不到同一时刻
 *       （与 W6-T28 账本对该文件的判定同源）。
 *     removeWhen —— applyLock 退役或 daemon 变多实例时重判。
 *   modules/intent/infrastructure/sqliteIntentApplyOperations.ts: 1
 *     :293 intentApplyJournal。why —— 同步事务面 + 同一把 applyLock。
 *     removeWhen —— 随同步面退役。
 *   modules/resource-catalog/infrastructure/aggregateAdapters/postgresqlIntentApplyResourcePorts.ts: 7
 *     :552 agents / :661 mcps / :760 plugins / :925 skills / :1235 workflows / :1451 workgroups /
 *     :1544 workgroupMembers（全是 `*_owner_name_unique` 一族）。
 *     why —— 接过句柄的助手，事务由 intent apply 的 `applyLock` 之下打开；**未复核**。
 *     removeWhen —— 与上面两条 intent 账目一起判。
 *   modules/resource-catalog/infrastructure/demoResourceCatalogSeed.ts: 2
 *     :34 agents / :73 workflows。why —— **启动期播种**，单写者，并发无从谈起（假阳性）。
 *     removeWhen —— 演示播种退役即消失。
 *   modules/resource-catalog/infrastructure/workflowRepository.ts: 1
 *     :189 workflows（`copy` 路径）。why —— `runResourceCatalogTransaction` = SERIALIZABLE，
 *       且读的正是要插的那张表 ⇒ SSI 认得出，40001 整笔重放后前置检查命中。
 *     removeWhen —— opener 降级到 `.transaction()` 时必须补锁。
 *   modules/source-control/infrastructure/repositoryWorkspaceStore.ts: 1
 *     :176 repoGroups（`idx_repo_groups_name_ci`）。
 *     why —— **已修好，形状仍在**：`.transaction()`（READ COMMITTED）+ 读之前
 *       `engineOf(tx).advisoryLock(tx, 'source-control:repository-groups')`。实测两个用户同时建
 *       同名组，两个引擎都是 `name-conflict` → 409；把那行 advisoryLock 删掉，PG 当场红成裸 23505。
 *     removeWhen —— 判据若改成「认得出读前串行化」，这条自动出账。
 *   modules/task-execution/infrastructure/effectQuiescence.ts: 1
 *     :312 taskExecutionLineageOperationRecords。why —— 接过句柄的助手；调用方是
 *       task-execution 的 SERIALIZABLE 事务面。removeWhen —— 调用方降级时重判。
 *   modules/task-execution/infrastructure/postgresqlChildExecutionLaunchOperations.ts: 1
 *     :579 tasks（`idx_tasks_event_delivery_unique`）。
 *     why —— opener 是 `withPostgresqlSerializableTaskExecution`。removeWhen —— 同上。
 *   modules/task-execution/infrastructure/postgresqlTaskRouteOperations.ts: 1
 *     :814 taskCollaborators。why —— `withPostgresqlTaskAggregateTransaction`（事务头对 task 行
 *       取 `for update`），且插入前先整体 `delete` 同任务的成员行。removeWhen —— 那两条前提任一
 *       消失时重判。
 *   modules/task-execution/infrastructure/sqliteTaskExecutionEffect.ts: 3（RFC-359 W10 起；开账时 5）
 *     taskExecutionEffects / taskExecutionEffectAttempts / taskExecutionLineageOperationRecords ×3。
 *     why —— 同步事务面（`dbTxSync`）为主，PG 上不可达。
 *     ⚠️ **这个数字在缩**：该文件正被同步面退役那一刀改动（落账当天从 6 掉到 5），红了先看是不是
 *     同步面又退了一处——那是收敛，把数字改小即可。
 *     removeWhen —— 随同步面退役（`rfc359-sync-transaction-highwater` 归零）整份消失。
 *   modules/task-execution/infrastructure/taskContinuationAdmission.ts: 1
 *     :147 taskExecutionIntents（部分唯一索引 `idx_task_execution_intents_pending_task`）。
 *     why —— **已实测不可达**：唯一的生产入口把它塞进 `withPostgresqlSerializableTaskExecution` /
 *       `.serializable()`，且同一笔事务里更早还有一次 task 行 CAS（status + lifecycleEventRevision）
 *       把输家先挡掉。两个引擎并发提交 240/240 都是 `task-continuation-conflict`；把 opener 降成
 *       `.transaction()`，PG 立刻 120/120 全红。
 *     removeWhen —— opener 降级时必须补锁。
 *   modules/task-execution/infrastructure/workspaceRollbackEffect.ts: 1
 *     :80 taskExecutionEffects。why —— 接过句柄的助手，调用方是 task-execution 的 SERIALIZABLE
 *       事务面。removeWhen —— 调用方降级时重判。
 *   platform/events/committed/append.ts: 2
 *     :116 committedEventAggregateHeads / :235 committedEvents。
 *     why —— **事件骨干，已实测安全**：`reserveAggregateSequence` 在读 heads 之前取
 *       **per-aggregate** 的 `engineOf(tx).advisoryLock(producer:family:kind:id)`；:235 那条的
 *       序号由同一个函数分配（锁在别的函数里，本判据看不见 ⇒ 假阳性）。实测同一聚合两条并发追加
 *       在两个引擎、两种 opener 下都拿到 seq 1 / 2；删掉那行 advisoryLock 后 READ COMMITTED 上
 *       PG 25/25 全红（SERIALIZABLE 上仍绿，SSI 兜住）。
 *     removeWhen —— 判据若改成「认得出读前串行化」，:116 自动出账；:235 要判据能跨函数才行。
 *   platform/events/committed/sqliteStore.ts: 2
 *     :163 committedEventAggregateHeads / :276 committedEvents。
 *     why —— 句柄类型是 `DbTxSync`（bun:sqlite 同步面），PostgreSQL 客户端产生不出来，这两条在
 *       PG 上一次都不会执行；SQLite 上有 `BEGIN IMMEDIATE` 独占。文件头已写明「不要往这里加新东西」。
 *     removeWhen —— 两个还挂在 `dbTxSync` 上的参与者迁走后整份文件删除。
 *   platform/persistence/sqlite/legacyResourcePackageBundleApply.ts: 1
 *     :273 resourceBundleApplies（`uniq_resource_bundle_applies_key`）。
 *     why —— **本轮未复核**；opener 是 `.transaction()`。removeWhen —— 与 runtimeStore /
 *       eventStore 那批一起实测。
 *   services/task.ts: 1
 *     tasks（`idx_tasks_event_delivery_unique`，任务创建原子）。
 *     why —— 同步事务面（`dbTxSync`），PG 上不可达。removeWhen —— 随同步面退役。
 */
export const UNNORMALIZED_UNIQUE_INSERT_DEBT: readonly string[] = [
  'modules/collaboration/infrastructure/humanGateOpenParticipant.ts: 1',
  'modules/collaboration/infrastructure/legacySqliteTaskCollab.ts: 1',
  'modules/digital-employee/infrastructure/runtimeStore.ts: 5',
  'modules/event-center/infrastructure/eventStore.ts: 2',
  'modules/integration/infrastructure/verifiedWebhookDeliveryPersistence.ts: 2',
  'modules/intent/infrastructure/postgresqlIntentApplyOperations.ts: 1',
  'modules/intent/infrastructure/sqliteIntentApplyOperations.ts: 1',
  'modules/resource-catalog/infrastructure/aggregateAdapters/postgresqlIntentApplyResourcePorts.ts: 7',
  'modules/resource-catalog/infrastructure/demoResourceCatalogSeed.ts: 2',
  'modules/resource-catalog/infrastructure/workflowRepository.ts: 1',
  'modules/source-control/infrastructure/repositoryWorkspaceStore.ts: 1',
  'modules/task-execution/infrastructure/effectQuiescence.ts: 1',
  'modules/task-execution/infrastructure/postgresqlChildExecutionLaunchOperations.ts: 1',
  'modules/task-execution/infrastructure/postgresqlTaskRouteOperations.ts: 1',
  // RFC-359 W10 销账：5 → 3 —— 同步的 `closeOutcomeUnknownAndRelease`（生产零调用方，清算只剩
  // `effectQuiescence.ts` 那一份中立实现）随本波删除，它体内那两处「先查存在、再插入唯一键表」
  // 一并消失。
  'modules/task-execution/infrastructure/sqliteTaskExecutionEffect.ts: 3',
  'modules/task-execution/infrastructure/taskContinuationAdmission.ts: 1',
  'modules/task-execution/infrastructure/workspaceRollbackEffect.ts: 1',
  'platform/events/committed/append.ts: 2',
  'platform/events/committed/sqliteStore.ts: 2',
  'platform/persistence/sqlite/legacyResourcePackageBundleApply.ts: 1',
  'services/task.ts: 1',
]

interface ScannedFile {
  readonly path: string
  readonly sites: readonly UnnormalizedUniqueInsertSite[]
}

function scan(): ScannedFile[] {
  const out: ScannedFile[] = []
  for (const rel of CORPUS_FILES) {
    const text = readFileSync(join(SRC, rel), 'utf8')
    // 便宜的前置过滤：没有 `.insert(` 的文件不必解析（全树 AST 解析是这条守卫的主要成本）。
    if (!text.includes('.insert(')) continue
    const sites = uniqueInsertDebtSites(rel, text, UNIQUE_TABLES)
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
          `  ${file.path}:${String(site.line)} —— insert(${site.table}) 之前在 ` +
          `:${String(site.readLine)} 读过同一张表；opener=${site.opener}` +
          `${site.openerSerializes ? '（SERIALIZABLE）' : ''}` +
          `${site.serializedBeforeRead ? '，读前已串行化' : '，读前未串行化'}`,
      ),
    )
    .join('\n')
}

// ---------------------------------------------------------------------------
// 守卫
// ---------------------------------------------------------------------------

const SCAN_TIMEOUT_MS = 60_000

describe('RFC-359 W8-T29 —— 「先查存在、再插入唯一键表、且不归一」只降不升', () => {
  test(
    '语料非空：确实扫到了整棵 backend 源码树（扫成 0 说明扫描根失效，此刻零预言力）',
    () => {
      expect(CORPUS_FILES.length).toBeGreaterThanOrEqual(1500)
    },
    SCAN_TIMEOUT_MS,
  )

  test(
    '带唯一约束的表数得出来（schema 扫空会让整条判据静默放行）',
    () => {
      expect(UNIQUE_TABLES.size).toBeGreaterThanOrEqual(100)
      // 三张点名的表：判据认不出它们就说明 extras 的读法坏了。
      expect(UNIQUE_TABLES.has('repoGroups')).toBe(true) // uniqueIndex（表达式索引）
      expect(UNIQUE_TABLES.has('taskExecutionIntents')).toBe(true) // 部分唯一索引
      expect(UNIQUE_TABLES.has('committedEventAggregateHeads')).toBe(true) // 复合主键
    },
    SCAN_TIMEOUT_MS,
  )

  test(
    '逐文件处数与账本逐字相等（增了是又搬来一处，减了是收敛，都要改账本）',
    () => {
      expect(
        ledgerRows(SCANNED),
        '「先查存在、再插入唯一键表、且本文件不归一唯一冲突」的逐文件处数与账本不符。\n' +
          '**增**了说明有人把一段只在 SQLite 的 `BEGIN IMMEDIATE` 独占下才碰巧正确的形状搬了过来：' +
          'PostgreSQL 上两个用户并发时前置检查双双落空，后一笔撞唯一索引抛 23505，' +
          '而 23505 不是 40001、不被重试，裸驱动错误直接冒成 **500**。三种正解（判据见文件头）：\n' +
          '  · opener 抬到 SERIALIZABLE（`.serializable()` 等）——SSI 给输家 40001，整笔重放后' +
          '前置检查才命中；**前提是两笔都读过要插的那张表**，判据来自别的表时 SSI 挂不上冲突；\n' +
          '  · READ COMMITTED 下在**读之前**取 `engineOf(tx).advisoryLock(...)` 或 ' +
          '`lockAggregateRoot(...)`——每条语句取新快照，输家等到锁后就看得见赢家；\n' +
          "  · 归一：`engineOf(tx).classifyError(e) === 'unique-violation'` 翻译回自己的错误合同" +
          '（序号自增那一子类还要配 `runCatalogTransactionRetryingUniqueViolations` 换一笔事务重来）。\n' +
          '**减**了说明收敛发生了——把账本一起改小，让这次减少留下一次有署名的提交记录。\n' +
          '当前扫描结果逐条（opener / 读前是否串行化只是诊断，不是判据）：\n' +
          detail(SCANNED),
      ).toEqual([...UNNORMALIZED_UNIQUE_INSERT_DEBT])
    },
    SCAN_TIMEOUT_MS,
  )

  test('账本按路径字典序、无重复（清点稳定的前提）', () => {
    const paths = UNNORMALIZED_UNIQUE_INSERT_DEBT.map((row) => row.slice(0, row.lastIndexOf(':')))
    expect(new Set(paths).size, '账本里有重复路径').toBe(paths.length)
    expect([...paths].sort()).toEqual(paths)
  })
})

// ---------------------------------------------------------------------------
// 负 fixture：判据自己必须有牙齿（RFC-317 T14）
// ---------------------------------------------------------------------------
//
// 语料下限挡的是「扫了个寂寞」；这一节挡的是另一半——语料还在，但 matcher 不咬了。
// 全部内存字符串，不落磁盘、不依赖仓里某个文件恰好保持某形状。

const FIXTURE_SCHEMA = `
export const widgets = sqliteTable(
  'widgets',
  { id: text('id').primaryKey(), name: text('name').notNull() },
  (t) => ({ nameUq: uniqueIndex('uq_widgets_name').on(t.name) }),
)
export const gadgets = sqliteTable(
  'gadgets',
  { a: text('a').notNull(), b: text('b').notNull() },
  (t) => ({ pk: primaryKey({ columns: [t.a, t.b] }) }),
)
export const notes = sqliteTable(
  'notes',
  { id: text('id').primaryKey(), body: text('body').notNull() },
  (t) => ({ bodyIdx: index('idx_notes_body').on(t.body) }),
)
`

/** 真债：读一眼有没有同名的，没有就插——既不 SERIALIZABLE、也不锁、也不归一。 */
const DEBT_FIXTURE = `
export function createWidget(tx: Tx, name: string) {
  return session.transaction(async (tx) => {
    const hit = await tx.select().from(widgets).where(eq(widgets.name, name)).limit(1)
    if (hit.length > 0) return 'name-conflict'
    await tx.insert(widgets).values({ id: mintId(), name })
    return 'created'
  })
}
`

/** 正解 A：upsert——冲突是正常分支，不会抛。 */
const UPSERT_FIXTURE = `
export function createWidget(tx: Tx, name: string) {
  return session.transaction(async (tx) => {
    const hit = await tx.select().from(widgets).where(eq(widgets.name, name)).limit(1)
    if (hit.length > 0) return 'name-conflict'
    await tx.insert(widgets).values({ id: mintId(), name }).onConflictDoNothing()
    return 'created'
  })
}
`

/** 正解 B：本文件把驱动的唯一冲突翻译成了自己的错误合同。 */
const NORMALIZED_FIXTURE = `
export function createWidget(tx: Tx, name: string) {
  return session.transaction(async (tx) => {
    const hit = await tx.select().from(widgets).where(eq(widgets.name, name)).limit(1)
    if (hit.length > 0) return 'name-conflict'
    try {
      await tx.insert(widgets).values({ id: mintId(), name })
    } catch (error) {
      if (engineOf(tx).classifyError(error) === 'unique-violation') return 'name-conflict'
      throw error
    }
    return 'created'
  })
}
`

/** 放过：表上没有任何唯一约束，插重复也不会抛。 */
const NO_UNIQUE_FIXTURE = `
export function addNote(tx: Tx, body: string) {
  return session.transaction(async (tx) => {
    const hit = await tx.select().from(notes).where(eq(notes.body, body)).limit(1)
    if (hit.length > 0) return 'dup'
    await tx.insert(notes).values({ id: mintId(), body })
    return 'created'
  })
}
`

/** 放过：没有前置读——冲突本来就是预期，不存在「SQLite 上碰巧命中」这回事。 */
const BLIND_INSERT_FIXTURE = `
export function addWidget(tx: Tx, name: string) {
  return session.transaction(async (tx) => {
    await tx.insert(widgets).values({ id: mintId(), name })
    return 'created'
  })
}
`

/** 放过：事务外（没有 tx / transaction 形参的作用域）。 */
const OUTSIDE_TRANSACTION_FIXTURE = `
export async function createWidget(db: Db, name: string) {
  const hit = await db.select().from(widgets).where(eq(widgets.name, name)).limit(1)
  if (hit.length > 0) return 'name-conflict'
  await db.insert(widgets).values({ id: mintId(), name })
  return 'created'
}
`

/** 复合主键的表同样算（`gadgets` 没有 uniqueIndex，只有复合 PK）。 */
const COMPOSITE_PK_FIXTURE = `
export function link(tx: Tx, a: string, b: string) {
  return session.transaction(async (tx) => {
    const hit = await tx.select().from(gadgets).where(eq(gadgets.a, a)).limit(1)
    if (hit.length > 0) return 'exists'
    await tx.insert(gadgets).values({ a, b })
    return 'linked'
  })
}
`

/** 伪造 schema 里带唯一约束的表——判据 ① 的自证输入。 */
const FIXTURE_TABLES = uniqueConstrainedTables(FIXTURE_SCHEMA)

describe('RFC-359 W8-T29 —— 判据自证（负 fixture）', () => {
  test('唯一约束表的识别：uniqueIndex 与复合 primaryKey 都算，普通 index 不算', () => {
    expect([...FIXTURE_TABLES].sort()).toEqual(['gadgets', 'widgets'])
  })

  test('真债被认出来（认不出就说明 matcher 不咬了，账本此刻零预言力）', () => {
    const sites = uniqueInsertDebtSites('fixture-debt.ts', DEBT_FIXTURE, FIXTURE_TABLES)
    expect(sites).toHaveLength(1)
    expect(sites[0]?.table).toBe('widgets')
    expect(sites[0]?.opener).toBe('transaction')
    expect(sites[0]?.serializedBeforeRead).toBe(false)
  })

  test('复合主键的表同样被认出来', () => {
    expect(
      uniqueInsertDebtSites('fixture-composite-pk.ts', COMPOSITE_PK_FIXTURE, FIXTURE_TABLES).map(
        (site) => site.table,
      ),
    ).toEqual(['gadgets'])
  })

  test('正解与无关形状一律放过（否则判据会逼着人给正确代码改写法）', () => {
    expect(
      uniqueInsertDebtSites('fixture-upsert.ts', UPSERT_FIXTURE, FIXTURE_TABLES),
      'onConflictDo* 是把冲突当正常分支处理',
    ).toEqual([])
    expect(
      uniqueInsertDebtSites('fixture-normalized.ts', NORMALIZED_FIXTURE, FIXTURE_TABLES),
      '本文件已归一唯一冲突',
    ).toEqual([])
    expect(
      uniqueInsertDebtSites('fixture-no-unique.ts', NO_UNIQUE_FIXTURE, FIXTURE_TABLES),
      '表上没有唯一约束，插重复不会抛',
    ).toEqual([])
    expect(
      uniqueInsertDebtSites('fixture-blind-insert.ts', BLIND_INSERT_FIXTURE, FIXTURE_TABLES),
      '没有前置读 ⇒ 不是「先查存在」这个形状',
    ).toEqual([])
    expect(
      uniqueInsertDebtSites(
        'fixture-outside-transaction.ts',
        OUTSIDE_TRANSACTION_FIXTURE,
        FIXTURE_TABLES,
      ),
      '不在事务作用域里',
    ).toEqual([])
  })

  test('诊断字段：读前串行化 / SERIALIZABLE opener 都照实报出来（但不改判据）', () => {
    const locked = DEBT_FIXTURE.replace(
      'const hit = await',
      'await engineOf(tx).advisoryLock(tx, "k")\n    const hit = await',
    )
    const lockedSites = uniqueInsertDebtSites('fixture-locked.ts', locked, FIXTURE_TABLES)
    expect(lockedSites).toHaveLength(1)
    expect(lockedSites[0]?.serializedBeforeRead, '读前的 advisoryLock 要被看见').toBe(true)

    expect(
      uniqueInsertDebtSites('fixture-debt.ts', DEBT_FIXTURE, FIXTURE_TABLES)[0]?.openerSerializes,
      '`.transaction()` 不抬隔离',
    ).toBe(false)
    const serializable = DEBT_FIXTURE.replace('session.transaction(', 'session.serializable(')
    expect(
      uniqueInsertDebtSites('fixture-serializable.ts', serializable, FIXTURE_TABLES)[0]?.opener,
    ).toBe('serializable')
    expect(
      uniqueInsertDebtSites('fixture-serializable.ts', serializable, FIXTURE_TABLES)[0]
        ?.openerSerializes,
      'SERIALIZABLE opener 要被看见',
    ).toBe(true)

    // 接过句柄的助手：opener 在调用方，判据本身看不见。
    const helper = `
export async function createWidgetTx(tx: Tx, name: string) {
  const hit = await tx.select().from(widgets).where(eq(widgets.name, name)).limit(1)
  if (hit.length > 0) return 'name-conflict'
  await tx.insert(widgets).values({ id: mintId(), name })
  return 'created'
}
`
    expect(uniqueInsertDebtSites('fixture-helper.ts', helper, FIXTURE_TABLES)[0]?.opener).toBe(
      '<caller>',
    )
  })
})

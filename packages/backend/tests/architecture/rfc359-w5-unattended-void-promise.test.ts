// RFC-359 W5 —— **`void <promise>` 且链上没有拒绝处理器**的高水位账本（只降不升）。
//
// # 为什么这条守卫存在
//
// 2026-09-13 主干红了一次，形态很反直觉：ubuntu 分片 2/12 的日志里 **1960 个用例 `0 fail`**、
// 一行 `(fail)` 都没有，进程却退 1。真正的失败是这行：
//
//     # Unhandled error between tests
//     error: Failed query: select "in_flight_turn_id" from "…"."mcp_runtime_test_sessions" …
//     PostgresError: Connection closed   code: "ERR_POSTGRES_CONNECTION_CLOSED"
//       at async nextDeadline (…/mcpRuntimeTestPersistence.ts)
//
// 出事的代码是 `services/mcpRuntimeTest.ts` 里一条 fire-and-forget：
//
//     void this.deps.persistence.nextDeadline().then((earliest) => { … })   // 没有 .catch
//
// **在 bun:sqlite 上这条没有窗口**——`nextDeadline()` 体内全是同步读，`void` 交出去的那一刻
// promise 已经 settle，永远轮不到「库关了它还在飞」。**在 PostgreSQL 上它是一次真异步查询**：
// 服务停掉 / 测试拆台 / daemon 收尾把库关掉之后，这条还在飞的 promise 以 `Connection closed`
// 拒绝，而当时没有任何人接住它 → 进程级的 unhandled rejection。
//
// 这正是 RFC-359 要消灭的那种「同一份代码，一个引擎好、一个引擎不好」——只不过它不在 SQL 方言上，
// 而在**同步 / 异步**这条更隐蔽的分界上。凡是 fire-and-forget 的 promise，都必须显式接住拒绝：
// `.catch(…)`，或双参 `.then(ok, err)`。
//
// # 账本口径
//
// 逐文件计数（不是行号：行号会被任何无关编辑冲掉，计数不会）。**增**了说明又写了一条在 PG 上
// 会变成 unhandled rejection 的路径；**减**了说明有人接住了它，把账本一起改小。
//
// 账本里的既有条目是**「存量」**：其中一部分已逐条核实为安全——被调函数自己整体兜住了拒绝，
// 已核的有
//
//   · `modules/intent/**` 的 13 条（`intentSessionRoutes.ts` 10 + `dispatcher.ts` 3）——
//     它们最终都落到 `dispatchIntentTurn`，那个函数的头注释就写着「**全部**调用点都是
//     fire-and-forget，所以它必须自己保证永不 reject」，并记着 2026-09-12 同一类事故
//     （CI ubuntu shard 6/8）。
//   · `platform/background/maintenanceWorker.ts` 的 `processQueue`：`try { … } catch { … } finally { … }`。
//   · `mcp/server.ts` / `server.ts` 的 `tokenCallAudit.record`：`insertAudit` 在 try 里，
//     `writeDeleteSnapshot` 自身整体 try/catch，连兜底的 `markSnapshotFailed` 也包了。
//
// 其余尚未逐条核实。**退役一条的机械判据只有一个**——在调用点链上补 `.catch`（或双参 `.then`），
// 让本扫描器不再数到它。内部已经 try/catch 的补一条永不触发的 `.catch` 也无害，
// 而且把「这里为什么安全」从读者的脑子里搬进代码。
//
// 之所以**不**按「被调函数是否 try/catch」自动免责：那个判据在本仓不可靠——
// `processQueue` 的 try 前面有二十多行前置赋值，`dispatchIntentTurn` 的 catch 与 finally
// **自己也在写库**（连接池一关，兜底块自己就抛、异常越过它逃出来）。能机械判准的只有调用点那一侧。

import { describe, expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import ts from 'typescript'

const SRC = resolve(import.meta.dir, '..', '..', 'src')

/** 扫到的全部 backend 源文件——语料下限的分母（RFC-317 T13：扫空 = 假绿）。 */
function corpusFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(SRC, dir), { withFileTypes: true })) {
      const rel = dir === '' ? entry.name : `${dir}/${entry.name}`
      if (entry.isDirectory()) walk(rel)
      else if (entry.name.endsWith('.ts')) out.push(rel)
    }
  }
  walk('')
  return out
}

/** thenable 才算数：`void someSyncCall()` 不是本守卫的对象。按类型判，不按名字判。 */
function isThenable(type: ts.Type): boolean {
  if (type.isUnionOrIntersection()) return type.types.some(isThenable)
  return type.getProperty('then') !== undefined
}

/**
 * 链上是否已经有人接住拒绝。`.catch(…)` 与双参 `.then(ok, err)` 都算；
 * `.finally(…)` **不算**——它不消费拒绝，只是转手。
 */
function hasRejectionHandler(expr: ts.Expression): boolean {
  let cur: ts.Expression = expr
  for (;;) {
    if (ts.isParenthesizedExpression(cur)) {
      cur = cur.expression
      continue
    }
    if (ts.isAwaitExpression(cur)) return true
    if (!ts.isCallExpression(cur)) return false
    const callee = cur.expression
    if (!ts.isPropertyAccessExpression(callee)) return false
    if (callee.name.text === 'catch') return true
    if (callee.name.text === 'then' && cur.arguments.length >= 2) return true
    cur = callee.expression
  }
}

function countUnattended(source: ts.SourceFile, checker: ts.TypeChecker): number {
  let count = 0
  const visit = (node: ts.Node): void => {
    if (ts.isExpressionStatement(node) && ts.isVoidExpression(node.expression)) {
      const inner = node.expression.expression
      if (!hasRejectionHandler(inner) && isThenable(checker.getTypeAtLocation(inner))) count += 1
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return count
}

let sourceProgram: ts.Program | undefined
function program(): ts.Program {
  if (sourceProgram === undefined) {
    const configPath = resolve(SRC, '..', 'tsconfig.json')
    const config = ts.readConfigFile(configPath, ts.sys.readFile)
    if (config.error !== undefined) {
      throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
    }
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, resolve(SRC, '..'))
    sourceProgram = ts.createProgram(
      corpusFiles().map((file) => join(SRC, file)),
      parsed.options,
    )
  }
  return sourceProgram
}

function scan(): string[] {
  const built = program()
  const checker = built.getTypeChecker()
  const out: string[] = []
  for (const rel of corpusFiles()) {
    const source = built.getSourceFile(join(SRC, rel))
    if (source === undefined) throw new Error(`RFC-359 void-promise corpus missing ${rel}`)
    const count = countUnattended(source, checker)
    if (count > 0) out.push(`${rel}: ${count}`)
  }
  return out.sort()
}

/**
 * 存量：`void <promise>` 且链上无 `.catch` / 无双参 `.then`。逐文件计数。
 * 退役判据见头注释——在调用点链上补一个拒绝处理器即可，账本随之改小。
 */
export const UNATTENDED_VOID_PROMISE_DEBT: readonly string[] = [
  'cli/postgresqlDaemonApplication.ts: 3',
  'cli/start.ts: 6',
  'mcp/server.ts: 1',
  'modules/digital-employee/application/osWorker.ts: 1',
  'modules/event-center/application/eventCenterWorker.ts: 1',
  'modules/intent/application/dispatcher.ts: 3',
  'modules/intent/inbound/intentSessionRoutes.ts: 10',
  'platform/background/maintenanceService.ts: 1',
  'platform/background/maintenanceWorker.ts: 3',
  'platform/events/committed/workerDefinitions.ts: 1',
  'routes/webhooks.ts: 1',
  'server.ts: 4',
  'services/controlListener.ts: 1',
  'services/execution/managedProcess.ts: 4',
  'services/pluginGenerationGc.ts: 1',
  'services/repoBatchImport.ts: 2',
  'services/reviewMutationCoordinator.ts: 1',
  'services/scheduledTaskScheduler.ts: 1',
  'services/structuralDiff/service.ts: 2',
]

/** 内存源码变异：不改共享工作树，验证判据确实咬住「没人接的 fire-and-forget」。 */
function fixtureUnattended(body: string): number {
  const file = '/rfc359-void-promise-fixture.ts'
  const source = ts.createSourceFile(
    file,
    `
    interface Thenable<T> {
      then(onOk?: (v: T) => unknown, onErr?: (e: unknown) => unknown): Thenable<unknown>
      catch(onErr: (e: unknown) => unknown): Thenable<unknown>
      finally(onDone: () => unknown): Thenable<unknown>
    }
    declare function query(): Thenable<number>;
    declare function plain(): number;
    ${body}
  `,
    ts.ScriptTarget.Latest,
    true,
  )
  const options: ts.CompilerOptions = { noLib: true, strict: true }
  const host = ts.createCompilerHost(options)
  host.getSourceFile = (name) => (name === file ? source : undefined)
  const built = ts.createProgram([file], options, host)
  return countUnattended(source, built.getTypeChecker())
}

describe('RFC-359 W5 —— 没人接的 `void <promise>` 只降不升', () => {
  test.each([
    'function f() { void query() }',
    'function f() { void query().then((v) => v) }',
    'function f() { void query().finally(() => 1) }',
    'function f() { void (query()) }',
    'function f() { void query().then((v) => v).finally(() => 1) }',
  ])('咬住：%s', (body) => {
    expect(fixtureUnattended(body)).toBe(1)
  })

  test.each([
    'function f() { void query().catch(() => 1) }',
    'function f() { void query().then((v) => v, () => 1) }',
    'function f() { void query().then((v) => v).catch(() => 1) }',
    'function f() { void query().catch(() => 1).finally(() => 1) }',
    // 非 thenable 的 `void` 不是本守卫的对象。
    'function f() { void plain() }',
  ])('放行：%s', (body) => {
    expect(fixtureUnattended(body)).toBe(0)
  })

  test('逐文件计数与账本逐字相等（增了是新的 PG-only unhandled rejection，减了是收敛，都要改账本）', () => {
    expect(
      scan(),
      '`void <promise>` 且链上没有拒绝处理器的站点变了。\n' +
        '**增**了说明新写了一条在 PostgreSQL 上会变成进程级 unhandled rejection 的路径——\n' +
        'bun:sqlite 上它同步 settle 看不出问题，PG 上库一关就以 `Connection closed` 拒绝，\n' +
        'bun test 记成「Unhandled error between tests」：用例全过、进程退 1（CI run 34768029441）。\n' +
        '给它接上 `.catch(…)`（或双参 `.then(ok, err)`）并落一条 warn。\n' +
        '**减**了说明有人接住了——把账本一起改小，让这次收敛留下一次有署名的提交记录。',
    ).toEqual([...UNATTENDED_VOID_PROMISE_DEBT])
  }, 120_000)

  test('语料下限：扫到的源文件数量不为零（防扫空假绿）', () => {
    expect(corpusFiles().length).toBeGreaterThanOrEqual(500)
  })
})

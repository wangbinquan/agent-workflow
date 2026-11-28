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
//   · `platform/background/maintenanceWorkerRuntime.ts` 的 `processQueue`：`try { … } catch { … } finally { … }`。
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
import ts from 'typescript'
import {
  UNATTENDED_VOID_PROMISE_DEBT,
  countUnattendedVoidPromises,
} from '../helpers/rfc629SharedProgramRules'

export { UNATTENDED_VOID_PROMISE_DEBT }

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
  return countUnattendedVoidPromises(source, built.getTypeChecker())
}

// RFC-629: the live full-backend `ts.Program` scan runs in
// `architecture/rfc629-shared-program-guards.test.ts` on the shared program.
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
})

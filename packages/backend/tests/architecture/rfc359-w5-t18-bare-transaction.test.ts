// RFC-359 W5-T18 —— **裸 `db.transaction(`** 的高水位账本（只降不升）。
//
// # 为什么这条守卫存在
//
// RFC-359 要消灭的形态是「同一段业务逻辑抄两遍，一份给 SQLite 一份给 PostgreSQL」。它的**唯一**
// 技术成因就是驱动自带的那个 `.transaction(`：`bun:sqlite` 的 `Database.transaction` 是**同步
// 包装器**——async 回调在第一个 `await` 处把一个 pending promise 交回去，包装器当它「已返回」
// 并当场 COMMIT，之后的语句全在 autocommit 里跑、再抛错什么也回滚不了（`src/db/txSync.ts` 头注释
// 与 `tests/scheduler-audit-s10-async-transaction-decorative.test.ts` 的行为证明层记着这个事实）；
// 而 PostgreSQL 客户端的事务天生是 async 的。于是**一个事务体没法同时跑在两个引擎上**，谁要写
// 一笔带事务的逻辑就只能落两份实现——153 对 `sqliteX.ts` / `postgresqlX.ts` 就是这么来的。
//
// 中立原语 `platform/persistence/databaseTransaction.ts` 的 `databaseSessionFor(db).transaction(...)`
// 就是为了消灭这件事：SQLite 侧它不碰那个同步包装器，改用显式 `BEGIN IMMEDIATE` + async 体 +
// 显式 `COMMIT` / `ROLLBACK`（半提交与 `SQLITE_BUSY_SNAPSHOT` 两类危害都关在原语内），PG 侧走驱动
// 自己的 async 事务。两侧语义相同，于是**一个事务体、两个 provider、一份实现**。
//
// 所以本守卫锁的是：**除了事务原语自己那几个文件，任何地方都不许再直接调驱动的 `.transaction(`**
// ——`db.transaction(` / `this.db.transaction(` / `dependencies.db.transaction(` 这些裸形态，每一处
// 都是一条「这段逻辑只能给一个 provider 写」的路，新写的一律必须走 `databaseSessionFor(db).transaction(...)`。
//
// # 与既有两条守卫的分工（不重叠）
//
//   · `scheduler-audit-s10-async-transaction-decorative.test.ts`（S-10 / RFC-317 T37）**只看 SQLite
//     侧**——它的 `sqliteTransactionSource` 显式把 `postgresql*.ts` 整份返回 `null`，理由写在那里：
//     那条守卫管的是 bun:sqlite 同步包装器的安全性，把 PG 的 async 事务算进去会让它退化成一张
//     provider 名单。它的账本已经归零，且**按设计**永远看不见 PG 侧。
//   · `rfc359-sync-transaction-highwater.test.ts` 清点的是 `dbTxSync` / `withOwnedTaskTx` 的调用点
//     ——SQLite 独有的**同步**事务面。
//   · 本条补上剩下那一半：**不分 provider**，整棵 `src` 树上一切非中立的 `.transaction(`。PG 侧的
//     裸 `db.transaction(` 同样是债——它意味着那条路径此刻只有 PG 一份实现，SQLite 那半要么另写
//     要么缺失，正是 RFC-359 的目标形态的反面。
//
// W12 收口：裸驱动调用已归零；保留 exact 空账本，任何新调用都会让 CI 转红。
// 接收者按 TypeScript 类型解析，SQL 程序 runner 的中立事务编排不属于裸驱动。

import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import {
  BARE_TRANSACTION_DEBT,
  TRANSACTION_PRIMITIVES,
  countBareTransactions,
} from '../helpers/rfc629SharedProgramRules'

export { BARE_TRANSACTION_DEBT }

const SRC = resolve(import.meta.dir, '..', '..', 'src')

/** 内存源码变异：不改共享工作树，验证判据确实咬住裸驱动调用。 */
function fixtureBareTransactions(body: string): number {
  const file = '/rfc359-transaction-fixture.ts'
  const source = ts.createSourceFile(
    file,
    `
    interface DatabaseClient {
      select(): void; insert(): void; update(): void; delete(): void;
      transaction<T>(body: () => T): T;
    }
    interface DatabaseSession { transaction<T>(body: () => T): T }
    interface IntentSqlProgramRunner { read(): void; transaction<T>(body: () => T): T }
    declare function databaseSessionFor(db: DatabaseClient): DatabaseSession;
    ${body}
  `,
    ts.ScriptTarget.Latest,
    true,
  )
  const options: ts.CompilerOptions = { noLib: true, strict: true }
  const host = ts.createCompilerHost(options)
  host.getSourceFile = (name) => (name === file ? source : undefined)
  const program = ts.createProgram([file], options, host)
  return countBareTransactions(source, program.getTypeChecker())
}

// RFC-629: the live full-backend `ts.Program` scan runs in
// `architecture/rfc629-shared-program-guards.test.ts` on the shared program.
describe('RFC-359 W5-T18 —— 裸 `db.transaction(` 只降不升', () => {
  test.each([
    'function write(db: DatabaseClient) { db.transaction(() => 1) }',
    'function write(session: DatabaseClient) { session.transaction(() => 1) }',
    'class Store { constructor(private db: DatabaseClient) {} write() { this.db.transaction(() => 1) } }',
    'function write(deps: { db: DatabaseClient }) { deps.db.transaction(() => 1) }',
    'function write(db: DatabaseClient) { const renamed = db; renamed.transaction<number>(() => 1) }',
    "function write(db: DatabaseClient) { db['transaction'](() => 1) }",
    'function write(db: DatabaseClient | undefined) { db?.transaction(() => 1) }',
    'type Alias = DatabaseClient; function write(db: Alias) { db\n.transaction(() => 1) }',
    // 中立原语的 import/调用不能给同文件里的裸驱动调用发许可证。
    'function write(session: DatabaseClient) { databaseSessionFor(session); session.transaction(() => 1) }',
    'function write(db: DatabaseClient, runner: IntentSqlProgramRunner) { runner.transaction(() => 1); db.transaction(() => 1) }',
  ])('裸驱动变异必红：%s', (source) => {
    expect(fixtureBareTransactions(source)).toBe(1)
  })

  test('中立事务与生成器程序不依赖变量命名；注释/字符串不计入调用点', () => {
    expect(
      fixtureBareTransactions(`
      function write(client: DatabaseClient, db: DatabaseSession, runner: IntentSqlProgramRunner) {
        databaseSessionFor(client).transaction(() => 1)
        const arbitraryName = databaseSessionFor(client)
        arbitraryName.transaction(() => 1)
        db.transaction(() => 1)
        runner.transaction(() => 1)
        const example = 'client.transaction(() => 1)'
        /* client.transaction(() => 1) */
      }
    `),
    ).toBe(0)
  })

  test('账本按路径字典序、无重复（清点稳定的前提）', () => {
    const paths = BARE_TRANSACTION_DEBT.map((row) => row.slice(0, row.lastIndexOf(':')))
    expect(new Set(paths).size, '账本里有重复路径').toBe(paths.length)
    expect([...paths].sort()).toEqual(paths)
  })

  test('白名单每条都是仍然存在的具名文件并写清理由', () => {
    for (const [rel, why] of Object.entries(TRANSACTION_PRIMITIVES)) {
      expect(rel, '白名单只收具名 .ts 文件，不收目录 / 通配').toMatch(/\.ts$/)
      expect(existsSync(join(SRC, rel)), `${rel}: 白名单里的文件已不存在，必须删掉这一条`).toBe(
        true,
      )
      expect(
        why.length,
        `${rel}: 白名单每条都必须写明「为什么这一处必须直接调驱动」`,
      ).toBeGreaterThan(60)
    }
  })
})

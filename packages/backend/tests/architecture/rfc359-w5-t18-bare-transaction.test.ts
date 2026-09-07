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

import { beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import ts from 'typescript'

const SRC = resolve(import.meta.dir, '..', '..', 'src')

/**
 * 事务原语自己的家。**逐个具名文件，不用目录通配**——本仓的教训是「一条需要几十条豁免才能变绿
 * 的规则，豁免本身就是新的空白许可证」：目录级豁免会把该目录下未来新增的裸事务一并静默放过。
 * 每条都必须写明「为什么这一处必须直接调驱动」。
 */
const TRANSACTION_PRIMITIVES: Readonly<Record<string, string>> = {
  'db/txSync.ts':
    'RFC-093 的同步事务原语 `dbTxSync` 的定义处：它就是那个包住 bun:sqlite 同步包装器的地方' +
    '（在类型层把返回 promise 的回调塌成 never、运行期对 thenable 抛错回滚，并补 { behavior: "immediate" }）。' +
    '它自己必须调驱动的 db.transaction，否则无从实现。它的**调用点**由 rfc359-sync-transaction-highwater 单独清点。',
  'platform/persistence/databaseTransaction.ts':
    'RFC-359 W2 的中立原语本体：`createPostgresqlDatabaseSession` 的 transaction / snapshotRead / ' +
    'serializable 三处直接调 PG 驱动的 db.transaction，那正是「中立会话在 PG 上的实现」。' +
    'SQLite 那半在同一文件里刻意**不**用驱动的 transaction，改发显式 BEGIN IMMEDIATE / COMMIT / ROLLBACK。',
  'platform/persistence/postgresqlDatabaseClient.ts':
    'PG 客户端（sqlite-proxy 之上的 drizzle 远端库）自己的事务管道：它在 `transaction` 属性上预留连接、' +
    '开一个绑定该连接的 drizzle 库再调 `transactionBase.transaction`，实现的正是上面中立会话所依赖的 ' +
    '`db.transaction` 本身。这是驱动层，不是业务调用点。',
}

/**
 * 判接收者的类型，不判变量名。数据库句柄有查询/写入面；中立 session 和 SQL 程序 runner
 * 只有事务编排面。TypeChecker 负责追别名、构造器属性、嵌套对象与局部类型定义，避免把一个
 * drizzle 客户端改叫 `session` 就漏计，也不再误算已经调用中立原语的 runner。
 */
function isDatabaseHandle(type: ts.Type, checker: ts.TypeChecker): boolean {
  if (type.isUnionOrIntersection()) {
    return type.types.some((member) => isDatabaseHandle(member, checker))
  }
  // 类型解析失败不能变成静默漏计。实际生产扫描必须能解析每个事务接收者。
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return true
  const has = (name: string): boolean => checker.getPropertyOfType(type, name) !== undefined
  return (
    ['select', 'insert', 'update', 'delete'].every(has) || ['prepare', 'query', 'exec'].every(has)
  )
}

function countBareTransactions(source: ts.SourceFile, checker: ts.TypeChecker): number {
  let count = 0
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const receiver =
        ts.isPropertyAccessExpression(callee) && callee.name.text === 'transaction'
          ? callee.expression
          : ts.isElementAccessExpression(callee) &&
              ts.isStringLiteralLike(callee.argumentExpression) &&
              callee.argumentExpression.text === 'transaction'
            ? callee.expression
            : undefined
      if (
        receiver !== undefined &&
        isDatabaseHandle(checker.getTypeAtLocation(receiver), checker)
      ) {
        count += 1
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return count
}

let sourceProgram: ts.Program | undefined
const transactionCounts = new Map<string, number>()

function bareTransactionSites(rel: string): number {
  const cached = transactionCounts.get(rel)
  if (cached !== undefined) return cached
  if (sourceProgram === undefined) {
    const configPath = resolve(SRC, '..', 'tsconfig.json')
    const config = ts.readConfigFile(configPath, ts.sys.readFile)
    if (config.error !== undefined)
      throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, resolve(SRC, '..'))
    sourceProgram = ts.createProgram(
      corpusFiles().map((file) => join(SRC, file)),
      parsed.options,
    )
  }
  const source = sourceProgram.getSourceFile(join(SRC, rel))
  if (source === undefined) throw new Error(`RFC-359 transaction corpus missing ${rel}`)
  const count = countBareTransactions(source, sourceProgram.getTypeChecker())
  transactionCounts.set(rel, count)
  return count
}

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

function scan(): string[] {
  const out: string[] = []
  for (const rel of corpusFiles()) {
    if (rel in TRANSACTION_PRIMITIVES) continue
    const count = bareTransactionSites(rel)
    if (count > 0) out.push(`${rel}: ${count}`)
  }
  return out.sort()
}

/** W11 已清完裸驱动事务；生成器 runner 已经走中立原语，不属于驱动调用。 */
export const BARE_TRANSACTION_DEBT: readonly string[] = []

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

describe('RFC-359 W5-T18 —— 裸 `db.transaction(` 只降不升', () => {
  // 真实语料需要构造完整类型图；CI macOS 上约 15 秒。集中扫描一次，
  // 不把 TypeScript 建图成本算进每个默认 5 秒的断言预算。
  beforeAll(() => {
    for (const rel of corpusFiles()) bareTransactionSites(rel)
  }, 60_000)

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

  test('语料非空：确实扫到了整棵 backend 源码树（扫成 0 说明扫描根失效，此刻零预言力）', () => {
    expect(corpusFiles().length).toBeGreaterThanOrEqual(800)
  })

  test('逐文件裸调用点数与账本逐字相等（增了是新的单 provider 事务体，减了是收敛，都要改账本）', () => {
    expect(
      scan(),
      '裸 `.transaction(`（驱动自带的事务面，非中立会话）的逐文件调用点数与账本不符。\n' +
        '**增**了：有人又写了一个只能给一个 provider 跑的事务体——bun:sqlite 的 ' +
        '`Database.transaction` 是同步包装器（async 回调在第一个 await 处被当作已返回并当场 COMMIT），' +
        'PG 驱动的事务是 async，同一个体没法两边跑，于是这段逻辑注定要抄两遍。' +
        '改用中立原语：`databaseSessionFor(db).transaction(async (tx) => …)`' +
        '（只读一致性快照用 `.snapshotRead(...)`，确需谓词隔离才用 `.serializable(...)`），' +
        '它在 SQLite 上发显式 BEGIN IMMEDIATE / COMMIT / ROLLBACK，两个 provider 语义相同。' +
        '确有理由直调驱动（只可能是事务原语自身）就登进 TRANSACTION_PRIMITIVES 并写清理由。\n' +
        '**减**了：收敛发生了——把账本一起改小，让这次减少留下一次有署名的提交记录。',
    ).toEqual([...BARE_TRANSACTION_DEBT])
  })

  test('账本按路径字典序、无重复（清点稳定的前提）', () => {
    const paths = BARE_TRANSACTION_DEBT.map((row) => row.slice(0, row.lastIndexOf(':')))
    expect(new Set(paths).size, '账本里有重复路径').toBe(paths.length)
    expect([...paths].sort()).toEqual(paths)
  })

  test('白名单每条都是仍然存在、且仍然直调驱动的具名文件（死条目 = 空白许可证）', () => {
    for (const [rel, why] of Object.entries(TRANSACTION_PRIMITIVES)) {
      expect(rel, '白名单只收具名 .ts 文件，不收目录 / 通配').toMatch(/\.ts$/)
      expect(existsSync(join(SRC, rel)), `${rel}: 白名单里的文件已不存在，必须删掉这一条`).toBe(
        true,
      )
      expect(
        bareTransactionSites(rel),
        `${rel}: 这个文件已经不直调驱动的 .transaction( 了——豁免变成了空白许可证，` +
          '会把该文件未来新增的裸事务静默放过。删掉这一条。',
      ).toBeGreaterThan(0)
      expect(
        why.length,
        `${rel}: 白名单每条都必须写明「为什么这一处必须直接调驱动」`,
      ).toBeGreaterThan(60)
    }
  })
})

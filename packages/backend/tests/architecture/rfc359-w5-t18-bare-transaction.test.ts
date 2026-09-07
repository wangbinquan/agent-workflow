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
// # 为什么现在是高水位而不是 0
//
// W4 还在逐对收敛（进度见 `STATE.md` 的 RFC-359 交接点）。钉 0 会在收敛完成前把主干钉红，所以
// 采用 RFC-317 T17 的**只降不升高水位棘轮**：逐文件记下当前存量调用点数，与磁盘**逐字相等**——
// 增了红（有人又开了一条单 provider 的路），减了也红（收敛发生了，把账本一起改小，让每一次减少
// 都留下一次有署名的提交记录）。

import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

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
 * 被认可的**中立**调用形态，计数前先剔掉。两种拼法：
 *   · `databaseSessionFor(<expr>).transaction(` —— 直接取会话就调；
 *   · `session.transaction(` / `this.session.transaction(` —— 会话存进局部变量或构造器字段再调。
 *
 * 第二种是别名，本身可以被冒用（把一个裸 drizzle 客户端命名成 `session` 就能蒙混过关），所以它
 * **只在文件确实引入了原语模块时**才豁免（`anchored`）：没有 `databaseSessionFor` / `DatabaseSession`
 * 的 import，那个 `session` 就不可能是中立会话，照债计。2026-09-07 全树实测：26 个用裸 `session`
 * 拼法的文件**无一例外**都 import 了 `@/platform/persistence/databaseTransaction`，这条锚点不放过
 * 任何现存调用点，只堵未来的冒用。
 */
function withoutNeutralSessions(line: string, anchored: boolean): string {
  const stripped = line.replace(/databaseSessionFor\s*\([^()]*\)\s*\.transaction\s*\(/g, 'NEUTRAL(')
  return anchored
    ? stripped.replace(/(^|[^A-Za-z0-9_$.])(?:this\.)?session\s*\.transaction\s*\(/g, '$1NEUTRAL(')
    : stripped
}

/** 引入了中立原语模块 ⇒ 文件里的 `session` 才可能真是 `DatabaseSession`。 */
function importsTransactionPrimitive(text: string): boolean {
  return /from\s+['"][^'"]*platform\/persistence\/databaseTransaction['"]/.test(text)
}

/** 与 S-10 守卫同一条判据：整行是注释就不计（头注释里举的反例不能算债）。 */
function isCommentLine(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
}

function bareTransactionSites(rel: string): number {
  const text = readFileSync(join(SRC, rel), 'utf8')
  const anchored = importsTransactionPrimitive(text)
  let count = 0
  for (const line of text.split('\n')) {
    if (isCommentLine(line)) continue
    count += (withoutNeutralSessions(line, anchored).match(/\.transaction\s*\(/g) ?? []).length
  }
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

/**
 * `<相对 src 的路径>: <裸 `.transaction(` 调用点数>`，按路径字典序。只降不升。
 *
 * 【口径备注 —— `intentSqlPersistence.ts` 的 27 处】那 27 处是 `this.runner.transaction(function* …)`，
 * 收件人是 `IntentSqlProgramRunner`（`modules/intent/infrastructure/intentSqlProgram.ts:53`）——它是
 * 本仓**第二套** provider-中立事务抽象，自带 `SqliteIntentSqlProgramRunner`（内部走 `dbTxSync`）与
 * `PostgresqlIntentSqlProgramRunner`（内部走裸 `db.transaction`）两份实现。它不是「PG 走不了的路」，
 * 但它正是 RFC-359 要收敛掉的那种**并行的双实现事务面**：最终该塌进 `databaseSessionFor`。故按债计入
 * 而不是豁免——把它放进白名单等于给「再开一套并行事务抽象」发许可证。
 */
export const BARE_TRANSACTION_DEBT: readonly string[] = [
  'modules/collaboration/infrastructure/postgresqlClarifyDirectiveStore.ts: 1',
  'modules/collaboration/infrastructure/postgresqlClarifyRepairParticipant.ts: 1',
  'modules/collaboration/infrastructure/postgresqlCollaborationRouteOperations.ts: 1',
  'modules/collaboration/infrastructure/postgresqlReviewRepairParticipant.ts: 1',
  'modules/intent/infrastructure/intentSqlPersistence.ts: 27',
  'modules/intent/infrastructure/postgresqlIntentApplyOperations.ts: 2',
  'modules/intent/infrastructure/postgresqlIntentSqlProgramRunner.ts: 2',
  'modules/resource-catalog/infrastructure/postgresql/repositorySupport.ts: 1',
  'modules/task-execution/infrastructure/postgresqlTaskArchiveMaintenanceCommand.ts: 1',
  'modules/task-execution/infrastructure/postgresqlTaskExecutionEffectPersistence.ts: 1',
  'modules/task-execution/infrastructure/postgresqlTaskExecutionRecovery.ts: 1',
  'modules/task-execution/infrastructure/postgresqlTaskLifecycleTransaction.ts: 3',
  'modules/task-execution/infrastructure/postgresqlTaskOwnershipPersistence.ts: 1',
  'modules/task-execution/infrastructure/postgresqlTerminalMaintenancePersistence.ts: 1',
  'platform/events/committed/postgresqlPersistence.ts: 1',
  'platform/persistence/postgresqlMaintenanceRunStore.ts: 4',
  'platform/persistence/postgresqlResourcePackageAtomicApply.ts: 2',
]

describe('RFC-359 W5-T18 —— 裸 `db.transaction(` 只降不升', () => {
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

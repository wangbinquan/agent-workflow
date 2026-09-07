// RFC-359 W6-T25 —— 批量 INSERT 的中立设施：一份实现，两个引擎按矩阵各自切批。
//
// # 为什么需要它
//
// 「一次操作往同一张表插很多行」在两个引擎上的代价天差地别。2026-09-07 双引擎实测
// （node_run_events，单事务内插 n 行；语句数由 tests/helpers/statementRecorder 录制）：
//
//   n=1000  逐行：SQLite 1002 条 / 28.0ms   PostgreSQL 2002 条 / 428.2ms
//           按批：SQLite    4 条 /  9.0ms   PostgreSQL    6 条 /  21.8ms
//
// PG 上每条语句都是一次网络往返，逐行写因此比 SQLite 贵一个数量级；批量写把它抹平
// （**PG 快 19.6×，SQLite 同时快 3.1×**——本 RFC 的判据是两个引擎都不退化）。
//
// # 为什么不能「一条语句插完」
//
// 无界的单条多行 INSERT 会撞绑定参数上限——`util/sqlChunk.ts` 记着归档器就是这样每小时
// 失败的。上限本身还随构建而变，所以行数上限走能力矩阵的 `batchInsertMax(列数)`，由它
// 一处推导「参数预算 ÷ 列数」与「引擎行数甜点」的较小值，调用方只管把行交出来。
//
// # 事务语义
//
// 切批**不改变原子性**：所有批次跑在调用方传进来的同一个 `tx` 里，任何一批抛错整笔回滚。
// 调用方因此不需要为「插到一半失败」写补偿——这条由 tests/rfc359-t25-batch-insert 双引擎钉住
// （漏 `await` 时 SQLite 侧照样绿、只有 PG 才炸，所以 await 收在这个设施里、不留给调用方）。

import { getTableColumns } from 'drizzle-orm'
import type { SQLiteTable } from 'drizzle-orm/sqlite-core'

import { engineOf, type DatabaseTransaction } from './databaseTransaction'

/**
 * 表宽。**必须走 dialect 无关的 `getTableColumns`**：`db/schema.ts` 的导出在进程级 schema 投影
 * 切到 PostgreSQL 后就是 PgTable，`sqlite-core` 的 `getTableConfig` 会在它上面读到 undefined 的
 * `InlineForeignKeys` 而抛 TypeError（2026-09-07 实撞：SQLite 单跑全绿，PG 侧四个用例当场炸——
 * 这正是「双引擎才抓得住」的一例）。
 */
function columnCountOf(table: SQLiteTable): number {
  return Object.keys(getTableColumns(table)).length
}

/**
 * 把 `rows` 按当前引擎的 `batchInsertMax(表列数)` 切批，逐批交给 `write` 并**在这里 await**。
 *
 * 用表的**全部列数**（而不是行对象上的键数）做保守估算：drizzle 对多行 INSERT 会按各行键的
 * 并集展开，取表宽必定不小于实际绑定数，切出来的批只会更小、不会越界。
 *
 * @returns 实际发出的批次数（= INSERT 语句条数），供性能守卫直接断言。
 */
export async function insertInBatches<Row>(
  tx: DatabaseTransaction,
  table: SQLiteTable,
  rows: readonly Row[],
  write: (batch: readonly Row[]) => unknown,
): Promise<number> {
  if (rows.length === 0) return 0
  const maxRows = engineOf(tx).batchInsertMax(columnCountOf(table))
  let batches = 0
  for (let offset = 0; offset < rows.length; offset += maxRows) {
    await write(rows.slice(offset, offset + maxRows))
    batches += 1
  }
  return batches
}

/**
 * 端口 / 键唯一的 upsert 批：同一批里出现重复键时 **PostgreSQL 直接抛**
 * （`ON CONFLICT DO UPDATE command cannot affect row a second time`），而逐行写的语义是
 * 「后写覆盖先写」。这里按 key **保留最后一条**，让批量写与逐行写落库结果逐字相同。
 */
export function lastPerKey<Row>(rows: readonly Row[], keyOf: (row: Row) => string): Row[] {
  const byKey = new Map<string, Row>()
  for (const row of rows) byKey.set(keyOf(row), row)
  return [...byKey.values()]
}

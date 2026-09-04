// RFC-357 —— 任务列表页查询的 provider 中立底座。
//
// 这一页此前在两个 provider 上是**两份实现**：SQLite 走 `services/taskOperations.ts`
// 的下推查询，PostgreSQL 走目录源里「拉 1 万行进内存再过滤」的另一份。分叉的代价不止
// 性能——facets 数在 view 之后、origin 按 `scheduled_task_id` 猜（「事件」/「API」筛选
// 直接 400）、层级与排序写死，三处都是先在一侧修好、另一侧照旧。
//
// 能收成一份，是因为 RFC-349 已经把地基铺完了，且**这一页的 SQL 文本在两个方言上完全
// 可移植**（调查结论，逐条为据）：
//
//   1. PostgreSQL 的业务客户端就是 drizzle 的 sqlite-proxy driver
//      （`platform/persistence/postgresqlDatabaseClient.ts:35`），`db.all(sql)` 被 Proxy
//      接管、经 `compilePostgresqlSql` 把 `?` 编成 `$n` 后交给连接，回来的同样是
//      `Record<string, unknown>[]`——两侧是同一个调用、同一种返回形状。
//   2. 查询里用到的 `json_valid` / `json_type` / `json_extract` / `instr` 在 PostgreSQL
//      基线里都建了同名 shim（`db/postgresql-migrations/0000_rfc349_baseline.sql:8-29`），
//      而运行时的 `search_path=agent_workflow,public`
//      （`platform/persistence/postgresqlRuntime.ts:204`）让**裸函数名**就能解析到它们。
//   3. `AS MATERIALIZED`、`WITH RECURSIVE`、行值比较 `(a, b) < (c, d)`、`NULLIF`、
//      `||` 拼接在两个方言里同义。
//   4. 用户搜索两侧都已 `lower(列) LIKE lower(模式)`——`docs/dev-gotchas.md` 记的
//      「PostgreSQL 的 LIKE 大小写敏感」在这里不成立，因为两侧都折了大小写。
//
// 于是**没有引入 dialect 抽象**：本来准备的 `SqlDialect` 在逐条核对后每个方法都会退化成
// 恒等，抽象只会变成一层看起来在做事、其实什么都没做的间接层。真正剩下的唯一差异是
// **裸 SQL 回读的数值类型**（PostgreSQL 的 int8 / numeric 按规范交回字符串，而 drizzle
// 的列 mapper 在 `db.all(sql)` 这条路上不参与），处置在投影层统一 `Number()` 归一 +
// 非有限值直接抛（见 `projection.ts`）。差异清单本身由 `rfc357-provider-portability`
// 逐条钉住，前提变了先红在前提上。
//
// 类型上沿用 RFC-350 `taskIdleTimeoutPersistence.ts` 立下的先例：`DbClient`（bun:sqlite，
// 同步）与 `PostgresqlDatabaseClient`（remote，异步）都可赋值给 `BaseSQLiteDatabase`，
// 同一套 query builder 与 `db.all` 在 `await` 之后行为一致。

import type { ProviderNeutralDatabase } from '@/db/query'

/** 两个 provider 客户端的公共基类型（平台词汇，见 `db/query.ts`）。 */
export type TaskListPageDb = ProviderNeutralDatabase

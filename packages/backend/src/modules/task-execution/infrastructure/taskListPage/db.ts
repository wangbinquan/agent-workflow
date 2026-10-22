// RFC-357 —— 任务列表页查询的 provider 中立底座。
//
// 这一页此前在两个 provider 上是**两份实现**：SQLite 走 `services/taskOperations.ts`
// 的下推查询，PostgreSQL 走目录源里「拉 1 万行进内存再过滤」的另一份。分叉的代价不止
// 性能——facets 数在 view 之后、origin 按 `scheduled_task_id` 猜（「事件」/「API」筛选
// 直接 400）、层级与排序写死，三处都是先在一侧修好、另一侧照旧。
//
// RFC-395 I-b：查询经 PersistenceDb 使用原生 Drizzle；表和能力从当前会话取得。
// rawRows 按投影的 contract codecs 解码 int8 / boolean；方言函数由 EngineCapabilities 渲染。
// WITH RECURSIVE、行值比较、NULLIF 与拼接保持原有的共同 SQL 语义。

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'

/** 两个 provider 客户端的公共查询面（平台词汇，见 `platform/persistence/persistenceDb.ts`）。 */
export type TaskListPageDb = PersistenceDb

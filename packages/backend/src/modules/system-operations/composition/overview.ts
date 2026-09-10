// RFC-359 W57 —— `/api/overview` 的装配出口：**一份，两个 provider 共用**。
//
// 此前 SQLite 走 `platform/persistence/sqlite/systemOverviewReadModel.ts::buildOverview`、
// PostgreSQL 走 `composeSystemOverviewQuery`，两份实现逐个聚合键语义等价（对账见 RFC-359
// plan §5i）。`buildOverview` 已整份删除，两个 bootstrap 都从这里取。
//
// 为什么要这一层薄再导出：legacy 层（`server.ts`）**不得直接 import 模块的 application 层**
// （`rfc317-module-boundary` R1）。composition 是模块对装配根开放的那道缝，
// 与 `task-execution/composition/taskOverview.ts` 同形。
export { composeSystemOverviewQuery } from '../application/overview'

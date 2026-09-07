// RFC-359 W4-D28b —— 任务执行写事务的中立装配面：一份实现，两个 provider 共用。
//
// 取代 `sqliteOwnedTaskMutation`（`dbTxSync` + `withOwnedTaskTx` 的同步网关，bun:sqlite 独有）。
// 事务体与围栏都在 `infrastructure/ownedTaskExecution.ts`，两个引擎走同一条：写事务由
// `databaseSessionFor(db).transaction` 划边界，围栏按「显式上下文 > 环境上下文 > 无主围栏」选。
export { fenceTaskWrite, withTaskExecutionWrite } from '../infrastructure/ownedTaskExecution'
export type { TaskExecutionTransaction } from '../infrastructure/ownedTaskExecution'

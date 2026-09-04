// RFC-310 — TaskEngine-backed agent executor for digital employees.
//
// RFC-359 W1-T3：校验 / 宿主快照合成 / 结果投影 / 取消语义收进 `actionExecutionRunners.ts`（一份实现，
// 两个引擎共用）；这里只留两个 provider 的装配面。类型与宿主工作流播种保持从本模块再导出，
// 既有消费方（development-automation 组合、数字员工执行器）import 路径不变。

import {
  createAgentActionExecutionRunner,
  type AgentActionExecutionRunner,
} from './actionExecutionRunners'
import {
  createPostgresqlActionExecutionEnvironment,
  createSqliteActionExecutionEnvironment,
  type PostgresqlActionExecutionEnvironmentDependencies,
  type SqliteActionExecutionEnvironmentDependencies,
} from './actionExecutionEnvironment'

export {
  ensureDigitalEmployeeHostWorkflow,
  type ActionLaunchResult,
  type AgentActionExecutionRunner,
  type AgentExecutionFailure,
  type DigitalEmployeeExecutionSnapshot,
  type DigitalEmployeeLaunchInput,
} from './actionExecutionRunners'

export function composeAgentActionExecution(
  deps: SqliteActionExecutionEnvironmentDependencies,
): AgentActionExecutionRunner {
  return createAgentActionExecutionRunner(createSqliteActionExecutionEnvironment(deps))
}

/** RFC-359 W1-T3：PostgreSQL daemon 的同一个执行器，跑在 provider 选出的根启动内核上。 */
export function composePostgresqlAgentActionExecution(
  deps: PostgresqlActionExecutionEnvironmentDependencies,
): AgentActionExecutionRunner {
  return createAgentActionExecutionRunner(createPostgresqlActionExecutionEnvironment(deps))
}

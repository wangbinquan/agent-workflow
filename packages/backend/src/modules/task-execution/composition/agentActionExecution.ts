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
  createActionExecutionEnvironment,
  type ActionExecutionEnvironmentDependencies,
} from './actionExecutionEnvironment'

export {
  ensureDigitalEmployeeHostWorkflow,
  type ActionLaunchResult,
  type AgentActionExecutionRunner,
  type AgentExecutionFailure,
  type DigitalEmployeeExecutionSnapshot,
  type DigitalEmployeeLaunchInput,
} from './actionExecutionRunners'

/**
 * RFC-359 AC-1（plan §5hi）：**两个 provider 装配面合成一个**，走启动内核那半。
 * 内核在两个引擎上都真启动过（§5hh），SQLite 侧不再走 `startTask`。
 */
export function composeAgentActionExecution(
  deps: ActionExecutionEnvironmentDependencies,
): AgentActionExecutionRunner {
  return createAgentActionExecutionRunner(createActionExecutionEnvironment(deps))
}

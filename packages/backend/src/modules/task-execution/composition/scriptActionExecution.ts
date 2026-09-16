// RFC-310 PR-11 — TaskEngine-backed program executor for digital employees.
//
// `scriptRef` 是 `<workflow-id>@<sha256(stored definition)>`；被引用的工作流必须恰好含一个 Script 节点，
// 其 body / dependencies / env 复制进合成的不可变宿主快照。RFC-359 W1-T3：这套判定与启动序列在
// `actionExecutionRunners.ts` 只写一次，这里只留两个 provider 的装配面。

import {
  createScriptActionExecutionRunner,
  type ScriptActionExecutionRunner,
} from './actionExecutionRunners'
import {
  createActionExecutionEnvironment,
  type ActionExecutionEnvironmentDependencies,
} from './actionExecutionEnvironment'

export {
  type DigitalEmployeeScriptLaunchInput,
  type ScriptActionExecutionRunner,
} from './actionExecutionRunners'

/**
 * RFC-359 AC-1（plan §5hi）：**两个 provider 装配面合成一个**，走启动内核那半。
 * 内核在两个引擎上都真启动过（§5hh），SQLite 侧不再走 `startTask`。
 */
export function composeScriptActionExecution(
  deps: ActionExecutionEnvironmentDependencies,
): ScriptActionExecutionRunner {
  return createScriptActionExecutionRunner(createActionExecutionEnvironment(deps))
}

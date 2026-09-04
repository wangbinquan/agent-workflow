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
  createPostgresqlActionExecutionEnvironment,
  createSqliteActionExecutionEnvironment,
  type PostgresqlActionExecutionEnvironmentDependencies,
  type SqliteActionExecutionEnvironmentDependencies,
} from './actionExecutionEnvironment'

export {
  type DigitalEmployeeScriptLaunchInput,
  type ScriptActionExecutionRunner,
} from './actionExecutionRunners'

export function composeScriptActionExecution(
  deps: SqliteActionExecutionEnvironmentDependencies,
): ScriptActionExecutionRunner {
  return createScriptActionExecutionRunner(createSqliteActionExecutionEnvironment(deps))
}

/** RFC-359 W1-T3：PostgreSQL daemon 的同一个执行器。 */
export function composePostgresqlScriptActionExecution(
  deps: PostgresqlActionExecutionEnvironmentDependencies,
): ScriptActionExecutionRunner {
  return createScriptActionExecutionRunner(createPostgresqlActionExecutionEnvironment(deps))
}

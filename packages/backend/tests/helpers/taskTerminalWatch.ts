// RFC-535: the session's terminal watch for test compositions. The daemon builds one per Task Execution assembly (next
// to its child-task budget); the test topologies build one per database client, so the waiters of a test (child-call
// nodes, action executions) and its notifier (the committed-event test pump, or the test itself) share one watch, and
// two databases never wake each other's waiters.
import {
  createTaskTerminalWatch,
  type TaskTerminalWatch,
} from '@/modules/task-execution/infrastructure/executionWatch'

const watches = new WeakMap<object, TaskTerminalWatch>()

export function testTaskTerminalWatch(db: object): TaskTerminalWatch {
  let watch = watches.get(db)
  if (watch === undefined) {
    watch = createTaskTerminalWatch()
    watches.set(db, watch)
  }
  return watch
}

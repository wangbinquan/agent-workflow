import type { DagScopePorts } from '../application/ports/dagScope'
import type { TaskScopeOutcome } from '../domain/taskEngine'
import { runScope } from '../engine/scope/runScope'
import { maybeRunCommitPush } from '@/services/scheduler'
import type { TaskMechanicsState, TaskScopeArgs } from '@/services/execution/taskMechanicsState'
import { executeNode } from './nodeExecution'
import type { WrapperRuntimeFactory } from './taskExecutionComponents'

/**
 * RFC-409 — the DAG scope interpreter's ports over one execution state (the root's or a wrapper's nested
 * state). Every value is read when the scope asks for it.
 */
export function createDagScopePorts(
  state: TaskMechanicsState,
  wrapperRuntimeFactory: WrapperRuntimeFactory,
): DagScopePorts {
  return {
    task: {
      get taskId() {
        return state.taskId
      },
      get rowId() {
        return state.task.id
      },
      get definition() {
        return state.definition
      },
      get autoCommitPush() {
        return state.task.autoCommitPush
      },
      get topLevelIds() {
        return state.topLevelIds
      },
      get containerOf() {
        return state.containerOf
      },
    },
    get execution() {
      return state.opts.executionContext
    },
    get signal() {
      return state.opts.signal
    },
    persistence: {
      get selection() {
        return state.opts.persistence.selection
      },
      get nodeExecution() {
        return state.opts.persistence.nodeExecution
      },
      get nodeRuns() {
        return state.opts.persistence.nodeRuns
      },
      get intents() {
        return state.opts.persistence.intents
      },
    },
    get collaboration() {
      return state.opts.taskDagCollaboration
    },
    executeNode: (input) => executeNode(state, input, wrapperRuntimeFactory),
    commitPush: (node, iteration, log) => maybeRunCommitPush(state, node, iteration, log),
  }
}

/** RFC-409 — the DAG scope over an execution state: the root drive and every wrapper's recursive scope. */
export function driveDagScope(
  state: TaskMechanicsState,
  args: TaskScopeArgs,
  wrapperRuntimeFactory: WrapperRuntimeFactory,
): Promise<TaskScopeOutcome> {
  return runScope(createDagScopePorts(state, wrapperRuntimeFactory), args)
}

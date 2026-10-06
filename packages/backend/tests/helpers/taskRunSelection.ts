// RFC-370: a complete selected family whose unused effects fail explicitly.
import type { NodeRunPromptOperations } from '@/modules/task-execution/application/ports/nodeRunPromptContent'
import type { PortArtifactOperations } from '@/modules/task-execution/application/ports/portArtifactContent'
import type { TaskAgentRunFamily } from '@/modules/task-execution/application/ports/taskAgentRunFamily'
import type { TaskScriptRunFamily } from '@/modules/task-execution/application/ports/taskScriptRunFamily'
import type { TaskRunFamilyBinding } from '@/modules/task-execution/application/ports/taskRunSelection'
import type { TaskRunRootSelection } from '@/modules/task-execution/composition/taskRunSelection'

export function unusedTaskRunEffect(): never {
  throw new Error('this selected family must stop before an execution effect')
}

export function unusedAgentFamily(): TaskAgentRunFamily {
  return Object.freeze({
    runtimeBindings: Object.freeze({
      resolve: unusedTaskRunEffect,
      ofSession: unusedTaskRunEffect,
      internal: unusedTaskRunEffect,
    }),
    materialReferences: Object.freeze({ references: unusedTaskRunEffect }),
    open: unusedTaskRunEffect,
  })
}

export function unusedScriptFamily(): TaskScriptRunFamily {
  return Object.freeze({
    resolveInterpreter: unusedTaskRunEffect,
    describeInterpreterResolution: unusedTaskRunEffect,
    prepareRunContent: unusedTaskRunEffect,
    dependencyInterpreter: unusedTaskRunEffect,
    ensureDependencies: unusedTaskRunEffect,
    execute: unusedTaskRunEffect,
    runtimeParameters: unusedTaskRunEffect,
    recordUnownedStart: unusedTaskRunEffect,
  })
}

export function chosenTaskRuns(
  contents: {
    readonly nodeRunPrompts: NodeRunPromptOperations
    readonly portArtifacts: PortArtifactOperations
  },
  effects: {
    agent?: (binding: TaskRunFamilyBinding) => TaskAgentRunFamily | Promise<TaskAgentRunFamily>
    script?: (binding: TaskRunFamilyBinding) => TaskScriptRunFamily | Promise<TaskScriptRunFamily>
  } = {},
) {
  const agents: TaskRunFamilyBinding[] = []
  const scripts: TaskRunFamilyBinding[] = []
  const selection: TaskRunRootSelection = Object.freeze({
    runs: Object.freeze({
      contentNamespace: Object.freeze({
        kind: 'task-run-content-namespace' as const,
        reference: Object.freeze({}),
      }),
      ...contents,
      taskAgentRunsFor(binding: TaskRunFamilyBinding) {
        agents.push(binding)
        return effects.agent === undefined ? unusedAgentFamily() : effects.agent(binding)
      },
      taskScriptRunsFor(binding: TaskRunFamilyBinding) {
        scripts.push(binding)
        return effects.script === undefined ? unusedScriptFamily() : effects.script(binding)
      },
    }),
    configurationFor() {
      return Object.freeze({
        kind: 'task-run-configuration' as const,
        reference: Object.freeze({}),
      })
    },
  })
  return { selection, agents, scripts }
}

export function unusedTaskRunContents() {
  return {
    nodeRunPrompts: Object.freeze({ read: unusedTaskRunEffect, store: unusedTaskRunEffect }),
    portArtifacts: Object.freeze({ read: unusedTaskRunEffect, archive: unusedTaskRunEffect }),
  }
}

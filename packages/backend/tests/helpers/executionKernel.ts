import type { TaskExecutionPersistence } from '@/modules/task-execution/application/ports/taskExecutionPersistence'
import type { TaskExecutionContextRef } from '@/modules/task-execution/application/ports/taskExecutionTopology'
import { bindIsolationKernel } from '@/modules/task-execution/infrastructure/executionKernelBinding'
import { createIsolationWorkspacePort } from '@/modules/task-execution/infrastructure/isolationWorkspaceView'
import { selectIsolationWorkspaceFactory } from '@/modules/source-control/public/participants'

/** Direct primitive tests select the native adapter explicitly, at the original lazy bind site. */
export function createTestIsolationBinding(input: {
  readonly persistence: Pick<
    TaskExecutionPersistence,
    'artifactPaths' | 'effects' | 'mergeStates' | 'nodeExecution'
  >
  readonly executionContext?: TaskExecutionContextRef
}) {
  return {
    ...bindIsolationKernel({
      ...input.persistence,
      workspace: createIsolationWorkspacePort((binding) =>
        selectIsolationWorkspaceFactory().bind(binding),
      ),
      ...(input.executionContext === undefined ? {} : { executionContext: input.executionContext }),
    }),
    persistence: input.persistence,
  }
}

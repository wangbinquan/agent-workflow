import {
  createProcessEffectAttemptObserver as createObserver,
  type ProcessEffectAttemptObserver,
} from '../application/processEffectObserver'
import type { TaskExecutionContext } from '../application/taskExecutionContext'
import type { TaskExecutionEffectPersistence } from '../application/ports/taskExecutionEffectStore'
import {
  createLocalProcessEffectProjection,
  type LocalProcessSpawnReceipt,
  type LocalProcessSettlement,
  type LocalProcessResources,
} from '../infrastructure/local/processEffectProjection'

/** Compatibility composition for the existing local Agent/script runners.
 * Selected execution bindings supply their own projection to the application
 * coordinator instead of obtaining this local default. */
export function createProcessEffectAttemptObserver(input: {
  persistence: TaskExecutionEffectPersistence
  taskId: string
  nodeRunId: string
  processKind: 'agent' | 'script'
  argv: readonly string[]
  cwd: string
  resourceKeys?: LocalProcessResources
  context?: TaskExecutionContext
}): ProcessEffectAttemptObserver<LocalProcessSpawnReceipt, LocalProcessSettlement> | undefined {
  return createObserver({
    persistence: input.persistence,
    taskId: input.taskId,
    nodeRunId: input.nodeRunId,
    processKind: input.processKind,
    projection: createLocalProcessEffectProjection(input),
    ...(input.context === undefined ? {} : { context: input.context }),
  })
}

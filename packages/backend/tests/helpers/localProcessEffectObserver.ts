// RFC-480 — moved from task-execution `composition/processEffectObserver.ts`. Production reached it only through a
// `public/participants` alias that no other module consumed; once the alias was withdrawn only tests composed the local
// default projection (the production runners hand their own projection to `application/processEffectObserver`).
import {
  createProcessEffectAttemptObserver as createObserver,
  type ProcessEffectAttemptObserver,
} from '@/modules/task-execution/application/processEffectObserver'
import type { TaskExecutionContext } from '@/modules/task-execution/application/taskExecutionContext'
import type { TaskExecutionEffectPersistence } from '@/modules/task-execution/application/ports/taskExecutionEffectStore'
import {
  createLocalProcessEffectProjection,
  type LocalProcessSpawnReceipt,
  type LocalProcessSettlement,
  type LocalProcessResources,
} from '@/modules/task-execution/infrastructure/local/processEffectProjection'

/** The local default projection composed onto the application coordinator, for tests that exercise local processes. */
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

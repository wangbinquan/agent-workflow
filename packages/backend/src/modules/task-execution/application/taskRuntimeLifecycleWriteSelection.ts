import type { TaskExecutionPersistence } from './ports/taskExecutionPersistence'
import type {
  TaskRuntimeLifecyclePersistence,
  TaskRuntimeLifecycleWritePurposes,
} from './ports/taskRuntimeLifecyclePersistence'

type Selection = Pick<
  TaskExecutionPersistence,
  'runtimeLifecycle' | 'runtimeLifecycleWriteMode' | 'runtimeLifecycleWritePurposes'
>

export function selectTaskRuntimeLifecycleWrites(
  persistence: Selection,
  purpose: keyof TaskRuntimeLifecycleWritePurposes,
): TaskRuntimeLifecyclePersistence {
  if (
    persistence.runtimeLifecycleWriteMode === undefined &&
    persistence.runtimeLifecycleWritePurposes === undefined
  )
    return persistence.runtimeLifecycle
  const view = persistence.runtimeLifecycleWritePurposes?.[purpose]
  if (view === undefined) throw new Error('task-runtime-lifecycle-write-purposes-not-composed')
  return view
}

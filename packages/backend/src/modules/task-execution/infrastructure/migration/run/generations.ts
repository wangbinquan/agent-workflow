import type { TaskFacts } from '@/platform/persistence/migration/conversion/lookups/keys'
import type { TargetRow } from '@/platform/persistence/migration/conversion/types'

export function legacyGeneration(task: TaskFacts): TargetRow {
  return {
    task_id: task.taskId,
    generation_seq: 0,
    cause: 'legacy-epoch1',
    previous_generation_seq: null,
    operation_ref: null,
    created_at: task.startedAt,
  }
}

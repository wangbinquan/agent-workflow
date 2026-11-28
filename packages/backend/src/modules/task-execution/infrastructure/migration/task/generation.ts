import type { TaskFacts } from '@/platform/persistence/migration/conversion/lookups/keys'
import type { TargetRow } from '@/platform/persistence/migration/conversion/types'

/**
 * RFC-626 §3.3: every converted task has execution generation 0, and the task rule emits it
 * beside the definition, launch context and workspace. The run rule used to emit it while it
 * converted the task's runs, so a run group set aside whole left a converted task without it.
 * The values are the ones the run rule wrote (`run/generations.ts`), field for field.
 */
export function legacyGenerationZero(task: TaskFacts): TargetRow {
  return {
    task_id: task.taskId,
    generation_seq: 0,
    cause: 'legacy-epoch1',
    previous_generation_seq: null,
    operation_ref: null,
    created_at: task.startedAt,
  }
}

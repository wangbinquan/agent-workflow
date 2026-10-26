import type { SourceRow, TargetRow } from '@/platform/persistence/migration/conversion/types'
import type { TargetRegistryView } from '@/platform/persistence/migration/conversion/targetRows'
import type { TaskLineage } from './lineage'
import { pick, text } from './values'

export function taskName(id: string, name: string | null): string {
  return name === null || name === '' ? `task-${[...id].slice(-10).join('')}` : name
}

export function taskLifecycle(
  task: SourceRow,
  target: TargetRegistryView,
  rootRef: string | null,
): TargetRow {
  return {
    ...pick(
      task,
      Object.values(target.table('tasks').columns)
        .map((column) => column.name)
        .filter((column) => column !== 'workspace_root_ref'),
    ),
    name: taskName(
      text(task, 'id'),
      typeof task.values.name === 'string' ? task.values.name : null,
    ),
    workspace_root_ref: rootRef,
  }
}

export function taskLaunchContext(task: SourceRow, lineage: TaskLineage): TargetRow {
  return {
    task_id: text(task, 'id'),
    ...pick(task, [
      'launch_origin',
      'scheduled_task_id',
      'webhook_trigger_id',
      'webhook_fire_id',
      'event_subscription_id',
      'event_delivery_id',
      'digital_employee_round_id',
      'digital_employee_case_id',
      'parent_node_run_id',
      'trigger_context_json',
      'platform_input_paths_json',
      'source_termination_binding',
      'source_termination_launch_rev',
    ]),
    execution_lineage_id: lineage.missingFields.length ? null : lineage.executionLineageId,
    lineage_slot_path_json: lineage.missingFields.length ? null : lineage.lineageSlotPathJson,
  }
}

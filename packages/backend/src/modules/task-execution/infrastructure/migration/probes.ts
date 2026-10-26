import type { ReadOnlyProbe } from '@/platform/persistence/migration/run/types'

/** Target admission checks are reads; they never start task recovery or effects. */
export const readOnlyProbes: readonly ReadOnlyProbe[] = [
  {
    id: 'task-execution:task-aggregate',
    async run(connection) {
      const incomplete = await connection.query(`select t.id from tasks t
      left join task_definitions d on d.task_id = t.id
      left join task_launch_contexts l on l.task_id = t.id
      left join task_workspaces w on w.task_id = t.id
      left join task_execution_generations g on g.task_id = t.id and g.generation_seq = 0
      where d.task_id is null or l.task_id is null or w.task_id is null or g.task_id is null
      or (t.status in ('pending', 'running', 'awaiting_review', 'awaiting_human', 'interrupted')
        and (d.subject_kind = 'unknown' or l.execution_lineage_id is null or l.lineage_slot_path_json is null)) limit 1`)
      const invalidMount = await connection.query(`select task_id from task_repository_mounts
      group by task_id having min(ordinal) <> 0 limit 1`)
      return {
        id: 'task-execution:task-aggregate',
        passed: incomplete.length === 0 && invalidMount.length === 0,
        detail: {
          incomplete: incomplete.map((row) => String(row.id)),
          invalidMount: invalidMount.map((row) => String(row.task_id)),
        },
      }
    },
  },
]

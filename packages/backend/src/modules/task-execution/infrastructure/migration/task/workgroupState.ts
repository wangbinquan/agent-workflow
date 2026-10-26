import type { SourceRow, TargetRow } from '@/platform/persistence/migration/conversion/types'
import type { TaskFacts } from '@/platform/persistence/migration/conversion/lookups/keys'
import { nullableText, text } from './values'

export function workgroupState(
  task: SourceRow,
  state: SourceRow | undefined,
  facts: TaskFacts,
): { row: TargetRow; synthesized: boolean } | null {
  const config = task.codecTakeovers?.some((failure) => failure.column === 'workgroup_config_json')
    ? null
    : nullableText(task, 'workgroup_config_json')
  if (!state && facts.subjectKind !== 'workgroup' && config === null) return null
  return {
    row: {
      // resource-catalog/infrastructure/legacy/workgroup/state.ts:170 — engine default row.
      ...(state?.values ?? {
        task_id: text(task, 'id'),
        gate_status: 'idle',
        gate_summary: null,
        gate_rejected_comment: null,
        pause_reason: null,
        dw_state_json: null,
        result_message_id: null,
        updated_at: facts.startedAt,
      }),
      runtime_config_json: config,
      config_revision: 1,
    },
    synthesized: !state,
  }
}

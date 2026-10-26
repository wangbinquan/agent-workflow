import { decodeTaskWorkgroupConfig, WorkflowDefinitionSchema } from '@agent-workflow/shared'
import { encodeWorkgroupLaunchConfig } from '../../../domain/workgroupLaunchConfigCodec'
import type { SourceRow, TargetRow } from '@/platform/persistence/migration/conversion/types'
import type { deriveTaskSubjectFacts } from './subject'
import { jsonObject, nullableText, pick, text } from './values'

export function taskDefinition(
  task: SourceRow,
  facts: ReturnType<typeof deriveTaskSubjectFacts>,
): { row: TargetRow; missingFields: readonly string[] } {
  const config = decodeTaskWorkgroupConfig(nullableText(task, 'workgroup_config_json'))
  const snapshot = jsonObject(text(task, 'workflow_snapshot'))
  const missingFields: string[] = []
  if (!WorkflowDefinitionSchema.safeParse(snapshot).success) missingFields.push('workflow_snapshot')
  if (!jsonObject(text(task, 'inputs'))) missingFields.push('inputs')
  if (facts.subject.kind === 'workflow' && facts.subject.sourceId === '')
    missingFields.push('workflow_id')
  if (facts.subject.kind === 'workgroup') {
    if (!config.runtime.config) missingFields.push('workgroup_config_json')
    if (config.runtime.raw?.workgroupId !== facts.subject.sourceId)
      missingFields.push('workgroup_config_json.workgroupId')
  }
  const unknownSubject =
    facts.mismatch || (facts.subject.kind === 'workflow' && facts.subject.sourceId === '')
  return {
    row: {
      task_id: text(task, 'id'),
      subject_kind: unknownSubject ? 'unknown' : facts.subject.kind,
      source_id: unknownSubject ? text(task, 'workflow_id') : facts.subject.sourceId,
      source_name:
        !unknownSubject && facts.subject.kind === 'agent' ? facts.subject.sourceName : null,
      source_revision: task.values.workflow_version!,
      definition_origin: facts.definitionOrigin,
      engine_kind: unknownSubject ? 'unknown' : facts.engineKind,
      definition_revision: 1,
      ...pick(task, [
        'workflow_snapshot',
        'inputs',
        'max_duration_ms',
        'max_total_tokens',
        'schema_version',
        'ref_closure_json',
      ]),
      workgroup_config_json:
        config.runtime.raw === null ? null : encodeWorkgroupLaunchConfig(config.runtime.raw),
    },
    missingFields,
  }
}

import type { TaskFacts } from '@/platform/persistence/migration/conversion/lookups/keys'
import type { SourceRow } from '@/platform/persistence/migration/conversion/types'
import {
  decodeTaskWorkgroupConfig,
  deriveWorkgroupDispatch,
  parseDwState,
  workgroupLaunchMode,
} from '@agent-workflow/shared'
import {
  definitionAnchorId,
  definitionHost,
  TASK_DEFINITION_HOSTS,
  taskDefinitionOrigin,
  type TaskSubject,
} from '../../../domain/taskSubject'
import { jsonObject, nullableText, text } from './values'

export function deriveTaskSubjectFacts(
  task: SourceRow,
  workflowBuiltin: boolean | undefined,
  state?: SourceRow,
) {
  const stored = {
    workflowId: text(task, 'workflow_id'),
    codeRoundId: nullableText(task, 'code_round_id'),
    workgroupId: nullableText(task, 'workgroup_id'),
    sourceAgentId: nullableText(task, 'source_agent_id'),
    sourceAgentName: nullableText(task, 'source_agent_name'),
  }
  const subject = decodeTaskSubject(stored)
  const config = decodeTaskWorkgroupConfig(nullableText(task, 'workgroup_config_json'))
  const dw = parseDwState(state ? jsonObject(nullableText(state, 'dw_state_json')) : null)
  const mode = workgroupLaunchMode(config.launch)
  const dispatch = mode ? deriveWorkgroupDispatch(mode, dw?.phase) : null
  const engineKind: TaskFacts['engineKind'] =
    subject.kind !== 'workgroup'
      ? 'dag'
      : dispatch === 'dw-generate'
        ? 'dw-generate'
        : dispatch === 'dw-execute'
          ? 'dag'
          : 'workgroup-turns'
  return {
    subject,
    mismatch: taskSubjectStorageMismatch(stored),
    definitionAnchorId: definitionAnchorId(subject),
    engineKind,
    definitionOrigin: taskDefinitionOrigin(subject, workflowBuiltin === true),
  }
}

export const TASK_SUBJECT_DISCRIMINATORS = [
  { kind: 'code-round', field: 'codeRoundId' },
  { kind: 'workgroup', field: 'workgroupId' },
  { kind: 'agent', field: 'sourceAgentName' },
  {
    kind: 'digital-employee',
    field: 'workflowId',
    equals: TASK_DEFINITION_HOSTS['digital-employee'].id,
  },
] as const

export interface StoredTaskSubject {
  readonly workflowId: string
  readonly codeRoundId?: string | null
  readonly workgroupId?: string | null
  readonly sourceAgentId?: string | null
  readonly sourceAgentName?: string | null
}

/** Epoch-1 reader; migration rule 4.1-5 fixes this precedence, including inconsistent rows. */
export function decodeTaskSubject(row: StoredTaskSubject): TaskSubject {
  for (const rule of TASK_SUBJECT_DISCRIMINATORS) {
    const value = row[rule.field]
    if ('equals' in rule ? value !== rule.equals : value == null || value === '') continue
    switch (rule.kind) {
      case 'code-round':
        return { kind: 'code-round', sourceId: value! }
      case 'workgroup':
        return { kind: 'workgroup', sourceId: value! }
      case 'agent':
        return { kind: 'agent', sourceId: row.sourceAgentId ?? null, sourceName: value! }
      case 'digital-employee':
        return { kind: 'digital-employee', sourceId: null }
    }
  }
  return { kind: 'workflow', sourceId: row.workflowId }
}

export function taskSubjectStorageMismatch(row: StoredTaskSubject): boolean {
  return (
    definitionHost(row.workflowId) !== null &&
    (decodeTaskSubject(row).kind === 'workflow' ||
      definitionAnchorId(decodeTaskSubject(row)) !== row.workflowId)
  )
}

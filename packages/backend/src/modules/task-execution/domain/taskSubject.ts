import { TASK_DEFINITION_HOSTS } from '@agent-workflow/shared'

/** RFC-395 II-a: execution identity is independent of the resource catalog. */
export type TaskSubject =
  | { readonly kind: 'workflow'; readonly sourceId: string }
  | { readonly kind: 'agent'; readonly sourceId: string | null; readonly sourceName: string }
  | { readonly kind: 'workgroup'; readonly sourceId: string }
  | { readonly kind: 'digital-employee'; readonly sourceId: null }
  | { readonly kind: 'code-round'; readonly sourceId: string }

export { TASK_DEFINITION_HOSTS } from '@agent-workflow/shared'

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

export function definitionAnchorId(subject: TaskSubject): string {
  return subject.kind === 'workflow' ? subject.sourceId : TASK_DEFINITION_HOSTS[subject.kind].id
}

export function definitionHost(
  anchorId: string,
): (typeof TASK_DEFINITION_HOSTS)[keyof typeof TASK_DEFINITION_HOSTS] | null {
  return Object.values(TASK_DEFINITION_HOSTS).find((host) => host.id === anchorId) ?? null
}

export function taskSubjectStorageMismatch(row: StoredTaskSubject): boolean {
  return (
    definitionHost(row.workflowId) !== null &&
    (decodeTaskSubject(row).kind === 'workflow' ||
      definitionAnchorId(decodeTaskSubject(row)) !== row.workflowId)
  )
}

export type TaskDefinitionOrigin = 'authored' | 'platform'

/** II-a reads today's layout decision; II-b freezes this value at launch. */
export function taskDefinitionOrigin(
  subject: TaskSubject,
  workflowBuiltin: boolean,
): TaskDefinitionOrigin {
  return subject.kind !== 'workflow' || workflowBuiltin ? 'platform' : 'authored'
}

export interface TaskSubjectProjection {
  workflowId: string
  workflowName: string | null
}

export function projectTaskSubject(
  subject: TaskSubject,
  liveWorkflowName: string | null,
): TaskSubjectProjection {
  return {
    workflowId: definitionAnchorId(subject),
    workflowName:
      subject.kind === 'workflow' ? liveWorkflowName : TASK_DEFINITION_HOSTS[subject.kind].name,
  }
}

export function taskSubjectWorkflowVersion(
  _subject: TaskSubject,
  frozenVersion: number | null,
): number | null {
  return frozenVersion
}

/** Runtime mode remains a workgroup concern after subject discrimination. */
export function isTurnEngineTaskSubject(
  subject: TaskSubject,
  mode: string | null | undefined,
): boolean {
  return subject.kind === 'workgroup' && mode !== 'dynamic_workflow'
}

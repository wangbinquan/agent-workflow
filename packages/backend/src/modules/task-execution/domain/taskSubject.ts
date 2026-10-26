import { TASK_DEFINITION_HOSTS } from '@agent-workflow/shared'

/** RFC-395 II-a: execution identity is independent of the resource catalog. */
export type TaskSubject =
  | { readonly kind: 'workflow'; readonly sourceId: string }
  | { readonly kind: 'agent'; readonly sourceId: string | null; readonly sourceName: string }
  | { readonly kind: 'workgroup'; readonly sourceId: string }
  | { readonly kind: 'digital-employee'; readonly sourceId: null }
  | { readonly kind: 'code-round'; readonly sourceId: string }

/** Unknown is a historical read variant, never a creation input. sourceId retains the old anchor. */
export type TaskReadSubject = TaskSubject | { readonly kind: 'unknown'; readonly sourceId: string }

export { TASK_DEFINITION_HOSTS } from '@agent-workflow/shared'

export function definitionAnchorId(subject: TaskReadSubject): string {
  return subject.kind === 'workflow' || subject.kind === 'unknown'
    ? subject.sourceId
    : TASK_DEFINITION_HOSTS[subject.kind].id
}

export function definitionHost(
  anchorId: string,
): (typeof TASK_DEFINITION_HOSTS)[keyof typeof TASK_DEFINITION_HOSTS] | null {
  return Object.values(TASK_DEFINITION_HOSTS).find((host) => host.id === anchorId) ?? null
}

export type TaskDefinitionOrigin = 'authored' | 'platform'

/** Compute the creation-time origin once; readers use the persisted column. */
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
  subject: TaskReadSubject,
  liveWorkflowName: string | null,
): TaskSubjectProjection {
  return {
    workflowId: definitionAnchorId(subject),
    workflowName:
      subject.kind === 'unknown'
        ? null
        : subject.kind === 'workflow'
          ? liveWorkflowName
          : TASK_DEFINITION_HOSTS[subject.kind].name,
  }
}

export function taskSubjectWorkflowVersion(
  _subject: TaskReadSubject,
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

export interface TaskDefinitionSubject {
  readonly subjectKind: TaskReadSubject['kind']
  readonly sourceId: string | null
  readonly sourceName: string | null
}

export function taskReadSubjectFromDefinition(row: TaskDefinitionSubject): TaskReadSubject {
  if (row.subjectKind === 'unknown') return { kind: 'unknown', sourceId: row.sourceId ?? '' }
  return taskSubjectFromDefinition(row)
}

/** Execution requires a known frozen discriminator; history uses taskReadSubjectFromDefinition. */
export function taskSubjectFromDefinition(row: TaskDefinitionSubject): TaskSubject {
  switch (row.subjectKind) {
    case 'unknown':
      throw new Error('task-subject-history-only')
    case 'digital-employee':
      if (row.sourceId !== null) throw new Error('task-subject-digital-employee-source')
      return { kind: 'digital-employee', sourceId: null }
    case 'agent':
      if (row.sourceName === null) throw new Error('task-subject-agent-name-missing')
      return { kind: 'agent', sourceId: row.sourceId, sourceName: row.sourceName }
    case 'workflow':
    case 'workgroup':
    case 'code-round':
      if (row.sourceId === null) throw new Error('task-subject-source-missing')
      return { kind: row.subjectKind, sourceId: row.sourceId }
  }
}

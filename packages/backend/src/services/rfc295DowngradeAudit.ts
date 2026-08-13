// RFC-295 — read-only compatibility audit for coordinated downgrades.
//
// The RFC-295 runtime only validates CodeHost templates that the selected
// action/provider can execute. Older binaries scanned a wider persisted
// projection. A resource saved by the new binary can therefore be valid now
// but fail save, launch, resume, or direct-executor preflight after downgrade.
// This module reports that exact legacy delta without mutating stored data.

import {
  WorkflowDefinitionSchema,
  collectActiveWorkflowTemplateSurfaces,
  collectWorkflowTemplateSurfaces,
  evaluateTriggerDependencies,
  extractTemplateRefs,
  migrateWorkflowDefinitionToLatest,
  parseTriggerContextJson,
  type ParsedTriggerContext,
  type TriggerDependencySource,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import { parseCallClosure } from '@/services/execution/closure'

export const RFC295_DOWNGRADE_AUDIT_TASK_STATUSES = [
  'pending',
  'running',
  'failed',
  'interrupted',
  'awaiting_review',
  'awaiting_human',
] as const

type AuditedTaskStatus = (typeof RFC295_DOWNGRADE_AUDIT_TASK_STATUSES)[number]

export interface Rfc295AuditWorkflowRow {
  readonly id: string
  readonly name: string
  readonly version: number
  readonly definition: string
}

export interface Rfc295AuditTaskRow {
  readonly id: string
  readonly workflowId: string
  readonly workflowVersion: number | null
  readonly status: string
  readonly workflowSnapshot: string
  readonly refClosureJson: string | null
  readonly triggerContextJson: string | null
}

export interface Rfc295DowngradeAuditInput {
  readonly workflows: readonly Rfc295AuditWorkflowRow[]
  readonly tasks: readonly Rfc295AuditTaskRow[]
}

export type Rfc295DowngradeIssueCode =
  | 'definition-invalid'
  | 'closure-invalid'
  | 'legacy-invalid-template-ref'
  | 'legacy-local-ref-missing'
  | 'legacy-trigger-context-invalid'
  | 'legacy-trigger-context-missing'
  | 'legacy-trigger-field-unavailable'

export interface Rfc295DowngradeIssue {
  readonly code: Rfc295DowngradeIssueCode
  readonly scope: 'workflow' | 'task-root' | 'task-closure'
  readonly workflowId: string
  readonly revision: number | null
  readonly taskId: string | null
  readonly nodeId: string | null
  readonly pointer: string
  readonly ref: string | null
  readonly detail: string
}

export interface Rfc295DowngradeAuditResult {
  readonly ok: boolean
  readonly scanned: {
    readonly workflows: number
    readonly tasks: number
    readonly closureWorkflows: number
  }
  readonly issues: readonly Rfc295DowngradeIssue[]
}

interface DefinitionOrigin {
  readonly scope: Rfc295DowngradeIssue['scope']
  readonly workflowId: string
  readonly revision: number | null
  readonly taskId: string | null
  readonly triggerSource: TriggerDependencySource
}

const AUDITED_TASK_STATUS_SET: ReadonlySet<string> = new Set(RFC295_DOWNGRADE_AUDIT_TASK_STATUSES)

function issue(
  origin: DefinitionOrigin,
  values: Omit<Rfc295DowngradeIssue, 'scope' | 'workflowId' | 'revision' | 'taskId'>,
): Rfc295DowngradeIssue {
  return {
    scope: origin.scope,
    workflowId: origin.workflowId,
    revision: origin.revision,
    taskId: origin.taskId,
    ...values,
  }
}

function parseDefinition(
  raw: string,
  origin: DefinitionOrigin,
  issues: Rfc295DowngradeIssue[],
): WorkflowDefinition | null {
  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch (error) {
    issues.push(
      issue(origin, {
        code: 'definition-invalid',
        nodeId: null,
        pointer: '/',
        ref: null,
        detail: `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      }),
    )
    return null
  }
  const parsed = WorkflowDefinitionSchema.safeParse(decoded)
  if (!parsed.success) {
    issues.push(
      issue(origin, {
        code: 'definition-invalid',
        nodeId: null,
        pointer: '/',
        ref: null,
        detail: parsed.error.issues[0]?.message ?? 'workflow definition does not match schema',
      }),
    )
    return null
  }
  return migrateWorkflowDefinitionToLatest(parsed.data)
}

function sourceFromStoredContext(raw: string | null): TriggerDependencySource {
  const parsed: ParsedTriggerContext = parseTriggerContextJson(raw)
  return parsed.kind === 'ok' ? { kind: 'context', value: parsed.value } : parsed
}

function inactiveCodeHostSurfaces(definition: WorkflowDefinition) {
  const active = new Set(
    collectActiveWorkflowTemplateSurfaces(definition).map(
      (surface) => `${surface.nodeId}\u0000${surface.pointer}`,
    ),
  )
  return collectWorkflowTemplateSurfaces(definition).filter(
    (surface) =>
      surface.refDomain === 'code-host' && !active.has(`${surface.nodeId}\u0000${surface.pointer}`),
  )
}

function scanDefinition(
  definition: WorkflowDefinition,
  origin: DefinitionOrigin,
  out: Rfc295DowngradeIssue[],
): void {
  const inbound = new Map<string, Set<string>>()
  for (const edge of definition.edges) {
    const ports = inbound.get(edge.target.nodeId) ?? new Set<string>()
    ports.add(edge.target.portName)
    inbound.set(edge.target.nodeId, ports)
  }

  for (const surface of inactiveCodeHostSurfaces(definition)) {
    for (const ref of extractTemplateRefs(surface.text)) {
      if (ref.kind === 'invalid') {
        out.push(
          issue(origin, {
            code: 'legacy-invalid-template-ref',
            nodeId: surface.nodeId,
            pointer: surface.pointer,
            ref: ref.raw,
            detail: `legacy persisted-inventory validation rejects ${ref.reason}`,
          }),
        )
        continue
      }

      // The legacy Workflow validator inspected every params.* value, even
      // when the selected preset/custom action never consumed that parameter.
      if (
        ref.kind === 'local' &&
        surface.pointer.includes('/params/') &&
        !(inbound.get(surface.nodeId) ?? new Set<string>()).has(ref.name)
      ) {
        out.push(
          issue(origin, {
            code: 'legacy-local-ref-missing',
            nodeId: surface.nodeId,
            pointer: surface.pointer,
            ref: ref.raw,
            detail:
              'legacy Workflow validation cannot resolve this inactive parameter to an inbound port',
          }),
        )
        continue
      }

      if (ref.kind !== 'trigger') continue
      const dependency = { field: ref.field, nodeId: surface.nodeId, pointer: surface.pointer }
      const dependencyIssue = evaluateTriggerDependencies([dependency], origin.triggerSource)[0]
      if (dependencyIssue === undefined) continue
      const code: Rfc295DowngradeIssueCode =
        dependencyIssue.code === 'trigger-context-invalid'
          ? 'legacy-trigger-context-invalid'
          : dependencyIssue.code === 'trigger-context-missing'
            ? 'legacy-trigger-context-missing'
            : 'legacy-trigger-field-unavailable'
      out.push(
        issue(origin, {
          code,
          nodeId: surface.nodeId,
          pointer: surface.pointer,
          ref: ref.raw,
          detail:
            dependencyIssue.code === 'trigger-context-invalid'
              ? 'legacy preflight cannot read the frozen trigger context'
              : dependencyIssue.code === 'trigger-context-missing'
                ? 'legacy preflight requires Webhook context for this inactive value'
                : 'legacy preflight rejects this inactive field for the frozen event type',
        }),
      )
    }
  }
}

/**
 * Compare data accepted after RFC-295 with the pre-RFC persisted projection.
 * Any issue blocks downgrade; there is intentionally no ignore/override input.
 */
export function auditRfc295Downgrade(input: Rfc295DowngradeAuditInput): Rfc295DowngradeAuditResult {
  const issues: Rfc295DowngradeIssue[] = []
  let closureWorkflows = 0

  for (const workflow of input.workflows) {
    const origin: DefinitionOrigin = {
      scope: 'workflow',
      workflowId: workflow.id,
      revision: workflow.version,
      taskId: null,
      // A current resource can be launched manually after downgrade; fail
      // closed for an inactive trigger ref rather than assuming an external
      // Webhook rule will always supply a compatible event.
      triggerSource: { kind: 'none' },
    }
    const definition = parseDefinition(workflow.definition, origin, issues)
    if (definition !== null) scanDefinition(definition, origin, issues)
  }

  const auditedTasks = input.tasks.filter((task) => AUDITED_TASK_STATUS_SET.has(task.status))
  for (const task of auditedTasks) {
    const triggerSource = sourceFromStoredContext(task.triggerContextJson)
    const rootOrigin: DefinitionOrigin = {
      scope: 'task-root',
      workflowId: task.workflowId,
      revision: task.workflowVersion,
      taskId: task.id,
      triggerSource,
    }
    const root = parseDefinition(task.workflowSnapshot, rootOrigin, issues)
    if (root !== null) scanDefinition(root, rootOrigin, issues)

    if (task.refClosureJson === null || task.refClosureJson === '') continue
    const closure = parseCallClosure(task.refClosureJson)
    if (closure === null) {
      issues.push(
        issue(rootOrigin, {
          code: 'closure-invalid',
          nodeId: null,
          pointer: '/refClosureJson',
          ref: null,
          detail: 'frozen call closure cannot be parsed',
        }),
      )
      continue
    }
    for (const frozen of Object.values(closure.workflows)) {
      closureWorkflows += 1
      const closureOrigin: DefinitionOrigin = {
        scope: 'task-closure',
        workflowId: frozen.id,
        revision: frozen.version,
        taskId: task.id,
        triggerSource,
      }
      scanDefinition(frozen.definition, closureOrigin, issues)
    }
  }

  return {
    ok: issues.length === 0,
    scanned: {
      workflows: input.workflows.length,
      tasks: auditedTasks.length,
      closureWorkflows,
    },
    issues,
  }
}

export function isRfc295AuditedTaskStatus(value: string): value is AuditedTaskStatus {
  return AUDITED_TASK_STATUS_SET.has(value)
}

// RFC-292 — one backend orchestration point for trigger dependency preflight.

import {
  TriggerContextSchema,
  collectTriggerDependencies,
  evaluateTriggerDependencies,
  type TriggerContext,
  type TriggerDependencyIssue,
  type TriggerDependencySource,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import { ValidationError } from '@/util/errors'
import { parseCallClosure } from './closure'

export function triggerSourceFromContext(
  context: TriggerContext | null | undefined,
): TriggerDependencySource {
  if (context === null || context === undefined) return { kind: 'none' }
  const parsed = TriggerContextSchema.safeParse(context)
  return parsed.success ? { kind: 'context', value: parsed.data } : { kind: 'invalid' }
}

export function collectLaunchTriggerDefinitions(
  root: WorkflowDefinition,
  closureJson: string | null,
): WorkflowDefinition[] {
  const closure = parseCallClosure(closureJson)
  return [
    root,
    ...(closure === null ? [] : Object.values(closure.workflows).map((item) => item.definition)),
  ]
}

export function triggerPreflightIssue(args: {
  root: WorkflowDefinition
  closureJson: string | null
  source: TriggerDependencySource
}): TriggerDependencyIssue | null {
  const dependencies = collectTriggerDependencies(
    collectLaunchTriggerDefinitions(args.root, args.closureJson),
  )
  return evaluateTriggerDependencies(dependencies, args.source)[0] ?? null
}

export function assertTriggerPreflight(args: {
  root: WorkflowDefinition
  closureJson: string | null
  source: TriggerDependencySource
}): void {
  const issue = triggerPreflightIssue(args)
  if (issue === null) return
  if (issue.code === 'trigger-context-invalid') {
    throw new ValidationError(issue.code, 'the frozen task trigger context is invalid')
  }
  if (issue.code === 'trigger-context-missing') {
    throw new ValidationError(issue.code, 'workflow requires webhook trigger context', {
      source: 'webhook',
      field: issue.dependency.field,
      nodeId: issue.dependency.nodeId,
      pointer: issue.dependency.pointer,
    })
  }
  throw new ValidationError(issue.code, 'workflow trigger field is unavailable for this event', {
    source: 'webhook',
    field: issue.dependency.field,
    ...(issue.eventType === undefined ? {} : { eventType: issue.eventType }),
    nodeId: issue.dependency.nodeId,
    pointer: issue.dependency.pointer,
  })
}

// RFC-292 — authoritative inventory of author-authored workflow templates.

import type { WorkflowDefinition, WorkflowNode } from './schemas/workflow'
import type { CodeHostEventType, WebhookTemplateVar } from './schemas/webhook'
import type { ParsedTriggerContext, TriggerContext } from './triggerContext'
import { WEBHOOK_EVENT_VAR_MATRIX } from './schemas/webhook'
import { extractTemplateRefs } from './templateRef'
import { projectCodeHostTemplates } from './codeHost/templateProjection'
import {
  workflowTemplateAuthorityKey,
  type WorkflowTemplateAuthorityKey,
} from './templateAuthority'

export type WorkflowTemplateSink =
  | 'model-prompt'
  | 'workgroup-goal'
  | 'review-prompt'
  | 'http-param'
  | 'http-path'
  | 'http-query'
  | 'http-json-body'

export type WorkflowTemplateRefDomain = 'prompt' | 'review' | 'code-host'

export interface WorkflowTemplateSurface {
  readonly nodeId: string
  readonly pointer: string
  readonly sink: WorkflowTemplateSink
  readonly refDomain: WorkflowTemplateRefDomain
  readonly authorityKey: WorkflowTemplateAuthorityKey
  readonly text: string
}

function pointerPart(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1')
}

function surface(
  nodeId: string,
  pointer: string,
  sink: WorkflowTemplateSink,
  refDomain: WorkflowTemplateRefDomain,
  text: unknown,
): WorkflowTemplateSurface | null {
  return typeof text === 'string'
    ? { nodeId, pointer, sink, refDomain, authorityKey: workflowTemplateAuthorityKey(sink), text }
    : null
}

function surfacesOfNode(node: WorkflowNode, index: number): WorkflowTemplateSurface[] {
  const rec = node as Record<string, unknown>
  const root = `/nodes/${index}`
  const out: WorkflowTemplateSurface[] = []
  const add = (item: WorkflowTemplateSurface | null): void => {
    if (item !== null) out.push(item)
  }

  switch (node.kind) {
    case 'agent-single':
      add(surface(node.id, `${root}/promptTemplate`, 'model-prompt', 'prompt', rec.promptTemplate))
      break
    case 'call-workgroup':
      add(surface(node.id, `${root}/goalTemplate`, 'workgroup-goal', 'prompt', rec.goalTemplate))
      break
    case 'review':
      add(
        surface(
          node.id,
          `${root}/commentInjectTemplate`,
          'review-prompt',
          'review',
          rec.commentInjectTemplate,
        ),
      )
      break
    case 'code-host-call': {
      const params = rec.params
      if (params !== null && typeof params === 'object' && !Array.isArray(params)) {
        for (const [key, text] of Object.entries(params as Record<string, unknown>)) {
          add(
            surface(node.id, `${root}/params/${pointerPart(key)}`, 'http-param', 'code-host', text),
          )
        }
      }
      const request = rec.request
      if (request !== null && typeof request === 'object' && !Array.isArray(request)) {
        const req = request as Record<string, unknown>
        add(surface(node.id, `${root}/request/path`, 'http-path', 'code-host', req.path))
        const query = req.query
        if (query !== null && typeof query === 'object' && !Array.isArray(query)) {
          for (const [key, text] of Object.entries(query as Record<string, unknown>)) {
            add(
              surface(
                node.id,
                `${root}/request/query/${pointerPart(key)}`,
                'http-query',
                'code-host',
                text,
              ),
            )
          }
        }
        add(surface(node.id, `${root}/request/body`, 'http-json-body', 'code-host', req.body))
      }
      break
    }
    default:
      break
  }
  return out
}

export function collectWorkflowTemplateSurfaces(
  definition: WorkflowDefinition,
): WorkflowTemplateSurface[] {
  return definition.nodes.flatMap((node, index) => surfacesOfNode(node, index))
}

/**
 * Authoring/validation/runtime inventory. Persisted collection above remains
 * deliberately exhaustive; CodeHostCall is projected to the selected
 * action/provider here so inactive legacy values cannot block an unrelated
 * action while still remaining available to migration/diff.
 */
export function collectActiveWorkflowTemplateSurfaces(
  definition: WorkflowDefinition,
): WorkflowTemplateSurface[] {
  return definition.nodes.flatMap((node, index) => {
    if (node.kind !== 'code-host-call') return surfacesOfNode(node, index)
    const root = `/nodes/${index}`
    return projectCodeHostTemplates(node).active.map((entry) => ({
      nodeId: node.id,
      pointer: `${root}${entry.pointer}`,
      sink: entry.sink,
      refDomain: 'code-host' as const,
      authorityKey: workflowTemplateAuthorityKey(entry.sink),
      text: entry.text,
    }))
  })
}

/** Clone and rewrite only inventoried template strings. */
export function mapWorkflowTemplateSurfaces(
  definition: WorkflowDefinition,
  mapper: (surface: WorkflowTemplateSurface) => string,
): WorkflowDefinition {
  let changed = false
  const nodes = definition.nodes.map((node, index) => {
    const rec = node as Record<string, unknown>
    const root = `/nodes/${index}`
    let next: Record<string, unknown> | null = null
    const ensure = (): Record<string, unknown> => {
      next ??= { ...rec }
      return next
    }
    const rewrite = (
      key: string,
      sink: WorkflowTemplateSink,
      refDomain: WorkflowTemplateRefDomain,
    ): void => {
      if (typeof rec[key] !== 'string') return
      const item = surface(node.id, `${root}/${key}`, sink, refDomain, rec[key])!
      const value = mapper(item)
      if (value !== rec[key]) {
        ensure()[key] = value
        changed = true
      }
    }

    if (node.kind === 'agent-single') rewrite('promptTemplate', 'model-prompt', 'prompt')
    if (node.kind === 'call-workgroup') rewrite('goalTemplate', 'workgroup-goal', 'prompt')
    if (node.kind === 'review') rewrite('commentInjectTemplate', 'review-prompt', 'review')

    if (node.kind === 'code-host-call') {
      const params = rec.params
      if (params !== null && typeof params === 'object' && !Array.isArray(params)) {
        let nextParams: Record<string, unknown> | null = null
        for (const [key, text] of Object.entries(params as Record<string, unknown>)) {
          if (typeof text !== 'string') continue
          const item = surface(
            node.id,
            `${root}/params/${pointerPart(key)}`,
            'http-param',
            'code-host',
            text,
          )!
          const value = mapper(item)
          if (value !== text) {
            nextParams ??= { ...(params as Record<string, unknown>) }
            nextParams[key] = value
            changed = true
          }
        }
        if (nextParams !== null) ensure().params = nextParams
      }

      const request = rec.request
      if (request !== null && typeof request === 'object' && !Array.isArray(request)) {
        const req = request as Record<string, unknown>
        let nextRequest: Record<string, unknown> | null = null
        const ensureRequest = (): Record<string, unknown> => {
          nextRequest ??= { ...req }
          return nextRequest
        }
        for (const [key, sink] of [
          ['path', 'http-path'],
          ['body', 'http-json-body'],
        ] as const) {
          const text = req[key]
          if (typeof text !== 'string') continue
          const item = surface(node.id, `${root}/request/${key}`, sink, 'code-host', text)!
          const value = mapper(item)
          if (value !== text) {
            ensureRequest()[key] = value
            changed = true
          }
        }
        const query = req.query
        if (query !== null && typeof query === 'object' && !Array.isArray(query)) {
          let nextQuery: Record<string, unknown> | null = null
          for (const [key, text] of Object.entries(query as Record<string, unknown>)) {
            if (typeof text !== 'string') continue
            const item = surface(
              node.id,
              `${root}/request/query/${pointerPart(key)}`,
              'http-query',
              'code-host',
              text,
            )!
            const value = mapper(item)
            if (value !== text) {
              nextQuery ??= { ...(query as Record<string, unknown>) }
              nextQuery[key] = value
              changed = true
            }
          }
          if (nextQuery !== null) ensureRequest().query = nextQuery
        }
        if (nextRequest !== null) ensure().request = nextRequest
      }
    }

    return (next ?? rec) as WorkflowNode
  })
  return changed ? { ...definition, nodes } : definition
}

export interface TriggerDependency {
  readonly field: WebhookTemplateVar
  readonly nodeId: string
  readonly pointer: string
}

export function collectTriggerDependencies(
  definitions: readonly WorkflowDefinition[],
): TriggerDependency[] {
  const out: TriggerDependency[] = []
  const seen = new Set<string>()
  for (const definition of definitions) {
    for (const item of collectActiveWorkflowTemplateSurfaces(definition)) {
      for (const ref of extractTemplateRefs(item.text)) {
        if (ref.kind !== 'trigger') continue
        const key = `${item.nodeId}\u0000${item.pointer}\u0000${ref.field}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ field: ref.field, nodeId: item.nodeId, pointer: item.pointer })
      }
    }
  }
  return out
}

export type TriggerDependencySource =
  | ParsedTriggerContext
  | { readonly kind: 'context'; readonly value: TriggerContext }
  | { readonly kind: 'event-types'; readonly eventTypes: readonly CodeHostEventType[] }

export type TriggerDependencyIssue =
  | { readonly code: 'trigger-context-invalid' }
  | { readonly code: 'trigger-context-missing'; readonly dependency: TriggerDependency }
  | {
      readonly code: 'trigger-field-unavailable'
      readonly dependency: TriggerDependency
      readonly eventType?: CodeHostEventType
    }

export function evaluateTriggerDependencies(
  dependencies: readonly TriggerDependency[],
  source: TriggerDependencySource,
): TriggerDependencyIssue[] {
  if (source.kind === 'invalid') return [{ code: 'trigger-context-invalid' }]
  if (dependencies.length === 0) return []
  if (source.kind === 'none') {
    return [{ code: 'trigger-context-missing', dependency: dependencies[0]! }]
  }

  if (source.kind === 'event-types') {
    if (source.eventTypes.length === 0) {
      return [{ code: 'trigger-field-unavailable', dependency: dependencies[0]! }]
    }
    for (const dependency of dependencies) {
      if (
        source.eventTypes.some(
          (eventType) => !WEBHOOK_EVENT_VAR_MATRIX[eventType].includes(dependency.field),
        )
      ) {
        return [{ code: 'trigger-field-unavailable', dependency }]
      }
    }
    return []
  }

  const context = source.value
  const eventType = context.trigger.webhook.event_type
  const available = WEBHOOK_EVENT_VAR_MATRIX[eventType]
  for (const dependency of dependencies) {
    if (!available.includes(dependency.field)) {
      return [{ code: 'trigger-field-unavailable', dependency, eventType }]
    }
  }
  return []
}

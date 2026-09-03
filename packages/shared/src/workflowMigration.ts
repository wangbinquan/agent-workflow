// RFC-292 — pure workflow-definition migration to the canonical template grammar.

import {
  WORKFLOW_SCHEMA_VERSION,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
} from './schemas/workflow'
import { REVIEW_INPUT_PORT_NAME } from './reviewMultiDoc'
import {
  mapWorkflowTemplateSurfaces,
  type WorkflowTemplateRefDomain,
} from './workflowTemplateSurfaces'
import type { WebhookTemplateVar } from './schemas/webhook'
import { isWebhookTriggerField } from './triggerContext'
import { webhookTriggerToken } from './templateRef'

const WORD_RE = /^\w+$/

function escapedToken(body: string): string | null {
  const first = body.search(/\S/)
  if (first < 0) return null
  return `{{${body.slice(0, first)}!${body.slice(first)}}}`
}

function canonicalTriggerBody(body: string): WebhookTemplateVar | null {
  const parts = body.split('.')
  if (parts.length === 2 && parts[0] === 'trigger' && isWebhookTriggerField(parts[1]!)) {
    return parts[1] as WebhookTemplateVar
  }
  if (
    parts.length === 3 &&
    parts[0] === 'trigger' &&
    parts[1] === 'webhook' &&
    isWebhookTriggerField(parts[2]!)
  ) {
    return parts[2] as WebhookTemplateVar
  }
  return null
}

function wasLegacyLocal(body: string, domain: WorkflowTemplateRefDomain): boolean {
  const parts = body.split('.')
  if (domain === 'code-host') {
    return parts.length <= 2 && parts.every((part) => WORD_RE.test(part))
  }
  return parts.length === 1 && WORD_RE.test(parts[0]!)
}

function isTriggerLooking(body: string): boolean {
  return body === 'trigger' || body.startsWith('trigger.')
}

/**
 * Upgrade one v4 author template while preserving every old literal expression
 * except the intentionally activated known trigger aliases.
 */
export function migrateWorkflowTemplateToV5(
  text: string,
  domain: WorkflowTemplateRefDomain,
): string {
  let out = ''
  let cursor = 0
  while (cursor < text.length) {
    const open = text.indexOf('{{', cursor)
    if (open < 0) {
      out += text.slice(cursor)
      break
    }
    out += text.slice(cursor, open)
    const close = text.indexOf('}}', open + 2)
    if (close < 0) {
      out += text.slice(open)
      break
    }

    const token = text.slice(open, close + 2)
    const rawBody = text.slice(open + 2, close)
    const body = rawBody.trim()
    const triggerField = canonicalTriggerBody(body)
    if (triggerField !== null) {
      out += webhookTriggerToken(triggerField)
    } else if (isTriggerLooking(body)) {
      // Unknown/legacy-malformed trigger paths stay visible to the v5 parser,
      // which rejects them instead of turning them into inert text.
      out += token
    } else if (wasLegacyLocal(body, domain)) {
      out += token
    } else {
      out += escapedToken(rawBody) ?? token
    }
    cursor = close + 2
  }
  return out
}

// ---------------------------------------------------------------------------
// RFC-354 — v5 → v6: every node-level PortRef field becomes an edge.
//
//   review   `inputSource`            → the one inbound edge to `__review_input__`
//   output   `ports[].bind`           → an inbound edge per port
//   loop     `outputBindings[]`       → `wrapper-output` boundary edges (returns)
//            `exitCondition.nodeId`   → dropped; `portName` now names the loop's
//                                       OWN return port (a binding is added when
//                                       the exit port had none)
//   fanout   `inputs[]`               → `shardSourcePort` (parameters are edges)
//
// Pure and idempotent: an edge is only added when no equivalent edge exists,
// ids are allocated against the definition's own id set, and a v6 document
// passes through untouched (the cascade never re-enters this step).
// ---------------------------------------------------------------------------

type PortRefLike = { nodeId: string; portName: string }
type RawNode = Record<string, unknown>

function isPortRef(value: unknown): value is PortRefLike {
  // An empty `{ nodeId: '', portName: '' }` was the canvas' "not wired yet"
  // mirror for an unconnected review / output port — it names nothing, so it
  // upgrades to no edge (the field is simply dropped).
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as Record<string, unknown>).nodeId === 'string' &&
    (value as Record<string, unknown>).nodeId !== '' &&
    typeof (value as Record<string, unknown>).portName === 'string' &&
    (value as Record<string, unknown>).portName !== ''
  )
}

function readBindingList(node: RawNode, key: string): Array<{ name: string; bind: PortRefLike }> {
  const raw = node[key]
  if (!Array.isArray(raw)) return []
  const out: Array<{ name: string; bind: PortRefLike }> = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (typeof record.name === 'string' && isPortRef(record.bind)) {
      out.push({
        name: record.name,
        bind: { nodeId: record.bind.nodeId, portName: record.bind.portName },
      })
    }
  }
  return out
}

function sameEnds(edge: WorkflowEdge, source: PortRefLike, target: PortRefLike): boolean {
  return (
    edge.source.nodeId === source.nodeId &&
    edge.source.portName === source.portName &&
    edge.target.nodeId === target.nodeId &&
    edge.target.portName === target.portName
  )
}

class EdgeIds {
  private readonly used: Set<string>
  constructor(edges: readonly WorkflowEdge[]) {
    this.used = new Set(edges.map((edge) => edge.id))
  }
  allocate(stem: string): string {
    const base = stem.replace(/[^A-Za-z0-9_-]+/g, '_')
    let candidate = base
    for (let n = 2; this.used.has(candidate); n += 1) candidate = `${base}_${n}`
    this.used.add(candidate)
    return candidate
  }
}

function withoutKeys(node: RawNode, keys: readonly string[]): RawNode {
  const next: RawNode = {}
  for (const [key, value] of Object.entries(node)) {
    if (!keys.includes(key)) next[key] = value
  }
  return next
}

/** RFC-354 — the v5 → v6 step on its own (exported for the golden tests). */
export function migrateWorkflowDefinitionV5ToV6(
  definition: WorkflowDefinition,
): WorkflowDefinition {
  const edges: WorkflowEdge[] = [...definition.edges]
  const ids = new EdgeIds(edges)
  const ensureEdge = (
    source: PortRefLike,
    target: PortRefLike,
    boundary: WorkflowEdge['boundary'] | undefined,
  ): void => {
    if (edges.some((edge) => sameEnds(edge, source, target))) return
    edges.push({
      id: ids.allocate(
        `${source.nodeId}_${source.portName}_to_${target.nodeId}_${target.portName}`,
      ),
      source: { nodeId: source.nodeId, portName: source.portName },
      target: { nodeId: target.nodeId, portName: target.portName },
      ...(boundary === undefined ? {} : { boundary }),
    })
  }

  const nodes = definition.nodes.map((original): WorkflowNode => {
    const node = original as unknown as RawNode
    switch (node.kind) {
      case 'review': {
        if (isPortRef(node.inputSource)) {
          ensureEdge(
            node.inputSource,
            { nodeId: node.id as string, portName: REVIEW_INPUT_PORT_NAME },
            undefined,
          )
        }
        return withoutKeys(node, ['inputSource']) as unknown as WorkflowNode
      }
      case 'output': {
        for (const port of readBindingList(node, 'ports')) {
          ensureEdge(port.bind, { nodeId: node.id as string, portName: port.name }, undefined)
        }
        return withoutKeys(node, ['ports']) as unknown as WorkflowNode
      }
      case 'wrapper-loop': {
        const loopId = node.id as string
        const bindings = readBindingList(node, 'outputBindings')
        for (const binding of bindings) {
          ensureEdge(binding.bind, { nodeId: loopId, portName: binding.name }, 'wrapper-output')
        }
        let exitCondition = node.exitCondition
        if (exitCondition !== null && typeof exitCondition === 'object') {
          const raw = exitCondition as Record<string, unknown>
          if (typeof raw.nodeId === 'string' && typeof raw.portName === 'string') {
            const source = { nodeId: raw.nodeId, portName: raw.portName }
            // The exit port must be one of the loop's own return ports: reuse the
            // binding that already promotes this body port, else promote it under
            // its own name (suffixed when that return name is taken by another
            // body port).
            const existing =
              bindings.find(
                (binding) =>
                  binding.bind.nodeId === source.nodeId &&
                  binding.bind.portName === source.portName,
              ) ??
              edges
                .filter(
                  (edge) =>
                    edge.boundary === 'wrapper-output' &&
                    edge.target.nodeId === loopId &&
                    edge.source.nodeId === source.nodeId &&
                    edge.source.portName === source.portName,
                )
                .map((edge) => ({ name: edge.target.portName, bind: source }))[0]
            let returnPort = existing?.name
            if (returnPort === undefined) {
              const taken = new Set(
                edges
                  .filter(
                    (edge) => edge.boundary === 'wrapper-output' && edge.target.nodeId === loopId,
                  )
                  .map((edge) => edge.target.portName),
              )
              returnPort = source.portName
              for (let n = 2; taken.has(returnPort); n += 1) returnPort = `${source.portName}_${n}`
              ensureEdge(source, { nodeId: loopId, portName: returnPort }, 'wrapper-output')
            }
            const { nodeId: _nodeId, ...rest } = raw
            exitCondition = { ...rest, portName: returnPort }
          }
        }
        return {
          ...withoutKeys(node, ['outputBindings', 'exitCondition']),
          ...(exitCondition === undefined ? {} : { exitCondition }),
        } as unknown as WorkflowNode
      }
      case 'wrapper-fanout': {
        const inputs = Array.isArray(node.inputs)
          ? (node.inputs as Array<Record<string, unknown>>)
          : []
        const shard = inputs.find(
          (port) => port !== null && typeof port === 'object' && port.isShardSource === true,
        )
        const next = withoutKeys(node, ['inputs'])
        if (typeof next.shardSourcePort !== 'string' && typeof shard?.name === 'string') {
          next.shardSourcePort = shard.name
        }
        return next as unknown as WorkflowNode
      }
      default:
        return original
    }
  })
  return { ...definition, nodes, edges, $schema_version: 6 }
}

/** Cascading v1 -> ... -> v6 migration. Pure and idempotent. */
export function migrateWorkflowDefinitionToLatest(
  definition: WorkflowDefinition,
): WorkflowDefinition {
  let current = definition
  if (current.$schema_version === 1) current = { ...current, $schema_version: 2 }
  if (current.$schema_version === 2) current = { ...current, $schema_version: 3 }
  if (current.$schema_version === 3) current = { ...current, $schema_version: 4 }
  if (current.$schema_version === 4) {
    current = mapWorkflowTemplateSurfaces(current, (item) =>
      migrateWorkflowTemplateToV5(item.text, item.refDomain),
    )
    current = { ...current, $schema_version: 5 }
  }
  if (current.$schema_version === 5) current = migrateWorkflowDefinitionV5ToV6(current)
  if (current.$schema_version !== WORKFLOW_SCHEMA_VERSION) return current
  return current
}

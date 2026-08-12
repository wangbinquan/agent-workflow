// RFC-292 — pure workflow-definition migration to the canonical template grammar.

import { WORKFLOW_SCHEMA_VERSION, type WorkflowDefinition } from './schemas/workflow'
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

/** Cascading v1 -> ... -> v5 migration. Pure and idempotent. */
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
  if (current.$schema_version !== WORKFLOW_SCHEMA_VERSION) return current
  return current
}

import type { WebhookLaunchKind } from './schemas/webhook'
import type { WebhookTemplateSink } from './webhookTemplate'
import type { WorkflowTemplateSink } from './workflowTemplateSurfaces'

export const WORKFLOW_TEMPLATE_AUTHORITY_KEYS = [
  'workflow:model-prompt',
  'workflow:workgroup-goal',
  'workflow:review-prompt',
  'workflow:http-param',
  'workflow:http-path',
  'workflow:http-query',
  'workflow:http-json-body',
] as const

export const WEBHOOK_TEMPLATE_AUTHORITY_KEYS = [
  'webhook:workflow:workflow-input-text',
  'webhook:workflow:working-branch',
  'webhook:agent:agent-description',
  'webhook:agent:agent-input',
  'webhook:agent:working-branch',
  'webhook:workgroup:workgroup-goal',
  'webhook:workgroup:working-branch',
] as const

export const RUNTIME_TEMPLATE_AUTHORITY_KEYS = [
  ...WORKFLOW_TEMPLATE_AUTHORITY_KEYS,
  ...WEBHOOK_TEMPLATE_AUTHORITY_KEYS,
] as const

export type WorkflowTemplateAuthorityKey = (typeof WORKFLOW_TEMPLATE_AUTHORITY_KEYS)[number]
export type WebhookTemplateAuthorityKey = (typeof WEBHOOK_TEMPLATE_AUTHORITY_KEYS)[number]
export type RuntimeTemplateAuthorityKey = (typeof RUNTIME_TEMPLATE_AUTHORITY_KEYS)[number]

export function workflowTemplateAuthorityKey(
  sink: WorkflowTemplateSink,
): WorkflowTemplateAuthorityKey {
  return `workflow:${sink}`
}

export function webhookTemplateAuthorityKey(
  launchKind: WebhookLaunchKind,
  sink: WebhookTemplateSink,
): WebhookTemplateAuthorityKey {
  const key = `webhook:${launchKind}:${sink}`
  if (!(WEBHOOK_TEMPLATE_AUTHORITY_KEYS as readonly string[]).includes(key)) {
    throw new Error(`invalid Webhook template authority '${key}'`)
  }
  return key as WebhookTemplateAuthorityKey
}

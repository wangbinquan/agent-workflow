// RFC-292 — neutral, source-shaped trigger context.
//
// This module is deliberately outside codeHost/: webhook is a task launch
// source, while code-host-call, agent prompts, workgroup goals and review
// prompts are all equal consumers of the frozen task context.

import { z } from 'zod'
import {
  CodeHostEventTypeSchema,
  WEBHOOK_TEMPLATE_VARS,
  type CodeHostEventType,
  type WebhookTemplateVar,
} from './schemas/webhook'

/** The closed webhook field set. It is derived, never copied. */
export const TRIGGER_CONTEXT_FIELDS: readonly WebhookTemplateVar[] = WEBHOOK_TEMPLATE_VARS

const TRIGGER_CONTEXT_FIELD_SET: ReadonlySet<string> = new Set(TRIGGER_CONTEXT_FIELDS)

export function isWebhookTriggerField(value: string): value is WebhookTemplateVar {
  return TRIGGER_CONTEXT_FIELD_SET.has(value)
}

export type WebhookTriggerFields = Readonly<
  { event_type: CodeHostEventType } & Partial<
    Readonly<Record<Exclude<WebhookTemplateVar, 'event_type'>, string>>
  >
>

export interface TriggerContext {
  readonly trigger: {
    readonly webhook: WebhookTriggerFields
  }
}

const optionalWebhookFields = Object.fromEntries(
  TRIGGER_CONTEXT_FIELDS.filter((field) => field !== 'event_type').map((field) => [
    field,
    z.string().optional(),
  ]),
)

export const WebhookTriggerFieldsSchema = z
  .object({
    event_type: CodeHostEventTypeSchema,
    ...optionalWebhookFields,
  })
  .strict() as z.ZodType<WebhookTriggerFields>

export const TriggerContextSchema = z
  .object({
    trigger: z
      .object({
        webhook: WebhookTriggerFieldsSchema,
      })
      .strict(),
  })
  .strict() as z.ZodType<TriggerContext>

export type ParsedTriggerContext =
  | { readonly kind: 'none' }
  | { readonly kind: 'ok'; readonly value: TriggerContext; readonly migratedFromFlat: boolean }
  | { readonly kind: 'invalid' }

/**
 * Decode the task-row JSON without conflating NULL with corrupt state.
 *
 * Historical RFC-269 rows stored the webhook fields as a flat object. A valid
 * flat row is wrapped in memory; unknown keys, a missing discriminator, or a
 * malformed nested root fail closed.
 */
export function parseTriggerContextJson(raw: string | null | undefined): ParsedTriggerContext {
  if (raw === null || raw === undefined) return { kind: 'none' }

  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    return { kind: 'invalid' }
  }

  const canonical = TriggerContextSchema.safeParse(decoded)
  if (canonical.success) {
    return { kind: 'ok', value: canonical.data, migratedFromFlat: false }
  }

  const historicalFlat = WebhookTriggerFieldsSchema.safeParse(decoded)
  if (!historicalFlat.success) return { kind: 'invalid' }
  return {
    kind: 'ok',
    value: { trigger: { webhook: historicalFlat.data } },
    migratedFromFlat: true,
  }
}

export function webhookFieldsOf(context: TriggerContext): WebhookTriggerFields {
  return context.trigger.webhook
}

/** Deterministic, value-free editor/test preview context. */
export function sampleWebhookTriggerContext(): TriggerContext {
  const fields = Object.fromEntries(
    TRIGGER_CONTEXT_FIELDS.filter((field) => field !== 'event_type').map((field) => [
      field,
      `<trigger.webhook.${field}>`,
    ]),
  ) as Partial<Record<Exclude<WebhookTemplateVar, 'event_type'>, string>>
  return { trigger: { webhook: { event_type: 'note', ...fields } } }
}

// RFC-292/RFC-310 — neutral, source-shaped trigger context.
//
// This module is deliberately outside codeHost/: webhook is a task launch
// source, while code-host-call, agent prompts, workgroup goals and review
// prompts are all equal consumers of the frozen task context.

import { z } from 'zod'
import {
  CodeHostEventTypeSchema,
  WEBHOOK_EVENT_VAR_MATRIX,
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

/**
 * The same field bag, without claiming a code-host event.
 *
 * RFC-292's header already says webhook is a launch SOURCE and its consumers
 * are equal; RFC-309 added the second source — a person pressing "run this
 * template" — which fills the same fields and has no `event_type`, because no
 * code-host event happened. Synthesizing one would put a fabricated delivery
 * into the context every downstream consumer reads and trusts.
 */
export type CodeContextFields = Omit<WebhookTriggerFields, 'event_type'> &
  Partial<Pick<WebhookTriggerFields, 'event_type'>>

export const TRIGGER_NAMESPACE_RE = /^[a-z][a-z0-9_-]{0,63}$/
export const TRIGGER_FIELD_RE = /^[a-z][a-z0-9_-]{0,127}$/

export interface TriggerParameterContract {
  /** Author-facing namespace in `trigger.<namespace>.<field>`. */
  readonly namespace: string
  /** Immutable event-type-owned definition that declared the injected fields. */
  readonly definitionRef: { readonly id: string; readonly revision: number }
  /** Fields structurally available for this exact event, including empty values. */
  readonly availableFields: readonly string[]
}

export interface TriggerContext {
  readonly trigger: Readonly<Record<string, Readonly<Record<string, string>>>>
  /** Absent only on pre-RFC-310 in-memory/serialized Webhook fixtures. */
  readonly contract?: TriggerParameterContract
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

const triggerParameterContractSchema = z
  .object({
    namespace: z.string().regex(TRIGGER_NAMESPACE_RE),
    definitionRef: z
      .object({ id: z.string().min(1).max(200), revision: z.number().int().positive() })
      .strict(),
    availableFields: z
      .array(z.string().regex(TRIGGER_FIELD_RE))
      .min(1)
      .max(256)
      .transform((fields) => [...new Set(fields)]),
  })
  .strict()

const canonicalTriggerContextSchema = z
  .object({
    trigger: z.record(
      z.string().regex(TRIGGER_NAMESPACE_RE),
      z.record(z.string().regex(TRIGGER_FIELD_RE), z.string().max(64 * 1024)),
    ),
    contract: triggerParameterContractSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const namespaces = Object.keys(value.trigger)
    if (namespaces.length !== 1 || namespaces[0] !== value.contract.namespace) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'trigger context must contain exactly its declared namespace',
        path: ['trigger'],
      })
      return
    }
    const fields = value.trigger[value.contract.namespace] ?? {}
    for (const field of Object.keys(fields)) {
      if (!value.contract.availableFields.includes(field)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `trigger value is not declared by its contract: ${field}`,
          path: ['trigger', value.contract.namespace, field],
        })
      }
    }
  })

/**
 * Canonical runtime contract. Its shape is source-neutral; the legacy
 * Webhook-only forms are accepted only by `parseTriggerContextJson` below.
 */
const legacyNestedTriggerContextSchema = z
  .object({ trigger: z.object({ webhook: WebhookTriggerFieldsSchema }).strict() })
  .strict()
  .superRefine((value, ctx) => {
    const fields = value.trigger.webhook
    const available = WEBHOOK_EVENT_VAR_MATRIX[fields.event_type]
    for (const field of Object.keys(fields)) {
      if (!available.includes(field as WebhookTemplateVar)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `trigger value is unavailable for ${fields.event_type}: ${field}`,
          path: ['trigger', 'webhook', field],
        })
      }
    }
  })
  .transform((value): TriggerContext => {
    const fields = value.trigger.webhook
    return {
      trigger: { webhook: fields },
      contract: {
        namespace: 'webhook',
        definitionRef: { id: `code-host.webhook.${fields.event_type}`, revision: 1 },
        availableFields: WEBHOOK_EVENT_VAR_MATRIX[fields.event_type],
      },
    }
  })

export const TriggerContextSchema = z.union([
  canonicalTriggerContextSchema,
  legacyNestedTriggerContextSchema,
]) as z.ZodType<TriggerContext>

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

  const historicalNested = legacyNestedTriggerContextSchema.safeParse(decoded)
  const historicalFlat = WebhookTriggerFieldsSchema.safeParse(decoded)
  const fields = historicalNested.success
    ? webhookFieldsOf(historicalNested.data)
    : historicalFlat.success
      ? historicalFlat.data
      : null
  if (fields === null) return { kind: 'invalid' }
  return {
    kind: 'ok',
    value: webhookContext(fields),
    migratedFromFlat: historicalFlat.success,
  }
}

export function webhookFieldsOf(context: TriggerContext): WebhookTriggerFields {
  return WebhookTriggerFieldsSchema.parse(context.trigger.webhook)
}

function webhookContext(fields: WebhookTriggerFields): TriggerContext {
  return TriggerContextSchema.parse({
    trigger: { webhook: fields },
    contract: {
      namespace: 'webhook',
      definitionRef: { id: `code-host.webhook.${fields.event_type}`, revision: 1 },
      availableFields: WEBHOOK_EVENT_VAR_MATRIX[fields.event_type],
    },
  })
}

/** Deterministic, value-free editor/test preview context. */
export function sampleWebhookTriggerContext(): TriggerContext {
  const fields = Object.fromEntries(
    TRIGGER_CONTEXT_FIELDS.filter((field) => field !== 'event_type').map((field) => [
      field,
      `<trigger.webhook.${field}>`,
    ]),
  ) as Partial<Record<Exclude<WebhookTemplateVar, 'event_type'>, string>>
  return webhookContext({ event_type: 'note', ...fields })
}

export function triggerContextValue(
  context: TriggerContext,
  source: string,
  field: string,
): string {
  const contract = triggerContextContract(context)
  if (contract === null || contract.namespace !== source) return ''
  return context.trigger[source]?.[field] ?? ''
}

export function triggerContextContract(context: TriggerContext): TriggerParameterContract | null {
  if (context.contract !== undefined) return context.contract
  const webhook = WebhookTriggerFieldsSchema.safeParse(context.trigger.webhook)
  if (!webhook.success) return null
  return {
    namespace: 'webhook',
    definitionRef: { id: `code-host.webhook.${webhook.data.event_type}`, revision: 1 },
    availableFields: WEBHOOK_EVENT_VAR_MATRIX[webhook.data.event_type],
  }
}

export function createTriggerContext(input: {
  readonly namespace: string
  readonly definitionRef: { readonly id: string; readonly revision: number }
  readonly availableFields: readonly string[]
  readonly values: Readonly<Record<string, string>>
}): TriggerContext {
  return TriggerContextSchema.parse({
    trigger: { [input.namespace]: input.values },
    contract: {
      namespace: input.namespace,
      definitionRef: input.definitionRef,
      availableFields: input.availableFields,
    },
  })
}

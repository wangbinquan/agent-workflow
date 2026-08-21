import { canonicalJson, type TriggerContext } from '@agent-workflow/shared'
import { z } from 'zod'

import { sha256Hex } from '@/util/hash'

export const machineIdSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/)

export const localizedEventTextSchema = z
  .object({
    'zh-CN': z.string().min(1).max(500),
    'en-US': z.string().min(1).max(500),
  })
  .strict()

export const eventExactRefSchema = z
  .object({ id: z.string().min(1).max(200), revision: z.number().int().positive() })
  .strict()

export type EventExactRef = z.infer<typeof eventExactRefSchema>

export const eventSourceDescriptorSchema = z
  .object({
    schemaVersion: z.literal(1),
    sourceRef: eventExactRefSchema,
    ownerTypeId: machineIdSchema,
    displayName: localizedEventTextSchema,
    description: localizedEventTextSchema,
    observationMode: z.enum(['passive', 'active', 'hybrid']),
    observerProgramRef: eventExactRefSchema.nullable(),
    pollIntervalMs: z
      .number()
      .int()
      .min(1_000)
      .max(24 * 60 * 60 * 1_000),
    batchSize: z.number().int().min(1).max(1_000),
  })
  .strict()

export type EventSourceDescriptor = z.infer<typeof eventSourceDescriptorSchema>

export const eventTypeDescriptorSchema = z
  .object({
    schemaVersion: z.literal(1),
    eventTypeRef: eventExactRefSchema,
    sourceRef: eventExactRefSchema,
    ownerTypeId: machineIdSchema,
    subjectTypeId: machineIdSchema,
    payloadSchemaId: machineIdSchema,
    displayName: localizedEventTextSchema,
    description: localizedEventTextSchema,
    deliveryClass: machineIdSchema,
    /**
     * Deprecated transport-era metadata retained only so persisted RFC-310
     * event revisions remain readable and immutable after priority moved to
     * subscriber reaction rules. Event Center never schedules by this field.
     */
    priority: z.number().int().min(0).max(100_000).optional(),
    /**
     * Internal attention signals and compatibility facts remain routable inside
     * Event Center but never appear in the public catalog or source-neutral
     * response-rule editor. This keeps observer ticks and ingress protocols
     * from becoming a second business event taxonomy.
     *
     * Optional by design: descriptors persisted before this distinction remain
     * byte-identical and therefore keep their immutable revision digest.
     */
    catalogVisibility: z.enum(['public', 'internal', 'compatibility']).optional(),
    triggerParameters: z
      .object({
        namespace: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-z][a-z0-9_-]*$/),
        fields: z
          .array(
            z
              .object({
                fieldId: z
                  .string()
                  .min(1)
                  .max(128)
                  .regex(/^[a-z][a-z0-9_-]*$/),
                displayName: localizedEventTextSchema,
                description: localizedEventTextSchema,
              })
              .strict(),
          )
          .min(1)
          .max(256),
      })
      .strict()
      .nullable()
      .default(null),
  })
  .strict()
  .superRefine((descriptor, ctx) => {
    const ids = descriptor.triggerParameters?.fields.map((field) => field.fieldId) ?? []
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['triggerParameters', 'fields'],
        message: 'trigger parameter field ids must be unique',
      })
    }
  })

export type EventTypeDescriptor = z.infer<typeof eventTypeDescriptorSchema>

export const eventSubjectSchema = z
  .object({ typeId: machineIdSchema, subjectRef: z.string().min(1).max(1_000) })
  .strict()

export type EventSubject = z.infer<typeof eventSubjectSchema>

export const eventSubscriberSchema = z
  .object({
    kind: z.enum(['employee-case', 'employee-invocation', 'automation', 'system']),
    subscriberRef: z.string().min(1).max(500),
  })
  .strict()

export type EventSubscriber = z.infer<typeof eventSubscriberSchema>

export type EventRoutingValue =
  | null
  | boolean
  | number
  | string
  | EventRoutingValue[]
  | { [key: string]: EventRoutingValue }

export const eventRoutingValueSchema: z.ZodType<EventRoutingValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(eventRoutingValueSchema),
    z.record(z.string(), eventRoutingValueSchema),
  ]),
)

export const eventRoutingFactsSchema = eventRoutingValueSchema
  .refine((value) => value !== null && typeof value === 'object' && !Array.isArray(value), {
    message: 'routing facts must be a JSON object',
  })
  .refine((value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= 64 * 1024, {
    message: 'routing facts exceed 64 KiB',
  })

export const eventObservationSchema = z
  .object({
    sourceRef: eventExactRefSchema,
    eventTypeRef: eventExactRefSchema,
    subject: eventSubjectSchema,
    occurredAt: z.number().int().nonnegative(),
    dedupeKey: z.string().min(1).max(500),
    summary: z.string().min(1).max(2_000),
    payloadArtifactRef: z.string().min(1).max(1_000).nullable(),
    routingFacts: eventRoutingFactsSchema.nullable().default(null),
    triggerParameters: z
      .record(
        z
          .string()
          .min(1)
          .max(128)
          .regex(/^[a-z][a-z0-9_-]*$/),
        z.string().max(64 * 1024),
      )
      .nullable()
      .default(null),
  })
  .strict()

export type EventObservation = z.infer<typeof eventObservationSchema>

export const observerBatchSchema = z
  .object({
    schemaVersion: z.literal(1),
    cursorJson: z
      .string()
      .max(64 * 1024)
      .nullable(),
    observations: z.array(eventObservationSchema).max(1_000),
  })
  .strict()

// Observer programs may omit fields with contract defaults. The Event Center
// parses and normalizes the batch before any store or routing code can see it.
export type ObserverBatch = z.input<typeof observerBatchSchema>

export interface EventSubscriptionRecord {
  readonly id: string
  readonly eventTypeRef: EventExactRef
  readonly sourceRef: EventExactRef
  readonly subject: EventSubject
  readonly subscriber: EventSubscriber
  readonly mode: 'exact' | 'filtered'
  readonly origin: {
    readonly kind: string
    readonly ref: string
    readonly definitionRevision: string
  } | null
  readonly displayName: z.infer<typeof localizedEventTextSchema> | null
  readonly selector: { readonly kind: string; readonly config: EventRoutingValue } | null
  readonly state: 'active' | 'cancelled'
  readonly createdAt: number
  readonly updatedAt: number
  readonly cancelledAt: number | null
}

export interface ObserverActivationRecord {
  readonly sourceRef: EventExactRef
  readonly subscriberCount: number
  readonly state: 'idle' | 'active' | 'draining' | 'blocked'
  readonly generation: number
  readonly wakeEpoch: number
  readonly cursorJson: string | null
  readonly leaseOwner: string | null
  readonly leaseEpoch: number
  readonly leaseExpiresAt: number | null
  readonly nextScanAt: number | null
  readonly lastScanAt: number | null
  readonly lastSuccessAt: number | null
  readonly lastErrorCode: string | null
  readonly updatedAt: number
}

export interface EventDeliveryRecord {
  readonly deliveryId: string
  readonly eventId: string
  readonly subscriptionId: string
  readonly subscriber: EventSubscriber
  readonly eventTypeRef: EventExactRef
  readonly sourceRef: EventExactRef
  readonly subject: EventSubject
  readonly deliveryClass: string
  readonly occurredAt: number
  readonly summary: string
  readonly payloadArtifactRef: string | null
  readonly routingFacts: EventRoutingValue | null
  readonly triggerContext: TriggerContext | null
  readonly attemptCount: number
  readonly createdAt: number
}

/** Read-only operational projection. ACK state belongs to one subscription. */
export interface EventDeliveryStatusRecord {
  readonly deliveryId: string
  readonly eventId: string
  readonly subscriptionId: string
  readonly subscriber: EventSubscriber
  readonly eventTypeRef: EventExactRef
  readonly subject: EventSubject
  readonly state: 'pending' | 'claimed' | 'accepted' | 'dead-letter'
  readonly attemptCount: number
  readonly nextAttemptAt: number
  readonly claimedBy: string | null
  readonly claimExpiresAt: number | null
  readonly lastError: string | null
  readonly createdAt: number
  readonly acceptedAt: number | null
  readonly deadLetterAt: number | null
}

/** Immutable source fact projection for the global Event Center audit. */
export interface EventRecordAuditRecord {
  readonly eventId: string
  readonly eventTypeRef: EventExactRef
  readonly sourceRef: EventExactRef
  readonly subject: EventSubject
  readonly occurredAt: number
  readonly observedAt: number
  readonly summary: string
  readonly payloadArtifactRef: string | null
}

export interface FilteredEventSubscriptionDefinition {
  readonly id: string
  readonly definitionRevision: string
  readonly sourceRef: EventExactRef
  readonly eventTypeRefs: readonly EventExactRef[]
  readonly subjectTypeId: string
  readonly subscriber: EventSubscriber
  readonly displayName: z.infer<typeof localizedEventTextSchema>
  readonly selector: { readonly kind: string; readonly config: EventRoutingValue }
  readonly state: 'active' | 'paused' | 'invalid'
  readonly createdAt: number
  readonly updatedAt: number
}

export interface MatchedFilteredEventSubscription {
  readonly definition: FilteredEventSubscriptionDefinition
  readonly eventTypeRef: EventExactRef
  readonly materializedSubscriptionId: string
}

export function eventContentDigest(value: object): string {
  return sha256Hex(canonicalJson(value))
}

/**
 * Catalog visibility is an operational publication policy, not part of the
 * immutable event payload contract. Keeping it outside the content digest lets
 * an upgrade hide a legacy ingress fact without pretending its schema changed
 * or minting a second event revision.
 */
export function eventTypeContentDigest(value: EventTypeDescriptor): string {
  const { catalogVisibility: _catalogVisibility, ...contract } = value
  return eventContentDigest(contract)
}

export function subscriptionIdentity(input: {
  readonly eventTypeRef: EventExactRef
  readonly subject: EventSubject
  readonly subscriber: EventSubscriber
}): string {
  return sha256Hex(
    canonicalJson({
      eventTypeRef: input.eventTypeRef,
      subject: input.subject,
      subscriber: input.subscriber,
    }),
  )
}

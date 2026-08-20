import { canonicalJson } from '@agent-workflow/shared'
import { z } from 'zod'

import { sha256Hex } from '@/util/hash'

const machineIdSchema = z
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
    priority: z.number().int().min(0).max(100_000),
  })
  .strict()

export type EventTypeDescriptor = z.infer<typeof eventTypeDescriptorSchema>

export const eventSubjectSchema = z
  .object({ typeId: machineIdSchema, subjectRef: z.string().min(1).max(1_000) })
  .strict()

export type EventSubject = z.infer<typeof eventSubjectSchema>

export const eventSubscriberSchema = z
  .object({
    kind: z.enum(['employee-case', 'employee-invocation', 'system']),
    subscriberRef: z.string().min(1).max(500),
  })
  .strict()

export type EventSubscriber = z.infer<typeof eventSubscriberSchema>

export const eventObservationSchema = z
  .object({
    sourceRef: eventExactRefSchema,
    eventTypeRef: eventExactRefSchema,
    subject: eventSubjectSchema,
    occurredAt: z.number().int().nonnegative(),
    dedupeKey: z.string().min(1).max(500),
    summary: z.string().min(1).max(2_000),
    payloadArtifactRef: z.string().min(1).max(1_000).nullable(),
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

export type ObserverBatch = z.infer<typeof observerBatchSchema>

export interface EventSubscriptionRecord {
  readonly id: string
  readonly eventTypeRef: EventExactRef
  readonly sourceRef: EventExactRef
  readonly subject: EventSubject
  readonly subscriber: EventSubscriber
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
  readonly priority: number
  readonly occurredAt: number
  readonly summary: string
  readonly payloadArtifactRef: string | null
  readonly createdAt: number
}

export function eventContentDigest(value: object): string {
  return sha256Hex(canonicalJson(value))
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

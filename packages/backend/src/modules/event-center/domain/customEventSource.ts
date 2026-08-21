import { canonicalJson } from '@agent-workflow/shared'
import { z } from 'zod'

import { sha256Hex } from '@/util/hash'
import { eventExactRefSchema, localizedEventTextSchema, machineIdSchema } from './model'

export const CUSTOM_EVENT_OBSERVER_PROTOCOL = 'aw-event-observer@1' as const

export const customEventTypeDraftSchema = z
  .object({
    eventKey: machineIdSchema,
    subjectTypeId: machineIdSchema,
    payloadSchemaId: machineIdSchema,
    displayName: localizedEventTextSchema,
    description: localizedEventTextSchema,
    deliveryClass: machineIdSchema,
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

export const customEventSourceDraftSchema = z
  .object({
    schemaVersion: z.literal(1),
    displayName: localizedEventTextSchema,
    description: localizedEventTextSchema,
    pollIntervalMs: z
      .number()
      .int()
      .min(1_000)
      .max(24 * 60 * 60 * 1_000),
    batchSize: z.number().int().min(1).max(1_000),
    ingestionMode: z.enum(['state-change', 'occurrence']),
    program: z
      .object({
        language: z.enum(['bash', 'node', 'python']),
        source: z.string().min(1).max(1_000_000),
        /** True only while the UI-generated starter has never been edited. */
        templateManaged: z.boolean().optional(),
        timeoutMs: z
          .number()
          .int()
          .min(1_000)
          .max(30 * 60 * 1_000),
      })
      .strict(),
    eventTypes: z
      .array(customEventTypeDraftSchema)
      .min(1)
      .max(100)
      .superRefine((events, ctx) => {
        const keys = new Set<string>()
        for (const [index, event] of events.entries()) {
          if (keys.has(event.eventKey)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [index, 'eventKey'],
              message: `duplicate event key: ${event.eventKey}`,
            })
          }
          keys.add(event.eventKey)
        }
      }),
    fixture: z
      .object({
        subjects: z
          .array(
            z
              .object({
                typeId: machineIdSchema,
                subjectRef: z.string().min(1).max(1_000),
              })
              .strict(),
          )
          .max(100),
        cursorJson: z
          .string()
          .max(64 * 1024)
          .nullable()
          .superRefine((value, ctx) => {
            if (value === null) return
            try {
              JSON.parse(value)
            } catch {
              ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'cursorJson must be JSON' })
            }
          }),
      })
      .strict(),
  })
  .strict()
  .superRefine((draft, ctx) => {
    for (const [index, event] of draft.eventTypes.entries()) {
      const triggerFields = event.triggerParameters?.fields.map((field) => field.fieldId) ?? []
      if (new Set(triggerFields).size !== triggerFields.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['eventTypes', index, 'triggerParameters', 'fields'],
          message: 'trigger parameter field ids must be unique',
        })
      }
    }
  })

export type CustomEventSourceDraft = z.infer<typeof customEventSourceDraftSchema>

export const customObserverInputEnvelopeSchema = z
  .object({
    protocol: z.literal(CUSTOM_EVENT_OBSERVER_PROTOCOL),
    sourceRef: eventExactRefSchema,
    subjects: z
      .array(
        z.object({ typeId: machineIdSchema, subjectRef: z.string().min(1).max(1_000) }).strict(),
      )
      .max(1_000),
    cursor: z.unknown().nullable(),
    deadlineAt: z.string().datetime({ offset: true }),
  })
  .strict()

export type CustomObserverInputEnvelope = z.infer<typeof customObserverInputEnvelopeSchema>

export const customObserverOutputEnvelopeSchema = z
  .object({
    protocol: z.literal(CUSTOM_EVENT_OBSERVER_PROTOCOL),
    cursor: z.unknown().nullable(),
    observations: z
      .array(
        z
          .object({
            eventKey: machineIdSchema,
            subjectRef: z.string().min(1).max(1_000),
            occurredAt: z.string().datetime({ offset: true }),
            sourceEventKey: z.string().min(1).max(500),
            sourceEventRevision: z.string().min(1).max(500),
            summary: z.string().min(1).max(2_000),
            payloadArtifactRef: z.string().min(1).max(1_000).nullable().optional(),
            triggerParameters: z.record(z.string(), z.string()).nullable().optional(),
          })
          .strict(),
      )
      .max(1_000),
  })
  .strict()

export type CustomObserverOutputEnvelope = z.infer<typeof customObserverOutputEnvelopeSchema>

export interface CustomEventSourceValidationReceipt {
  readonly schemaVersion: 1
  readonly draftDigest: string
  readonly validatedAt: number
  readonly observationCount: number
  readonly stdoutDigest: string
}

export interface CustomEventSourceAuthoringRecord {
  readonly id: string
  readonly draft: CustomEventSourceDraft
  readonly publishedRevision: number | null
  readonly publishedDigest: string | null
  readonly ownerUserId: string | null
  readonly createdAt: number
  readonly updatedAt: number
  readonly retiredAt: number | null
}

export interface PublishedCustomEventSource {
  readonly sourceRef: { readonly id: string; readonly revision: number }
  readonly content: CustomEventSourceDraft
  readonly contentDigest: string
  readonly validationReceipt: CustomEventSourceValidationReceipt
}

export function customEventSourceDraftDigest(draft: CustomEventSourceDraft): string {
  return sha256Hex(canonicalJson(draft))
}

export function customEventTypeId(sourceId: string, eventKey: string): string {
  return `custom.${sourceId}.${eventKey}`
}

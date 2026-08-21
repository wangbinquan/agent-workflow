import { extractTemplateRefs } from '@agent-workflow/shared'
import { z } from 'zod'

import { ValidationError } from '@/util/errors'
import { eventExactRefSchema, machineIdSchema } from './model'

const templateText = z.string().max(64 * 1024)

export const eventResponseTargetSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('workflow'),
      refId: z.string().min(1).max(200),
      nameTemplate: z.string().min(1).max(255),
      inputs: z.record(z.string().min(1).max(160), templateText),
    })
    .strict(),
  z
    .object({
      kind: z.literal('agent'),
      refId: z.string().min(1).max(200),
      nameTemplate: z.string().min(1).max(255),
      descriptionTemplate: templateText.nullable(),
      inputs: z.record(z.string().min(1).max(160), templateText),
    })
    .strict(),
  z
    .object({
      kind: z.literal('workgroup'),
      refId: z.string().min(1).max(200),
      nameTemplate: z.string().min(1).max(255),
      goalTemplate: z
        .string()
        .min(1)
        .max(64 * 1024),
    })
    .strict(),
  z
    .object({
      kind: z.literal('digital-employee'),
      refId: z.string().min(1).max(200),
      intakeKind: z.enum(['body', 'external-id']),
      target: z.record(machineIdSchema, templateText),
      valueTemplate: z
        .string()
        .min(1)
        .max(2 * 1024 * 1024),
    })
    .strict(),
])

export type EventResponseTarget =
  | {
      readonly kind: 'workflow'
      readonly refId: string
      readonly nameTemplate: string
      readonly inputs: Readonly<Record<string, string>>
    }
  | {
      readonly kind: 'agent'
      readonly refId: string
      readonly nameTemplate: string
      readonly descriptionTemplate: string | null
      readonly inputs: Readonly<Record<string, string>>
    }
  | {
      readonly kind: 'workgroup'
      readonly refId: string
      readonly nameTemplate: string
      readonly goalTemplate: string
    }
  | {
      readonly kind: 'digital-employee'
      readonly refId: string
      readonly intakeKind: 'body' | 'external-id'
      readonly target: Readonly<Record<string, string>>
      readonly valueTemplate: string
    }

export const eventResponseRuleDraftSchema = z
  .object({
    name: z.string().min(1).max(200),
    enabled: z.boolean(),
    eventTypeRef: eventExactRefSchema,
    subjectMatch: z.enum(['all', 'exact', 'prefix']),
    subjectPattern: z.string().min(1).max(1_000).nullable(),
    target: eventResponseTargetSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.subjectMatch === 'all' && value.subjectPattern !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['subjectPattern'],
        message: 'all-subject rules must not carry a subject pattern',
      })
    }
    if (value.subjectMatch !== 'all' && value.subjectPattern === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['subjectPattern'],
        message: 'exact and prefix rules require a subject pattern',
      })
    }
  })

export type EventResponseRuleDraft = z.infer<typeof eventResponseRuleDraftSchema>

export interface EventResponseRuleRecord extends EventResponseRuleDraft {
  readonly id: string
  readonly ownerUserId: string
  readonly sourceRef: { readonly id: string; readonly revision: number }
  readonly subjectTypeId: string
  readonly lastFiredAt: number | null
  readonly lastStatus: 'launched' | 'failed' | null
  readonly lastError: string | null
  readonly createdAt: number
  readonly updatedAt: number
}

export function responseTargetTemplateTexts(target: EventResponseTarget): readonly string[] {
  if (target.kind === 'workflow') {
    return [target.nameTemplate, ...Object.values(target.inputs)]
  }
  if (target.kind === 'agent') {
    return [
      target.nameTemplate,
      ...(target.descriptionTemplate === null ? [] : [target.descriptionTemplate]),
      ...Object.values(target.inputs),
    ]
  }
  if (target.kind === 'workgroup') return [target.nameTemplate, target.goalTemplate]
  return [...Object.values(target.target), target.valueTemplate]
}

export function assertResponseTargetContract(input: {
  readonly target: EventResponseTarget
  readonly triggerParameters: {
    readonly namespace: string
    readonly fields: readonly { readonly fieldId: string }[]
  } | null
}): void {
  const allowed = new Set(
    input.triggerParameters?.fields.map(
      (field) => `trigger.${input.triggerParameters!.namespace}.${field.fieldId}`,
    ) ?? [],
  )
  for (const text of responseTargetTemplateTexts(input.target)) {
    for (const ref of extractTemplateRefs(text)) {
      if (ref.kind !== 'trigger' || !allowed.has(ref.raw)) {
        throw new ValidationError(
          'event-response-template-ref-invalid',
          `response target references an undeclared event parameter: ${ref.raw}`,
        )
      }
    }
  }
}

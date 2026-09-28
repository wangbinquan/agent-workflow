import { z } from 'zod'

/** RFC-371: CNY decimal strings; a missing rate is never interpreted as free. */
export const ObservationCnyRateSchema = z
  .string()
  .regex(/^(0|[1-9]\d{0,11})(\.\d{1,6})?$/)
  .nullable()
export const ObservationCnyRatesSchema = z
  .object({
    input: ObservationCnyRateSchema,
    cacheRead: ObservationCnyRateSchema,
    cacheWrite: ObservationCnyRateSchema,
    output: ObservationCnyRateSchema,
  })
  .strict()
export const ObservationPriceIdentitySchema = z.object({
  configurationRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  protocol: z.enum(['opencode', 'claude-code']),
  provider: z.string().trim().min(1).max(200),
  model: z.string().trim().min(1).max(300),
  condition: z.string().trim().min(1).max(200).nullable(),
})
export const SaveObservationPriceSchema = ObservationPriceIdentitySchema.extend({
  expectedRevision: z.number().int().min(0).max(2147483646),
  requestKey: z.string().min(8).max(128),
  currency: z.literal('CNY'),
  rates: ObservationCnyRatesSchema,
  effectiveFrom: z
    .string()
    .datetime({ offset: true })
    .refine((value) => Number.isFinite(Date.parse(value)), 'Invalid activation time'),
  sourceNote: z.string().trim().min(1).max(2000),
}).strict()
export const ObservationPriceVersionSchema = SaveObservationPriceSchema.omit({
  expectedRevision: true,
  requestKey: true,
}).extend({
  id: z.string().min(1),
  registrationId: z.string().min(1),
  revision: z.number().int().positive(),
  createdAt: z.string().datetime(),
  createdBy: z.string().min(1),
})
export const ObservationPricePageQuerySchema = z.object({
  beforeRevision: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})
export type ObservationPriceIdentity = z.infer<typeof ObservationPriceIdentitySchema>
export type SaveObservationPrice = z.infer<typeof SaveObservationPriceSchema>
export type ObservationPriceVersion = z.infer<typeof ObservationPriceVersionSchema>
export type ObservationPricePageQuery = z.infer<typeof ObservationPricePageQuerySchema>
export interface ObservationPriceHistory {
  readonly items: readonly ObservationPriceVersion[]
  readonly revision: number
  readonly nextBeforeRevision?: number
}
export interface ObservationPricingRuntime {
  readonly registrationId: string
  readonly name: string
  readonly configurationRevision: number
  readonly protocol: 'opencode' | 'claude-code'
  readonly model: string | null
  readonly enabled: boolean
  readonly pricingRevision: number
}

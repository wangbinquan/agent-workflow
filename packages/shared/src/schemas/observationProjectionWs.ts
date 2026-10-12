import { z } from 'zod'

/** Notification only; the database projection version remains authoritative. */
export const ObservationProjectionWsMessageSchema = z
  .object({
    type: z.literal('observability.projection.changed'),
    revision: z.string().regex(/^(0|[1-9][0-9]*)$/),
    asOf: z.number().int().nonnegative(),
  })
  .strict()
export type ObservationProjectionWsMessage = z.infer<typeof ObservationProjectionWsMessageSchema>

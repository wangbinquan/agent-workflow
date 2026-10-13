import { z } from 'zod'
const count = z.string().regex(/^(0|[1-9]\d*)$/)
export const ObservationStorageSchema = z.object({
  sampledAt: z.number().nullable(),
  databaseBytes: count.nullable(),
  factsBytes: count.nullable(),
  derivedBytes: count.nullable(),
  indexBytes: count.nullable(),
  reusableBytes: count.nullable(),
  freeBytes: count.nullable(),
  growthBytesPerDay: count.nullable(),
  daysRemaining: z.number().nonnegative().nullable(),
  pending: count,
  oldestPendingAt: z.number().nullable(),
  activeReports: count,
  retiringReports: count,
  reclaimed: count,
  lastSuccess: z.number().nullable(),
  lastError: z.string().nullable(),
  retentionDays: z.literal(7),
})
export type ObservationStorage = z.infer<typeof ObservationStorageSchema>

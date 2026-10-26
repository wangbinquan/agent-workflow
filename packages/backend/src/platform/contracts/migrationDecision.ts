import { z } from 'zod'
type EncodedKey = `mk1:${string}`
export const OperatorDecisionSchema = z.strictObject({
  kind: z.literal('acknowledge-unfinished-legacy-work'),
  sourceTable: z.string().min(1),
  sourceKey: z
    .string()
    .startsWith('mk1:')
    .transform((value): EncodedKey => value as EncodedKey),
  sourcePhase: z.enum(['current', 'pre-upgrade']),
  rowDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  blockCode: z.literal('v2-code-history-unfinished'),
  acknowledgedBy: z.string().refine((value) => value.trim().length > 0),
  acknowledgedAt: z.number().int().nonnegative(),
  reason: z.string().refine((value) => value.trim().length > 0),
})
export type OperatorDecision = Readonly<z.infer<typeof OperatorDecisionSchema>>

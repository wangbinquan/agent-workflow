import { z } from 'zod'
import type { JsonValue } from '@/platform/persistence/migration/conversion/types'
import { digestSchemaContract } from '@/platform/persistence/schema/canonical'
import {
  EpochDigestSchema,
  EpochGenerationIdSchema,
  EpochOperationIdSchema,
  EpochTimestampSchema,
  EpochSwitchError,
} from './model'

const json: z.ZodType<JsonValue> = z.json()
export const ProbeResultSchema = z.strictObject({
  id: z.string().min(1),
  passed: z.boolean(),
  detail: json,
})
export const HealthReportSchema = z.strictObject({
  version: z.literal(1),
  checkedAt: EpochTimestampSchema,
  catalogAdmitted: z.boolean(),
  probes: z.array(ProbeResultSchema).readonly(),
  passed: z.boolean(),
  digest: EpochDigestSchema,
})
export const SwitchReceiptPayloadSchema = z.strictObject({
  version: z.literal(1),
  kind: z.enum(['verified', 'completed']),
  operationId: EpochOperationIdSchema,
  runId: z.string().min(1),
  generationId: EpochGenerationIdSchema,
  activationReceiptDigest: EpochDigestSchema,
  pointerDigest: EpochDigestSchema.nullable(),
  firstLiveWriteAt: EpochTimestampSchema.nullable(),
  health: HealthReportSchema,
  retained: z.array(z.string().min(1)).readonly(),
  recordedAt: EpochTimestampSchema,
})
export type SwitchReceiptPayload = z.infer<typeof SwitchReceiptPayloadSchema>
export const SwitchReceiptSchema = z.strictObject({
  payload: SwitchReceiptPayloadSchema,
  digest: EpochDigestSchema,
})
export type SwitchReceipt = z.infer<typeof SwitchReceiptSchema>
export function createSwitchReceipt(input: SwitchReceiptPayload): SwitchReceipt {
  const payload = SwitchReceiptPayloadSchema.parse(input)
  return { payload, digest: digestSchemaContract(payload) }
}
export function parseSwitchReceipt(text: string): SwitchReceipt {
  const receipt = SwitchReceiptSchema.parse(JSON.parse(text))
  if (digestSchemaContract(receipt.payload) !== receipt.digest)
    throw new EpochSwitchError('v3-receipt-digest-mismatch')
  return receipt
}

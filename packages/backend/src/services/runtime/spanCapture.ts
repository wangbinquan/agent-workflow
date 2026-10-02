import type {
  NativeSpan,
  NativeSpanCapture,
  NativeSpanCaptureIdentity,
} from '@/modules/runtime-management/public/participants'

export interface PreparedRuntimeSpanCapture {
  readonly contract: 'runtime-span-facts-v1'
  readonly sourceNamespace: string
  create(identity: NativeSpanCaptureIdentity): NativeSpanCapture
  normalize(raw: unknown, rootSessionId: string): readonly NativeSpan[]
}
export const spanObject = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
export const spanId = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : null
export const spanTime = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
export const isoSpanTime = (value: unknown): number | null => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null
  return spanTime(Date.parse(value))
}

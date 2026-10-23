// Frozen from HEAD 67ab6b9aed08d97dcd6d3d9dfb57b8885a11f8e6 services/freshness.ts.
// RFC-395 II-a A3 SA7: preserve the historical plain-object lookup, including inherited names.
export function parseConsumedJson(json: string | null | undefined): Record<string, string> {
  if (json === null || json === undefined || json === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return {}
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

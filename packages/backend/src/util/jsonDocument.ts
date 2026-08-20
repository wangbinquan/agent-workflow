export type JsonDocument =
  | null
  | boolean
  | number
  | string
  | JsonDocument[]
  | { [key: string]: JsonDocument }

function isJsonDocument(value: unknown): value is JsonDocument {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return true
  }
  if (Array.isArray(value)) return value.every(isJsonDocument)
  if (typeof value !== 'object') return false
  return Object.values(value).every(isJsonDocument)
}

/** Parse an internal serialized projection without leaking `any` into routes. */
export function parseJsonDocument(serialized: string): JsonDocument {
  const value: unknown = JSON.parse(serialized)
  if (!isJsonDocument(value)) throw new Error('serialized projection is not a JSON document')
  return value
}

/** Preserve an already-serialized projection without widening it through `any`. */
export function jsonDocumentResponse(serialized: string, status = 200): Response {
  parseJsonDocument(serialized)
  return new Response(serialized, {
    status,
    headers: { 'content-type': 'application/json; charset=UTF-8' },
  })
}

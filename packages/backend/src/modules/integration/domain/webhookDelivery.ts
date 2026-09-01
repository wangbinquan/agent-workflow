/** body_json is independently capped below the HTTP ingress limit. */
export const DELIVERY_BODY_MAX_CHARS = 256 * 1024

/** RFC-257 / RFC-261 retention defaults. Runtime configuration may override them. */
export const DELIVERY_BODY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
export const DELIVERY_ROW_RETENTION_MS = 90 * 24 * 60 * 60 * 1000

/** Maximum rows changed by one maintenance slice. */
export const DELIVERY_GC_BATCH = 10_000

export function truncateDeliveryBody(body: string): string {
  return body.length > DELIVERY_BODY_MAX_CHARS ? body.slice(0, DELIVERY_BODY_MAX_CHARS) : body
}

/**
 * RFC-626 §3.6: the text of a failure, for a message a person reads. Database clients throw
 * values that are not `Error` instances, and `String(value)` on those gives
 * "[object Object]" — which is what an upgrade that failed on PostgreSQL used to report.
 */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null) {
    const message = (error as { readonly message?: unknown }).message
    if (typeof message === 'string' && message.length > 0) return message
  }
  return String(error)
}
/** The code a failure carries (errno, SQLSTATE, or the application's own), when it has one. */
export function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null
  const code = (error as { readonly code?: unknown }).code
  return typeof code === 'string' && code.length > 0 ? code : null
}

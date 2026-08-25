// RFC-326 — a request-body limit that counts REAL bytes.
//
// Extracted from routes/resourcePackages.ts (RFC-271) so the review write routes
// can share it. Hono's built-in `bodyLimit` takes a fast path when a
// `Content-Length` header is present: it rejects an oversized declaration, but
// otherwise TRUSTS the declaration and never counts the stream — an understated
// or malformed length walks straight past the limit. This wrapper keeps the
// fail-fast branch, then strips an accepted length before delegating so Hono
// also counts the actual bytes, without duplicating its bounded stream
// buffering and Request reconstruction.

import type { Context, MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'

export interface VerifiedBodyLimitOptions {
  maxSize: number
  onError: (c: Context) => Response | Promise<Response>
}

export function verifiedBodyLimit(opts: VerifiedBodyLimitOptions): MiddlewareHandler {
  const inner = bodyLimit({ maxSize: opts.maxSize, onError: opts.onError })
  return async (c, next) => {
    const raw = c.req.raw
    const contentLength = raw.headers.get('content-length')
    const hasTransferEncoding = raw.headers.has('transfer-encoding')
    if (contentLength !== null && !hasTransferEncoding) {
      const parsedLength = Number(contentLength)
      if (
        !/^\d+$/.test(contentLength) ||
        !Number.isSafeInteger(parsedLength) ||
        parsedLength > opts.maxSize
      ) {
        return opts.onError(c)
      }
      if (raw.body !== null) {
        const headers = new Headers(raw.headers)
        headers.delete('content-length')
        const requestInit: RequestInit & { duplex: 'half' } = {
          headers,
          body: raw.body,
          duplex: 'half',
        }
        c.req.raw = new Request(raw, requestInit)
      }
    }
    return inner(c, next)
  }
}

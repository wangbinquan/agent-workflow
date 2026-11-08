// RFC-472 — the standalone HTTP credential syntax (`Authorization: Bearer <token>`).
//
// It is the format a standalone deployment publishes to its clients, so it lives here as a pure rule:
// the local HTTP credential adapter reads it, the CrewStation adapter reads the optional automation PAT
// with it, and `public/types` offers it to the REST account routes (logout / password change revoke or
// keep the request's own session). RFC-285 B4: REST has exactly this one Bearer reader and no query
// token reader; WebSocket upgrade credentials have their own reader in the local WS adapter.

/** The token of a well-formed `Bearer <token>` header (scheme case-insensitive), else null. */
export function parseLocalBearerHeader(header: string | null | undefined): string | null {
  if (!header) return null
  const match = header.match(/^Bearer\s+(\S+)\s*$/i)
  if (!match || !match[1]) return null
  return match[1]
}

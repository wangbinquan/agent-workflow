// RFC-030 — defensive redaction for arbitrary text we persist or log.
//
// The probe service captures stderr from MCP stdio children and HTTP response
// bodies from MCP remote servers. Both can contain secrets the user pasted
// into mcp.config.env / mcp.config.headers (e.g. `PG_URL=postgresql://...:secret@...`
// echoed back in an error message, or `Authorization: Bearer ...` reflected
// in a 401 page). Before we persist these as errorDetailJson or log them, we
// run them through this redactor.
//
// Patterns covered:
//   - Authorization / Proxy-Authorization headers and Bearer tokens (header style)
//   - key=value forms where key ∈ {token, password, secret, api_key, apikey,
//     auth, authorization, access_key, accesskey, pwd}, case-insensitive
//   - URI userinfo (e.g. postgresql://user:pass@host, https://x:y@h) — fully
//     stripping `:pass` and replacing user with `***`
//
// Not a security boundary — secrets can still leak via channels we haven't
// patterned (e.g. base64-encoded). The point is to catch the common shapes
// before they end up in the SQLite row or daemon log.

import { redactGitUrl } from '@agent-workflow/shared'

// `authorization` is intentionally NOT in this list — the HEADER_BEARER_RE
// below handles `Authorization: ...` (and `Proxy-Authorization: ...`) with
// the proper `: ***` separator. If it were in here, the key=value pattern
// would re-match the *already-redacted* "Authorization: ***" output and
// rewrite it to "Authorization=***" (losing the canonical header form).
const SENSITIVE_KEYS = [
  'token',
  'password',
  'secret',
  'api_key',
  'apikey',
  'auth',
  'access_key',
  'accesskey',
  'pwd',
]

// `Authorization: Bearer abc123` → `Authorization: ***`
// Eats the entire rest of the line so multi-word schemes like `Basic <b64>`
// or `Bearer <jwt-with-dots>` get fully scrubbed.
const HEADER_BEARER_RE = /\b(authorization|proxy-authorization)\s*:\s*[^\r\n]+/gi

// key=value (or key: value), value is non-whitespace, non-comma, non-`;`
const SENSITIVE_KV_RE = new RegExp(
  String.raw`\b(` + SENSITIVE_KEYS.join('|') + String.raw`)\b\s*[:=]\s*[^\s,;"']+`,
  'gi',
)

// scheme://user:pass@host
const URI_USERINFO_RE = /\b([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^:/@\s]+):([^@\s]+)@/g

/**
 * Redact common secret shapes from arbitrary text. Always returns a string.
 * `null` / `undefined` map to empty string so the call site can safely chain.
 */
export function redactSensitiveString(input: string | null | undefined): string {
  if (input === null || input === undefined) return ''
  let out = input
  // Run git-URL redactor first; it handles its own URI userinfo for git hosts.
  out = redactGitUrl(out)
  out = out.replace(URI_USERINFO_RE, (_m, scheme: string) => `${scheme}://***:***@`)
  out = out.replace(HEADER_BEARER_RE, (_m, header: string) => `${header}: ***`)
  out = out.replace(SENSITIVE_KV_RE, (_m, key: string) => `${key}=***`)
  return out
}

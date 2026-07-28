// RFC-234 §8 — the CLOSED secret-slot projection + credential scanner (T1).
//
// One table, two directions (Codex design-gate P0-2):
//
//  OUT (platform → model): every credential-bearing carrier of every resource
//  type is enumerated here and redacted before it can enter a dump, a prompt,
//  an error message or a diagnostics field. Heuristics are a LAST layer on top
//  of the closed carriers, not the mechanism.
//
//  IN (model → platform): the same carriers only accept the sentinel; every
//  other payload string additionally passes scanForCredentialPatterns() so a
//  hallucinated or exfiltrated credential is rejected
//  (`intent-secret-value-forbidden`) unless the USER explicitly waives the
//  specific finding in the confirm UI (slot kind `secretWaiver`).
//
// Pure module: no IO, browser-safe (confirm UI renders slots from here).

import { redactGitUrl } from './git-url'

/** Sentinel the MODEL must emit for any secret-bearing value it proposes. */
export const INTENT_SECRET_SENTINEL = '‹secret›'
/** Replacement the PLATFORM writes into dumps for existing secret values. */
export const INTENT_REDACTED = '‹redacted›'

/** Heuristic key match — the last-layer net over free-form JSON
 *  (frontmatterExtra / plugin options / workgroup instructions metadata). */
export const SECRET_KEY_RE = /(token|secret|key|password|passwd|credential|auth)/i

// -----------------------------------------------------------------------------
// OUT: dump projections
// -----------------------------------------------------------------------------

export interface McpDumpProjection {
  type: 'local' | 'remote'
  name: string
  description: string
  enabled: boolean
  config: Record<string, unknown>
}

/** Redact a URL for dump display: strip userinfo AND the entire query (query
 *  keys routinely carry tokens); keep scheme + host + path so the model can
 *  still reason about the endpoint. */
interface UrlLike {
  username: string
  password: string
  search: string
  hash: string
  toString(): string
}

export function redactUrlForDump(raw: string): string {
  try {
    // Walled-off global lookup (git-url.ts precedent): URL exists in Bun and
    // every modern browser; the shared tsconfig carries no DOM/Node libs.
    const UrlCtor = (globalThis as unknown as { URL: new (raw: string) => UrlLike }).URL
    const u = new UrlCtor(raw)
    const hadUserinfo = u.username !== '' || u.password !== ''
    const hadQuery = u.search !== ''
    u.username = ''
    u.password = ''
    u.search = ''
    u.hash = ''
    let out = u.toString()
    if (hadUserinfo || hadQuery) out += ` (${INTENT_REDACTED}: userinfo/query stripped)`
    return out
  } catch {
    // Non-URL-parseable: fall back to the shared git-url redactor.
    return redactGitUrl(raw)
  }
}

function redactRecordValues(
  rec: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (rec === undefined) return undefined
  const out: Record<string, string> = {}
  for (const k of Object.keys(rec)) out[k] = INTENT_REDACTED
  return out
}

/** MCP → dump projection. Closed carriers:
 *  local  — env.* values (all), command[1:] (all argv after the executable),
 *  remote — url userinfo+query, headers.* values (all), oauth secrets. */
export function projectMcpForDump(mcp: {
  type: 'local' | 'remote'
  name: string
  description: string
  enabled: boolean
  config: Record<string, unknown>
}): McpDumpProjection {
  if (mcp.type === 'local') {
    const command = Array.isArray(mcp.config.command) ? (mcp.config.command as string[]) : []
    return {
      type: 'local',
      name: mcp.name,
      description: mcp.description,
      enabled: mcp.enabled,
      config: {
        command: command.map((arg, i) => (i === 0 ? arg : `${INTENT_REDACTED}-arg-${i}`)),
        env: redactRecordValues(mcp.config.env as Record<string, string> | undefined),
        timeoutMs: mcp.config.timeoutMs,
      },
    }
  }
  return {
    type: 'remote',
    name: mcp.name,
    description: mcp.description,
    enabled: mcp.enabled,
    config: {
      url: typeof mcp.config.url === 'string' ? redactUrlForDump(mcp.config.url) : undefined,
      headers: redactRecordValues(mcp.config.headers as Record<string, string> | undefined),
      oauth: mcp.config.oauth === undefined ? undefined : INTENT_REDACTED,
      timeoutMs: mcp.config.timeoutMs,
    },
  }
}

export interface PluginDumpProjection {
  name: string
  spec: string
  description: string
  enabled: boolean
  options: Record<string, unknown> | undefined
}

/** Plugin → dump projection: spec through the git-url redactor (userinfo /
 *  embedded tokens), EVERY string option value masked (keys kept — the model
 *  can see the shape, never the values). Machine-local fields (cachedPath,
 *  resolvedVersion, sourceKind) are simply not part of the projection. */
export function projectPluginForDump(plugin: {
  name: string
  spec: string
  description: string
  enabled: boolean
  options?: Record<string, unknown>
}): PluginDumpProjection {
  return {
    name: plugin.name,
    spec: redactGitUrl(plugin.spec),
    description: plugin.description,
    enabled: plugin.enabled,
    options: plugin.options === undefined ? undefined : maskFreeJsonSecrets(plugin.options, true),
  }
}

/** Free-form JSON masking. `maskAllStrings=true` masks every string value
 *  (plugin options); otherwise only values under SECRET_KEY_RE keys are masked
 *  (frontmatterExtra etc.). Arrays and nested objects are walked. */
export function maskFreeJsonSecrets(
  value: Record<string, unknown>,
  maskAllStrings = false,
): Record<string, unknown> {
  const walk = (v: unknown, keyHit: boolean): unknown => {
    if (typeof v === 'string') {
      return maskAllStrings || keyHit ? INTENT_REDACTED : v
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, keyHit))
    if (v !== null && typeof v === 'object') {
      const src = v as Record<string, unknown>
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(src)) {
        out[k] = walk(src[k], keyHit || SECRET_KEY_RE.test(k))
      }
      return out
    }
    return v
  }
  return walk(value, false) as Record<string, unknown>
}

// -----------------------------------------------------------------------------
// IN: sentinel slots + credential pattern scanner
// -----------------------------------------------------------------------------

export interface CredentialFinding {
  /** RFC 6901 JSON pointer into the scanned value. */
  jsonPointer: string
  kind: 'url-userinfo' | 'url-query-credential' | 'flag-credential' | 'high-entropy'
  /** Short display excerpt with the suspect part masked. */
  excerpt: string
}

const FLAG_CRED_RE = /(?:^|\s)--?(?:token|secret|password|passwd|api-?key|auth)[=\s]\S+/i
const URL_USERINFO_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^/\s@]+@/i
const URL_QUERY_CRED_RE =
  /[?&](?:token|secret|password|api-?key|access_token|private_token|auth)=[^&\s]+/i

/** ≥32 chars of pure base64url/hex charset with mixed classes — the classic
 *  pasted-API-key shape. Deliberately conservative: normal prose, paths and
 *  handles never match. */
export function looksHighEntropy(s: string): boolean {
  if (s.length < 32 || s.length > 512) return false
  if (!/^[A-Za-z0-9+/_=-]+$/.test(s)) return false
  const classes = [/[a-z]/.test(s), /[A-Z]/.test(s), /[0-9]/.test(s)].filter(Boolean).length
  return classes >= 2
}

/** Display excerpt with the suspect material itself masked: any run of ≥16
 *  token-charset characters collapses to the redaction marker, so a finding
 *  can be shown in the UI / persisted without re-leaking the credential. */
function excerptAround(s: string, limit = 48): string {
  const masked = s.replace(/[A-Za-z0-9+/_=-]{16,}/g, INTENT_REDACTED)
  const head = masked.slice(0, limit)
  return masked.length > limit ? `${head}…` : head
}

/** Scan an arbitrary JSON value for credential-shaped strings. The sentinel
 *  and the redaction marker never match. Used on EVERY inbound changeset
 *  payload (design §8 — both anti-hallucination and anti-exfiltration). */
export function scanForCredentialPatterns(value: unknown, basePointer = ''): CredentialFinding[] {
  const findings: CredentialFinding[] = []
  const visit = (v: unknown, pointer: string): void => {
    if (typeof v === 'string') {
      if (v === INTENT_SECRET_SENTINEL || v === INTENT_REDACTED) return
      if (URL_USERINFO_RE.test(v)) {
        findings.push({ jsonPointer: pointer, kind: 'url-userinfo', excerpt: excerptAround(v) })
      } else if (URL_QUERY_CRED_RE.test(v)) {
        findings.push({
          jsonPointer: pointer,
          kind: 'url-query-credential',
          excerpt: excerptAround(v),
        })
      } else if (FLAG_CRED_RE.test(v)) {
        findings.push({ jsonPointer: pointer, kind: 'flag-credential', excerpt: excerptAround(v) })
      } else if (looksHighEntropy(v)) {
        findings.push({ jsonPointer: pointer, kind: 'high-entropy', excerpt: excerptAround(v) })
      }
      return
    }
    if (Array.isArray(v)) {
      v.forEach((x, i) => visit(x, `${pointer}/${i}`))
      return
    }
    if (v !== null && typeof v === 'object') {
      const src = v as Record<string, unknown>
      for (const k of Object.keys(src)) {
        visit(src[k], `${pointer}/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`)
      }
    }
  }
  visit(value, basePointer)
  return findings
}

/** The carriers that must be sentinel-or-empty on INBOUND payloads. Returns
 *  pointers whose current value is a non-empty non-sentinel string. */
// Codex impl-gate P1-2 — the IN direction reuses the SAME key net the OUT
// projection masks with (symmetry is the point: what gets redacted on the way
// out must come back as the sentinel, never as a literal).
function escapePointer(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1')
}

export function findNonSentinelSecretCarriers(op: {
  resourceType: string
  payload: unknown
}): string[] {
  const out: string[] = []
  const push = (pointer: string) => out.push(pointer)

  // 1. MCP structural carriers (the original closed set).
  if (op.resourceType === 'mcp') {
    const p = op.payload as {
      type?: string
      config?: {
        env?: Record<string, string>
        headers?: Record<string, string>
        command?: string[]
        url?: string
      }
    }
    const check = (rec: Record<string, string> | undefined, base: string) => {
      if (!rec) return
      for (const k of Object.keys(rec)) {
        const v = rec[k]
        if (v !== '' && v !== INTENT_SECRET_SENTINEL) push(`${base}/${escapePointer(k)}`)
      }
    }
    if (p.type === 'local') {
      check(p.config?.env, '/payload/config/env')
      // argv[1:] mirrors the OUT projection: any non-sentinel value that
      // LOOKS credential-bearing (--token=… / userinfo URL) is refused.
      const argv = p.config?.command ?? []
      for (let i = 1; i < argv.length; i++) {
        const value = argv[i] ?? ''
        if (value === INTENT_SECRET_SENTINEL) continue
        if (
          /--?(?:token|secret|password|passwd|api-?key|auth)[=]/i.test(value) ||
          /\b[a-z][a-z0-9+.-]*:\/\/[^/\s@]+@/i.test(value)
        ) {
          push(`/payload/config/command/${i}`)
        }
      }
    }
    if (p.type === 'remote') {
      check(p.config?.headers, '/payload/config/headers')
      const url = p.config?.url
      if (typeof url === 'string' && /\/\/[^/\s@]+@/.test(url)) {
        push('/payload/config/url')
      }
    }
  }

  // 2. Secret-named keys anywhere in the payload (plugin options, agent/skill
  //    frontmatterExtra, workgroup free fields, …): string value must be the
  //    sentinel or empty. Redaction markers are ALWAYS refused — a model
  //    echoing `‹redacted›…` back as real config is a corruption, not a value.
  const walk = (value: unknown, pointer: string): void => {
    if (typeof value === 'string') {
      if (value.includes(INTENT_REDACTED)) push(pointer)
      return
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${pointer}/${index}`))
      return
    }
    if (typeof value === 'object' && value !== null) {
      for (const [k, v] of Object.entries(value)) {
        const child = `${pointer}/${escapePointer(k)}`
        if (
          typeof v === 'string' &&
          SECRET_KEY_RE.test(k) &&
          v !== '' &&
          v !== INTENT_SECRET_SENTINEL
        ) {
          push(child)
          continue
        }
        walk(v, child)
      }
    }
  }
  walk(op.payload, '/payload')
  return [...new Set(out)]
}

/** Mask credential-shaped content inside free diagnostics text (stderr tails,
 *  error messages) before it is persisted or displayed (design §8 OUT rule for
 *  "物化对象、错误消息与诊断字段"). */
export function maskDiagnosticsText(text: string): string {
  return text
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, `$1${INTENT_REDACTED}@`)
    .replace(
      /([?&](?:token|secret|password|api-?key|access_token|private_token|auth)=)[^&\s]+/gi,
      `$1${INTENT_REDACTED}`,
    )
    .replace(
      /((?:^|\s)--?(?:token|secret|password|passwd|api-?key|auth)[=\s])\S+/gi,
      `$1${INTENT_REDACTED}`,
    )
}

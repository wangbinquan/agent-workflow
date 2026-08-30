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
function projectMcpOAuthForDump(oauth: unknown): unknown {
  if (oauth === undefined) return undefined
  if (oauth === false) return false
  if (typeof oauth !== 'object' || oauth === null) return INTENT_REDACTED
  const o = oauth as {
    clientId?: unknown
    clientSecret?: unknown
    scope?: unknown
    redirectUri?: unknown
  }
  return {
    ...(typeof o.clientId === 'string' ? { clientId: o.clientId } : {}),
    ...(o.clientSecret === undefined ? {} : { clientSecret: INTENT_REDACTED }),
    ...(typeof o.scope === 'string' ? { scope: o.scope } : {}),
    ...(typeof o.redirectUri === 'string' ? { redirectUri: o.redirectUri } : {}),
  }
}

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
      // RFC-348 D2 — project OAuth so the model can read and echo it back: only
      // `clientSecret` is redacted; `false` (disabled) stays `false`.
      oauth: projectMcpOAuthForDump(mcp.config.oauth),
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

/** Script node env masking (RFC-253 T28, carrier `script-node-env`).
 *  A workflow definition rides everywhere else verbatim; script nodes' `env`
 *  is its one closed credential carrier (same status as MCP local env: ALL
 *  values are masked, keys survive so the reader can reason about shape).
 *  ONE walker for both outlets — the intent dump masks with the default
 *  `‹redacted›` marker, the token read projection (services/tokenRedaction.ts)
 *  passes its own `***` — so the two mechanisms can never disagree about which
 *  nodes carry secrets. Non-script nodes and every other field pass through
 *  untouched. Pure and non-mutating; returns the SAME reference when nothing
 *  needed masking; tolerates malformed shapes (no `nodes` array, non-record
 *  env). */
export function maskWorkflowScriptEnv<T>(definition: T, marker: string = INTENT_REDACTED): T {
  if (typeof definition !== 'object' || definition === null || Array.isArray(definition)) {
    return definition
  }
  const def = definition as Record<string, unknown>
  if (!Array.isArray(def.nodes)) return definition
  let touched = false
  const nodes = def.nodes.map((node) => {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) return node
    const rec = node as Record<string, unknown>
    if (rec.kind !== 'script') return node
    const env = rec.env
    if (typeof env !== 'object' || env === null || Array.isArray(env)) return node
    // `Object.fromEntries`, not `masked[k] = marker`: a JSON-parsed env may
    // legitimately hold `__proto__` (the env-name grammar accepts it), and
    // plain assignment hits the legacy prototype setter instead of creating an
    // own property — the key vanishes. That breaks the keys-survive contract
    // and, worse, silently changes the workflow shape on YAML export→import.
    const masked = Object.fromEntries(Object.keys(env).map((k) => [k, marker]))
    touched = true
    return { ...rec, env: masked }
  })
  return touched ? ({ ...def, nodes } as T) : definition
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

/**
 * Workflow input routing uses two canonical public identifier fields whose
 * names happen to match the last-layer `key` heuristic. They are graph labels,
 * not credential carriers:
 *
 *   definition.inputs[].key      — launcher input identifier
 *   definition.nodes[].inputKey  — input-node reference to that identifier
 *
 * Keep this exemption path-exact. Unknown/free-form `*key*` fields elsewhere
 * in a workflow definition still require the sentinel, and a redaction marker
 * in either public field is still rejected by the generic string walk below.
 */
function isWorkflowRoutingIdentifier(resourceType: string, pointer: string, key: string): boolean {
  if (resourceType !== 'workflow') return false
  if (key === 'key') return /^\/payload\/definition\/inputs\/\d+\/key$/.test(pointer)
  if (key === 'inputKey') return /^\/payload\/definition\/nodes\/\d+\/inputKey$/.test(pointer)
  return false
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
      // RFC-348 D2 — `oauth.clientSecret` is a secret carrier like env/headers
      // values: only the sentinel (filled through a confirm-time slot) or ''.
      const oauth = (p.config as { oauth?: unknown } | undefined)?.oauth
      if (typeof oauth === 'object' && oauth !== null) {
        const secret = (oauth as { clientSecret?: unknown }).clientSecret
        if (typeof secret === 'string' && secret !== '' && secret !== INTENT_SECRET_SENTINEL) {
          push('/payload/config/oauth/clientSecret')
        }
      }
    }
  }

  // 2. Workflow script-node env (RFC-253 T28, carrier `script-node-env`).
  //    Mirrors MCP local env exactly: EVERY value is a closed carrier, not just
  //    secret-named keys — `DATABASE_URL` and `LOG_LEVEL` alike must arrive as
  //    the sentinel (the user fills real values at confirm time) or empty.
  if (op.resourceType === 'workflow') {
    const def = (op.payload as { definition?: { nodes?: unknown[] } }).definition
    const nodes = Array.isArray(def?.nodes) ? def.nodes : []
    nodes.forEach((node, i) => {
      if (typeof node !== 'object' || node === null) return
      const rec = node as { kind?: unknown; env?: unknown }
      if (rec.kind !== 'script') return
      if (typeof rec.env !== 'object' || rec.env === null || Array.isArray(rec.env)) return
      for (const [k, v] of Object.entries(rec.env as Record<string, unknown>)) {
        // Non-strings are refused too, exactly like the MCP branch above. The
        // node schema for a stored definition is the permissive
        // `WorkflowNodeSchema`, so `env: {DB: ['postgres://u:p@h/db']}` does
        // reach the database; that it is inert at run time (`readScriptEnv`
        // drops non-strings) is a second line of defence, not a reason for
        // this one to have a hole. A carrier is a carrier at any type.
        if (v !== '' && v !== INTENT_SECRET_SENTINEL) {
          push(`/payload/definition/nodes/${i}/env/${escapePointer(k)}`)
        }
      }
    })
  }

  // 3. Secret-named keys anywhere in the payload (plugin options, agent/skill
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
          !isWorkflowRoutingIdentifier(op.resourceType, child, k) &&
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

/** At or above this length a value is masked wherever it appears, substring or
 *  not. BELOW it, the value is still masked — but only where it stands alone
 *  as a token.
 *
 *  This is not a leniency knob. An earlier draft simply SKIPPED short values,
 *  which contradicted the closed-carrier rule (`DEPLOY_PIN=73921` is a real
 *  credential that passes every env validator) and the test even asserted the
 *  short value survived, locking the hole in. The reason a plain substring
 *  replace is still wrong for them is different: with `RETRY=1`, replacing
 *  every `1` turns `attempt 10 of 3` into unreadable noise and hides nothing
 *  a reader did not already know. Token boundaries give both — the PIN goes,
 *  the prose survives. */
export const SCRIPT_ENV_SUBSTRING_MIN_LEN = 6

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** RFC-253 T28 — mask a script node's KNOWN env values out of diagnostics text
 *  (stderr lines, failure details) before persistence. Longest value first, so
 *  a value that contains another still collapses to a single marker rather
 *  than leaving the longer one's prefix behind. Complements
 *  maskDiagnosticsText (which matches credential SHAPES without knowing
 *  values). */
export function maskScriptEnvValues(text: string, env: Record<string, string>): string {
  const values = [...new Set(Object.values(env))]
    .filter((v) => v.length > 0)
    .sort((a, b) => b.length - a.length)
  let out = text
  for (const value of values) {
    if (value.length >= SCRIPT_ENV_SUBSTRING_MIN_LEN) {
      out = out.split(value).join(INTENT_REDACTED)
      continue
    }
    out = out.replace(
      new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(value)}(?![A-Za-z0-9_])`, 'g'),
      INTENT_REDACTED,
    )
  }
  return out
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

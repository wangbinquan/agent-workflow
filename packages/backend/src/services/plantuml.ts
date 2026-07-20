// RFC-105 WP-B — server-side PlantUML rendering for the /api/plantuml/render
// proxy. Moves the kroki/picoweb round-trip off the browser so PlantUML works
// for ALL logged-in users (the render endpoint + auth header live in admin-only
// config; previously only admins, who could read /api/config, rendered it).
//
// The encoders mirror the former browser logic (PlantUmlBlock.encodeFor*): raw
// DEFLATE then either kroki's base64url alphabet or PlantUML's digits-first
// alphabet. pako (browser) and node zlib produce different DEFLATE bytes but
// both inflate to the same source, so the rendered SVG is identical — covered
// by a round-trip test, not a byte-equality one.
//
// Syntax-error EXTRACTION + i18n stays on the frontend (it owns the locale
// bundle): on a PlantUML 4xx diagnostic SVG the proxy returns the raw `errorSvg`
// and the browser runs its existing extractor. The backend only needs a coarse
// "is this a PlantUML diagnostic" check to stop the fallback chain.

import { deflateRawSync } from 'node:zlib'

/** Max source bytes accepted by the proxy (defensive abuse cap). */
export const PLANTUML_SOURCE_MAX = 100 * 1024

// kroki base64url: standard base64 then +/→-_ and strip '='.
function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

// PlantUML's official text-encoding alphabet (digits first, then upper, lower,
// '-', '_'). Required by plantuml.jar's picoweb server + the official
// plantuml-server, which decode base64url payloads with this table → garbage.
const PLANTUML_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_'

function plantumlAlphaEncode(bytes: Uint8Array): string {
  let result = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b1 = bytes[i]!
    const b2 = i + 1 < bytes.length ? bytes[i + 1]! : 0
    const b3 = i + 2 < bytes.length ? bytes[i + 2]! : 0
    result += PLANTUML_ALPHABET[b1 >> 2]
    result += PLANTUML_ALPHABET[((b1 & 0x3) << 4) | (b2 >> 4)]
    result += PLANTUML_ALPHABET[((b2 & 0xf) << 2) | (b3 >> 6)]
    result += PLANTUML_ALPHABET[b3 & 0x3f]
  }
  return result
}

/** DEFLATE + kroki base64url alphabet. */
export function encodeForGet(source: string): string {
  return base64UrlEncode(deflateRawSync(Buffer.from(source, 'utf8')))
}

/** DEFLATE + PlantUML digits-first alphabet (picoweb / plantuml-server). */
export function encodeForPlantuml(source: string): string {
  return plantumlAlphaEncode(deflateRawSync(Buffer.from(source, 'utf8')))
}

/** Hostname of a configured renderer endpoint, for the browser privacy note. */
export function hostOf(endpoint: string): string {
  const raw = endpoint.trim()
  try {
    return new URL(raw).host || raw
  } catch {
    return raw.replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '') || raw
  }
}

/**
 * Coarse "is this a PlantUML diagnostic SVG" check. A configured server returns
 * 4xx + an SVG containing "PlantUML version …" for a source bug; when we see it
 * we stop the fallback chain (a different server's response would mask the real
 * line number) and hand the raw SVG to the browser, which extracts the message.
 */
export function looksLikePlantumlError(body: string): boolean {
  return body.includes('<svg') && /PlantUML version/i.test(body)
}

export type PlantumlRenderResult =
  | { kind: 'svg'; svg: string }
  | { kind: 'error-svg'; errorSvg: string }
  | { kind: 'failed'; detail: string }

/**
 * Render `source` against a configured PlantUML endpoint, replicating the
 * three-step browser fallback server-side:
 *   1. GET {base}/plantuml/svg/{plantuml-alpha}  (picoweb-friendly, first)
 *   2. GET {base}/plantuml/svg/{base64url}        (kroki)
 *   3. POST {base}/plantuml/svg  text/plain
 * Stops early on a step-1 PlantUML diagnostic 4xx. The `authHeader` is sent only
 * here (server→endpoint) and never returned to the browser.
 */
/**
 * RFC-208 — ceiling for one PlantUML round trip.
 *
 * This is the only place the daemon calls a USER-CONFIGURED EXTERNAL host, which
 * makes it far likelier to black-hole than anything on 127.0.0.1. All three
 * fallbacks used a bare `fetch` with no AbortSignal, and `await r.text()` was
 * unbounded on top of that — so a stalled endpoint pinned the request forever.
 * Applied per attempt, so the three-step fallback stays bounded overall.
 */
export const PLANTUML_ATTEMPT_TIMEOUT_MS = 15_000

export async function renderPlantuml(opts: {
  source: string
  endpoint: string
  authHeader: string | undefined
  fetchImpl?: typeof fetch
  /** Override the per-attempt ceiling (tests). */
  timeoutMs?: number
}): Promise<PlantumlRenderResult> {
  const attemptMs = opts.timeoutMs ?? PLANTUML_ATTEMPT_TIMEOUT_MS
  const baseFetch = opts.fetchImpl ?? fetch
  // Bound the body read as well as the request: a stalled host can send headers
  // and then stop, leaving `.text()` waiting on an EOF that never comes.
  const doFetch = ((url: string, init?: RequestInit) =>
    baseFetch(url, { ...init, signal: AbortSignal.timeout(attemptMs) })) as typeof fetch
  const textOf = async (r: Response): Promise<string> =>
    await Promise.race([
      r.text(),
      new Promise<string>((_ok, reject) =>
        setTimeout(() => {
          void r.body?.cancel().catch(() => {})
          reject(new Error(`plantuml body read timed out after ${attemptMs}ms`))
        }, attemptMs),
      ),
    ])
  const headers: Record<string, string> = {}
  if (opts.authHeader !== undefined && opts.authHeader.length > 0) {
    headers['Authorization'] = opts.authHeader
  }
  const base = opts.endpoint.replace(/\/+$/, '')
  let lastErr = 'render-failed'

  // 1) GET plantuml-alpha.
  try {
    const r = await doFetch(`${base}/plantuml/svg/${encodeForPlantuml(opts.source)}`, { headers })
    const text = await textOf(r)
    if (r.ok && text.includes('<svg')) return { kind: 'svg', svg: text }
    if (!r.ok && looksLikePlantumlError(text)) return { kind: 'error-svg', errorSvg: text }
    lastErr = `GET(plantuml) ${r.status}`
  } catch (err) {
    lastErr = err instanceof Error ? err.message : String(err)
  }

  // 2) GET kroki base64url.
  try {
    const r = await doFetch(`${base}/plantuml/svg/${encodeForGet(opts.source)}`, { headers })
    const text = await textOf(r)
    if (r.ok && text.includes('<svg')) return { kind: 'svg', svg: text }
    lastErr = `GET(base64url) ${r.status}`
  } catch (err) {
    lastErr = err instanceof Error ? err.message : String(err)
  }

  // 3) POST raw.
  try {
    const r = await doFetch(`${base}/plantuml/svg`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'text/plain' },
      body: opts.source,
    })
    const text = await textOf(r)
    if (r.ok && text.includes('<svg')) return { kind: 'svg', svg: text }
    lastErr = `POST ${r.status}`
  } catch (err) {
    lastErr = err instanceof Error ? err.message : String(err)
  }

  return { kind: 'failed', detail: lastErr }
}

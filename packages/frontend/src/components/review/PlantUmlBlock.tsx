// PlantUmlBlock — RFC-005 PR-C T18.
//
// Renders ```plantuml fenced blocks via a user-configured external HTTP
// renderer (kroki-compatible). We do NOT bundle plantuml.jar — that would
// pull in a GPL dependency and require a JVM at runtime; instead the
// platform stays GPL-free and the user wires in their own endpoint (or
// kroki.io if they accept the privacy implications).
//
// Render path:
//   1. If no endpoint configured → fallback to a `<pre>` source dump with
//      a muted hint pointing users at Settings → Rendering.
//   2. Try GET `{endpoint}/plantuml/svg/{deflate + plantuml-alphabet}` —
//      this is the alphabet plantuml.jar's built-in picoweb server and the
//      official plantuml-server use. We try this FIRST because picoweb on
//      a base64url payload decodes garbage that produces SVG with control
//      chars (0x01) and CRASHES picoweb mid-serialisation, polluting the
//      server log on every render. plantuml-alpha never crashes picoweb.
//   3. On non-2xx or network failure, try GET with kroki-style base64url
//      (`A-Za-z0-9-_`). kroki.io rejects plantuml-alpha cleanly so we hit
//      this fallback for kroki.io users; their first GET fails 4xx (no
//      server crash, clean log) and base64url renders.
//   4. On still-failure, fall back to POST `{endpoint}/plantuml/svg` with
//      `text/plain` body (plantuml-server format).
//   5. On any failure → show the error + fall through to source code.
//
// The static helper (PlantUmlBlock.render) mounts directly into a DOM
// element handed in by MarkdownView; no React tree per diagram.

import DOMPurify from 'dompurify'
import pako from 'pako'

import i18n from '@/i18n'

export const PlantUmlBlock = {
  /**
   * Synchronously mount the loading state, then kick off the fetch.
   * The mount element receives an SVG when the fetch resolves, or a
   * source-code dump if all attempts fail.
   */
  render(
    mount: HTMLElement,
    source: string,
    endpoint: string | undefined,
    authHeader: string | undefined,
  ): void {
    mount.innerHTML = ''
    if (endpoint === undefined || endpoint.trim().length === 0) {
      mount.appendChild(buildUnconfigured(source))
      return
    }
    // RFC-005 (Q10) — a configured endpoint receives the raw document source.
    // Surface that explicitly AT send time (and again under the rendered SVG)
    // so the exfiltration is never silent. Acceptance criterion: design.md
    // "PlantUML 外部端点泄漏文档源码 | UI 显式提示『将向 {host} 发送源码』".
    mount.appendChild(buildPrivacyNote(hostOf(endpoint)))
    mount.appendChild(buildLoading())
    void fetchAndSwap(mount, source, endpoint, authHeader)
  },

  /** Hostname of a configured renderer endpoint, for the privacy notice.
   *  Falls back to the raw endpoint (minus scheme/path) on parse failure.
   *  Exported for tests. */
  hostOf(endpoint: string): string {
    return hostOf(endpoint)
  },

  /**
   * Encode source for kroki GET-path: zlib deflate then base64-url.
   * Exported for tests.
   */
  encodeForGet(source: string): string {
    const bytes = new TextEncoder().encode(source)
    const deflated = pako.deflateRaw(bytes)
    return base64UrlEncode(deflated)
  },

  /**
   * Encode source using PlantUML's own text-encoding alphabet (digits
   * first: `0-9A-Za-z-_`). Same deflate compression as kroki, only the
   * 6-bit→char alphabet differs. Required by plantuml.jar's picoweb
   * server and the official plantuml-server — they ignore base64url
   * payloads and decode them with the digits-first table, yielding
   * garbage source that often serialises with control chars (0x01) and
   * dies in XML serialisation. Exported for tests.
   */
  encodeForPlantuml(source: string): string {
    const bytes = new TextEncoder().encode(source)
    const deflated = pako.deflateRaw(bytes)
    return plantumlAlphaEncode(deflated)
  },
}

async function fetchAndSwap(
  mount: HTMLElement,
  source: string,
  endpoint: string,
  authHeader: string | undefined,
): Promise<void> {
  const headers: Record<string, string> = {}
  if (authHeader !== undefined && authHeader.length > 0) headers['Authorization'] = authHeader
  const base = endpoint.replace(/\/+$/, '')
  // 1) GET with PlantUML's native alphabet (picoweb / plantuml-server).
  //    First because picoweb crashes on base64url payloads (0x01 in SVG).
  let svg: string | null = null
  let lastErr: Error | null = null
  // Special sentinel: if PlantUML server responded with 4xx + a syntax-error
  // SVG, we stop the fallback chain — the user's source is wrong and any
  // further attempt would just paint the kroki "use ~1 header" diagnostic
  // SVG over the real error, hiding the actual line number from the user.
  let plantumlSyntaxError: string | null = null
  try {
    const encoded = PlantUmlBlock.encodeForPlantuml(source)
    const r = await fetch(`${base}/plantuml/svg/${encoded}`, { headers })
    const text = await r.text()
    if (r.ok) {
      svg = text
    } else {
      const syntaxErr = extractPlantUmlSyntaxError(text)
      if (syntaxErr !== null) {
        plantumlSyntaxError = syntaxErr
      } else {
        lastErr = new Error(`GET (plantuml-encoding) returned ${r.status}`)
      }
    }
  } catch (err) {
    lastErr = err as Error
  }
  // 2) GET kroki-style base64url (kroki.io etc). Skip when we already know
  //    the source is bad — only run when the first attempt failed for
  //    transport/encoding reasons, not for genuine syntax errors.
  if (svg === null && plantumlSyntaxError === null) {
    try {
      const encoded = PlantUmlBlock.encodeForGet(source)
      const r = await fetch(`${base}/plantuml/svg/${encoded}`, { headers })
      if (r.ok) {
        svg = await r.text()
      } else {
        lastErr = new Error(`GET (base64url) returned ${r.status}`)
      }
    } catch (err) {
      lastErr = err as Error
    }
  }
  // 3) POST raw fallback. Same skip: don't paint over an authoritative
  //    syntax error with a different server's response.
  if (svg === null && plantumlSyntaxError === null) {
    try {
      const r = await fetch(`${base}/plantuml/svg`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'text/plain' },
        body: source,
      })
      if (r.ok) {
        svg = await r.text()
      } else {
        lastErr = new Error(`POST returned ${r.status}`)
      }
    } catch (err) {
      lastErr = err as Error
    }
  }

  mount.innerHTML = ''
  if (svg !== null && svg.includes('<svg')) {
    const wrap = document.createElement('div')
    wrap.className = 'review-diagram__svg'
    wrap.innerHTML = DOMPurify.sanitize(svg, {
      USE_PROFILES: { svg: true, svgFilters: true },
    })
    // PlantUML emits `preserveAspectRatio="none"` + fixed `width="…px"` /
    // `height="…px"` on the <svg>. Combined with our `max-width: 100%` CSS
    // that constrains width only, the SVG gets squashed horizontally
    // (height keeps the original px, width shrinks to container width,
    // and `none` disables aspect-ratio preservation). Strip all three.
    //
    // Then: SVG with a viewBox is a replaced element whose intrinsic
    // dimensions equal the viewBox in raw pixels (e.g. 2547×1580). Once
    // intrinsic dimensions exist, `height: auto` resolves to the intrinsic
    // pixel height — NOT to `width × aspect-ratio` — so the SVG still
    // renders 1580px tall inside a 1180px-wide container, leaving huge
    // vertical whitespace from `xMidYMid meet`. The reliable fix is the
    // padding-bottom hack: set the wrap to `position: relative` with
    // `padding-bottom: (vbH/vbW)*100%`, then absolutely-fill the SVG
    // inside it. Works in every browser without ResizeObserver gymnastics.
    const svgEl = wrap.querySelector('svg')
    if (svgEl !== null) {
      svgEl.removeAttribute('preserveAspectRatio')
      svgEl.removeAttribute('width')
      svgEl.removeAttribute('height')
      const vb = (svgEl.getAttribute('viewBox') ?? '').trim().split(/\s+/).map(Number)
      if (vb.length === 4 && vb[2]! > 0 && vb[3]! > 0) {
        wrap.style.position = 'relative'
        wrap.style.paddingBottom = `${(vb[3]! / vb[2]!) * 100}%`
        wrap.style.height = '0'
        svgEl.style.position = 'absolute'
        svgEl.style.inset = '0'
        svgEl.style.width = '100%'
        svgEl.style.height = '100%'
      }
    }
    mount.appendChild(buildPrivacyNote(hostOf(endpoint)))
    mount.appendChild(wrap)
    return
  }
  const msg =
    plantumlSyntaxError !== null
      ? plantumlSyntaxError
      : (lastErr?.message ?? i18n.t('reviews.plantumlUnknownError'))
  mount.appendChild(buildErrorWithSource(source, msg))
}

/**
 * Detect PlantUML server's "syntax error" response. PlantUML returns 4xx
 * with an SVG body whose <text> elements include "PlantUML version …",
 * "[From string (line N) ]", a dump of the source, and as the LAST <text>
 * the actual error reason (e.g. "Cannot find if (Assumed diagram type:
 * activity)"). When we see that, the user's source has a real bug — we
 * surface the line number AND the reason, not fall back to another
 * encoding (kroki.io's response would mask the real diagnosis with its
 * own "use ~1 header" diagnostic SVG). Returns a short human message for
 * the error banner, or null if not a PlantUML syntax error. Exported for
 * tests.
 */
export function extractPlantUmlSyntaxError(body: string): string | null {
  if (!body.includes('<svg')) return null
  if (!/PlantUML version/i.test(body)) return null
  const lineMatch = body.match(/From string \(line (\d+)\)/i)
  const reason = extractReasonFromErrorSvg(body)
  if (lineMatch !== null) {
    return reason !== null
      ? i18n.t('reviews.plantumlSyntaxErrorLineAndReason', { line: lineMatch[1], reason })
      : `${i18n.t('reviews.plantumlSyntaxErrorAtLine', { line: lineMatch[1] })}${i18n.t('reviews.plantumlSeeSourceSuffix')}`
  }
  if (reason !== null) {
    return i18n.t('reviews.plantumlSyntaxErrorReasonOnly', { reason })
  }
  // Some PlantUML versions write "Syntax Error?" without a line number.
  if (/Syntax Error/i.test(body)) {
    return i18n.t('reviews.plantumlSyntaxErrorGeneric')
  }
  return null
}

/**
 * Pull the human-readable failure reason out of a PlantUML error SVG.
 * The reason is the LAST <text> element after the dumped source — e.g.
 * "Cannot find if (Assumed diagram type: activity)". Strips off the
 * leading source-dump rows (they look like real PlantUML code starting
 * with `@`, `:`, `if`, `else`, `endif`, `skinparam`, etc.) so we don't
 * mistake a source line for the reason.
 */
function extractReasonFromErrorSvg(body: string): string | null {
  const matches = [...body.matchAll(/<text[^>]*>([^<]+)<\/text>/g)].map((m) =>
    decodeXmlEntities(m[1] ?? '').trim(),
  )
  if (matches.length === 0) return null
  // Walk from the end, skip the "&nbsp;" / empty padding rows. The last
  // meaningful text that isn't a recognised PlantUML source line is the
  // reason.
  for (let i = matches.length - 1; i >= 0; i--) {
    const t = matches[i]!
    if (t.length === 0 || /^\s*$/.test(t)) continue
    if (/^PlantUML version /i.test(t)) continue
    if (/^\[From string/i.test(t)) continue
    // Don't return what is clearly a copy of one of the user's source lines.
    if (looksLikePlantUmlSource(t)) continue
    return t
  }
  return null
}

function looksLikePlantUmlSource(line: string): boolean {
  return /^(@(startuml|enduml)|skinparam\b|title\b|note\b|start\b|stop\b|if\b|else\b|elseif\b|endif\b|switch\b|case\b|endswitch\b|:[^<>]+;|->|<-|partition\b|while\b|repeat\b|fork\b|legend\b|endlegend\b|package\b|component\b|class\b|end note\b|#[A-Fa-f0-9]+:)/.test(
    line.trim(),
  )
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function buildUnconfigured(source: string): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'review-diagram__unconfigured'
  const hint = document.createElement('div')
  hint.className = 'review-diagram__hint'
  // Wording stays explicitly "plantuml ... not configured" so the
  // plantuml-block.test.ts regex (/not configured/) still matches; the
  // banner styling in prose.css is what makes it read as a system notice
  // rather than markdown body text.
  hint.textContent = i18n.t('reviews.plantumlUnconfigured')
  const pre = document.createElement('pre')
  pre.className = 'review-diagram__source'
  pre.textContent = source
  wrap.appendChild(hint)
  wrap.appendChild(pre)
  return wrap
}

function buildLoading(): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'review-diagram__loading'
  wrap.textContent = i18n.t('reviews.plantumlRendering')
  return wrap
}

/** Hostname of a configured renderer endpoint (e.g. `kroki.io`). Falls back to
 *  the raw endpoint minus scheme/path when it isn't a parseable URL. */
export function hostOf(endpoint: string): string {
  const raw = endpoint.trim()
  try {
    return new URL(raw).host || raw
  } catch {
    return raw.replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '') || raw
  }
}

/** RFC-005 (Q10) — privacy notice naming the third-party host the document
 *  source is sent to. Persisted alongside loading + the rendered SVG. */
function buildPrivacyNote(host: string): HTMLElement {
  const note = document.createElement('div')
  note.className = 'review-diagram__privacy'
  note.textContent = i18n.t('reviews.plantumlPrivacyNotice', { host })
  return note
}

function buildErrorWithSource(source: string, msg: string): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'review-diagram__error-wrap'
  const err = document.createElement('div')
  err.className = 'review-diagram__error'
  err.textContent = i18n.t('reviews.plantumlRenderFailed', { msg })
  const pre = document.createElement('pre')
  pre.className = 'review-diagram__source'
  pre.textContent = source
  wrap.appendChild(err)
  wrap.appendChild(pre)
  return wrap
}

/**
 * Standard kroki base64-url encoding: same alphabet as base64url but with
 * a stable padding-trimmed form so the URL stays compact.
 */
function base64UrlEncode(bytes: Uint8Array): string {
  let str = ''
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]!)
  const b64 = typeof btoa === 'function' ? btoa(str) : Buffer.from(bytes).toString('base64')
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// PlantUML's official text-encoding alphabet (digits first, then upper,
// then lower, then `-` and `_`). Documented at
// https://plantuml.com/text-encoding and implemented in PlantUML's
// AsciiEncoder. Differs from base64url only in ordering — same 64-symbol
// space, but the same 6-bit value maps to a different character.
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

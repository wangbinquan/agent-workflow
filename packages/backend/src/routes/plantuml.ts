// RFC-105 WP-B — POST /api/plantuml/render
//
// Server-side PlantUML proxy. Mounted under /api/* (multiAuth), with NO extra
// permission gate, so ANY logged-in user can render PlantUML — unlike
// /api/config (settings:read, admin-only) which previously gated the endpoint.
// The configured endpoint + auth header stay server-side; the browser only
// receives the SVG (which it still DOMPurify-sanitizes).
//
// Response shapes (200 unless noted):
//   { svg, host }            — rendered
//   { unconfigured: true }   — no endpoint configured (browser shows source)
//   { errorSvg, host }       — PlantUML 4xx diagnostic (browser extracts msg)
//   { error } (400)          — missing source
//   { error } (413)          — oversized source (Content-Length or length cap)
//   { error } (200)          — all render attempts failed (union member; api.post
//                              throws + drops the body on non-2xx, so 200 keeps
//                              `error` reachable on the browser)

import type { Hono } from 'hono'
import { loadConfig } from '@/config'
import type { AppDeps } from '@/server'
import { PLANTUML_SOURCE_MAX, hostOf, renderPlantuml } from '@/services/plantuml'
import { DomainError } from '@/util/errors'

export function mountPlantumlRoutes(app: Hono, deps: AppDeps): void {
  app.post('/api/plantuml/render', async (c) => {
    // Reject oversized requests BEFORE buffering/parsing the JSON body
    // (Content-Length is a cheap first cap; the post-parse check below is the
    // authoritative source-length guard when the header is absent / lying).
    const declaredLen = Number(c.req.header('content-length') ?? '0')
    if (Number.isFinite(declaredLen) && declaredLen > PLANTUML_SOURCE_MAX + 1024) {
      // RFC-203 T6: uniform DomainError body (was `{error:string}`).
      throw new DomainError(
        'plantuml-source-too-large',
        'plantuml source exceeds render limit',
        413,
      )
    }
    const body = (await c.req.json().catch(() => ({}))) as { source?: unknown }
    const source = typeof body.source === 'string' ? body.source : ''
    if (source.length === 0) {
      throw new DomainError('plantuml-source-required', 'plantuml source is empty', 400)
    }
    if (source.length > PLANTUML_SOURCE_MAX) {
      throw new DomainError(
        'plantuml-source-too-large',
        'plantuml source exceeds render limit',
        413,
      )
    }
    const cfg = loadConfig(deps.configPath)
    const endpoint = (cfg.plantumlEndpoint ?? '').trim()
    if (endpoint.length === 0) {
      return c.json({ unconfigured: true })
    }
    const result = await renderPlantuml({
      source,
      endpoint,
      authHeader: cfg.plantumlAuthHeader,
    })
    const host = hostOf(endpoint)
    if (result.kind === 'svg') return c.json({ svg: result.svg, host })
    if (result.kind === 'error-svg') return c.json({ errorSvg: result.errorSvg, host })
    // Upstream render failed: 200 with a discriminated { error } (NOT a non-2xx
    // status) — api.post throws + drops the body on non-2xx, so the browser
    // would lose `detail`. "render failed" is an expected outcome here, like
    // `unconfigured` / `errorSvg`, so the union member carries the reason.
    return c.json({ error: result.detail })
  })
}

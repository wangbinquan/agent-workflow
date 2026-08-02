// RFC-247 D17 / D18 / T29 / T34 — the API documentation endpoint and the MCP
// discovery document.
//
// `GET /api/docs/api` is generated per request from the live route registry,
// the live tool registry and the permission catalog (services/apiDocs.ts). It
// is trimmed to the caller's role, because a page listing endpoints the reader
// can never call teaches them nothing they can act on.
//
// `GET /.well-known/mcp` is public by convention — that is what a discovery
// document is for. It says where the endpoint is and how to authenticate, and
// nothing else: an unauthenticated inventory of what the platform can do would
// be a gift to someone deciding whether to bother attacking it, and the tool
// list is per-token anyway.

import type { Hono } from 'hono'
import { actorOf } from '@/auth/actor'
import { registerRoute } from '@/routes/registry'
import { buildApiDocs, clientSnippets, wellKnownMcp } from '@/services/apiDocs'
import type { AppDeps } from '@/server'

/** The origin the caller reached us on, so snippets are copy-pasteable as-is. */
function originOf(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return ''
  }
}

export function mountDocsRoutes(app: Hono, _deps: AppDeps): void {
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/docs/api',
      permissions: [],
      publicReason:
        'documentation of the caller’s OWN capabilities; every authenticated actor may read what its credential can do, and a token needs it because RFC-247 D6 closes /api/auth/me to tokens',
      tokenAccess: 'allow',
      summary: 'Generated REST + MCP documentation for the current role',
    },
    (c) => {
      const actor = actorOf(c)
      const origin = originOf(c.req.url)
      return c.json({
        ...buildApiDocs(actor.user.role),
        snippets: clientSnippets(origin),
      })
    },
  )
}

/**
 * Mounted OUTSIDE the `/api/*` auth scope, next to `/health`.
 *
 * A discovery document behind authentication cannot be discovered, which is the
 * one thing it exists to do.
 */
export function mountWellKnownRoutes(app: Hono, _deps: AppDeps): void {
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/.well-known/mcp',
      permissions: [],
      publicReason:
        'MCP discovery document; must answer before any credential exists (that is what discovery is for) and carries only the endpoint URL and auth scheme',
      tokenAccess: 'allow',
      summary: 'MCP endpoint discovery',
    },
    (c) => c.json(wellKnownMcp(originOf(c.req.url))),
  )
}

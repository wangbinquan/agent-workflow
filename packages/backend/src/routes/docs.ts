// RFC-247 D17 / D18 / T29 / T34 — the API documentation endpoint and the MCP
// discovery document.
//
// `GET /api/docs/api` is generated per request from the live route registry,
// the live tool registry and the permission catalog (services/apiDocs.ts). It
// is trimmed to the caller's effective permissions, because a page listing
// endpoints the reader can never call teaches them nothing they can act on.
//
// `GET /.well-known/mcp` is public by convention — that is what a discovery
// document is for. It says where the endpoint is, whether the surface is
// switched on, and how to authenticate, and nothing else: an unauthenticated
// inventory of what the platform can do would be a gift to someone deciding
// whether to bother attacking it, and the tool list is per-token anyway.
//
// Both documents embed URLs the reader is expected to paste, so the origin they
// quote comes from `publicOriginOf` (config `publicBaseUrl` → `X-Forwarded-*` →
// `Host` → request URL) rather than from `c.req.url` alone. Behind TLS
// termination or a host-rewriting proxy the latter is the daemon's internal
// origin, which made every snippet and the discovery `endpoint` unusable
// (RFC-247 impl-gate P2).

import type { Hono } from 'hono'
import { actorOf } from '@/auth/actor'
import { publicOriginOf } from '@/routes/publicOrigin'
import { registerRoute } from '@/routes/registry'
import { buildApiDocs, clientSnippets, wellKnownMcp } from '@/services/apiDocs'
import { isMcpSurfaceEnabled } from '@/services/mcpSurface'
import type { AppDeps } from '@/server'

export function mountDocsRoutes(app: Hono, deps: AppDeps): void {
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/docs/api',
      permissions: [],
      publicReason:
        'documentation of the caller’s OWN capabilities; every authenticated actor may read what its credential can do, and a token needs it because RFC-247 D6 closes /api/auth/me to tokens',
      tokenAccess: 'allow',
      summary: 'Generated REST + MCP documentation for the current effective permissions',
    },
    (c) => {
      const actor = actorOf(c)
      return c.json({
        ...buildApiDocs(actor.user.role, actor.permissions),
        snippets: clientSnippets(publicOriginOf(c, deps.configPath)),
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
export function mountWellKnownRoutes(app: Hono, deps: AppDeps): void {
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
    (c) =>
      c.json(
        wellKnownMcp(publicOriginOf(c, deps.configPath), {
          enabled: isMcpSurfaceEnabled(deps.configPath),
        }),
      ),
  )
}

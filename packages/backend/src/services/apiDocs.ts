// RFC-247 D17 / §7 — the API + MCP documentation, generated at runtime.
//
// Everything here is DERIVED: the endpoint list comes from `allRouteMeta()`,
// the tool list from the MCP registry, the permission list from the shared
// catalog. Nothing is retyped.
//
// That is the whole design constraint, and it is not about saving effort.
// Hand-written API docs are wrong within a release and stay wrong, because
// nothing fails when they drift. A user reading "needs `workflows:create`" and
// finding that their token 403s has been failed twice — once by the gate and
// once by the page that told them what to ask for. AC-22 locks this: change a
// `RouteMeta` permission or add a tool, and this output changes with it.
//
// The docs are also TRIMMED PER ROLE. A plain user reading about repo-import
// endpoints they can never call learns nothing except that the product has
// surfaces they are locked out of.

import {
  grantableMatrixPoints,
  MATRIX_VERBS,
  READ_POINTS,
  type MatrixResource,
  type Permission,
  type Role,
} from '@agent-workflow/shared'
import { ALL_TOOLS, describeResource, MCP_RESOURCE_KINDS } from '@/mcp/tools'
import { allRouteMeta } from '@/routes/registry'

export interface ApiDocEndpoint {
  readonly method: string
  readonly path: string
  readonly summary: string
  readonly permissions: ReadonlyArray<Permission>
  readonly identity?: 'admin' | 'resource-admin'
  /** True when no permission point is required (see `publicReason`). */
  readonly open: boolean
}

export interface ApiDocTool {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly permissions: ReadonlyArray<Permission>
  /** Whether this role could ever hold the points this tool needs. */
  readonly grantable: boolean
}

export interface ApiDocs {
  readonly role: Role
  /** Every point this role can put on a token, grouped for the matrix UI. */
  readonly grantablePermissions: ReadonlyArray<{
    readonly resource: MatrixResource
    readonly verbs: ReadonlyArray<{ readonly verb: string; readonly permission: Permission }>
  }>
  /** Points every token carries without ticking anything (D3). */
  readonly alwaysGranted: ReadonlyArray<Permission>
  readonly endpoints: ReadonlyArray<ApiDocEndpoint>
  readonly tools: ReadonlyArray<ApiDocTool>
  readonly resourceKinds: ReadonlyArray<ReturnType<typeof describeResource>>
  readonly mcp: {
    readonly endpoint: string
    readonly transport: string
    readonly auth: string
  }
}

/**
 * Build the documentation one role should see.
 *
 * `tokenAccess: 'never'` endpoints are omitted entirely rather than listed as
 * forbidden: this page documents what a TOKEN can do, and an endpoint no token
 * can reach is not part of that story. (The account and ACL surfaces are the
 * bulk of them — see D6.)
 */
export function buildApiDocs(role: Role): ApiDocs {
  const grantable = new Set(grantableMatrixPoints(role))

  const endpoints = allRouteMeta()
    .filter((m) => m.tokenAccess !== 'never')
    // Role trimming: an endpoint whose points this role can never hold is not
    // "advanced", it is unreachable, and listing it teaches the wrong thing.
    .filter((m) => m.permissions.every((p) => grantable.has(p) || READ_POINTS.includes(p)))
    .map((m) => ({
      method: m.method,
      path: m.path,
      summary: m.summary,
      permissions: m.permissions,
      identity: m.identity,
      open: m.permissions.length === 0,
    }))
    .sort((a, b) =>
      a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path),
    )

  const tools = ALL_TOOLS.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    permissions: t.permissions,
    grantable: t.permissions.every((p) => grantable.has(p)),
  }))

  const grantablePermissions: Array<{
    resource: MatrixResource
    verbs: Array<{ verb: string; permission: Permission }>
  }> = []
  for (const kind of MCP_RESOURCE_KINDS) {
    const verbs = MATRIX_VERBS.filter((v) => grantable.has(`${kind}:${v}` as Permission)).map(
      (v) => ({ verb: v, permission: `${kind}:${v}` as Permission }),
    )
    if (verbs.length > 0) grantablePermissions.push({ resource: kind, verbs })
  }
  // `tasks` is not in MCP_RESOURCE_KINDS (its verbs have dedicated tools) but a
  // token absolutely can hold them, so the permission list must still show it.
  const taskVerbs = MATRIX_VERBS.filter((v) => grantable.has(`tasks:${v}` as Permission)).map(
    (v) => ({ verb: v, permission: `tasks:${v}` as Permission }),
  )
  if (taskVerbs.length > 0) grantablePermissions.push({ resource: 'tasks', verbs: taskVerbs })

  return {
    role,
    grantablePermissions,
    alwaysGranted: READ_POINTS.filter((p) => !p.endsWith(':own') && !p.endsWith(':all')),
    endpoints,
    tools,
    resourceKinds: MCP_RESOURCE_KINDS.map((k) => describeResource(k)),
    mcp: {
      endpoint: '/api/mcp',
      transport: 'Streamable HTTP (stateless)',
      auth: 'Bearer <personal access token>',
    },
  }
}

/**
 * Client configuration snippets.
 *
 * Kept as data (not prose in the page) so the base URL is substituted once and
 * every snippet stays consistent with the others.
 *
 * The opencode snippet sets `oauth: false` explicitly. Its MCP client
 * auto-detects OAuth otherwise, and against a bearer-token server that
 * detection costs a failed round trip and an error the user has to interpret —
 * verified in the opencode source, recorded in docs/dev-gotchas.md.
 */
export function clientSnippets(
  baseUrl: string,
  tokenPlaceholder = '<your-token>',
): Array<{
  id: string
  label: string
  language: string
  code: string
}> {
  const url = `${baseUrl.replace(/\/$/, '')}/api/mcp`
  return [
    {
      id: 'claude-code',
      label: 'Claude Code',
      language: 'bash',
      code: `claude mcp add --transport http agent-workflow ${url} \\\n  --header "Authorization: Bearer ${tokenPlaceholder}"`,
    },
    {
      id: 'opencode',
      label: 'opencode',
      language: 'json',
      code: JSON.stringify(
        {
          mcp: {
            'agent-workflow': {
              type: 'remote',
              url,
              headers: { Authorization: `Bearer ${tokenPlaceholder}` },
              // Without this the client probes for OAuth first; this server
              // takes a bearer token.
              oauth: false,
              enabled: true,
            },
          },
        },
        null,
        2,
      ),
    },
    {
      id: 'generic',
      label: 'Any MCP client',
      language: 'json',
      code: JSON.stringify(
        {
          mcpServers: {
            'agent-workflow': {
              type: 'streamable-http',
              url,
              headers: { Authorization: `Bearer ${tokenPlaceholder}` },
            },
          },
        },
        null,
        2,
      ),
    },
    {
      id: 'curl',
      label: 'curl (REST)',
      language: 'bash',
      code: `curl -H "Authorization: Bearer ${tokenPlaceholder}" \\\n  ${baseUrl.replace(/\/$/, '')}/api/tasks`,
    },
  ]
}

/**
 * `GET /.well-known/mcp` — the discovery document (D18).
 *
 * Deliberately unauthenticated and deliberately empty of anything specific:
 * it says where the endpoint is and how to authenticate, which is what
 * discovery is for. Listing tools here would be an unauthenticated inventory of
 * the platform's capabilities, and the tool list is per-token anyway.
 */
export function wellKnownMcp(baseUrl: string): Record<string, unknown> {
  return {
    version: '1',
    endpoint: `${baseUrl.replace(/\/$/, '')}/api/mcp`,
    transport: 'streamable-http',
    authentication: { type: 'bearer', description: 'Personal access token issued from /account' },
    documentation: `${baseUrl.replace(/\/$/, '')}/docs/api`,
  }
}

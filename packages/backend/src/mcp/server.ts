// RFC-247 §4.1 — the MCP endpoint.
//
// `POST /api/mcp`, stateless Streamable HTTP. Every request carries its own
// credential and its own transport instance; nothing about one call survives
// into the next, which is what makes a daemon restart mid-conversation a
// non-event for the client.
//
// ## Transport choice (design §4.1 said `StreamableHTTPServerTransport`)
//
// The SDK ships two implementations of the same wire protocol. The one named
// in the design is the Node `IncomingMessage`/`ServerResponse` wrapper; this
// daemon is Bun + Hono, where a request IS a web-standard `Request`. Using the
// wrapper would mean adapting web-standard objects into Node stream shims and
// back. `WebStandardStreamableHTTPServerTransport` is the same transport
// underneath — the Node one wraps it — and its own docstring gives the Hono
// call as the usage example, so this is the intended entry point rather than a
// clever detour.

import type { Hono, MiddlewareHandler } from 'hono'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { Actor } from '@/auth/actor'
import { actorOf } from '@/auth/actor'
import { createDispatcher, mcpDispatchActor, type Dispatcher } from '@/mcp/dispatch'
import { McpCallError, toolsFor, type McpToolContext } from '@/mcp/tools'
import { isMcpSurfaceEnabled } from '@/services/mcpSurface'
import { recordTokenCall, type TokenCallRecord } from '@/services/tokenAudit'
import { redactErrorText } from '@/services/tokenRedaction'
import type { AppDeps } from '@/server'
import { ForbiddenError, UnauthorizedError } from '@/util/errors'

/** Advertised to clients on initialize. */
const SERVER_INFO = { name: 'agent-workflow', version: '1' } as const

export function buildMcpServer(
  actor: Actor,
  dispatcher: Dispatcher,
  audit?: (record: Omit<TokenCallRecord, 'actor' | 'channel'>) => void,
): McpServer {
  const server = new McpServer(SERVER_INFO)
  const dispatchActor = mcpDispatchActor(actor)

  for (const tool of toolsFor(actor)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      // The SDK types the callback against the tool's own schema; the registry
      // is heterogeneous by construction, so the shape is re-widened here and
      // the zod schema above is what actually validates the arguments.
      (async (args: Record<string, unknown>, extra: ToolExtra) => {
        const ctx: McpToolContext = {
          actor,
          dispatch: (req) => dispatcher(req, dispatchActor),
          progress: async (message) => {
            const token = extra._meta?.progressToken
            // D9 / F9 — no progressToken means the client did not ask to be
            // kept informed. Skipping silently is correct; the call's blocking
            // and timeout behaviour must not change either way.
            if (token === undefined) return
            await extra.sendNotification({
              method: 'notifications/progress',
              params: { progressToken: token, message },
            })
          },
          signal: extra.signal,
        }
        try {
          const result = await tool.handler(args, ctx)
          // Audited per TOOL, not per HTTP request: every MCP call is the same
          // `POST /api/mcp`, so the request line carries no information an
          // operator can use. The tool name and its arguments' resource
          // identity do.
          audit?.({
            toolName: tool.name,
            resourceKind: stringArg(args.kind),
            resourceId: stringArg(args.id),
            statusCode: 200,
          })
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          }
        } catch (err) {
          audit?.({
            toolName: tool.name,
            resourceKind: stringArg(args.kind),
            resourceId: stringArg(args.id),
            statusCode: err instanceof McpCallError ? err.status : 400,
          })
          return toolError(err)
        }
      }) as never,
    )
  }
  return server
}

function stringArg(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}

interface ToolExtra {
  signal: AbortSignal
  _meta?: { progressToken?: string | number }
  sendNotification: (n: {
    method: 'notifications/progress'
    params: { progressToken: string | number; message: string }
  }) => Promise<void>
}

/**
 * RFC-247 §4.3 — a refusal a model can act on.
 *
 * A permission failure names the missing point, because the useful next step is
 * for the model to tell its user "this token needs `workflows:create`" rather
 * than to retry the same call. Every text goes through the redactor first:
 * opencode's MCP client concatenates `isError` content and throws it, so the
 * error path is as much of a leak surface as the success path (§2.4).
 */
function toolError(err: unknown): {
  isError: true
  content: Array<{ type: 'text'; text: string }>
} {
  let text: string
  if (err instanceof McpCallError) {
    text =
      err.code === 'forbidden'
        ? `permission denied: ${err.message}. Call describe_capabilities to see what this token holds.`
        : `${err.code}: ${err.message}`
  } else if (err instanceof Error) {
    text = err.message
  } else {
    text = String(err)
  }
  return { isError: true, content: [{ type: 'text', text: redactErrorText(text) }] }
}

export function mountMcpTransport(app: Hono, deps: AppDeps): void {
  // Built once, on FIRST USE. The dispatcher mounts the whole /api route table
  // into a second Hono app — real work, and pointless for a daemon (or a test)
  // that never receives an MCP request. Deferring it keeps `createApp` the same
  // cost it was before this RFC, which matters because the test suite builds
  // hundreds of apps.
  let dispatcher: Dispatcher | null = null
  const dispatcherOnce = (): Dispatcher => {
    dispatcher ??= createDispatcher(deps)
    return dispatcher
  }

  // Deliberately NOT registerRoute: `/api/mcp` is a transport, not a REST
  // endpoint with a permission point. Its authorization happens per TOOL, from
  // the same declarations `tools/list` filters on. The exemption is recorded in
  // `EXEMPT_MOUNTS` (routes/registry.ts) so the coverage self-check treats it as
  // a decision rather than an oversight.
  //
  // `app.all` rather than `app.post`: in stateless mode the transport answers
  // GET and DELETE with 405, which is what the Streamable HTTP spec asks for.
  // Mounting POST alone would turn those into a 404 — "no such endpoint" —
  // which tells a client to look elsewhere for a server that is right here.
  const handler: MiddlewareHandler = async (c) => {
    const actor = actorOf(c)
    // D10 — one switch closes both the MCP endpoint and token minting.
    if (!isMcpSurfaceEnabled(deps.configPath)) {
      throw new ForbiddenError('mcp-surface-disabled', 'the MCP surface is disabled')
    }
    // Only PATs. A session cookie reaching this endpoint would mean a browser
    // was talked into driving the platform on someone's behalf; the daemon
    // token would mean the deployment's root credential is being used as an
    // agent credential. Neither is a thing anyone needs.
    if (actor.source !== 'pat') {
      // 401, not 403 — D10 says so explicitly, and the distinction is
      // meaningful here: the caller presented a credential this endpoint does
      // not accept AT ALL, so the actionable answer is "authenticate with a
      // personal access token", not "your permissions are insufficient". The
      // first version used 403 and a test asserted it, so implementation and
      // test agreed with each other while both disagreed with the contract.
      throw new UnauthorizedError('the MCP endpoint accepts personal access tokens only')
    }

    const server = buildMcpServer(actor, dispatcherOnce(), (record) => {
      void recordTokenCall(deps.db, { ...record, actor, channel: 'mcp' })
    })
    const transport = new WebStandardStreamableHTTPServerTransport({
      // Stateless: no session id, no server-side conversation state. A blocking
      // tool still streams its progress on ITS OWN response, which is why
      // watch_task works without sessions.
      sessionIdGenerator: undefined,
    })
    await server.connect(transport)
    // NOT closed here. `handleRequest` returns as soon as the response HEADERS
    // are ready; its body is a stream the transport is still writing into, so
    // closing on the way out truncates every answer to zero bytes (observed:
    // 200 with an empty body, which reads exactly like a working endpoint that
    // has nothing to say). The transport ends its own stream when the request's
    // responses are all sent, and the server/transport pair — referenced only
    // by each other — becomes collectable then.
    return await transport.handleRequest(c.req.raw)
  }

  app.all('/api/mcp', handler)
}

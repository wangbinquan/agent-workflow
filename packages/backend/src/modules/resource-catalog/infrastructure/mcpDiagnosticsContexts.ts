import type { Mcp } from '@agent-workflow/shared'
import type {
  AuthenticatedAuthoritySnapshot,
  CommandContext,
  QueryContext,
  DirectCommandContextFactory,
  DirectQueryContextFactory,
  DirectAuthorityBinding,
} from '@/modules/identity-access/public/participants'
import type { McpOperationContext } from '../public/participants'
import type {
  McpDiagnosticsContextResolver,
  McpDiagnosticsRequest,
} from '../application/mcps/diagnosticsOperations'

/** Per-request IA binding; neither an application singleton nor a result cache. */
export function createMcpDiagnosticsContexts(input: {
  readonly contexts: DirectCommandContextFactory & DirectQueryContextFactory
  readonly directAuthority: DirectAuthorityBinding
  readonly loadVisibleMcp: (authority: McpOperationContext, id: string) => Promise<Mcp | null>
}) {
  const requests = new WeakMap<CommandContext | QueryContext, McpDiagnosticsRequest>()
  function bind<T extends CommandContext | QueryContext>(
    context: T,
    actor: McpOperationContext,
  ): T {
    requests.set(
      context,
      Object.freeze({
        caller: Object.freeze({
          user: Object.freeze({ id: actor.user.id }),
          permissions: Object.freeze({
            has: (permission: 'mcp-runtime-tests:audit') => actor.permissions.has(permission),
          }),
        }),
        loadVisibleMcp: (id: string) => input.loadVisibleMcp(actor, id),
      }),
    )
    return context
  }
  function request(context: CommandContext | QueryContext): McpDiagnosticsRequest {
    const request = requests.get(context)
    if (request === undefined) throw new Error('mcp-diagnostics-context-not-bound')
    return request
  }
  const resolver: McpDiagnosticsContextResolver = Object.freeze({
    command(context: CommandContext) {
      input.contexts.resolveCommandContext(context)
      return request(context)
    },
    query(context: QueryContext) {
      input.contexts.resolveQueryContext(context)
      return request(context)
    },
  })
  return Object.freeze({
    resolver,
    command(actor: AuthenticatedAuthoritySnapshot): CommandContext {
      const authority = input.directAuthority.authorityForLegacyProjection(actor)
      return bind(
        input.contexts.fromAuthority(authority, 'http'),
        input.directAuthority.legacyProjectionForAuthority(authority),
      )
    },
    query(actor: AuthenticatedAuthoritySnapshot): QueryContext {
      const authority = input.directAuthority.authorityForLegacyProjection(actor)
      return bind(
        input.contexts.queryFromAuthority(authority, 'http'),
        input.directAuthority.legacyProjectionForAuthority(authority),
      )
    },
  })
}

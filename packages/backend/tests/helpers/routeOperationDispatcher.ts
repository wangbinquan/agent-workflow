import type { Actor } from '@/auth/actor'
import { createIdentityAccessRuntime } from '@/modules/identity-access/composition'
import { allOperationRoutes } from '@/platform/operations/catalog'
import type { OperationResult } from '@/platform/operations/contracts'
import { createBoundOperationInvoker } from '@/platform/operations/boundOperationInvoker'
import { createApp, type AppDeps } from '@/server'
import { admitTestDirectAuthority } from './identityAccessAuthority'

export interface RouteOperationRequest {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  readonly path: string
  readonly query?: Readonly<Record<string, string | undefined>>
  readonly body?: unknown
}

export type RouteOperationDispatcher = (
  request: RouteOperationRequest,
  actor: Actor,
) => Promise<OperationResult>

function matchPath(template: string, concrete: string): Readonly<Record<string, string>> | null {
  const expected = template.split('/').filter(Boolean)
  const actual = concrete.split('/').filter(Boolean)
  if (expected.length !== actual.length) return null
  const params: Record<string, string> = {}
  for (let index = 0; index < expected.length; index += 1) {
    const part = expected[index]!
    const value = actual[index]!
    if (part.startsWith(':')) params[part.slice(1)] = decodeURIComponent(value)
    else if (part !== value) return null
  }
  return params
}

/** Test-only compatibility shim for pre-RFC-344 route-level assertions. */
export function createRouteOperationDispatcher(deps: AppDeps): RouteOperationDispatcher {
  const identityAccess = deps.identityAccess ?? createIdentityAccessRuntime({ db: deps.db })
  const app = createApp({ ...deps, identityAccess })
  return async (request, actor) => {
    for (const route of allOperationRoutes()) {
      if (route.method !== request.method) continue
      const params = matchPath(route.path, request.path)
      if (params === null) continue
      const identity = await admitTestDirectAuthority(
        identityAccess.directAuthority,
        actor.source === 'pat'
          ? {
              userId: actor.user.id,
              source: 'pat',
              patScopes: [...actor.permissions],
              ...(actor.purpose === undefined ? {} : { patPurpose: actor.purpose }),
              ...(actor.patId === undefined ? {} : { patId: actor.patId }),
            }
          : actor.source === 'session'
            ? { userId: actor.user.id, source: 'session' }
            : { source: 'daemon' },
      )
      if (identity === null) throw new Error('test route actor could not be admitted')
      return createBoundOperationInvoker(app, identity.actor)(route.operationId, {
        params,
        query: request.query,
        body: request.body,
      })
    }
    return {
      status: 404,
      body: {
        ok: false,
        code: 'route-not-found',
        message: `no route for ${request.path}`,
      },
    }
  }
}

import type { Hono } from 'hono'

import type { Actor } from '@/auth/actor'
import {
  createIdentityAccessRuntime,
  type IdentityAccessRuntime,
} from '@/modules/identity-access/composition'
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

/**
 * Test-only compatibility shim for pre-RFC-344 route-level assertions.
 *
 * RFC-359 —— 两种入参形态：
 *   · `{ app, identityAccess }` —— **已装配好的应用**，两个 provider 通用。共用 HTTP 夹具把
 *     这两样都交出来了（`ProviderHttpApplication`），所以 MCP dispatcher 类用例不再需要
 *     `AppDeps`，也就不再被钉死在 SQLite 上。
 *   · `AppDeps` —— 旧形态：自己 `createApp`，只能是 SQLite。存量调用方还在用，新用例别再用。
 */
export function createRouteOperationDispatcher(
  input: AppDeps | { readonly app: Hono; readonly identityAccess: IdentityAccessRuntime },
): RouteOperationDispatcher {
  const composed = 'app' in input
  const identityAccess = composed
    ? input.identityAccess
    : (input.identityAccess ?? createIdentityAccessRuntime({ db: input.db }))
  const app = composed ? input.app : createApp({ ...input, identityAccess })
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

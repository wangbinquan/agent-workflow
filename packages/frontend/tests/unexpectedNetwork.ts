// Vitest network boundary: unit/component tests must declare every HTTP
// interaction by replacing globalThis.fetch. A rejected fetch alone is not a
// sufficient guard because React Query can catch it and still let the test go
// green, so every unexpected request is also recorded for the global
// afterEach assertion in setup.ts.
//
// Permission-aware presentation reads the same current-authority snapshot in
// almost every authenticated component. Treat that one GET as test-platform
// infrastructure and supply a complete admin actor by default. Tests whose
// subject is authorization still replace fetch with their own explicit actor;
// every other endpoint remains fail-closed and must be declared by the test.

import { PERMISSIONS } from '@agent-workflow/shared'
import type { QueryClient } from '@tanstack/react-query'

const unexpectedRequests: string[] = []

export function fullAccessActorPayload() {
  return {
    user: {
      id: 'vitest-admin',
      username: 'vitest-admin',
      displayName: 'Vitest Admin',
      role: 'admin' as const,
      status: 'active' as const,
    },
    source: 'session' as const,
    permissions: [...PERMISSIONS],
    linkedIdentities: [],
    pats: [],
  }
}

export function fullAccessActorResponse(): Response {
  return new Response(JSON.stringify(fullAccessActorPayload()), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** Seed the exact token-scoped query consumed by usePermission/useActor. */
export function seedFullAccessActor(client: QueryClient, token = 'tok'): void {
  client.setQueryData(['auth', 'me', token], fullAccessActorPayload())
}

function isAuthMeRequest(input: RequestInfo | URL, init?: RequestInit): boolean {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  return method === 'GET' && new URL(url, 'http://daemon.test').pathname === '/api/auth/me'
}

/** Compose a test-owned endpoint mock with the shared full-authority fixture. */
export function withFullAccessActorFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return async (input, init) => {
    if (isAuthMeRequest(input, init)) return fullAccessActorResponse()
    return await handler(input, init)
  }
}

function requestDescription(input: RequestInfo | URL, init?: RequestInit): string {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  return `${method} ${url}`
}

export const unexpectedNetworkFetch: typeof fetch = async (input, init) => {
  const request = requestDescription(input, init)
  if (isAuthMeRequest(input, init)) return fullAccessActorResponse()
  unexpectedRequests.push(request)
  throw new Error(
    `Unexpected network request in Vitest: ${request}. Mock globalThis.fetch in this test.`,
  )
}

export function installUnexpectedNetworkGuard(): void {
  globalThis.fetch = unexpectedNetworkFetch
}

export function resetUnexpectedNetworkRequests(): void {
  unexpectedRequests.length = 0
}

export function takeUnexpectedNetworkRequests(): string[] {
  return unexpectedRequests.splice(0)
}

import type { IncomingMessage, ServerResponse } from 'node:http'

import { randomUUID } from 'node:crypto'

import { writeJson, writeText } from '../core/http'
import type { MockHttpResponse, MockHttpRoute, MockHttpRouteSnapshot } from '../types'

interface StoredRoute {
  id: string
  method: string
  path: string
  responses: MockHttpResponse[]
  repeatLast: boolean
  consumed: number
}

/**
 * A deliberately generic upstream for script adapters.
 *
 * RFC-304 treats company CI, document stores and issue routers as scripts whose
 * HTTP protocols the platform cannot know. This mock therefore models the one
 * stable boundary they share: an exact request produces an ordered response.
 */
export class ExternalHttpMock {
  readonly #routes: StoredRoute[] = []

  seed(input: MockHttpRoute): MockHttpRouteSnapshot {
    if (!input.path.startsWith('/')) throw new Error("external mock route path must start with '/'")
    if (input.responses.length === 0)
      throw new Error('external mock route needs at least one response')
    const route: StoredRoute = {
      id: input.id ?? randomUUID(),
      method: (input.method ?? 'GET').toUpperCase(),
      path: input.path,
      responses: structuredClone(input.responses),
      repeatLast: input.repeatLast ?? true,
      consumed: 0,
    }
    const existing = this.#routes.findIndex((candidate) => candidate.id === route.id)
    if (existing >= 0) this.#routes.splice(existing, 1, route)
    else this.#routes.push(route)
    return snapshotOf(route)
  }

  reset(): void {
    this.#routes.length = 0
  }

  snapshot(): MockHttpRouteSnapshot[] {
    return this.#routes.map(snapshotOf)
  }

  handle(input: {
    request: IncomingMessage
    response: ServerResponse
    url: URL
    routePrefix: string
  }): boolean {
    const path = input.url.pathname.slice(input.routePrefix.length) || '/'
    const method = (input.request.method ?? 'GET').toUpperCase()
    const route = this.#routes.find(
      (candidate) => candidate.method === method && candidate.path === path,
    )
    if (route === undefined) {
      writeJson(input.response, 404, {
        error: 'external-route-not-seeded',
        method,
        path,
      })
      return true
    }

    const index = Math.min(route.consumed, route.responses.length - 1)
    if (route.consumed >= route.responses.length && !route.repeatLast) {
      writeJson(input.response, 410, {
        error: 'external-route-exhausted',
        routeId: route.id,
      })
      return true
    }
    const response = route.responses[index]!
    route.consumed += 1
    const status = response.status ?? 200
    if (response.json !== undefined) {
      writeJson(input.response, status, response.json, response.headers ?? {})
    } else {
      writeText(
        input.response,
        status,
        response.body ?? '',
        response.headers?.['content-type'] ?? 'text/plain; charset=utf-8',
        response.headers ?? {},
      )
    }
    return true
  }
}

function snapshotOf(route: StoredRoute): MockHttpRouteSnapshot {
  return {
    id: route.id,
    method: route.method,
    path: route.path,
    responses: structuredClone(route.responses),
    repeatLast: route.repeatLast,
    consumed: route.consumed,
  }
}

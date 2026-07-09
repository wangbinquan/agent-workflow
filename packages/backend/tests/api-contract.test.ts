import { rimrafDir } from './helpers/cleanup'
// RFC-054 W1-2 — API contract suite (response shape + auth gate per endpoint).
//
// LOCKS: every endpoint enumerated in `tests/contracts/registry.ts ENDPOINTS`
// must (a) refuse anonymous callers with a 401 + canonical `ErrorResponse`
// body — unless `public: true` — and (b) where a `happy` fixture is declared,
// respond with the declared status + a body that matches the Zod schema.
//
// Coverage of registry completeness lives in `api-contract-coverage.test.ts`.
//
// W1-2 deliberately limits happy fixtures to a curated set so this PR stays
// shippable. Adding `happy: {...}` to an existing entry in registry.ts is the
// follow-up loop: schema gets exercised, regression catches sneak in.

import { afterAll, beforeAll, describe, test, expect } from 'bun:test'
import { rmSync } from 'node:fs'
import { ErrorResponseSchema } from '@agent-workflow/shared'
import {
  buildContractHarness,
  fillPath,
  reqAsAdmin,
  reqUnauthorized,
  type ContractHarness,
} from './contracts/harness'
import { ENDPOINTS, type EndpointSpec, type HappyFixture } from './contracts/registry'

let harness: ContractHarness

beforeAll(async () => {
  harness = await buildContractHarness()
})
afterAll(() => {
  try {
    rimrafDir(harness.homePath)
  } catch {
    /* best-effort */
  }
})

// ---------------------------------------------------------------------------
// 401 gate: every authRequired endpoint must reject anonymous callers with
// a canonical ErrorResponse payload. Generates one test per endpoint.
// ---------------------------------------------------------------------------
describe('API contract — 401 gate (anonymous callers)', () => {
  const authRequired = ENDPOINTS.filter((e) => !e.public)
  for (const ep of authRequired) {
    test(`${ep.method} ${ep.path} → 401`, async () => {
      // Substitute :params with literal placeholders so the path is parseable;
      // we expect a 401 from the auth middleware BEFORE the handler is even
      // dispatched, so the placeholder values don't matter.
      const url = fillPath(ep.path, {
        id: 'X',
        name: 'X',
        nodeRunId: 'X',
        taskId: 'X',
        commentId: 'X',
        batchId: 'X',
        rowId: 'X',
        versionId: 'X',
        slug: 'X',
        nodeId: 'X',
      })
      const res = await reqUnauthorized(harness.app, ep.method, url)
      expect(res.status).toBe(401)
      const body = (await res.json()) as unknown
      const parsed = ErrorResponseSchema.safeParse(body)
      if (!parsed.success) {
        throw new Error(
          `${ep.method} ${ep.path} 401 body did not match ErrorResponseSchema:\n` +
            JSON.stringify(body, null, 2) +
            '\n\nZod errors:\n' +
            JSON.stringify(parsed.error.flatten(), null, 2),
        )
      }
      expect(parsed.data.ok).toBe(false)
      expect(typeof parsed.data.code).toBe('string')
      expect(parsed.data.code.length).toBeGreaterThan(0)
    })
  }
})

// ---------------------------------------------------------------------------
// Happy-path: for entries that declare a `happy` fixture, send the request
// and validate the response body against the declared schema.
// ---------------------------------------------------------------------------
describe('API contract — happy paths', () => {
  const withHappy = ENDPOINTS.filter((e): e is EndpointSpec & { happy: HappyFixture } => !!e.happy)
  for (const ep of withHappy) {
    test(`${ep.method} ${ep.path} → ${ep.happy.status ?? 200} matches schema`, async () => {
      const happy = ep.happy
      if (happy.skipHappy) {
        // Test still listed but no-op — surfaces in run list with the skip reason.
        return
      }

      const pathParams =
        typeof happy.pathParams === 'function'
          ? happy.pathParams(harness)
          : (happy.pathParams ?? {})
      let url = fillPath(ep.path, pathParams)
      if (happy.query) {
        const q = new URLSearchParams(happy.query).toString()
        if (q.length > 0) url += `?${q}`
      }

      const body = typeof happy.body === 'function' ? await happy.body(harness) : happy.body
      const res = ep.public
        ? await harness.app.request(url, {
            method: ep.method,
            headers: {
              ...(happy.headers ?? {}),
              ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
            },
            body:
              body !== undefined
                ? typeof body === 'string'
                  ? body
                  : JSON.stringify(body)
                : undefined,
          })
        : await reqAsAdmin(harness.app, ep.method, url, body, happy.headers)

      const expectedStatus = happy.status ?? 200
      const text = await res.text()
      if (res.status !== expectedStatus) {
        throw new Error(
          `${ep.method} ${ep.path} expected status ${expectedStatus}, got ${res.status}\n` +
            `body: ${text.slice(0, 500)}`,
        )
      }

      // If no body expected (e.g. 204), skip schema check.
      if (expectedStatus === 204 || text.length === 0) return

      let json: unknown
      try {
        json = JSON.parse(text)
      } catch {
        throw new Error(`${ep.method} ${ep.path} response is not JSON:\n${text.slice(0, 500)}`)
      }

      const schema = happy.schema ?? null
      if (schema !== null) {
        const parsed = schema.safeParse(json)
        if (!parsed.success) {
          throw new Error(
            `${ep.method} ${ep.path} body did not match happy schema:\n` +
              JSON.stringify(json, null, 2).slice(0, 1000) +
              '\n\nZod errors:\n' +
              JSON.stringify(parsed.error.flatten(), null, 2),
          )
        }
      }
    })
  }
})

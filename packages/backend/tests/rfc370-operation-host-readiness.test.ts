// RFC-370: descriptor HTTP projection and direct bound/MCP invocation must
// consume the same root admission. This tests the transport contract; real SO
// lifetime retirement is separately exercised with both actual providers.
import { afterEach, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { z } from 'zod'
import type { HostExecutionStatus } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import type {
  HostExecutionAdmission,
  HostExecutionStopReason,
} from '@/modules/system-operations/public/participants'
import {
  captureOperationCatalogForTests,
  restoreOperationCatalogForTests,
} from '@/platform/operations/catalog'
import { defineCommandOperation } from '@/platform/operations/definitions'
import { createBoundOperationInvoker } from '@/platform/operations/boundOperationInvoker'
import { bindHttpHostExecutionAvailability } from '@/platform/http/hostExecutionAvailability'
import { registerOperationRoute } from '@/routes/operationRoute'
import { resetRouteMetaRegistry } from '@/routes/registry'
import { errorHandler } from '@/util/errors'
import { deferred } from './helpers/taskHostExecution'

const checkpoint = captureOperationCatalogForTests()
afterEach(() => {
  resetRouteMetaRegistry()
  restoreOperationCatalogForTests(checkpoint)
})

test('HTTP and bound invocation refuse before decode; an admitted descriptor keeps its exact request lease until completion', async () => {
  const entered = deferred(),
    release = deferred()
  let view: HostExecutionStatus = {
    mode: 'resource-only',
    status: {
      phase: 'standby',
      generation: 'transport-test',
      readyGroups: [],
      reason: 'resource-only',
    },
  }
  let decoded = 0,
    invoked = 0,
    acquired = 0,
    completed = 0
  const admission: HostExecutionAdmission = {
    acquire(group) {
      expect(group).toBe('task')
      acquired += 1
      return {
        kind: 'admitted',
        lease: {
          generation: 'transport-test',
          reference: Object.freeze({}),
          stopped: new Promise<HostExecutionStopReason>(() => {}),
          complete() {
            completed += 1
          },
        },
      }
    },
  }
  const descriptor = defineCommandOperation({
    id: 'rfc370.host-transport-contract.v1',
    summary: 'Test the exact descriptor transport',
    permissions: [],
    publicReason: 'test-only transport fixture',
    publicErrors: [],
    inputSchema: z.object({ nonce: z.string() }).strict(),
    outputSchema: z.object({ nonce: z.string() }).strict(),
    async invoke(_context: object, input) {
      invoked += 1
      entered.resolve()
      await release.promise
      return { nonce: input.nonce }
    },
  })
  const app = new Hono()
  app.onError(errorHandler)
  bindHttpHostExecutionAvailability(app, { queries: { readCurrent: () => view }, admission })
  registerOperationRoute(app, {
    descriptor,
    method: 'POST',
    path: '/api/rfc370-host-transport',
    tokenAccess: 'allow',
    executionGroup: 'task',
    decode: async (c) => {
      decoded += 1
      return c.req.json()
    },
    context: () => ({}),
    encode: (c, output) => c.json(output),
  })
  const actor: Actor = {
    user: {
      id: 'transport-reader',
      username: 'transport-reader',
      displayName: 'Reader',
      role: 'user',
      status: 'active',
    },
    source: 'session',
    permissions: new Set(),
  }
  const bound = createBoundOperationInvoker(app, actor)
  const request = () =>
    app.request('/api/rfc370-host-transport', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce: 'original-request' }),
    })
  let issued: ReturnType<typeof bound> | undefined
  try {
    expect((await request()).status).toBe(503)
    expect((await bound(descriptor.id, { body: { nonce: 'blocked-bound-request' } })).status).toBe(
      503,
    )
    expect({ decoded, invoked, acquired, completed }).toEqual({
      decoded: 0,
      invoked: 0,
      acquired: 0,
      completed: 0,
    })
    view = {
      mode: 'execution',
      status: {
        phase: 'active',
        generation: 'transport-test',
        readyGroups: ['task'],
        reason: null,
      },
    }
    issued = bound(descriptor.id, { body: { nonce: 'original-bound-request' } })
    await entered.promise
    expect({ invoked, acquired, completed }).toEqual({ invoked: 1, acquired: 1, completed: 0 })
    view = {
      ...view,
      status: { ...view.status, phase: 'draining', readyGroups: [], reason: 'original-loss' },
    }
    expect((await request()).status).toBe(503)
    expect((await bound(descriptor.id, { body: { nonce: 'second-bound-request' } })).status).toBe(
      503,
    )
    expect(invoked).toBe(1)
    release.resolve()
    expect(await issued).toMatchObject({ status: 200, body: { nonce: 'original-bound-request' } })
    expect(completed).toBe(1)
  } finally {
    release.resolve()
    await issued
  }
})

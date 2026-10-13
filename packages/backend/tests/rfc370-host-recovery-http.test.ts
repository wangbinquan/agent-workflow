// RFC-370: status GET is side-effect free; recovery POST invokes the original
// selected control even while execution admission is closed.
import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import { buildActor } from '@/auth/actor'
import { mountDaemonRoutes } from '@/routes/daemon'
import { errorHandler } from '@/util/errors'
import type { HostExecutionStatus } from '@agent-workflow/shared'

function appFor(execution?: Parameters<typeof mountDaemonRoutes>[1]['execution']) {
  const app = new Hono()
  app.onError(errorHandler)
  app.use('*', async (c, next) => {
    c.set(
      'actor',
      buildActor({
        source: 'session',
        user: {
          id: 'operator',
          username: 'operator',
          displayName: 'Operator',
          role: 'admin',
          status: 'active',
        },
      }),
    )
    await next()
  })
  mountDaemonRoutes(app, { runtime: { readCurrent: async () => null }, execution })
  return app
}

test('recovery controls preserve the original receiver and return the actual post-ACK state', async () => {
  let calls = 0
  let view: HostExecutionStatus = {
    mode: 'execution',
    status: {
      generation: 'original',
      phase: 'draining',
      readyGroups: [],
      reason: 'host-execution-start-failed',
    },
  }
  const recovery = {
    async retryActivation() {
      expect(this).toBe(recovery)
      calls += 1
      view = {
        mode: 'execution',
        status: { ...view.status!, phase: 'active', readyGroups: ['task'], reason: null },
      }
    },
  }
  const app = appFor({
    queries: { readCurrent: () => view },
    admission: { acquire: () => ({ kind: 'unavailable', reason: 'original recovery pending' }) },
    recovery,
  })
  recovery.retryActivation = async () => {
    throw new Error('replacement command must not run')
  }
  expect(await (await app.request('/api/execution/status')).json()).toMatchObject({
    status: { phase: 'draining' },
  })
  expect(calls).toBe(0)
  const response = await app.request('/api/execution/recover', { method: 'POST' })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    status: { phase: 'active', readyGroups: ['task'] },
  })
  expect(calls).toBe(1)
})

test('native and resource-only roots do not pretend activation recovery is available', async () => {
  for (const execution of [
    undefined,
    {
      queries: {
        readCurrent: (): HostExecutionStatus => ({
          mode: 'resource-only',
          status: { phase: 'standby', generation: 'resource-only', readyGroups: [], reason: null },
        }),
      },
      admission: { acquire: () => ({ kind: 'unavailable' as const, reason: 'resource-only' }) },
      recovery: {
        async retryActivation() {
          throw new Error('resource-only recovery must not run')
        },
      },
    },
  ]) {
    const response = await appFor(execution).request('/api/execution/recover', { method: 'POST' })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'host-execution-recovery-not-selected' })
  }
})

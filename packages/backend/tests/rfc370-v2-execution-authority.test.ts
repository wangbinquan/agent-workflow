// RFC-370 v2 H7 (design/RFC-370-crewstation-hosted-deployment/redesign-v2-20261014.md):
// one business path for standalone and hosted; only bootstrap picks the execution
// authority. Locks the always-active standalone authority, the public status
// projection, and the request gate: a route that starts execution is refused with
// 503 on an instance that is not active — over HTTP and over the bound-operation
// (MCP) path alike — while every other route keeps working.
import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { ExecutionStatusSchema, type ExecutionStatus } from '@agent-workflow/shared'
import type { Actor } from '../src/auth/actor'
import { errorHandler, DomainError } from '../src/util/errors'
import { registerRoute } from '../src/routes/registry'
import { mountDaemonRoutes } from '../src/routes/daemon'
import { lookupDeclaredHttpOperation } from '../src/platform/operations/catalog'
import { createBoundOperationInvoker } from '../src/platform/operations/boundOperationInvoker'
import {
  assertExecutionAvailable,
  bindExecutionAvailability,
  readExecutionStatus,
} from '../src/platform/http/executionAvailability'
import {
  composeLocalExecutionAuthority,
  executionStatusOf,
} from '../src/modules/system-operations/composition'
import type {
  ExecutionAuthorityPort,
  ExecutionAuthorityState,
} from '../src/modules/system-operations/application/ports/executionAuthority'

function hostedAuthority(state: ExecutionAuthorityState): ExecutionAuthorityPort {
  return {
    mode: 'crewstation',
    current: () => state,
    whenActive: () => new Promise(() => {}),
    onLost: () => () => {},
    close: async () => {},
  }
}

const STANDBY: ExecutionStatus = { mode: 'crewstation', state: 'standby', reason: 'waiting' }

function gatedApp(read?: () => ExecutionStatus): Hono {
  const app = new Hono()
  app.onError(errorHandler)
  if (read !== undefined) bindExecutionAvailability(app, read)
  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/rfc370-v2/execute',
      executionGroup: 'task',
      permissions: [],
      publicReason: 'test-only fixture',
      tokenAccess: 'allow',
      summary: 'RFC-370 v2 gated execution fixture',
    },
    (c) => c.json({ ran: true }),
  )
  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/rfc370-v2/edit',
      permissions: [],
      publicReason: 'test-only fixture',
      tokenAccess: 'allow',
      summary: 'RFC-370 v2 ungated resource fixture',
    },
    (c) => c.json({ saved: true }),
  )
  return app
}

describe('RFC-370 v2 standalone execution authority', () => {
  test('is active from start to exit with a fixed fence', async () => {
    const authority = composeLocalExecutionAuthority()
    expect(authority.mode).toBe('standalone')
    const state = authority.current()
    expect(state).toEqual({ kind: 'active', fence: { epoch: 1, token: 'standalone' } })
    await expect(authority.whenActive()).resolves.toEqual({ epoch: 1, token: 'standalone' })
    let lost = 0
    const unsubscribe = authority.onLost(() => {
      lost += 1
    })
    unsubscribe()
    await authority.close()
    expect(authority.current()).toBe(state)
    expect(lost).toBe(0)
  })

  test('projects every authority state onto the public status', () => {
    expect(executionStatusOf(composeLocalExecutionAuthority())).toEqual({
      mode: 'standalone',
      state: 'active',
      reason: null,
    })
    expect(
      executionStatusOf(hostedAuthority({ kind: 'standby', reason: 'lease-held-elsewhere' })),
    ).toEqual({ mode: 'crewstation', state: 'standby', reason: 'lease-held-elsewhere' })
    expect(executionStatusOf(hostedAuthority({ kind: 'frozen', reason: null }))).toEqual({
      mode: 'crewstation',
      state: 'frozen',
      reason: null,
    })
    expect(
      executionStatusOf(hostedAuthority({ kind: 'active', fence: { epoch: 3, token: 'lease' } })),
    ).toEqual({ mode: 'crewstation', state: 'active', reason: null })
    for (const status of [STANDBY, executionStatusOf(composeLocalExecutionAuthority())])
      expect(ExecutionStatusSchema.parse(status)).toEqual(status)
  })
})

describe('RFC-370 v2 execution availability gate', () => {
  test('an unbound app is a standalone root and is always available', () => {
    const app = new Hono()
    expect(readExecutionStatus(app)).toEqual({ mode: 'standalone', state: 'active', reason: null })
    expect(() => assertExecutionAvailable(app, 'task')).not.toThrow()
  })

  test('only grouped requests are refused while the instance is not active', () => {
    const app = new Hono()
    bindExecutionAvailability(app, () => STANDBY)
    expect(() => assertExecutionAvailable(app, undefined)).not.toThrow()
    let refused: unknown
    try {
      assertExecutionAvailable(app, 'memory')
    } catch (error) {
      refused = error
    }
    expect(refused).toBeInstanceOf(DomainError)
    expect(refused).toMatchObject({
      code: 'execution-standby',
      status: 503,
      details: { group: 'memory', mode: 'crewstation', state: 'standby', reason: 'waiting' },
    })
  })

  test('an app binds exactly one reader', () => {
    const app = new Hono()
    bindExecutionAvailability(app, () => STANDBY)
    expect(() => bindExecutionAvailability(app, () => STANDBY)).toThrow(
      'execution-availability-already-bound',
    )
  })

  test('HTTP: a standby instance refuses execution and keeps resource routes', async () => {
    let status: ExecutionStatus = STANDBY
    const app = gatedApp(() => status)
    const refused = await app.request('/api/rfc370-v2/execute', { method: 'POST' })
    expect(refused.status).toBe(503)
    expect(await refused.json()).toMatchObject({ ok: false, code: 'execution-standby' })
    const edited = await app.request('/api/rfc370-v2/edit', { method: 'POST' })
    expect(edited.status).toBe(200)
    expect(await edited.json()).toEqual({ saved: true })

    status = { mode: 'crewstation', state: 'active', reason: null }
    const ran = await app.request('/api/rfc370-v2/execute', { method: 'POST' })
    expect(ran.status).toBe(200)
    expect(await ran.json()).toEqual({ ran: true })

    status = { mode: 'crewstation', state: 'frozen', reason: 'handover' }
    expect((await app.request('/api/rfc370-v2/execute', { method: 'POST' })).status).toBe(503)
  })

  test('bound operations (MCP) hit the same gate without Hono middleware', async () => {
    const app = gatedApp(() => STANDBY)
    const operation = lookupDeclaredHttpOperation('POST', '/api/rfc370-v2/execute')
    expect(operation).toBeDefined()
    const actor = {
      user: { id: 'u-rfc370', role: 'admin', status: 'active' },
      source: 'daemon',
      permissions: new Set(),
    } as unknown as Actor
    const result = await createBoundOperationInvoker(app, actor)(operation!.id)
    expect(result.status).toBe(503)
    expect(result.body).toMatchObject({ ok: false, code: 'execution-standby' })
  })

  test('GET /api/execution/status reports the bound status, standalone by default', async () => {
    const runtime = { readCurrent: async () => null }
    const standalone = new Hono()
    standalone.onError(errorHandler)
    mountDaemonRoutes(standalone, { runtime })
    const local = await standalone.request('/api/execution/status')
    expect(local.status).toBe(200)
    expect(ExecutionStatusSchema.parse(await local.json())).toEqual({
      mode: 'standalone',
      state: 'active',
      reason: null,
    })

    const hosted = new Hono()
    hosted.onError(errorHandler)
    bindExecutionAvailability(hosted, () => STANDBY)
    mountDaemonRoutes(hosted, { runtime })
    const standby = await hosted.request('/api/execution/status')
    expect(standby.status).toBe(200)
    expect(await standby.json()).toEqual(STANDBY)
  })
})

import { afterEach, describe, expect, test } from 'bun:test'
import { Hono, type MiddlewareHandler } from 'hono'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { buildActor } from '@/auth/actor'
import { loadConfig } from '@/config'
import {
  mountConfigRoutes,
  type ConfigConcurrencyHotApplyInput,
  type ConfigRouteDependencies,
} from '@/routes/config'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function harness(): {
  app: Hono
  configPath: string
  calls: {
    runtimeNames: string[]
    invalidated: string[][]
    reconciled: number
    concurrency: ConfigConcurrencyHotApplyInput[]
  }
} {
  const root = mkdtempSync(join(tmpdir(), 'rfc349-config-route-'))
  roots.push(root)
  const configPath = join(root, 'config.json')
  loadConfig(configPath)
  const calls = {
    runtimeNames: [] as string[],
    invalidated: [] as string[][],
    reconciled: 0,
    concurrency: [] as ConfigConcurrencyHotApplyInput[],
  }
  const deps: ConfigRouteDependencies = {
    configPath,
    runtimeRegistry: {
      async getRuntime(name) {
        calls.runtimeNames.push(name)
        return null
      },
      async invalidateInheritedRuntimeProbeReceipts(protocols) {
        calls.invalidated.push([...protocols])
        return protocols.length
      },
    },
    runtimeTests: {
      async reconcileDurableIntents() {
        calls.reconciled += 1
      },
    },
    concurrencyHotApply: {
      async apply(input) {
        calls.concurrency.push({ ...input })
      },
    },
  }
  const actor = buildActor({
    user: {
      id: 'rfc349-config-admin',
      username: 'rfc349-config-admin',
      displayName: 'RFC-349 Config Admin',
      role: 'admin',
      status: 'active',
    },
    source: 'session',
  })
  const app = new Hono()
  const injectActor: MiddlewareHandler = async (context, next) => {
    context.set('actor', actor)
    await next()
  }
  app.use('*', injectActor)
  mountConfigRoutes(app, deps)
  return { app, configPath, calls }
}

describe('RFC-349 config route provider boundary', () => {
  test('PUT delegates runtime invalidation, MCP reconciliation and concurrency hot apply', async () => {
    const h = harness()
    const response = await h.app.request('/api/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        defaultRuntime: 'rfc349-runtime',
        opencodePath: '/opt/rfc349-opencode',
        maxConcurrentNodes: 9,
        maxConcurrentScriptNodes: 3,
        maxConcurrentCodeHostCalls: 7,
        multiProcessSubprocessConcurrency: 5,
        maxActiveChildTasks: 11,
        maxInvocationDepth: 4,
      }),
    })

    expect(response.status).toBe(200)
    expect(h.calls.runtimeNames).toEqual(['rfc349-runtime'])
    expect(h.calls.invalidated).toEqual([['opencode']])
    expect(h.calls.reconciled).toBe(1)
    expect(h.calls.concurrency).toEqual([
      {
        maxConcurrentNodes: 9,
        maxConcurrentScriptNodes: 3,
        maxConcurrentCodeHostCalls: 7,
        multiProcessSubprocessConcurrency: 5,
        maxActiveChildTasks: 11,
        maxInvocationDepth: 4,
      },
    ])
    expect(loadConfig(h.configPath)).toMatchObject({
      defaultRuntime: 'rfc349-runtime',
      opencodePath: '/opt/rfc349-opencode',
      maxConcurrentNodes: 9,
      maxConcurrentScriptNodes: 3,
      maxConcurrentCodeHostCalls: 7,
      multiProcessSubprocessConcurrency: 5,
      maxActiveChildTasks: 11,
      maxInvocationDepth: 4,
    })
  })

  test('route source owns no provider client or service construction', () => {
    const source = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'routes', 'config.ts'),
      'utf8',
    )
    expect(source).not.toContain("from '@/server'")
    expect(source).not.toContain("from '@/db/client'")
    expect(source).not.toContain('deps.db')
    expect(source).not.toContain('getMcpRuntimeTestService(')
    expect(source).not.toContain('resizeAllNodePools(')
    expect(source).toContain('runtimeRegistry.getRuntime(')
    expect(source).toContain('runtimeRegistry.invalidateInheritedRuntimeProbeReceipts(')
    expect(source).toContain('runtimeTests.reconcileDurableIntents()')
    expect(source).toContain('concurrencyHotApply.apply({')
  })
})

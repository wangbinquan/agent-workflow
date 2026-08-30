// RFC-344 — closed operation catalog and single inbound-root locks.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { Hono } from 'hono'
import type { Actor } from '../src/auth/actor'
import { createBoundOperationInvoker } from '../src/platform/operations/boundOperationInvoker'
import { ALL_TOOLS } from '../src/mcp/tools'
import { MCP_TOOL_BINDINGS } from '../src/mcp/operationBindings'
import {
  operationDependencies,
  operationId,
  lookupDeclaredHttpOperation,
  registerHttpOperationProjection,
  validateOperationCatalogSnapshot,
  type DeclaredHttpOperation,
  type OperationCatalogRouteProjection,
  type OperationCatalogSnapshot,
  type OperationCatalogToolProjection,
  type OperationDescriptorProjection,
} from '../src/platform/operations/catalog'
import { defineQueryOperation } from '../src/platform/operations/definitions'
import { invokeOperation, OperationContractViolation } from '../src/platform/operations/invoke'
import {
  ConflictError,
  DomainError,
  errorHandler,
  NotFoundError,
  ValidationError,
} from '../src/util/errors'
import { registerRoute, registerRouteMiddleware } from '../src/routes/registry'
import { DirectOperationContextFactory } from '../src/modules/identity-access/application/operationContext'
import { directMcpOperationAuthority } from '../src/routes/operationAuthority'
import { createDevelopmentActivityWorkerBinding } from '../src/modules/development-automation/composition/activityOperations'

const ROOT = join(import.meta.dir, '..')

const declaration = Object.freeze({
  id: operationId('rfc344.read-probe.v1'),
  kind: 'query',
  method: 'GET',
  path: '/api/rfc344-probe',
  implementation: 'compatibility',
} satisfies DeclaredHttpOperation)

const route = Object.freeze({
  kind: 'http',
  operationId: declaration.id,
  operationKind: declaration.kind,
  method: declaration.method,
  path: declaration.path,
  tokenAccess: 'allow',
  permissions: Object.freeze([]),
  publicReason: 'rfc344-test-fixture',
  summary: 'Read the RFC-344 probe',
  legacyHttpAdapter: true,
} satisfies OperationCatalogRouteProjection)

const tool = Object.freeze({
  name: 'rfc344_probe',
  title: 'RFC-344 probe',
  description: 'Pure catalog validation fixture',
  permissions: Object.freeze([]),
  binding: Object.freeze({
    kind: 'mcp-direct',
    toolName: 'rfc344_probe',
    operationId: declaration.id,
  }),
} satisfies OperationCatalogToolProjection)

const snapshot = (overrides: Partial<OperationCatalogSnapshot> = {}): OperationCatalogSnapshot => ({
  declarations: [declaration],
  routes: [route],
  tools: [tool],
  ...overrides,
})

describe('RFC-344 closed operation catalog', () => {
  test('accepts a fully closed declaration / route / tool projection', () => {
    expect(() => validateOperationCatalogSnapshot(snapshot())).not.toThrow()
  })

  test('rejects duplicate ids, unknown dependencies and projection drift', () => {
    const duplicate = Object.freeze({ ...declaration, path: '/api/rfc344-duplicate' })
    expect(() =>
      validateOperationCatalogSnapshot(snapshot({ declarations: [declaration, duplicate] })),
    ).toThrow(/duplicate operation ids/)

    const unknown = operationId('rfc344.unknown-probe.v1')
    expect(() =>
      validateOperationCatalogSnapshot(
        snapshot({
          tools: [
            {
              ...tool,
              binding: { ...tool.binding, operationId: unknown },
            },
          ],
        }),
      ),
    ).toThrow(/unknown operation dependency/)

    expect(() =>
      validateOperationCatalogSnapshot(
        snapshot({ routes: [{ ...route, legacyHttpAdapter: false }] }),
      ),
    ).toThrow(/compatibility projection/)
  })

  test('rejects incomplete or wildcard parameterized bindings', () => {
    const parameterized = (selectors: readonly string[]): OperationCatalogToolProjection => ({
      ...tool,
      binding: {
        kind: 'mcp-parameterized',
        toolName: tool.name,
        cases: selectors.map((selector) => ({ selector, operationId: declaration.id })),
      },
    })
    expect(() =>
      validateOperationCatalogSnapshot(snapshot({ tools: [parameterized(['default'])] })),
    ).toThrow(/wildcard\/default selector/)
    expect(() =>
      validateOperationCatalogSnapshot(snapshot({ tools: [parameterized(['list', 'list'])] })),
    ).toThrow(/duplicate parameterized selector/)
  })

  test('rejects context mismatch, unknown public errors, orphan descriptors and admission drift', () => {
    const descriptorDeclaration = {
      ...declaration,
      implementation: 'descriptor' as const,
    }
    const descriptorRoute = { ...route, legacyHttpAdapter: false }
    const descriptor: OperationDescriptorProjection = {
      id: declaration.id,
      kind: 'query',
      contextKind: 'authenticated-query',
      summary: route.summary,
      inputCodec: { name: 'rfc344.probe.input', version: 1 },
      outputCodec: { name: 'rfc344.probe.output', version: 1 },
      publicErrors: ['internal-error'],
      permissions: [],
      publicReason: route.publicReason,
    }
    const described = (overrides: Partial<OperationCatalogSnapshot> = {}) =>
      snapshot({
        declarations: [descriptorDeclaration],
        descriptors: [descriptor],
        routes: [descriptorRoute],
        ...overrides,
      })

    expect(() =>
      validateOperationCatalogSnapshot(
        described({
          descriptors: [{ ...descriptor, contextKind: 'authenticated-command' }],
        }),
      ),
    ).toThrow(/cannot use context/)
    expect(() =>
      validateOperationCatalogSnapshot(
        described({
          descriptors: [
            {
              ...descriptor,
              publicErrors: ['not-a-public-code'] as OperationDescriptorProjection['publicErrors'],
            },
          ],
        }),
      ),
    ).toThrow(/unknown public errors/)
    expect(() =>
      validateOperationCatalogSnapshot(
        described({
          descriptors: [descriptor, { ...descriptor, id: operationId('rfc344.orphan.v1') }],
        }),
      ),
    ).toThrow(/orphan operation descriptor/)
    expect(() =>
      validateOperationCatalogSnapshot(
        described({ tools: [{ ...tool, permissions: ['tasks:execute'] }] }),
      ),
    ).toThrow(/tool admission does not match/)
  })

  test('keeps compatibility MCP admission presentation-owned until descriptor cutover', () => {
    const protectedCompatibilityRoute: OperationCatalogRouteProjection = {
      kind: route.kind,
      operationId: route.operationId,
      operationKind: route.operationKind,
      method: route.method,
      path: route.path,
      tokenAccess: route.tokenAccess,
      permissions: ['tasks:read'],
      summary: route.summary,
      legacyHttpAdapter: route.legacyHttpAdapter,
    }
    expect(() =>
      validateOperationCatalogSnapshot(
        snapshot({
          routes: [protectedCompatibilityRoute],
        }),
      ),
    ).not.toThrow()
  })

  test('all 52 tools have one exact direct, parameterized, composite or local binding', () => {
    const toolNames = ALL_TOOLS.map((entry) => entry.name).sort()
    const bindingNames = Object.keys(MCP_TOOL_BINDINGS).sort()
    expect(toolNames).toHaveLength(52)
    expect(bindingNames).toEqual(toolNames)
    for (const binding of Object.values(MCP_TOOL_BINDINGS)) {
      expect(operationDependencies(binding).length).toBeGreaterThan(0)
      if (binding.kind !== 'mcp-parameterized') continue
      const selectors = binding.cases.map((entry) => entry.selector)
      expect(new Set(selectors).size).toBe(selectors.length)
      expect(selectors).not.toContain('*')
      expect(selectors).not.toContain('default')
    }
  })

  test('legacy declarations keep exact and wildcard route identities distinct', () => {
    const exact = registerHttpOperationProjection({
      method: 'GET',
      path: '/api/rfc344-legacy/:id',
      permissions: [],
      tokenAccess: 'allow',
      summary: 'Read one legacy probe',
    })
    const wildcard = registerHttpOperationProjection({
      method: 'GET',
      path: '/api/rfc344-legacy/:id/*',
      permissions: [],
      tokenAccess: 'allow',
      summary: 'Read a legacy probe path',
    })

    expect(wildcard.operationId).not.toBe(exact.operationId)
    expect(wildcard.operationId).toBe(
      operationId('legacy-http.read-rfc344-legacy-by-id-wildcard.v1'),
    )
  })
})

describe('RFC-344 exact invocation pipeline', () => {
  const operation = (invoke: () => { readonly ok: true }, publicErrors = ['not-found'] as const) =>
    defineQueryOperation({
      id: 'rfc344.invoke-probe.v1',
      summary: 'Invoke pipeline fixture',
      permissions: [],
      publicReason: 'test-only fixture',
      publicErrors,
      inputSchema: z.object({ value: z.string() }).strict(),
      outputSchema: z.object({ ok: z.literal(true) }).strict(),
      invoke,
    })

  test('rejects unknown input fields before invoke and invalid output after invoke', async () => {
    let calls = 0
    await expect(
      invokeOperation(
        operation(() => ({ ok: true })),
        {},
        { value: 'x', extra: true },
      ),
    ).rejects.toBeInstanceOf(ValidationError)
    expect(calls).toBe(0)

    await expect(
      invokeOperation(
        operation(() => {
          calls += 1
          return { ok: true, extra: true }
        }),
        {},
        { value: 'x' },
      ),
    ).rejects.toBeInstanceOf(OperationContractViolation)
    expect(calls).toBe(1)
  })

  test('passes declared error categories and collapses undeclared categories', async () => {
    const notFound = new NotFoundError('probe-not-found', 'missing')
    await expect(
      invokeOperation(
        operation(() => {
          throw notFound
        }),
        {},
        { value: 'x' },
      ),
    ).rejects.toBe(notFound)

    await expect(
      invokeOperation(
        operation(() => {
          throw new ConflictError('probe-conflict', 'conflict')
        }),
        {},
        { value: 'x' },
      ),
    ).rejects.toBeInstanceOf(OperationContractViolation)
  })
})

describe('RFC-344 trusted direct authority', () => {
  test('identity-access mints a branded frozen snapshot instead of exposing the transport Actor', () => {
    const permissions = new Set(['tasks:read'] as const)
    const factory = new DirectOperationContextFactory({ id: () => 'op-1', now: () => 1 })
    const authority = factory.authorityFromAuthenticatedPrincipal({
      user: {
        id: 'u-rfc344',
        username: 'rfc344',
        displayName: 'RFC 344',
        role: 'user',
        status: 'active',
      },
      source: 'pat',
      permissions,
      purpose: 'mcp_only',
      patId: 'pat-rfc344',
      authorityRevision: 7,
    })
    permissions.clear()

    expect(Object.isFrozen(authority)).toBe(true)
    expect(Object.isFrozen(authority.user)).toBe(true)
    expect(authority.userId).toBe('u-rfc344')
    expect(authority.permissions.has('tasks:read')).toBe(true)
    expect(authority.purpose).toBe('mcp_only')
    expect(authority.authorityRevision).toBe(7)
  })
})

describe('RFC-344 direct bound handler invocation', () => {
  test('calls the registered handler chain by id without entering Hono routing', async () => {
    const app = new Hono()
    app.use('*', () => {
      throw new Error('global Hono dispatch must not run')
    })
    registerRoute(
      app,
      {
        method: 'POST',
        path: '/api/rfc344-bound/:id',
        permissions: [],
        publicReason: 'test-only fixture',
        tokenAccess: 'allow',
        summary: 'Direct bound handler fixture',
      },
      async (context) =>
        context.json({
          id: context.req.param('id'),
          query: context.req.query('q'),
          body: await context.req.json(),
        }),
    )
    const operation = lookupDeclaredHttpOperation('POST', '/api/rfc344-bound/:id')
    expect(operation).toBeDefined()
    const actor = {
      user: { id: 'u-rfc344', role: 'admin', status: 'active' },
      source: 'pat',
      purpose: 'mcp_only',
      permissions: new Set(),
    } as unknown as Actor
    const authority = directMcpOperationAuthority(
      new DirectOperationContextFactory({ id: () => 'op-mcp', now: () => 1 }),
      actor,
    )
    const result = await createBoundOperationInvoker(app, authority)(operation!.id, {
      params: { id: 'a/b' },
      query: { q: 'value' },
      body: { exact: true },
    })
    expect(result).toEqual({
      status: 200,
      body: { id: 'a/b', query: 'value', body: { exact: true } },
      auditSnapshot: undefined,
    })
  })

  test('preserves route-owned middleware without entering the HTTP router', async () => {
    const app = new Hono()
    const order: string[] = []
    registerRouteMiddleware(app, '/api/rfc344-owned/:id/*', async (_context, next) => {
      order.push('middleware')
      await next()
    })
    registerRoute(
      app,
      {
        method: 'GET',
        path: '/api/rfc344-owned/:id/detail',
        permissions: [],
        publicReason: 'rfc344-test-fixture',
        tokenAccess: 'allow',
        summary: 'Route-owned middleware fixture',
      },
      (context) => {
        order.push('handler')
        return context.json({ id: context.req.param('id') })
      },
    )
    const operation = lookupDeclaredHttpOperation('GET', '/api/rfc344-owned/:id/detail')!
    const actor = {
      user: { id: 'u-rfc344', role: 'admin', status: 'active' },
      source: 'daemon',
      permissions: new Set(),
    } as unknown as Actor
    const result = await createBoundOperationInvoker(app, actor)(operation.id, {
      params: { id: 'owned' },
    })
    expect(order).toEqual(['middleware', 'handler'])
    expect(result.body).toEqual({ id: 'owned' })
  })

  test('preserves the existing 404/409/410/412 error wire on both adapters', async () => {
    const app = new Hono()
    registerRoute(
      app,
      {
        method: 'GET',
        path: '/api/rfc344-error/:status',
        permissions: [],
        publicReason: 'rfc344-test-fixture',
        tokenAccess: 'allow',
        summary: 'Error parity fixture',
      },
      (context) => {
        const status = Number(context.req.param('status')) as 404 | 409 | 410 | 412
        throw new DomainError(`probe-${status}`, `probe ${status}`, status, {
          status,
        })
      },
    )
    app.onError(errorHandler)
    const operation = lookupDeclaredHttpOperation('GET', '/api/rfc344-error/:status')!
    const actor = {
      user: { id: 'u-rfc344', role: 'admin', status: 'active' },
      source: 'daemon',
      permissions: new Set(),
    } as unknown as Actor
    const invoke = createBoundOperationInvoker(app, actor)

    for (const status of [404, 409, 410, 412] as const) {
      const http = await app.request(`/api/rfc344-error/${status}`)
      const direct = await invoke(operation.id, { params: { status } })
      expect(direct.status).toBe(status)
      expect(direct.body).toEqual(await http.json())
    }
  })
})

describe('RFC-344 bootstrap-owned development activity participant', () => {
  test('fails closed before binding and accepts exactly one runtime worker', async () => {
    const binding = createDevelopmentActivityWorkerBinding()
    await expect(binding.operations.runOneWorkerCycle()).rejects.toThrow(
      'development-activity-worker-not-bound',
    )

    binding.bind({
      publishOneChannelResult: () => 'idle',
      runOneOutbox: async () => 'idle',
      pumpOneDelivery: () => false,
      planOneReaction: () => null,
      inspectOneExecution: async () => 'completed',
    })

    await expect(binding.operations.runOneWorkerCycle()).resolves.toEqual({
      activity: 'execution',
      state: 'completed',
    })
    expect(() =>
      binding.bind({
        publishOneChannelResult: () => 'idle',
        runOneOutbox: async () => 'idle',
        pumpOneDelivery: () => false,
        planOneReaction: () => null,
        inspectOneExecution: async () => 'idle',
      }),
    ).toThrow('development-activity-worker-already-bound')
  })
})

describe('RFC-344 single inbound root source locks', () => {
  test('the legacy dispatcher and private Hono root cannot return', () => {
    expect(existsSync(join(ROOT, 'src/mcp/dispatch.ts'))).toBe(false)
    expect(existsSync(join(ROOT, 'src/platform/operations/httpOperationInvoker.ts'))).toBe(false)

    const server = readFileSync(join(ROOT, 'src/mcp/server.ts'), 'utf8')
    expect(server).not.toContain("from '@/server'")
    expect(server).not.toContain('mountApiRoutes')
    expect(server).not.toContain('createApp(')
    expect(server).not.toContain('new Hono')
    expect(server).not.toContain('app.request(')

    const invoker = readFileSync(
      join(ROOT, 'src/platform/operations/boundOperationInvoker.ts'),
      'utf8',
    )
    expect(invoker).not.toContain('.request(')
    expect(invoker).not.toContain('mountApiRoutes')
    expect(invoker).toContain('registerBoundOperationHandler')
    expect(invoker).toContain('registerBoundOperationMiddleware')

    const tasks = readFileSync(join(ROOT, 'src/routes/tasks.ts'), 'utf8')
    expect(tasks).not.toContain("app.use('/api/tasks/:id")
    expect(tasks.match(/registerRouteMiddleware\s*\(/g)).toHaveLength(2)
  })

  test('tool handlers cannot select HTTP methods or URL templates', () => {
    const tools = readFileSync(join(ROOT, 'src/mcp/tools.ts'), 'utf8')
    expect(tools).not.toContain('ctx.dispatch')
    expect(tools).not.toMatch(/path:\s*['"]\/api\//)
    expect(tools).not.toMatch(/method:\s*['"](?:GET|POST|PUT|PATCH|DELETE)['"]/)
  })

  test('API docs read only the operation projections', () => {
    const docs = readFileSync(join(ROOT, 'src/services/apiDocs.ts'), 'utf8')
    expect(docs).not.toContain("from '@/routes/registry'")
    expect(docs).not.toContain("from '@/mcp/tools'")
    expect(docs).toContain("from '@/platform/operations/catalog'")
  })

  test('development pilots receive trusted authority and the daemon composes one automation root', () => {
    for (const relative of [
      'src/modules/development-automation/application/activityOperations.ts',
      'src/modules/development-automation/application/configOperations.ts',
      'src/modules/development-automation/application/missionOperations.ts',
    ]) {
      expect(readFileSync(join(ROOT, relative), 'utf8')).not.toContain("from '@/auth/actor'")
    }

    const authority = readFileSync(join(ROOT, 'src/routes/operationAuthority.ts'), 'utf8')
    expect(authority).toContain('authorityFromAuthenticatedPrincipal')
    expect(authority).toContain('directMcpOperationAuthority')

    const server = readFileSync(join(ROOT, 'src/server.ts'), 'utf8')
    expect(server).toContain('directMcpOperationAuthority(identityAccess.contexts, actor)')

    const start = readFileSync(join(ROOT, 'src/cli/start.ts'), 'utf8')
    expect(start.match(/composeDevelopmentAutomation\s*\(/g)).toHaveLength(1)
    expect(start).toContain('developmentAutomation,')

    expect(server).toContain('automation: developmentAutomation')

    const missionComposition = readFileSync(
      join(ROOT, 'src/modules/development-automation/composition/missionOperations.ts'),
      'utf8',
    )
    expect(missionComposition).toContain('readonly automation: DevelopmentAutomationModule')
    expect(missionComposition).toContain('const automation = deps.automation')
    expect(missionComposition).not.toContain('composeDevelopmentAutomation(')
    expect(missionComposition).not.toMatch(
      /from '@\/modules\/(?:integration|source-control|task-execution)\//,
    )

    const configComposition = readFileSync(
      join(ROOT, 'src/modules/development-automation/composition/configOperations.ts'),
      'utf8',
    )
    expect(configComposition).toContain('developmentAdapter: DevelopmentConfigResourceOperations')
    expect(configComposition).not.toContain("from '@/modules/integration/")

    const terminalObserver = readFileSync(
      join(ROOT, 'src/modules/development-automation/composition/executionTerminalObserver.ts'),
      'utf8',
    )
    expect(terminalObserver).toContain('missionIdOfExecutionRef')
    expect(terminalObserver).toContain('recordWakeHint')
    expect(terminalObserver).not.toContain("from '@/modules/task-execution/")

    const adapterComposition = readFileSync(
      join(ROOT, 'src/modules/integration/composition/developmentAdapterConfigOperations.ts'),
      'utf8',
    )
    expect(adapterComposition).toContain('composeDevelopmentAdapterConfigOperations')
    expect(adapterComposition).not.toContain("from '@/modules/development-automation/")
  })

  test('pilot transport adapters depend on the narrow database port, not the composition root', () => {
    for (const relative of [
      'src/routes/developmentConfig.ts',
      'src/routes/digitalEmployees.ts',
      'src/routes/resourceAcl.ts',
    ]) {
      const source = readFileSync(join(ROOT, relative), 'utf8')
      expect(source).not.toContain("from '@/server'")
      expect(source).not.toContain('AppDeps')
      expect(source).toContain('DbClient')
    }
  })
})

// RFC-616 §5.4 — recording human operations at the route registry.
//
// Locks the one new write channel of process metrics: a route that declares
// `observe` has its successful calls recorded by the registry, for HTTP and for
// bound (MCP) invocations alike; a failed call, an undeclared route, an app
// without a sink and the daemon's own calls record nothing; and recording can
// never change the outcome of the operation it observes. Also locks, at source
// level, the nineteen routes that declare an operation.
import { describe, expect, test } from 'bun:test'
import { Hono, type MiddlewareHandler } from 'hono'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROCESS_OPERATION_ACTIONS } from '@agent-workflow/shared'
import { buildActor, type Actor } from '@/auth/actor'
import { ConflictError, errorHandler } from '@/platform/errors/domainErrors'
import { createBoundOperationInvoker } from '@/platform/operations/boundOperationInvoker'
import { lookupDeclaredHttpOperation } from '@/platform/operations/catalog'
import {
  attachRouteOperationSink,
  registerRoute,
  RouteMetaError,
  type RouteObservation,
  type RouteOperationRecord,
} from '@/routes/registry'

const admin = buildActor({
  user: { id: 'u-alice', username: 'alice', displayName: 'Alice', role: 'admin', status: 'active' },
  source: 'session',
})

function appWith(actor: Actor | null, records: RouteOperationRecord[] | null): Hono {
  const app = new Hono()
  if (actor !== null) {
    const inject: MiddlewareHandler = async (c, next) => {
      c.set('actor', actor)
      await next()
    }
    app.use('*', inject)
  }
  app.onError(errorHandler)
  if (records !== null) {
    attachRouteOperationSink(app, {
      record: async (operation) => {
        records.push(operation)
      },
    })
  }
  return app
}

const OBSERVE: RouteObservation = {
  action: 'task.resume',
  subject: { kind: 'task', param: 'id' },
  mode: 'each',
}

/** A route per test keeps the process-wide registry free of conflicting redeclarations. */
function route(
  app: Hono,
  name: string,
  handler: Parameters<typeof registerRoute>[2],
  // null: the route declares nothing. (An explicit `undefined` would take the default.)
  observe: RouteObservation | null = OBSERVE,
): string {
  const path = `/api/rfc616-ops/${name}/:id`
  registerRoute(
    app,
    {
      method: 'POST',
      path,
      ...(observe === null ? {} : { observe }),
      permissions: ['tasks:execute'],
      tokenAccess: 'allow',
      summary: `rfc616 test route ${name}`,
    },
    handler,
  )
  return path.replace(':id', 'task-9')
}

describe('RFC-616 route operations over HTTP', () => {
  test('a successful call of an observed route is recorded', async () => {
    const records: RouteOperationRecord[] = []
    const app = appWith(admin, records)
    const url = route(app, 'ok', (c) => c.json({ resumed: true }))
    const before = Date.now()
    const response = await app.request(url, { method: 'POST' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ resumed: true })
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      action: 'task.resume',
      subjectKind: 'task',
      subjectId: 'task-9',
      mode: 'each',
      actorUserId: 'u-alice',
      transport: 'http',
    })
    expect(records[0]!.at).toBeGreaterThanOrEqual(before)
    expect(records[0]!.at).toBeLessThanOrEqual(Date.now())
  })

  test('a failed call is not recorded: error status, thrown error, refused by the gate', async () => {
    const records: RouteOperationRecord[] = []
    const app = appWith(admin, records)
    const notFound = route(app, 'status', (c) => c.json({ ok: false }, 404))
    const thrown = route(app, 'thrown', () => {
      throw new ConflictError('task-not-resumable', 'task cannot be resumed')
    })
    expect((await app.request(notFound, { method: 'POST' })).status).toBe(404)
    const conflict = await app.request(thrown, { method: 'POST' })
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ code: 'task-not-resumable' })

    const stranger = appWith({ ...admin, permissions: new Set() } as Actor, records)
    const refused = route(stranger, 'refused', (c) => c.json({ resumed: true }))
    expect((await stranger.request(refused, { method: 'POST' })).status).toBe(403)
    expect(records).toEqual([])
  })

  test('a route that declares nothing records nothing', async () => {
    const records: RouteOperationRecord[] = []
    const app = appWith(admin, records)
    const url = route(app, 'plain', (c) => c.json({ ok: true }), null)
    expect((await app.request(url, { method: 'POST' })).status).toBe(200)
    expect(records).toEqual([])
  })

  test('an app without a sink serves the route and records nothing', async () => {
    const app = appWith(admin, null)
    const url = route(app, 'no-sink', (c) => c.json({ ok: true }))
    const response = await app.request(url, { method: 'POST' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  })

  test('a recording failure never changes the response', async () => {
    const app = appWith(admin, null)
    let attempts = 0
    attachRouteOperationSink(app, {
      record: async () => {
        attempts++
        throw new Error('database is read-only')
      },
    })
    const url = route(app, 'sink-fails', (c) => c.json({ resumed: true }, 201))
    const response = await app.request(url, { method: 'POST' })
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ resumed: true })
    expect(attempts).toBe(1)
  })

  test("the daemon's own calls and calls without an identity are not a person's", async () => {
    const records: RouteOperationRecord[] = []
    const daemon = appWith({ ...admin, source: 'daemon' } as Actor, records)
    const url = route(daemon, 'daemon', (c) => c.json({ ok: true }))
    expect((await daemon.request(url, { method: 'POST' })).status).toBe(200)

    const anonymous = appWith(null, records)
    registerRoute(
      anonymous,
      {
        method: 'POST',
        path: '/api/rfc616-ops/public/:id',
        observe: OBSERVE,
        permissions: [],
        publicReason: 'test route that answers before any identity exists',
        tokenAccess: 'allow',
        summary: 'rfc616 public test route',
      },
      (c) => c.json({ ok: true }),
    )
    expect(
      (await anonymous.request('/api/rfc616-ops/public/task-9', { method: 'POST' })).status,
    ).toBe(200)
    expect(records).toEqual([])
  })

  test('a session operation is handed over with its mode and subject kind', async () => {
    const records: RouteOperationRecord[] = []
    const app = appWith(admin, records)
    const url = route(app, 'view', (c) => c.json({ ok: true }), {
      action: 'review.view',
      subject: { kind: 'node-run', param: 'id' },
      mode: 'session',
    })
    await app.request(url, { method: 'POST' })
    expect(records[0]).toMatchObject({
      action: 'review.view',
      subjectKind: 'node-run',
      subjectId: 'task-9',
      mode: 'session',
    })
  })
})

describe('RFC-616 route operations over bound (MCP) invocations', () => {
  test('the same declaration covers a bound invocation, marked as mcp', async () => {
    const records: RouteOperationRecord[] = []
    const app = appWith(null, records)
    route(app, 'bound-ok', (c) => c.json({ resumed: c.req.param('id') }))
    const operation = lookupDeclaredHttpOperation('POST', '/api/rfc616-ops/bound-ok/:id')
    expect(operation).toBeDefined()
    const result = await createBoundOperationInvoker(app, admin)(operation!.id, {
      params: { id: 'task-42' },
    })
    expect(result).toMatchObject({ status: 200, body: { resumed: 'task-42' } })
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      action: 'task.resume',
      subjectId: 'task-42',
      actorUserId: 'u-alice',
      transport: 'mcp',
    })
  })

  test('a bound invocation that fails records nothing', async () => {
    const records: RouteOperationRecord[] = []
    const app = appWith(null, records)
    route(app, 'bound-thrown', () => {
      throw new ConflictError('task-not-resumable', 'task cannot be resumed')
    })
    route(app, 'bound-status', (c) => c.json({ ok: false }, 422))
    const invoke = createBoundOperationInvoker(app, admin)
    const thrown = await invoke(
      lookupDeclaredHttpOperation('POST', '/api/rfc616-ops/bound-thrown/:id')!.id,
      { params: { id: 'task-1' } },
    )
    expect(thrown.status).toBe(409)
    const status = await invoke(
      lookupDeclaredHttpOperation('POST', '/api/rfc616-ops/bound-status/:id')!.id,
      { params: { id: 'task-1' } },
    )
    expect(status.status).toBe(422)
    expect(records).toEqual([])
  })
})

describe('RFC-616 route declarations', () => {
  test('the sink is bound once per app', () => {
    const app = new Hono()
    const sink = { record: async () => {} }
    attachRouteOperationSink(app, sink)
    expect(() => attachRouteOperationSink(app, sink)).toThrow('route-operation-sink-already-bound')
  })

  test('the subject parameter must be a parameter of the path', () => {
    expect(() =>
      registerRoute(
        new Hono(),
        {
          method: 'POST',
          path: '/api/rfc616-ops/wrong-param/:id',
          observe: { ...OBSERVE, subject: { kind: 'task', param: 'taskId' } },
          permissions: ['tasks:execute'],
          tokenAccess: 'allow',
          summary: 'rfc616 wrong parameter',
        },
        (c) => c.json({}),
      ),
    ).toThrow(RouteMetaError)
  })

  test('the same declaration may be registered again; a different observation may not', () => {
    const declare = (observe: RouteObservation | undefined) =>
      registerRoute(
        new Hono(),
        {
          method: 'POST',
          path: '/api/rfc616-ops/redeclared/:id',
          ...(observe === undefined ? {} : { observe }),
          permissions: ['tasks:execute'],
          tokenAccess: 'allow',
          summary: 'rfc616 redeclared',
        },
        (c) => c.json({}),
      )
    declare({ ...OBSERVE, subject: { ...OBSERVE.subject } })
    // Every app build creates fresh declaration objects: equal content must be accepted.
    expect(() => declare({ ...OBSERVE, subject: { ...OBSERVE.subject } })).not.toThrow()
    expect(() => declare({ ...OBSERVE, action: 'task.cancel' })).toThrow(RouteMetaError)
    expect(() => declare({ ...OBSERVE, mode: 'session' })).toThrow(RouteMetaError)
    expect(() => declare({ ...OBSERVE, subject: { kind: 'node-run', param: 'id' } })).toThrow(
      RouteMetaError,
    )
    expect(() => declare(undefined)).toThrow(RouteMetaError)
  })
})

const MODULES = join(import.meta.dir, '../src/modules')
const DECLARED: readonly (readonly [
  file: string,
  method: string,
  path: string,
  action: string,
  kind: string,
  param: string,
  mode: string,
])[] = [
  [
    'collaboration/inbound/http/reviewRoutes.ts',
    'GET',
    '/api/reviews/:nodeRunId',
    'review.view',
    'node-run',
    'nodeRunId',
    'session',
  ],
  [
    'collaboration/inbound/http/reviewRoutes.ts',
    'POST',
    '/api/reviews/:nodeRunId/comments',
    'review.comment',
    'node-run',
    'nodeRunId',
    'each',
  ],
  [
    'collaboration/inbound/http/clarifyRoutes.ts',
    'GET',
    '/api/clarify/:nodeRunId',
    'clarify.view',
    'node-run',
    'nodeRunId',
    'session',
  ],
  [
    'collaboration/inbound/http/clarifyRoutes.ts',
    'POST',
    '/api/clarify/:nodeRunId/followup',
    'clarify.followup',
    'node-run',
    'nodeRunId',
    'each',
  ],
  [
    'task-execution/inbound/http/taskRoutes.ts',
    'POST',
    '/api/tasks/:id/cancel',
    'task.cancel',
    'task',
    'id',
    'each',
  ],
  [
    'task-execution/inbound/http/taskRoutes.ts',
    'POST',
    '/api/tasks/:id/resume',
    'task.resume',
    'task',
    'id',
    'each',
  ],
  [
    'task-execution/inbound/http/taskRoutes.ts',
    'POST',
    '/api/tasks/:id/nodes/:nodeRunId/retry',
    'task.retry-node',
    'task',
    'id',
    'each',
  ],
  [
    'task-execution/inbound/http/taskRoutes.ts',
    'POST',
    '/api/tasks/:id/alerts/:alertId/repair',
    'task.repair',
    'task',
    'id',
    'each',
  ],
  [
    'task-execution/inbound/http/taskRoutes.ts',
    'POST',
    '/api/tasks/:id/sync-workflow',
    'task.sync-workflow',
    'task',
    'id',
    'each',
  ],
  [
    'collaboration/inbound/http/taskQuestionRoutes.ts',
    'POST',
    '/api/tasks/:id/questions/dispatch',
    'question.dispatch',
    'task',
    'id',
    'each',
  ],
  [
    'collaboration/inbound/http/taskQuestionRoutes.ts',
    'POST',
    '/api/tasks/:id/questions/manual',
    'question.manual',
    'task',
    'id',
    'each',
  ],
  [
    'resource-catalog/inbound/http/workgroupTaskRoutes.ts',
    'POST',
    '/api/workgroup-tasks/:taskId/messages',
    'workgroup.message',
    'task',
    'taskId',
    'each',
  ],
  [
    'resource-catalog/inbound/http/workgroupTaskRoutes.ts',
    'POST',
    '/api/workgroup-tasks/:taskId/assignments/:id/deliver',
    'workgroup.deliver',
    'task',
    'taskId',
    'each',
  ],
  [
    'resource-catalog/inbound/http/workgroupTaskRoutes.ts',
    'POST',
    '/api/workgroup-tasks/:taskId/confirm',
    'workgroup.confirm',
    'task',
    'taskId',
    'each',
  ],
  [
    'resource-catalog/inbound/http/workgroupTaskRoutes.ts',
    'POST',
    '/api/workgroup-tasks/:taskId/dw-confirm',
    'workgroup.plan-confirm',
    'task',
    'taskId',
    'each',
  ],
  [
    'resource-catalog/inbound/http/workgroupTaskRoutes.ts',
    'POST',
    '/api/workgroup-tasks/:taskId/assignments/:id/cancel',
    'workgroup.cancel-assignment',
    'task',
    'taskId',
    'each',
  ],
  [
    'resource-catalog/inbound/http/workgroupTaskRoutes.ts',
    'PUT',
    '/api/workgroup-tasks/:taskId/config',
    'workgroup.config',
    'task',
    'taskId',
    'each',
  ],
  [
    'digital-employee/inbound/http/digitalEmployeeRoutes.ts',
    'POST',
    '/api/employee-cases/:id/resume',
    'employee-case.resume',
    'employee-case',
    'id',
    'each',
  ],
  [
    'digital-employee/inbound/http/digitalEmployeeRoutes.ts',
    'POST',
    '/api/employee-cases/:id/terminate',
    'employee-case.terminate',
    'employee-case',
    'id',
    'each',
  ],
]

describe('RFC-616 observable routes (source level)', () => {
  const sources = new Map<string, string>()
  const sourceOf = (file: string) => {
    if (!sources.has(file)) sources.set(file, readFileSync(join(MODULES, file), 'utf8'))
    return sources.get(file)!
  }

  test.each(DECLARED)('%s %s %s declares %s', (file, method, path, action, kind, param, mode) => {
    const lines = sourceOf(file).split('\n')
    const at = lines.findIndex((line) => line.trim() === `path: '${path}',`)
    expect(at, `${method} ${path} is registered in ${file}`).toBeGreaterThan(-1)
    expect(lines.slice(Math.max(0, at - 4), at).join('\n')).toContain(`method: '${method}'`)
    // The declaration follows `path:`: route discovery reads the text before it.
    // Whitespace and trailing commas depend on whether the formatter kept it on one line.
    const after = lines
      .slice(at + 1, at + 7)
      .join('\n')
      .replace(/\s+/g, ' ')
      .replace(/, }/g, ' }')
    expect(after).toContain(
      `observe: { action: '${action}', subject: { kind: '${kind}', param: '${param}' }, mode: '${mode}' }`,
    )
    expect(lines.slice(Math.max(0, at - 4), at).join('\n')).not.toContain('observe')
  })

  test('every operation action is declared by exactly one route, and no other route observes', () => {
    expect(DECLARED.map((entry) => entry[3]).sort()).toEqual([...PROCESS_OPERATION_ACTIONS].sort())
    let declarations = 0
    for (const file of new Set(DECLARED.map((entry) => entry[0])))
      declarations += sourceOf(file).split('observe: {').length - 1
    expect(declarations).toBe(DECLARED.length)
  })
})

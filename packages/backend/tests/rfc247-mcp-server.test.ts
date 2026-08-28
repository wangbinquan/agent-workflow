// RFC-247 §4 / AC-10 / AC-13 / AC-16 — the MCP channel.
//
// The claim this file has to defend is that MCP is a SUBSET of REST, not a
// second door with its own opinions. Three ways that claim could quietly become
// false, one describe block each:
//
//   1. a tool reaches a capability the token's matrix does not grant
//   2. a tool bypasses a handler-level rule (delete confirmation, ACL, payload
//      validation) by calling a service directly
//   3. `tools/list` advertises something the token cannot actually call
//
// The dispatcher exists precisely so (1) and (2) are structurally impossible;
// these tests are what tells us it stayed that way.

import { describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DEFAULT_CONFIG, type Permission, type WorkflowInput } from '@agent-workflow/shared'
import { buildActor, type Actor } from '../src/auth/actor'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createDispatcher, mcpDispatchActor } from '../src/mcp/dispatch'
import { createCollaborationCommandContext } from '../src/modules/collaboration/composition'
import { composeTaskExecutionRuntime } from '../src/modules/task-execution/composition/taskExecutionRuntime'
import {
  ALL_TOOLS,
  describeCapabilities,
  describeResource,
  MCP_RESOURCE_KINDS,
  toolsFor,
} from '../src/mcp/tools'
import { MATRIX_RESOURCES } from '@agent-workflow/shared'
import { KINDS_WITH_BODY_SCHEMAS } from '../src/mcp/resourceSchemas'
import { createApp } from '../src/server'
import { createRuntime } from '../src/services/runtimeRegistry'
import { createUser } from '../src/services/users'

/** Keep this test independent of the operator's locally configured runtimes. */
const TEST_RUNTIME = 'rfc247-test-opencode'

const AGENT_BODY = {
  description: 'created over the MCP channel',
  outputs: ['result'],
  bodyMd: 'noop',
  runtime: TEST_RUNTIME,
}

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const DAEMON_TOKEN = 'a'.repeat(64)

function configPath(mcpSurfaceEnabled = true): string {
  const path = join(mkdtempSync(join(tmpdir(), 'aw-rfc247-mcp-')), 'config.json')
  writeFileSync(path, JSON.stringify({ ...DEFAULT_CONFIG, mcpSurfaceEnabled }))
  return path
}

interface Harness {
  db: DbClient
  deps: Parameters<typeof createDispatcher>[0]
  userId: string
}

async function harness(role: 'admin' | 'user' = 'admin'): Promise<Harness> {
  const db = createInMemoryDb(MIGRATIONS, { bootstrap: 'ready' })
  await createRuntime(db, { name: TEST_RUNTIME, protocol: 'opencode', model: 'openai/gpt-5.6' })
  const user = await createUser(db, {
    username: 'alice',
    displayName: 'Alice',
    role,
    password: 'pw12345678',
  })
  const taskExecutionRuntime = composeTaskExecutionRuntime({ db })
  return {
    db,
    userId: user.id,
    deps: {
      token: DAEMON_TOKEN,
      configPath: configPath(),
      opencodeVersion: null,
      dbVersion: 1,
      db,
      secretBox: createSecretBoxFromKey(randomBytes(32)),
      schedulerDriver: taskExecutionRuntime.schedulerDriver,
      taskExecutionReadModels: taskExecutionRuntime.readModels,
      collaborationContext: createCollaborationCommandContext({
        db,
        taskExecutionReadModels: taskExecutionRuntime.readModels,
      }),
    },
  }
}

function tokenActor(
  h: Harness,
  matrix: ReadonlyArray<Permission>,
  role: 'admin' | 'user' = 'admin',
): Actor {
  return buildActor({
    user: { id: h.userId, username: 'alice', displayName: 'Alice', role, status: 'active' },
    source: 'pat',
    patScopes: matrix,
    patPurpose: 'mcp_only',
  })
}

describe('RFC-247 — the dispatcher runs the real route table', () => {
  test('a tool call is gated by the token matrix, exactly as REST would be', async () => {
    const h = await harness()
    const dispatch = createDispatcher(h.deps)

    // No `agents:create` in the matrix, even though the OWNER is an admin.
    const readOnly = mcpDispatchActor(tokenActor(h, []))
    const refused = await dispatch(
      { method: 'POST', path: '/api/agents', body: { ...AGENT_BODY, name: 'x' } },
      readOnly,
    )
    expect(refused.status).toBe(403)
    expect((refused.body as { code: string }).code).toBe('forbidden')

    // …and the same call with the point ticked goes through, so the refusal
    // above is the matrix rather than a broken dispatcher.
    const creator = mcpDispatchActor(tokenActor(h, ['agents:create']))
    const created = await dispatch(
      {
        method: 'POST',
        path: '/api/agents',
        body: { ...AGENT_BODY, name: 'mcp-made-agent' },
      },
      creator,
    )
    expect(created.status).toBe(201)
  })

  test('reads work with an empty matrix — reads are always on (D3)', async () => {
    const h = await harness()
    const dispatch = createDispatcher(h.deps)
    const res = await dispatch(
      { method: 'GET', path: '/api/agents' },
      mcpDispatchActor(tokenActor(h, [])),
    )
    expect(res.status).toBe(200)
  })

  test('delete still demands its type-to-confirm body over MCP', async () => {
    // The confirmation lives in the ROUTE HANDLER. A tool that called
    // `services/agents.ts` directly would skip it entirely and delete on the
    // first try — this is the single clearest example of why dispatch goes
    // through the route table.
    const h = await harness()
    const dispatch = createDispatcher(h.deps)
    const actor = mcpDispatchActor(tokenActor(h, ['agents:create', 'agents:delete']))

    const created = await dispatch(
      {
        method: 'POST',
        path: '/api/agents',
        body: { ...AGENT_BODY, name: 'doomed-agent' },
      },
      actor,
    )
    expect(created.status).toBe(201)
    const id = (created.body as { id: string }).id

    // Agent deletes are ALSO fenced on the revision (RFC-231): read it back so
    // the confirmation is the only thing under test here.
    const fetched = (await dispatch({ method: 'GET', path: `/api/agents/${id}` }, actor)).body as {
      updatedAt: number
      aclRevision: number
    }
    const fence = {
      expectedUpdatedAt: fetched.updatedAt,
      expectedAclRevision: fetched.aclRevision,
    }

    const noConfirm = await dispatch(
      { method: 'DELETE', path: `/api/agents/${id}`, body: fence },
      actor,
    )
    expect(noConfirm.status).toBe(422)
    expect((noConfirm.body as { code: string }).code).toBe('delete-confirm-required')

    const wrongConfirm = await dispatch(
      { method: 'DELETE', path: `/api/agents/${id}`, body: { ...fence, confirm: 'not-the-name' } },
      actor,
    )
    expect(wrongConfirm.status).toBe(422)
    expect((wrongConfirm.body as { code: string }).code).toBe('delete-confirm-mismatch')

    // Still there after two refused attempts.
    expect((await dispatch({ method: 'GET', path: `/api/agents/${id}` }, actor)).status).toBe(200)

    const ok = await dispatch(
      { method: 'DELETE', path: `/api/agents/${id}`, body: { ...fence, confirm: 'doomed-agent' } },
      actor,
    )
    expect(ok.status).toBe(204)
  })

  test('payload validation is the route’s, not a second copy', async () => {
    const h = await harness()
    const dispatch = createDispatcher(h.deps)
    const res = await dispatch(
      { method: 'POST', path: '/api/agents', body: { ...AGENT_BODY } },
      mcpDispatchActor(tokenActor(h, ['agents:create'])),
    )
    expect(res.status).toBe(422)
  })

  test('an unknown path answers 404 rather than falling through ungated', async () => {
    const h = await harness()
    const dispatch = createDispatcher(h.deps)
    const res = await dispatch(
      { method: 'GET', path: '/api/not-a-real-endpoint' },
      mcpDispatchActor(tokenActor(h, [])),
    )
    expect(res.status).toBe(404)
  })
})

describe('RFC-247 D2 — the purpose gate does not fire on its own channel', () => {
  test('an mcp_only token dispatches fine through the MCP path', async () => {
    const h = await harness()
    const dispatch = createDispatcher(h.deps)
    const actor = tokenActor(h, [])
    expect(actor.purpose).toBe('mcp_only')
    const res = await dispatch({ method: 'GET', path: '/api/agents' }, mcpDispatchActor(actor))
    expect(res.status).toBe(200)
  })

  test('the SAME token is refused on the REST app', async () => {
    // The two halves of D2 in one place: the purpose gate is about which door,
    // and this proves both doors read the field the way they should.
    const h = await harness()
    const app = createApp(h.deps)
    const { createPat } = await import('../src/auth/patStore')
    const { token } = await createPat({
      db: h.db,
      userId: h.userId,
      name: 'mcp-only',
      scopes: [],
      purpose: 'mcp_only',
    })
    const res = await app.request('/api/agents', {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { code: string }).code).toBe('token-mcp-only')
  })

  test('mcpDispatchActor clears purpose and NOTHING else', async () => {
    const h = await harness()
    const actor = tokenActor(h, ['agents:create'])
    const dispatchActor = mcpDispatchActor(actor)
    expect(dispatchActor.purpose).toBeUndefined()
    expect(dispatchActor.source).toBe('pat')
    expect(dispatchActor.user).toEqual(actor.user)
    // The authority is identical — this is the line that would turn a channel
    // adapter into a privilege escalation if someone "fixed" it later.
    expect([...dispatchActor.permissions].sort()).toEqual([...actor.permissions].sort())
  })
})

describe('RFC-247 D10 — tools/list reflects the matrix', () => {
  test('a read-only token sees the read tools and none of the mutating ones', async () => {
    const h = await harness()
    const names = toolsFor(tokenActor(h, [])).map((t) => t.name)
    expect(names).toContain('get_task')
    expect(names).toContain('resource_read')
    expect(names).toContain('describe_capabilities')
    expect(names).not.toContain('launch_task')
    expect(names).not.toContain('cancel_task')
    expect(names).not.toContain('delete_task')
  })

  test('a task-automation token gains the task verbs but not delete', async () => {
    const h = await harness()
    const names = toolsFor(tokenActor(h, ['tasks:execute'])).map((t) => t.name)
    expect(names).toContain('launch_task')
    expect(names).toContain('cancel_task')
    expect(names).toContain('retry_node')
    expect(names).not.toContain('delete_task')
  })

  test('delete_task appears only when tasks:delete is ticked', async () => {
    const h = await harness()
    expect(toolsFor(tokenActor(h, ['tasks:delete'])).map((t) => t.name)).toContain('delete_task')
  })

  test('every listed tool is one the token can actually call', async () => {
    const h = await harness()
    for (const matrix of [
      [],
      ['tasks:execute'],
      ['tasks:execute', 'tasks:delete'],
    ] as Permission[][]) {
      const actor = tokenActor(h, matrix)
      for (const tool of toolsFor(actor)) {
        for (const p of tool.permissions) expect(actor.permissions.has(p)).toBe(true)
      }
    }
  })
})

describe('RFC-247 — describe_capabilities explains a refusal', () => {
  test('it names the missing point for each unavailable tool', async () => {
    const h = await harness()
    const described = describeCapabilities(tokenActor(h, []))
    const launch = described.toolsUnavailable.find((t) => t.tool === 'launch_task')
    expect(launch?.missing).toEqual(['tasks:execute'])
    expect(described.toolsAvailable).toContain('get_task')
  })

  test('granted never includes a system-domain point', async () => {
    const h = await harness()
    // The owner is an admin, so `users:read` etc. are in the ROLE baseline —
    // the token must still not carry them (D7).
    const granted = describeCapabilities(tokenActor(h, [])).granted
    expect(granted).not.toContain('users:read')
    expect(granted).not.toContain('settings:write')
    expect(granted).not.toContain('account:self')
  })
})

describe('RFC-247 — the tool table cannot drift from the permission catalog', () => {
  test('the converged resource kinds cover every matrix resource except tasks', () => {
    // `MCP_RESOURCE_KINDS` is spelled out as a tuple (z.enum needs one). This
    // is the lock that keeps it honest: add a resource type to the catalog
    // without giving it tools and this goes red, rather than the resource
    // silently having no MCP surface.
    //
    // RFC-248 T30c 把方向从「相等」放宽成「覆盖」：MCP 的 kind 是**工具寻址
    // 单位**，不必逐个对应可授权资源。`repo-groups` 就是这种——它有独立的
    // CRUD 路由，但写权限沿用 `repos:*`（组编排的是仓库，不是第十一种可授权
    // 资源；给账号页的令牌矩阵加一行没人看得懂的 `repo-groups:*` 才是坏的）。
    for (const r of MATRIX_RESOURCES) {
      if (r === 'tasks') continue
      expect(MCP_RESOURCE_KINDS).toContain(r)
    }
    expect(MCP_RESOURCE_KINDS as readonly string[]).not.toContain('tasks')
  })

  test('RFC-248: kind 之外的额外项必须显式声明权限域，且那个域在矩阵里', async () => {
    // 反向守卫：任何**不在** MATRIX_RESOURCES 里的 kind，它的写操作报出来的
    // 权限点必须落在一个真实存在的域上。漏掉映射会让 describe_resource 报出
    // `repo-groups:update` 这种不存在的点——调用方照着去申请，永远申请不到。
    const { describeResource } = await import('@/mcp/tools')
    const extras = MCP_RESOURCE_KINDS.filter(
      (k) => !(MATRIX_RESOURCES as readonly string[]).includes(k),
    )
    expect(extras).toEqual(['repo-groups'])
    for (const kind of extras) {
      const d = describeResource(kind)
      for (const op of d.operations) {
        if (op.permission === null) continue
        const domain = op.permission.split(':')[0]!
        expect(MATRIX_RESOURCES as readonly string[]).toContain(domain)
      }
    }
  })

  test('every tool declares points that exist in the catalog', async () => {
    const h = await harness()
    const admin = tokenActor(h, [...MATRIX_RESOURCES.map((r) => `${r}:delete` as Permission)])
    for (const tool of ALL_TOOLS) {
      for (const p of tool.permissions) {
        // An unknown point would silently make the tool unlistable forever.
        expect(typeof p).toBe('string')
        expect(p.includes(':')).toBe(true)
      }
    }
    expect(toolsFor(admin).length).toBeGreaterThan(0)
  })

  test('no two tools share a name', () => {
    const names = ALL_TOOLS.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
  })

  test('every tool has a description that says what it does', () => {
    for (const tool of ALL_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(40)
      expect(tool.title.length).toBeGreaterThan(0)
    }
  })
})

describe('RFC-247 D9 — an MCP secret does not come back through a token', () => {
  test('a PAT read of an MCP server gets masked env, headers and oauth secret', async () => {
    // The gap this closes: `redactMcpRecord` existed and was unit-tested, but
    // nothing called it — so `GET /api/mcps/:id` returned credentials verbatim.
    // It matters more on this channel than on REST: `resource_read` puts the
    // answer straight into a model's context.
    const h = await harness()
    const dispatch = createDispatcher(h.deps)
    const actor = mcpDispatchActor(tokenActor(h, ['mcps:create']))

    const created = await dispatch(
      {
        method: 'POST',
        path: '/api/mcps',
        body: {
          name: 'secret-bearing',
          description: '',
          type: 'local',
          config: { command: ['run-me'], env: { API_KEY: 'sk-live-do-not-leak' } },
          enabled: true,
        },
      },
      actor,
    )
    expect(created.status).toBe(201)
    const id = (created.body as { id: string }).id

    const read = await dispatch({ method: 'GET', path: `/api/mcps/${id}` }, actor)
    expect(read.status).toBe(200)
    const raw = JSON.stringify(read.body)
    expect(raw).not.toContain('sk-live-do-not-leak')
    // The KEY survives — a caller must still be able to see which variables
    // exist in order to reason about the server at all.
    expect(raw).toContain('API_KEY')

    const listed = await dispatch({ method: 'GET', path: '/api/mcps' }, actor)
    expect(JSON.stringify(listed.body)).not.toContain('sk-live-do-not-leak')

    // …and the same read through a SESSION actor still shows it: redaction is
    // about the token channel, not about hiding a user's own data from them.
    const session = buildActor({
      user: {
        id: h.userId,
        username: 'alice',
        displayName: 'Alice',
        role: 'admin',
        status: 'active',
      },
      source: 'session',
    })
    const bySession = await dispatch({ method: 'GET', path: `/api/mcps/${id}` }, session)
    expect(JSON.stringify(bySession.body)).toContain('sk-live-do-not-leak')
  })
})

/**
 * Typed against the SHARED schema on purpose.
 *
 * The previous version of these fixtures was an untyped literal using `name`,
 * which is not a field `WorkflowInput` has — the implementation read `.name`
 * too, so the stub and the bug agreed with each other and the test passed while
 * every real refusal said "(?)". Declaring the type makes the compiler the
 * thing that keeps fixture and schema honest, instead of two humans reading
 * the same wrong string twice.
 */
const UPLOAD_INPUTS: WorkflowInput[] = [
  { kind: 'upload', key: 'attachment', label: 'Attachment', required: true },
]
const TEXT_INPUTS: WorkflowInput[] = [{ kind: 'text', key: 'goal', label: 'Goal' }]

describe('RFC-247 AC-17 — an upload workflow is refused before anything exists', () => {
  test('launch_task rejects it, and never dispatches the launch', async () => {
    const h = await harness()
    const dispatch = createDispatcher(h.deps)
    const actor = mcpDispatchActor(tokenActor(h, ['tasks:execute']))

    const tool = ALL_TOOLS.find((t) => t.name === 'launch_task')
    expect(tool).toBeDefined()

    // The workflow read is stubbed so the upload declaration is unambiguous;
    // what is under test is the ORDER — refuse before POSTing a launch, so no
    // task row and no worktree are created and there is nothing to clean up.
    const calls: string[] = []
    const ctx = {
      actor,
      dispatch: async (req: { method: string; path: string }) => {
        calls.push(`${req.method} ${req.path}`)
        if (req.method === 'GET' && req.path.startsWith('/api/workflows/')) {
          return { status: 200, body: { definition: { inputs: UPLOAD_INPUTS } } }
        }
        return dispatch(req as Parameters<typeof dispatch>[0], actor)
      },
      progress: async () => {},
      signal: new AbortController().signal,
    } as unknown as Parameters<NonNullable<typeof tool>['handler']>[1]

    // The refusal must NAME the offending input. Asserting only /upload/i is
    // what let the `.name` vs `.key` bug live: the message read
    // "takes file uploads (?)" and still matched.
    await expect(
      tool!.handler({ workflowId: 'wf-1', name: 'should-not-launch' }, ctx),
    ).rejects.toThrow(/attachment/)
    expect(calls).toEqual(['GET /api/workflows/wf-1'])
  })

  test('a workflow with no upload input is launched normally', async () => {
    // Without this the test above would also pass if launch_task simply always
    // threw.
    const h = await harness()
    const actor = mcpDispatchActor(tokenActor(h, ['tasks:execute']))
    const tool = ALL_TOOLS.find((t) => t.name === 'launch_task')

    const calls: string[] = []
    const ctx = {
      actor,
      dispatch: async (req: { method: string; path: string }) => {
        calls.push(`${req.method} ${req.path}`)
        if (req.method === 'GET' && req.path.startsWith('/api/workflows/')) {
          return { status: 200, body: { definition: { inputs: TEXT_INPUTS } } }
        }
        // The launch itself will fail on a nonexistent workflow — irrelevant
        // here; the point is that it was ATTEMPTED.
        return { status: 404, body: { code: 'workflow-not-found', message: 'nope' } }
      },
      progress: async () => {},
      signal: new AbortController().signal,
    } as unknown as Parameters<NonNullable<typeof tool>['handler']>[1]

    await expect(tool!.handler({ workflowId: 'wf-2', name: 'ok' }, ctx)).rejects.toThrow()
    expect(calls).toEqual(['GET /api/workflows/wf-2', 'POST /api/tasks'])
  })
})

// -----------------------------------------------------------------------------
// Implementation-gate fixes (Codex impl-gate 2026-08-02).
//
// Every one of these was an operation the tool set ADVERTISED and that had never
// once succeeded, because the tool's dispatch shape disagreed with the route it
// targets. They all passed the original tests because those tests stubbed the
// dispatcher — proving "the tool calls some path" while proving nothing about
// whether that path accepts the body. These go through the REAL route table.
// -----------------------------------------------------------------------------

describe('RFC-247 impl-gate — advertised operations actually reach a live route', () => {
  test('skills update targets the combined-save endpoint, not the retired PUT', async () => {
    // `PUT /api/skills/:id` answers 410 Gone on every call, so the previous
    // mapping made `resource_write(skills, update)` impossible to succeed.
    const h = await harness()
    const dispatch = createDispatcher(h.deps)
    const actor = mcpDispatchActor(tokenActor(h, ['skills:update']))

    const seen: string[] = []
    const tool = ALL_TOOLS.find((t) => t.name === 'resource_write')
    const ctx = {
      actor,
      dispatch: async (req: { method: string; path: string }) => {
        seen.push(`${req.method} ${req.path}`)
        return dispatch(req as Parameters<typeof dispatch>[0], actor)
      },
      progress: async () => {},
      signal: new AbortController().signal,
    } as unknown as Parameters<NonNullable<typeof tool>['handler']>[1]

    await tool!
      .handler({ kind: 'skills', method: 'update', id: 'sk-1', body: {} }, ctx)
      .catch(() => undefined)

    expect(seen).toEqual(['POST /api/skills/sk-1/save'])
    expect(seen[0]).not.toContain('PUT')
  })

  test('memory delete carries the ?confirm=true query the route demands', async () => {
    // The route checks the QUERY flag before the token's type-to-confirm body,
    // so a body-only dispatch failed with `confirm-required` every time.
    const h = await harness()
    const dispatch = createDispatcher(h.deps)
    const actor = mcpDispatchActor(tokenActor(h, ['memory:delete']))

    const seen: Array<{ path: string; query: unknown }> = []
    const tool = ALL_TOOLS.find((t) => t.name === 'resource_write')
    const ctx = {
      actor,
      dispatch: async (req: { method: string; path: string; query?: unknown }) => {
        seen.push({ path: req.path, query: req.query })
        return dispatch(req as Parameters<typeof dispatch>[0], actor)
      },
      progress: async () => {},
      signal: new AbortController().signal,
    } as unknown as Parameters<NonNullable<typeof tool>['handler']>[1]

    await tool!
      .handler({ kind: 'memory', method: 'delete', id: 'm-1', confirm: 'x' }, ctx)
      .catch(() => undefined)

    expect(seen[0]?.query).toEqual({ confirm: 'true' })
  })

  test('agents delete does NOT carry it — the flag is memory-specific', () => {
    // Guards the guard: a blanket `?confirm=true` would be indistinguishable
    // from the fix in the test above.
    expect(
      describeResource('agents').operations.find((o) => o.operation === 'delete'),
    ).toBeDefined()
    expect(describeResource('memory').note).toBeUndefined()
  })

  test('repair_alert sends optionId + confirm, the shape the route validates', async () => {
    const h = await harness()
    const actor = mcpDispatchActor(tokenActor(h, ['tasks:execute']))
    const tool = ALL_TOOLS.find((t) => t.name === 'repair_alert')
    let body: unknown
    const ctx = {
      actor,
      dispatch: async (req: { body?: unknown }) => {
        body = req.body
        return { status: 200, body: {} }
      },
      progress: async () => {},
      signal: new AbortController().signal,
    } as unknown as Parameters<NonNullable<typeof tool>['handler']>[1]

    await tool!.handler({ id: 't1', alertId: 'a1', optionId: 'opt-9', confirm: true }, ctx)
    expect(body).toEqual({ optionId: 'opt-9', confirm: true })
  })

  test('list_repair_options exists, so an option id is obtainable over MCP', () => {
    // Fixing repair_alert's body alone would still leave the operation unusable:
    // nothing else in the tool set returns an option id.
    expect(ALL_TOOLS.map((t) => t.name)).toContain('list_repair_options')
  })
})

describe('RFC-247 impl-gate — a model-supplied id cannot retarget the dispatch', () => {
  test('a traversal id is encoded instead of normalised into another endpoint', async () => {
    // `get_task({id:"../workflows"})` used to build `/api/tasks/../workflows`,
    // which URL normalisation collapses to `/api/workflows` — a different
    // endpoint from the one the tool declares, while the audit row still says
    // `get_task`.
    const h = await harness()
    const actor = mcpDispatchActor(tokenActor(h, []))
    const tool = ALL_TOOLS.find((t) => t.name === 'get_task')
    let path = ''
    const ctx = {
      actor,
      dispatch: async (req: { path: string }) => {
        path = req.path
        return { status: 200, body: {} }
      },
      progress: async () => {},
      signal: new AbortController().signal,
    } as unknown as Parameters<NonNullable<typeof tool>['handler']>[1]

    await tool!.handler({ id: '../workflows' }, ctx)
    expect(path).toBe('/api/tasks/..%2Fworkflows')
    expect(new URL(`http://x${path}`).pathname).toBe('/api/tasks/..%2Fworkflows')
  })

  test('a normal ULID is unaffected', async () => {
    const h = await harness()
    const actor = mcpDispatchActor(tokenActor(h, []))
    const tool = ALL_TOOLS.find((t) => t.name === 'get_task')
    let path = ''
    const ctx = {
      actor,
      dispatch: async (req: { path: string }) => {
        path = req.path
        return { status: 200, body: {} }
      },
      progress: async () => {},
      signal: new AbortController().signal,
    } as unknown as Parameters<NonNullable<typeof tool>['handler']>[1]
    await tool!.handler({ id: '01KZ08WX6YHWNFEZPX2PGT8GDP' }, ctx)
    expect(path).toBe('/api/tasks/01KZ08WX6YHWNFEZPX2PGT8GDP')
  })
})

describe('RFC-247 impl-gate — describe_resource answers the question it is pointed at', () => {
  test('it returns the create/update JSON Schema, derived from the route schemas', () => {
    // `resource_write` tells callers to come here for "a kind's field schema".
    // It used to return only method/path/permission, so a model following that
    // instruction had no move left except to guess a body and read the 422.
    const agents = describeResource('agents')
    const create = agents.bodySchemas.create as { properties?: Record<string, unknown> }
    expect(Object.keys(create?.properties ?? {})).toContain('name')
    expect(Object.keys(create?.properties ?? {})).toContain('bodyMd')
  })

  test('the update schema exposes the revision fence', () => {
    // The single most useful thing here: without these an update ALWAYS fails,
    // and nothing else in the tool set says they exist.
    const update = describeResource('agents').bodySchemas.update as { required?: string[] }
    expect(update?.required ?? []).toContain('expectedUpdatedAt')
    expect(update?.required ?? []).toContain('expectedAclRevision')
  })

  test('a kind with no body contract reports none rather than inventing one', () => {
    // repos have no single-resource create (imports are a batch) and no update.
    expect(describeResource('repos').bodySchemas).toEqual({})
  })

  test('schemas are inlined — a model cannot resolve $ref against a tool result', () => {
    const serialized = JSON.stringify(describeResource('workflows').bodySchemas)
    expect(serialized).not.toContain('"$ref"')
  })

  test('it is DERIVED: every kind that has a route create also reports a schema', () => {
    // Locks the correspondence rather than a snapshot of today's field list —
    // a snapshot would pass forever while the real schema drifted underneath.
    for (const kind of KINDS_WITH_BODY_SCHEMAS) {
      const d = describeResource(kind)
      const hasRouteCreate = d.operations.some((o) => o.operation === 'create')
      if (hasRouteCreate) expect(d.bodySchemas.create).toBeDefined()
    }
  })
})

describe('RFC-247 impl-gate — launch_task can reach every field the route accepts', () => {
  const launch = ALL_TOOLS.find((t) => t.name === 'launch_task')

  test('the previously unreachable fields are declared', () => {
    // MCP tool inputs are a CLOSED schema: an undeclared field cannot reach the
    // route no matter what the caller sends, so omissions here are not cosmetic
    // — they are capabilities that do not exist over this channel.
    const keys = Object.keys(launch!.inputSchema)
    for (const field of [
      'maxDurationMs',
      'maxTotalTokens',
      'collaboratorUserIds',
      'expectedWorkflowVersion',
      // RFC-248: `repos` 退役，多仓改由 `repoGroupId` 表达。这条断言的意义
      // 不变——多仓能力必须在这个通道上**可达**，只是字段名换了。
      'repoGroupId',
    ]) {
      expect(keys).toContain(field)
    }
    // 退役字段反过来必须**不可达**：MCP 的入参是闭合 schema，留着 `repos`
    // 只会让调用方发出一个注定 422 的 body。
    expect(keys).not.toContain('repos')
    expect(keys).not.toContain('gitUserName')
    expect(keys).not.toContain('gitUserEmail')
  })

  test('inputs tells the caller where port keys come from', () => {
    // The gap that made `inputs` unusable in practice: it is a free-form map and
    // nothing said which keys a given workflow wants.
    const desc = JSON.stringify(launch!.inputSchema.inputs)
    expect(desc).toContain('resource_read')
    expect(desc).toContain('definition.inputs')
  })
})

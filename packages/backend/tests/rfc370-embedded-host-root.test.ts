// RFC-370: exercise the actual embedded HTTP graph, resource persistence and
// selected Task/Intent/MCP owners. This SQLite entry has no daemon timer inventory.
import { expect, test, setDefaultTimeout } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInMemoryDb } from '@/db/client'
import { hostExecutionWriteContexts, tasks, workflows } from '@/db/schema'
import { createSecretBoxFromKey } from '@/auth/secretBox'
import { invalidateReadConfigCache } from '@/config'
import { createLocalHostExecutionAuthorityFactory } from '@/modules/system-operations/infrastructure/local/hostExecutionAuthority'
import type {
  HostExecutionAuthorityFactory,
  HostExecutionRecoveryFamily,
} from '@/modules/system-operations/public/participants'
import { composeEmbeddedHostExecutionApplication } from '../src/cli/embeddedHostExecutionApplication'
import type { DaemonHostExecutionSelection } from '../src/cli/daemonHostExecutionBootstrap'
import { MIGRATIONS } from './migration-freeze'
import type { FusionWorkspaceFactory } from '@/modules/knowledge-evolution/public/participants'
import { IndeterminateRuntimeProcessError } from '@/modules/memory/composition'

setDefaultTimeout(60_000)

function fixture(mode: DaemonHostExecutionSelection['mode']) {
  const db = createInMemoryDb(MIGRATIONS)
  const appHome = mkdtempSync(join(tmpdir(), 'rfc370-embedded-host-'))
  const configPath = join(appHome, 'config.json'),
    token = 'embedded-root-token'
  writeFileSync(configPath, '{}')
  let claims = 0,
    factories = 0
  const originalFactory = createLocalHostExecutionAuthorityFactory()
  const authority: HostExecutionAuthorityFactory = {
    async create(input) {
      factories += 1
      const driver = await originalFactory.create(input)
      const claim = driver.claim.bind(driver)
      return {
        claim() {
          claims += 1
          return claim()
        },
        renew: driver.renew.bind(driver),
        activate: driver.activate.bind(driver),
        quiesce: driver.quiesce.bind(driver),
        release: driver.release.bind(driver),
        subscribe: driver.subscribe.bind(driver),
      }
    },
  }
  const failures: unknown[] = []
  const input = {
    generation: 'embedded-real-generation',
    deps: {
      db,
      appHome,
      configPath,
      token,
      dbVersion: 0,
      opencodeVersion: null,
      secretBox: createSecretBoxFromKey(Buffer.alloc(32, 37)),
    },
    selection: {
      mode,
      authority,
      recoveryKind: 'local-startup' as const,
      leaseFacts: {
        forGrant: () => ({ holder: 'embedded-real-holder', expiresAt: Date.now() + 60_000 }),
      },
    },
    onFailure: (error: unknown) => {
      failures.push(error)
    },
  }
  const roots: Awaited<ReturnType<typeof composeEmbeddedHostExecutionApplication>>[] = []
  return {
    db,
    input,
    roots,
    failures,
    claims: () => claims,
    factories: () => factories,
    async open() {
      const root = await composeEmbeddedHostExecutionApplication(input)
      roots.push(root)
      return root
    },
    request(path: string, body?: unknown) {
      return new Request(`http://embedded.test${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    },
    async finish() {
      try {
        for (const root of roots.reverse()) await root.close()
      } finally {
        db.$client.close()
        invalidateReadConfigCache(configPath)
        rmSync(appHome, { recursive: true, force: true })
      }
    },
  }
}

test('resource-only HTTP can save and rebuild a real workflow without claiming execution', async () => {
  const f = fixture('resource-only')
  try {
    const first = await f.open()
    expect((await first.fetch(f.request('/api/workflows'))).status).toBe(503)
    expect(f.claims()).toBe(0)
    await first.resume()
    expect(first.execution.snapshot()).toMatchObject({
      phase: 'standby',
      readyGroups: [],
      reason: 'host-execution-resource-only',
    })
    expect(first.state().activeHandleIds).toEqual([])
    const beforeTasks = await f.db.select().from(tasks)
    const unavailable = await first.fetch(f.request('/api/tasks', { invalidLaunchPayload: true }))
    expect(unavailable.status).toBe(503)
    expect(await unavailable.json()).toMatchObject({
      code: 'host-execution-unavailable',
      details: { group: 'task', mode: 'resource-only' },
    })
    expect(await f.db.select().from(tasks)).toEqual(beforeTasks)
    expect(await (await first.fetch(f.request('/api/execution/status'))).json()).toEqual({
      mode: 'resource-only',
      status: first.execution.snapshot(),
    })
    const saved = await first.fetch(
      f.request('/api/workflows', {
        name: 'Resource-only 耐久编辑',
        description: 'saved by the original workflow route',
        definition: { $schema_version: 4, inputs: [], nodes: [], edges: [] },
      }),
    )
    expect(saved.status).toBe(201)
    const workflow = (await saved.json()) as { id: string; name: string }
    expect(workflow.name).toBe('Resource-only 耐久编辑')
    expect((await f.db.select().from(workflows)).some((row) => row.id === workflow.id)).toBe(true)
    await first.close()
    expect((await first.fetch(f.request(`/api/workflows/${workflow.id}`))).status).toBe(503)
    const rebuilt = await f.open()
    await rebuilt.resume()
    const restored = await rebuilt.fetch(f.request(`/api/workflows/${workflow.id}`))
    expect(restored.status).toBe(200)
    expect(await restored.json()).toMatchObject({ id: workflow.id, name: workflow.name })
    expect(f.claims()).toBe(0)
    expect(await f.db.select().from(hostExecutionWriteContexts)).toEqual([])
    expect(f.failures).toEqual([])
  } finally {
    await f.finish()
  }
})

test('blocked original recovery keeps real HTTP resources and recovery controls available in the embedded root', async () => {
  const f = fixture('execution')
  let permitPhysical = false
  const original = new IndeterminateRuntimeProcessError(
    'original execution not yet reaped',
    async () => permitPhysical,
  )
  original.retainOriginalSettlement(['original'], async () => {})
  const input = {
    ...f.input,
    selection: {
      ...f.input.selection,
      recovery: (): HostExecutionRecoveryFamily => ({
        kind: 'local-startup',
        async prepare() {
          if (!original.originalRecoveryAcknowledged()) throw original
          return {
            kind: 'prepared',
            preparationDigest: 'original-recovered',
            acceptedTaskContractVersions: [],
            readyGroups: ['task', 'diagnostics'],
          }
        },
        quiesce() {},
        async drain() {
          if (!original.originalRecoveryAcknowledged()) throw original
        },
      }),
    },
  }
  const root = await composeEmbeddedHostExecutionApplication(input)
  f.roots.push(root)
  try {
    await root.resumeForServing()
    expect((await root.fetch(f.request('/api/workflows'))).status).toBe(200)
    expect(await (await root.fetch(f.request('/api/execution/status'))).json()).toMatchObject({
      mode: 'execution',
      status: { phase: 'draining', readyGroups: [] },
    })
    expect((await root.fetch(f.request('/api/tasks', { invalidLaunchPayload: true }))).status).toBe(
      503,
    )
    expect(await f.db.select().from(tasks)).toEqual([])
    const blocked = await root.fetch(f.request('/api/execution/recover', {}))
    expect(blocked.status).toBeGreaterThanOrEqual(400)
    expect(root.execution.snapshot().phase).toBe('draining')
    expect(await original.recoverOriginal()).toBe(false)
    permitPhysical = true
    expect(await original.recoverOriginal()).toBe(true)
    const response = await root.fetch(f.request('/api/execution/recover', {}))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      status: { phase: 'active', readyGroups: ['task', 'diagnostics'] },
    })
    expect((await root.fetch(f.request('/api/workflows'))).status).toBe(200)
  } finally {
    permitPhysical = true
    await original.recoverOriginal()
    await f.finish()
  }
})

test('the embedded root activates its original Task, Intent and MCP owners, retires them and resumes with a fresh write revision', async () => {
  const f = fixture('execution')
  try {
    const root = await f.open()
    expect(f.claims()).toBe(0)
    await root.resume()
    expect(root.execution.snapshot()).toMatchObject({
      phase: 'active',
      readyGroups: ['task', 'intent', 'diagnostics'],
    })
    expect(root.state().activeHandleIds).toEqual([
      'task-execution',
      'intent-turn-execution',
      'mcp-runtime-tests',
    ])
    expect(await (await root.fetch(f.request('/api/execution/status'))).json()).toEqual({
      mode: 'execution',
      status: root.execution.snapshot(),
    })
    expect(f.claims()).toBe(1)
    const first = (await f.db.select().from(hostExecutionWriteContexts))[0]!
    expect(first.phase).toBe('active')
    expect((await root.fetch(f.request('/api/workflows'))).status).toBe(200)
    await root.pause()
    expect(root.state().activeHandleIds).toEqual([])
    expect((await root.fetch(f.request('/api/workflows'))).status).toBe(503)
    expect((await f.db.select().from(hostExecutionWriteContexts))[0]!.phase).toBe('closed')
    await root.resume()
    expect((await f.db.select().from(hostExecutionWriteContexts))[0]!.revision).toBeGreaterThan(
      first.revision,
    )
    expect(f.claims()).toBe(2)
    expect(f.failures).toEqual([])
  } finally {
    await f.finish()
  }
})

test('missing durable recovery is rejected before composing resources or creating an authority driver', async () => {
  const f = fixture('resource-only')
  try {
    await expect(
      composeEmbeddedHostExecutionApplication({
        ...f.input,
        selection: { ...f.input.selection, recoveryKind: 'durable-intent' },
      }),
    ).rejects.toThrow('daemon-host-recovery-adapter-missing')
    expect(f.factories()).toBe(0)
    expect(await f.db.select().from(hostExecutionWriteContexts)).toEqual([])
  } finally {
    await f.finish()
  }
})

test('a socket construction failure closes composed resources and leaves the borrowed database reusable', async () => {
  const f = fixture('resource-only')
  try {
    await expect(
      composeEmbeddedHostExecutionApplication({
        ...f.input,
        createWebSocket() {
          throw new Error('original-socket-construction-failed')
        },
      }),
    ).rejects.toThrow('original-socket-construction-failed')
    expect(f.claims()).toBe(0)
    const root = await f.open()
    await root.resume()
    expect((await root.fetch(f.request('/api/workflows'))).status).toBe(200)
    expect(await f.db.select().from(hostExecutionWriteContexts)).toEqual([])
  } finally {
    await f.finish()
  }
})

test('a recovery adapter construction failure closes the already composed session without closing its borrowed database', async () => {
  const f = fixture('resource-only')
  try {
    await expect(
      composeEmbeddedHostExecutionApplication({
        ...f.input,
        selection: {
          ...f.input.selection,
          recoveryKind: 'durable-intent',
          recovery() {
            throw new Error('original-recovery-adapter-construction-failed')
          },
        },
      }),
    ).rejects.toThrow('original-recovery-adapter-construction-failed')
    expect(f.claims()).toBe(0)
    const root = await f.open()
    await root.resume()
    expect((await root.fetch(f.request('/api/workflows'))).status).toBe(200)
    expect(await f.db.select().from(hostExecutionWriteContexts)).toEqual([])
  } finally {
    await f.finish()
  }
})

test('resource-only HTTP rejects every continuation family before reservation while retaining explicit resource-only runtime saves', async () => {
  const f = fixture('resource-only')
  try {
    const root = await f.open()
    await root.resume()
    const requests = [
      ['/api/tasks/missing/questions/dispatch', 'task', {}],
      ['/api/code/missions/missing/answers', 'development', {}],
      ['/api/code/missions/missing/requirement-source', 'development', {}],
      ['/api/code/missions/missing/source-refresh', 'development', {}],
      ['/api/intent-sessions/missing/current-action', 'intent', {}],
      ['/api/intent-sessions/missing/working-set', 'intent', {}],
      ['/api/intent-sessions/missing/working-set/missing/retry', 'intent', {}],
      ['/api/event-center/sources/missing/validate', 'event-dispatch', {}],
      ['/api/event-center/sources/missing/publish', 'event-dispatch', {}],
      ['/api/runtimes/status', 'diagnostics', undefined],
      ['/api/runtime/models', 'diagnostics', undefined],
      [
        '/api/runtimes',
        'diagnostics',
        { name: 'probe-required', protocol: 'opencode', binaryPath: '/unused-rfc370-runtime' },
      ],
    ] as const
    for (const [path, group, body] of requests) {
      const response = await root.fetch(f.request(path, body))
      expect(response.status).toBe(503)
      expect(await response.json()).toMatchObject({
        code: 'host-execution-unavailable',
        details: { group, mode: 'resource-only' },
      })
    }
    const saved = await root.fetch(
      f.request('/api/runtimes', {
        name: 'resource-runtime',
        protocol: 'opencode',
        binaryPath: '/unused-rfc370-runtime',
        probe: false,
      }),
    )
    expect(saved.status).toBe(201)
    expect(await saved.json()).toMatchObject({ runtime: { name: 'resource-runtime' } })
    const recover = await root.fetch(
      f.request('/api/mcps/missing/runtime-test-sessions/missing/recover', {}),
    )
    expect(recover.status).toBe(404)
    expect(((await recover.json()) as { code: string }).code).toBe('mcp-not-found')
    expect(f.claims()).toBe(0)
    expect(await f.db.select().from(hostExecutionWriteContexts)).toEqual([])
    expect(await f.db.select().from(tasks)).toEqual([])
  } finally {
    await f.finish()
  }
})

test('resource-only Fusion list, count and detail read stored facts without constructing any execution workspace', async () => {
  const f = fixture('resource-only')
  let constructions = 0
  const workspaces: FusionWorkspaceFactory = {
    create() {
      constructions += 1
      throw new Error('cold Fusion query constructed execution workspace')
    },
  }
  try {
    const root = await composeEmbeddedHostExecutionApplication({
      ...f.input,
      deps: { ...f.input.deps, fusionWorkspaces: workspaces },
    })
    f.roots.push(root)
    await root.resume()
    expect((await root.fetch(f.request('/api/fusions'))).status).toBe(200)
    const count = await root.fetch(f.request('/api/fusions/pending-count'))
    expect(count.status).toBe(200)
    expect(await count.json()).toEqual({ count: 0 })
    expect((await root.fetch(f.request('/api/fusions/missing'))).status).toBe(404)
    expect(constructions).toBe(0)
    expect(f.claims()).toBe(0)
    expect(await f.db.select().from(hostExecutionWriteContexts)).toEqual([])
  } finally {
    await f.finish()
  }
})

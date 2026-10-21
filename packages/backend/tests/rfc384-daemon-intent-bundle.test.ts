// RFC-384: pin one passive Intent graph, live defaults, maintenance activity and isolated run families on both providers.
import { createProviderHttpCompositionFixture } from './helpers/providerHttpComposition'
import { afterEach, expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono, type Context } from 'hono'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { DEFAULT_CONFIG, canonicalIntentJson, type Config } from '@agent-workflow/shared'
import { admitDurableWorkOwner, actorOfDirectAuthority } from '@/auth/session'
import { createSecretBoxFromKey } from '@/auth/secretBox'
import { composeDaemonIntentModules, type DaemonIntentInput } from '@/cli/daemonModules/intent'
import { intentDrafts, intentSessions, intentWorkingSetChanges } from '@/db/schema'
import * as applyComposition from '@/modules/intent/composition/apply'
import * as persistenceComposition from '@/modules/intent/composition/persistence'
import * as resourceComposition from '@/modules/intent/composition/resourceCatalog'
import { mountIntentSessionRoutes } from '@/modules/intent/composition/routes'
import { createIntentSession, insertUserTurnAndReserve } from '@/modules/intent/application/session'
import { intentResourceVisibility } from '@/modules/intent/application/resourceCatalog'
import { submitIntentWorkingSetChange } from '@/modules/intent/application/workingSet'
import { cancelIntentTurn } from '@/modules/intent/application/turnEngine'
import { composeLocalSystemAgentRunFamily } from '@/modules/task-execution/composition/localSystemAgentRunFamily'
import {
  createMaintenanceService,
  type MaintenanceServiceOptions,
} from '@/platform/background/maintenanceService'
import { createMaintenanceRunStore } from '@/platform/persistence/maintenanceRunStore'
import {
  emptySystemAgentOutputEvidence,
  type SystemAgentRunOptions,
  type SystemAgentRunResult,
} from '@/services/systemAgentRun'
import { createUser } from '@/services/users'
import { createAgent } from '@/services/agent'
import { describeEachProvider, type ProviderDatabaseHarness } from './helpers/eachProvider'
import { employeeAutomationFixture } from './helpers/daemonEmployeeAutomationBundle'
import { seedBuiltinRuntimes, updateRuntime } from './helpers/runtimeRegistryApplication'
import { runtimeRegistryPersistence } from './helpers/runtimeRegistryPersistence'
import { eventually } from './helpers/eventually'

const homes: string[] = []
function home() {
  const path = mkdtempSync(join(tmpdir(), 'rfc384-'))
  homes.push(path)
  return path
}
afterEach(() => {
  for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true })
})
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}
function output(opts: SystemAgentRunOptions): SystemAgentRunResult {
  const nonce = /nonce="([^"]+)"/.exec(opts.prompt)?.[1] ?? ''
  return {
    status: 'ok',
    exitCode: 0,
    eventText: `<workflow-output nonce="${nonce}"><port name="summary">resumed</port><port name="questions">[{"id":"q1","question":"Next step?","options":["a","b"],"multiSelect":false}]</port></workflow-output>`,
    stderrTail: '',
    durationMs: 1,
    scratchDir: '/tmp/rfc384-fixture',
    scratchRetained: false,
    outputEvidence: emptySystemAgentOutputEvidence(),
  }
}
function fixture(harness: ProviderDatabaseHarness) {
  const appHome = home()
  const f = employeeAutomationFixture(harness, appHome)
  let config: Config = { ...DEFAULT_CONFIG }
  let reads = 0
  const calls = {
    worker: [] as SystemAgentRunOptions[],
    http: [] as SystemAgentRunOptions[],
    unselected: 0,
  }
  const worker = composeLocalSystemAgentRunFamily({
    appHome: () => appHome,
    fixture: {
      runFn: async (opts) => {
        calls.worker.push(opts)
        return output(opts)
      },
    },
  })
  const http = composeLocalSystemAgentRunFamily({
    appHome: () => appHome,
    fixture: {
      runFn: async (opts) => {
        calls.unselected++
        return output(opts)
      },
    },
  })
  const errors: unknown[] = []
  const input: DaemonIntentInput = {
    db: harness.db,
    appHome,
    configuration: {
      read: () => {
        reads++
        return config
      },
    },
    log: { warn: (message, fields) => errors.push({ message, fields }) },
    core: f.core.identityAccess,
    resources: f.tasks.resourceCatalog,
    observation: { intentSystemAgentBinding: worker, intentHttpSystemAgentBinding: http },
    digitalEmployee: f.employee,
    adapters: {
      httpTurnFixture: async (opts) => {
        calls.http.push(opts)
        return output(opts)
      },
    },
  }
  return {
    ...f,
    input,
    calls,
    errors,
    reads: () => reads,
    update: (value: Partial<Config>) => {
      config = { ...config, ...value }
    },
  }
}
async function owner(f: ReturnType<typeof fixture>) {
  const user = await createUser(f.input.db, {
    username: `intent-${ulid().toLowerCase()}`,
    displayName: 'Intent owner',
    role: 'user',
    password: 'longEnoughPassword',
  })
  const admitted = await admitDurableWorkOwner(f.core.identityAccess, user.id)
  if (admitted === null) throw new Error('fixture owner missing')
  return actorOfDirectAuthority(admitted)
}
function routes(
  bundle: ReturnType<typeof composeDaemonIntentModules>,
  actor: Awaited<ReturnType<typeof owner>>,
) {
  const app = new Hono()
  app.use('*', async (c: Context, next) => {
    c.set('actor', actor)
    await next()
  })
  mountIntentSessionRoutes(app, bundle.routes)
  return app
}
async function seedQueued(
  f: ReturnType<typeof fixture>,
  bundle: ReturnType<typeof composeDaemonIntentModules>,
  actor: Awaited<ReturnType<typeof owner>>,
) {
  const visibility = intentResourceVisibility(bundle.resourceCatalogFor(actor))
  const agent = await createAgent(
    f.input.db,
    {
      name: `queued-${ulid().toLowerCase()}`,
      description: '',
      outputs: [],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: 'queued fixture',
    },
    { ownerUserId: actor.user.id },
  )
  const { session } = await createIntentSession(bundle.persistence, visibility, actor, {
    message: 'queued recovery',
  })
  await insertUserTurnAndReserve(
    bundle.persistence,
    actor,
    session.id,
    'message',
    { message: 'running' },
    50,
  )
  const running = (await bundle.persistence.findSession(session.id))!
  const queued = await submitIntentWorkingSetChange(
    bundle.persistence,
    visibility,
    actor,
    session.id,
    {
      clientMutationId: ulid(),
      expectedTurnSeq: running.turnSeq,
      expectedContextRevision: running.contextRevision,
      mode: 'after-current',
      delta: { additions: [{ resourceType: 'agent', resourceId: agent.id }], removals: [] },
    },
    50,
  )
  expect(queued.change.state).toBe('queued')
  await cancelIntentTurn(bundle.persistence, actor, session.id)
  return { sessionId: session.id, changeId: queued.change.id }
}

describeEachProvider('RFC-384 intent bundle', (harness) => {
  test('passive construction builds each shared member once, freezes the output and reads no configuration', () => {
    const f = fixture(harness)
    const recording = harness.recordStatements()
    const timer = spyOn(globalThis, 'setTimeout'),
      interval = spyOn(globalThis, 'setInterval')
    const apply = spyOn(applyComposition, 'composeIntentApplyOperations')
    const artifacts = spyOn(applyComposition, 'composeIntentApplyArtifactLifecycle')
    const persistence = spyOn(persistenceComposition, 'composeIntentPersistence')
    const catalog = spyOn(resourceComposition, 'composeIntentResourceCatalogBinding')
    try {
      const bundle = composeDaemonIntentModules(f.input)
      expect(recording.statements).toEqual([])
      expect(timer).not.toHaveBeenCalled()
      expect(interval).not.toHaveBeenCalled()
      expect(f.reads()).toBe(0)
      for (const constructor of [apply, artifacts, persistence, catalog])
        expect(constructor).toHaveBeenCalledTimes(1)
      expect(Object.isFrozen(bundle)).toBe(true)
      expect(Object.keys(bundle).sort()).toEqual(
        [
          'persistence',
          'resourceCatalogFor',
          'graphValidation',
          'dumpAuxiliary',
          'events',
          'applyOperations',
          'dispatch',
          'routes',
          'maintenance',
          'queuedResumption',
        ].sort(),
      )
      expect(bundle.routes.intentApply).toBe(bundle.applyOperations)
      expect(bundle.routes.intentPersistence).toBe(bundle.persistence)
      expect(bundle.dispatch.persistence).toBe(bundle.persistence)
      expect(bundle.routes.resourceCatalogFor).toBe(bundle.resourceCatalogFor)
      expect(bundle.dispatch.resourceCatalogFor).toBe(bundle.resourceCatalogFor)
      expect(bundle.routes.events).toBe(bundle.dispatch.events)
      expect(bundle.routes.intentTurnRuntime.graphValidation).toBe(bundle.graphValidation)
      expect(bundle.dispatch.graphValidation).toBe(bundle.graphValidation)
      expect(bundle.routes.intentTurnRuntime.dumpAuxiliary).toBe(bundle.dumpAuxiliary)
      expect(bundle.dispatch.dumpAuxiliary).toBe(bundle.dumpAuxiliary)
      expect(Object.keys(bundle.routes.identityAccess)).toEqual(['directAuthority'])
      expect(bundle.dispatch.systemAgents).not.toBe(bundle.routes.intentTurnRuntime.systemAgents)
      expect(composeDaemonIntentModules(f.input).applyOperations).not.toBe(bundle.applyOperations)
    } finally {
      recording.stop()
      timer.mockRestore()
      interval.mockRestore()
      apply.mockRestore()
      artifacts.mockRestore()
      persistence.mockRestore()
      catalog.mockRestore()
    }
  })

  test('dump fallback reads the changed default on its next call, not a construction snapshot', async () => {
    const f = fixture(harness)
    await seedBuiltinRuntimes(runtimeRegistryPersistence(harness.db))
    const bundle = composeDaemonIntentModules(f.input)
    expect(f.reads()).toBe(0)
    expect((await bundle.dumpAuxiliary.runtimeInventory.resolveDefault()).name).toBe('opencode')
    f.update({ defaultRuntime: 'claude-code' })
    expect((await bundle.dumpAuxiliary.runtimeInventory.resolveDefault()).name).toBe('claude-code')
    expect(f.reads()).toBe(2)
  })

  test('a route apply appears in maintenance while in flight and disappears when complete', async () => {
    const f = fixture(harness),
      actor = await owner(f)
    const entered = deferred(),
      release = deferred()
    const original = applyComposition.composeIntentApplyArtifactLifecycle
    const lifecycle = spyOn(
      applyComposition,
      'composeIntentApplyArtifactLifecycle',
    ).mockImplementation((input) => {
      const selected = original(input)
      return {
        ...selected,
        async rollForward(...args) {
          entered.resolve()
          await release.promise
          return selected.rollForward(...args)
        },
      }
    })
    const bundle = composeDaemonIntentModules(f.input)
    lifecycle.mockRestore()
    const other = composeDaemonIntentModules(f.input)
    const { session } = await createIntentSession(
      bundle.persistence,
      intentResourceVisibility(bundle.resourceCatalogFor(actor)),
      actor,
      { message: 'commit draft' },
    )
    const canonical = canonicalIntentJson({
      $schema_version: 1,
      ops: [
        {
          opId: 'op-1',
          action: 'create',
          resourceType: 'agent',
          tempRef: '$new:agent',
          payload: {
            name: 'applied-rfc384',
            description: '',
            outputs: [],
            bodyMd: 'created by the route',
          },
        },
      ],
    })
    const draftHash = `sha256:${createHash('sha256').update(canonical).digest('hex')}`
    const draftId = ulid()
    await harness.db.insert(intentDrafts).values({
      id: draftId,
      sessionId: session.id,
      revision: 1,
      changesetJson: canonical,
      validationJson: '{"errors":[],"credentialFindings":[]}',
      draftHash,
      contextRevision: 0,
      createdAt: Date.now(),
    })
    await harness.db
      .update(intentSessions)
      .set({ currentDraftId: draftId })
      .where(eq(intentSessions.id, session.id))
    const pending = Promise.resolve(
      routes(bundle, actor).request(`/api/intent-sessions/${session.id}/commit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          clientMutationId: ulid(),
          draftRevision: 1,
          draftHash,
          decisions: [],
        }),
      }),
    )
    try {
      await Promise.race([
        entered.promise,
        pending.then((response) => {
          throw new Error(`apply did not enter: ${response.status}`)
        }),
      ])
      const active = bundle.maintenance.activeApplyJournalIds()
      expect(active).toHaveLength(1)
      expect(active).toEqual(bundle.applyOperations.activeJournalIds())
      expect(Object.isFrozen(active)).toBe(true)
      expect(other.maintenance.activeApplyJournalIds()).toEqual([])
      release.resolve()
      const response = await pending
      expect(response.status, await response.clone().text()).toBe(200)
      expect(((await response.json()) as { journalId: string }).journalId).toBe(active[0]!)
      expect(bundle.maintenance.activeApplyJournalIds()).toEqual([])
    } finally {
      release.resolve()
      await pending
    }
  })

  test('maintenance deltas buffer before queued startup and resume through worker bindings; HTTP fixtures stay on routes', async () => {
    const f = fixture(harness),
      actor = await owner(f)
    await seedBuiltinRuntimes(runtimeRegistryPersistence(harness.db))
    await updateRuntime(runtimeRegistryPersistence(harness.db), 'opencode', {
      model: 'openai/gpt-5',
      binaryPath: '/rfc384-selected-runtime',
    })
    await f.employee.platformTools.load()
    await f.employee.module.maintenance.ready()
    const workerBind = spyOn(f.input.observation.intentSystemAgentBinding, 'bindRuntime')
    const selectedHttp = f.input.observation.intentHttpSystemAgentBinding.withFixture(
      f.input.adapters!.httpTurnFixture!,
    )
    const httpBind = spyOn(selectedHttp, 'bindRuntime')
    const httpFixture = spyOn(
      f.input.observation.intentHttpSystemAgentBinding,
      'withFixture',
    ).mockReturnValue(selectedHttp)
    const bundle = composeDaemonIntentModules(f.input)
    const first = await seedQueued(f, bundle, actor),
      second = await seedQueued(f, bundle, actor)
    const seam: { handlers?: Parameters<MaintenanceServiceOptions['startSupervisor']>[1] } = {}
    const service = createMaintenanceService({
      provider: harness.applicationBinding.provider,
      appHome: f.input.appHome,
      configPath: join(f.input.appHome, 'config.json'),
      loadConfig: () => DEFAULT_CONFIG,
      fileSnapshotInFlight: () => false,
      openAdmissionStore: () => ({ store: createMaintenanceRunStore(harness.db) }),
      startSupervisor: (_config, handlers) => {
        seam.handlers = handlers
        return {
          wake() {},
          live: () => ({ state: 'ready', lastHeartbeatAt: null, error: null, active: null }),
          pause: async () => {},
          resume: async () => {},
          stop: async () => {},
          drain: async () => {},
        }
      },
      payloadSources: {
        activeTaskIds: () => [],
        activeIntentApplyJournalIds: bundle.maintenance.activeApplyJournalIds,
        activeResourceBundleApplyIds: () => [],
        bootIntentTurnIds: bundle.maintenance.bootTurnIds,
      },
      onIntentQueued: bundle.queuedResumption.enqueue,
    })
    let handle: ReturnType<typeof bundle.queuedResumption.runtimeFactory.start> | undefined
    const state = async (id: string) =>
      (
        await harness.db
          .select()
          .from(intentWorkingSetChanges)
          .where(eq(intentWorkingSetChanges.id, id))
      )[0]!.state
    const settled = (id: string) =>
      eventually(
        () => bundle.persistence.findSession(id),
        (row) => row !== null && row.inFlightTurnId === null,
      )
    try {
      await service.captureBootSnapshot()
      await service.start()
      seam.handlers!.onDelta('boot', 'intentRecovery', {
        kind: 'intent-queued',
        sessionIds: [first.sessionId, first.sessionId],
      })
      expect(await state(first.changeId)).toBe('queued')
      expect(f.calls.worker).toHaveLength(0)
      handle = bundle.queuedResumption.runtimeFactory.start()
      await eventually(
        () => state(first.changeId),
        (value) => value === 'applied',
      )
      await settled(first.sessionId)
      seam.handlers!.onDelta('later', 'intentRecovery', {
        kind: 'intent-queued',
        sessionIds: [second.sessionId],
      })
      await eventually(
        () => state(second.changeId),
        (value) => value === 'applied',
      )
      await settled(second.sessionId)
      expect((await bundle.persistence.listTurns(first.sessionId)).at(-1)?.kind).toBe('questions')
      expect((await bundle.persistence.listTurns(second.sessionId)).at(-1)?.kind).toBe('questions')
      expect(
        f.calls.worker,
        JSON.stringify(await bundle.persistence.listTurns(second.sessionId)),
      ).toHaveLength(2)
      expect(f.calls.http).toHaveLength(0)
      expect(workerBind).toHaveBeenCalledTimes(2)
      const response = await routes(bundle, actor).request('/api/intent-sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'HTTP only' }),
      })
      expect(response.status, await response.clone().text()).toBe(201)
      await settled(((await response.json()) as { id: string }).id)
      expect(f.calls.worker).toHaveLength(2)
      expect(f.calls.http).toHaveLength(1)
      expect(httpBind).toHaveBeenCalledTimes(1)
      expect(f.calls.worker.map((call) => call.runtimeBinary)).toEqual([
        '/rfc384-selected-runtime',
        '/rfc384-selected-runtime',
      ])
      expect(f.calls.http[0]!.runtimeBinary).toBe('/rfc384-selected-runtime')
      expect(f.calls.unselected).toBe(0)
      expect(f.errors).toEqual([])
    } finally {
      await service.stop()
      handle?.stop()
      await handle?.drain()
      workerBind.mockRestore()
      httpBind.mockRestore()
      httpFixture.mockRestore()
    }
  }, 15_000)

  test('queued admission failure uses the neutral message and error field', async () => {
    const f = fixture(harness),
      reported = deferred()
    const logs: unknown[] = []
    const bundle = composeDaemonIntentModules({
      ...f.input,
      configuration: {
        read: () => {
          throw new Error('selected-read-failed')
        },
      },
      log: {
        warn(message, fields) {
          logs.push({ message, fields })
          reported.resolve()
        },
      },
    })
    bundle.queuedResumption.enqueue(['queued'])
    const handle = bundle.queuedResumption.runtimeFactory.start()
    try {
      await reported.promise
      expect(logs).toEqual([
        {
          message: 'queued intent working-set admission failed',
          fields: { error: 'selected-read-failed' },
        },
      ])
    } finally {
      handle.stop()
      await handle.drain()
    }
  })
})

describeEachProvider('RFC-384 HTTP injection boundary', (harness) => {
  test('HTTP preserves the supplied intent routes without constructing fallback members', async () => {
    const f = fixture(harness),
      bundle = composeDaemonIntentModules(f.input)
    await f.employee.platformTools.load()
    await f.employee.module.maintenance.ready()
    const opened = await createProviderHttpCompositionFixture(harness, {
      token: 'rfc384-http',
      dbVersion: 0,
      appHome: f.input.appHome,
      secretBox: createSecretBoxFromKey(Buffer.alloc(32, 8)),
    })
    const apply = spyOn(applyComposition, 'composeIntentApplyOperations'),
      catalog = spyOn(resourceComposition, 'composeIntentResourceCatalogBinding'),
      persistence = spyOn(persistenceComposition, 'composeIntentPersistence')
    const http = opened.compose({
      core: f.core,
      resourceCatalog: f.tasks.resourceCatalog,
      digitalEmployee: f.employee,
      developmentAutomation: f.automation,
      intent: bundle,
    })
    expect(http.composition.intent).toBe(bundle.routes)
    expect(bundle.applyOperations).toBeDefined()
    expect(bundle.persistence).toBeDefined()
    expect(bundle.resourceCatalogFor).toBeDefined()
    try {
      for (const constructor of [apply, catalog, persistence])
        expect(constructor).not.toHaveBeenCalled()
    } finally {
      await opened.dispose()
      apply.mockRestore()
      catalog.mockRestore()
      persistence.mockRestore()
    }
  })
})

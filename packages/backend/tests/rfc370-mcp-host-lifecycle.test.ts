import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { McpSchema } from '@agent-workflow/shared'
import { SYSTEM_USER_ID } from '@/auth/actor'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  mcps,
  runtimes,
  mcpRuntimeTestSessions,
  mcpRuntimeTestTurns,
  mcpRuntimeTestEvents,
  mcpRuntimeTestCreateReceipts,
  mcpRuntimeTestSessionLeases,
} from '@/db/schema'
import { createMcpDiagnosticsApplication } from '@/modules/resource-catalog/composition/mcpDiagnostics'
import { composeMcpRuntimeTestProvider } from '@/modules/resource-catalog/composition/mcpRuntimeTestPersistence'
import type { McpRuntimeTestPersistence } from '@/modules/resource-catalog/application/mcps/runtimeTestPersistence'
import { killStaleRunProcessTree } from '@/util/process'
import { createMcpTransactionLifecycle } from '@/modules/resource-catalog/composition/mcpRuntimeTestPersistence'
import { composeMcpCatalog } from '@/modules/resource-catalog/composition/mcpOperations'
import { composeResourceCatalogFor } from '@/modules/resource-catalog/composition/providerResourceCatalog'
import { createIdentityAccessRuntime } from '@/modules/identity-access/composition'
import { ResourceOperationCoordinator } from '@/services/resourceOperationCoordinator'
import type {
  McpDiagnosticsEffects,
  McpDiagnosticRunResult,
  ResolvedTestRuntime,
} from '@/modules/resource-catalog/application/mcps/runtimeDiagnosticsEffects'
import type { McpDiagnosticsCaller } from '@/modules/resource-catalog/application/mcps/runtimeDiagnostics'
import { bindMcpDiagnosticsHostOwner } from '../src/cli/daemonHostExecutionOwners'
import { describeEachProvider } from './helpers/eachProvider'
import { admitTestDirectAuthority } from './helpers/identityAccessAuthority'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

async function eventually(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = performance.now() + 10_000
  while (!(await predicate())) {
    if (performance.now() >= deadline) throw new Error('MCP durable state was not observed')
    await Bun.sleep(10)
  }
}

function grant(provider: 'sqlite' | 'postgresql') {
  let active = true
  const context = {
    generation: 'mcp-host-generation',
    reference: Object.freeze({}),
    current() {
      expect(this).toBe(context)
      return active
    },
  }
  return {
    context,
    scope: { provider, generationId: context.generation, operationId: 'mcp-host-test' },
    lose() {
      active = false
    },
  }
}

const actor: McpDiagnosticsCaller = {
  user: { id: SYSTEM_USER_ID },
  permissions: { has: () => true },
}
const hash = 'a'.repeat(64)
const nativeId = '2fb0be7c-1147-4b61-987e-bbd826b48505'
function unexpected(): never {
  throw new Error('unexpected execution or implicit native startup')
}

async function fixture(
  db: ProviderNeutralDatabase,
  effectsFor?: (persistence: McpRuntimeTestPersistence) => Partial<McpDiagnosticsEffects>,
) {
  const mcp = McpSchema.parse({
    id: 'host-mcp',
    schemaVersion: 1,
    name: 'host-mcp',
    description: '',
    type: 'local',
    config: { command: ['unused-host-mcp-fixture'] },
    enabled: true,
    ownerUserId: SYSTEM_USER_ID,
    visibility: 'private',
    createdAt: 1000,
    updatedAt: 1000,
  })
  await db.insert(mcps).values({ ...mcp, config: JSON.stringify(mcp.config) })
  await db
    .insert(runtimes)
    .values({ id: 'host-runtime', name: 'host-runtime', protocol: 'opencode', enabled: true })
  const composedProvider = composeMcpRuntimeTestProvider(db)
  const provider = {
    persistence: { ...composedProvider.persistence },
    leaseOperations: { ...composedProvider.leaseOperations },
  }
  const runtime: ResolvedTestRuntime = {
    row: {
      id: 'host-runtime',
      name: 'host-runtime',
      protocol: 'opencode',
      enabled: true,
      binaryPath: null,
      configDirEnv: null,
      configDirName: null,
      probeFence: 0,
      model: null,
      variant: null,
      temperature: null,
      steps: null,
      maxSteps: null,
      isSandbox: false,
    },
    target: { kind: 'mcp-diagnostic-runtime-target', reference: Object.freeze({}) },
    label: 'selected-fixture-runtime',
    snapshotJson: '{}',
  }
  const timers: Array<{ canceled: boolean; callback: () => void; kind: string }> = []
  const calls: string[] = []
  const runEntered = deferred<Parameters<McpDiagnosticsEffects['runTurn']>[0]>()
  const runResult = deferred<McpDiagnosticRunResult>()
  const result: McpDiagnosticRunResult = {
    status: 'ok',
    exitCode: 0,
    stderrTail: '',
    durationMs: 1,
    capturedSessionId: nativeId,
    verifyAfterCapture: async () => undefined,
  }
  function timer(kind: string, callback: () => void) {
    const state = { kind, callback, canceled: false }
    timers.push(state)
    return {
      cancel() {
        state.canceled = true
      },
      unref() {},
    }
  }
  const effects: McpDiagnosticsEffects = {
    now: () => 1000,
    setTimeout(callback) {
      expect(this).toBe(effects)
      return timer('timeout', callback)
    },
    setInterval(callback) {
      expect(this).toBe(effects)
      return timer('interval', callback)
    },
    async resolveRuntime() {
      expect(this).toBe(effects)
      return runtime
    },
    supportsSession: () => true,
    createNativeSessionId: () => nativeId,
    workspaceReference: (id) => `host-fixture:${id}`,
    workspaceExists: () => true,
    cleanupWorkspace() {
      calls.push('cleanup')
      return { cleanupState: 'complete', cleanupErrorCode: null }
    },
    currentMcpHash: async () => hash,
    broadcast() {
      expect(this).toBe(effects)
      calls.push('broadcast')
    },
    hasExecution: (turn) => turn.spawnedAt !== null,
    reapTurn: unexpected,
    recoverReapedTurn: unexpected,
    captureTurnStart() {
      expect(this).toBe(effects)
      return { kind: 'mcp-diagnostic-turn-start', reference: Object.freeze({}) }
    },
    async runTurn(input) {
      expect(this).toBe(effects)
      expect(input.runtime).toBe(runtime)
      await input.assertSpawnAllowed()
      const accepted = await provider.persistence.recordSpawn({
        sessionId: input.session.id,
        turnId: input.turn.id,
        pid: null,
        spawnedAt: 1000,
        spawnBinaryPath: runtime.label,
        fenceAt: 1000,
      })
      expect(accepted).toBe(true)
      calls.push('run')
      runEntered.resolve(input)
      return runResult.promise
    },
    failedResult: unexpected,
  }
  if (effectsFor) Object.assign(effects, effectsFor(provider.persistence))
  const application = createMcpDiagnosticsApplication({
    ...provider,
    effects,
    executionMode: 'host',
    loadMcp: async () => mcp,
  })
  const execution = application.executionLifecycle
  if (execution === undefined) throw new Error('host lifecycle missing')
  const owner = bindMcpDiagnosticsHostOwner(execution)
  async function seed() {
    return provider.persistence.create({
      mcpId: mcp.id,
      ownerUserId: SYSTEM_USER_ID,
      clientCreateId: 'host-create',
      requestDigest: hash,
      sessionId: 'host-session',
      turnId: 'host-turn',
      mcpConfigHash: hash,
      runtimeRowId: runtime.row.id,
      runtimeName: runtime.row.name,
      runtimeProtocol: 'opencode',
      runtimeSnapshotJson: runtime.snapshotJson,
      runtimeBinaryPath: runtime.label,
      runtimeSessionId: nativeId,
      scratchRoot: 'host-fixture:host-session',
      message: 'keep this pending request',
      clientMessageId: 'host-message',
      now: 1000,
      hardDeadlineAt: 301000,
      receiptExpiresAt: 601000,
    })
  }
  return {
    application,
    execution,
    owner,
    provider,
    effects,
    mcp,
    runtime,
    timers,
    calls,
    seed,
    runEntered,
    runResult,
    result,
  }
}

async function facts(db: ProviderNeutralDatabase) {
  return {
    sessions: await db.select().from(mcpRuntimeTestSessions),
    turns: await db.select().from(mcpRuntimeTestTurns),
    events: await db.select().from(mcpRuntimeTestEvents),
    receipts: await db.select().from(mcpRuntimeTestCreateReceipts),
    leases: await db.select().from(mcpRuntimeTestSessionLeases),
  }
}

describeEachProvider('RFC-370 MCP host execution lifecycle', (harness) => {
  test('cold resource queries and disposal do not start boot, timers, claims or a runtime', async () => {
    const f = await fixture(harness.db)
    await f.seed()
    const before = await facts(harness.db)
    await expect(f.application.start()).rejects.toMatchObject({
      code: 'mcp-test-execution-unavailable',
    })
    await expect(
      f.application.create(actor, f.mcp, {
        clientCreateId: 'another-create',
        clientMessageId: 'another-message',
        message: 'new request',
        expectedMcpConfigHash: hash,
        runtimeName: f.runtime.row.name,
      }),
    ).rejects.toMatchObject({ code: 'mcp-test-execution-unavailable' })
    await f.application.reconcileDurableIntents()
    expect((await f.application.storedQueries.latest(actor, f.mcp.id))?.turns[0]?.status).toBe(
      'queued',
    )
    await f.application.pause()
    await f.application.dispose()
    expect(await facts(harness.db)).toEqual(before)
    expect(f.timers).toEqual([])
    expect(f.calls).toEqual([])
  })

  test('real resource updates retain durable cleanup intent across a cold application rebuild', async () => {
    const f = await fixture(harness.db)
    await f.seed()
    const identity = createIdentityAccessRuntime({ db: harness.db })
    const catalog = composeMcpCatalog({
      db: harness.db,
      coordinator: new ResourceOperationCoordinator(),
      nextMutationTimestamp: async (mcp) => mcp.updatedAt + 1,
      runtime: {
        prepareDelete: f.application.prepareMcpDelete.bind(f.application),
        reconcileDurableIntents: f.application.reconcileDurableIntents.bind(f.application),
      },
      lifecycle: createMcpTransactionLifecycle(),
      resourceCatalog: composeResourceCatalogFor({ db: harness.db }),
    })
    try {
      const authority = await admitTestDirectAuthority(identity.directAuthority, {
        source: 'daemon',
      })
      if (authority === null) throw new Error('fixture daemon authority missing')
      const current = await catalog.queries.get(authority.actor, { id: f.mcp.id })
      if (current === null) throw new Error('fixture MCP missing')
      const saved = await catalog.operations.update.invoke(authority.actor, {
        id: f.mcp.id,
        update: { enabled: false, expectedConfigHash: current.operationConfigHash },
      })
      expect(saved.enabled).toBe(false)
      const stored = await f.application.storedQueries.get(actor, f.mcp.id, 'host-session')
      expect(stored).toMatchObject({ status: 'ending', endReason: 'mcp-disabled' })
      await expect(f.application.prepareMcpDelete(f.mcp.id)).rejects.toMatchObject({
        code: 'mcp-test-cleanup-incomplete',
      })
      const beforeClose = await facts(harness.db)
      await f.application.dispose()
      const rebuilt = createMcpDiagnosticsApplication({
        ...f.provider,
        effects: f.effects,
        executionMode: 'host',
        loadMcp: unexpected,
      })
      expect(await rebuilt.storedQueries.get(actor, f.mcp.id, 'host-session')).toEqual(stored)
      await rebuilt.reconcileDurableIntents()
      await rebuilt.dispose()
      expect(await facts(harness.db)).toEqual(beforeClose)
      expect((await catalog.queries.get(authority.actor, { id: f.mcp.id }))?.enabled).toBe(false)
      expect(f.calls).toEqual([])
      expect(f.timers).toEqual([])
    } finally {
      await f.application.dispose()
      identity.shutdown()
    }
  })

  test('a failed boot read settles before a later owner retries the actual startup', async () => {
    const f = await fixture(harness.db),
      g = grant(harness.applicationBinding.provider)
    const list = f.provider.persistence.listBootSessions.bind(f.provider.persistence)
    const failure = new Error('fixture boot read failed')
    f.provider.persistence.listBootSessions = async () => {
      throw failure
    }
    await expect(f.owner.start(g)).rejects.toBe(failure)
    expect(f.calls).toEqual([])
    expect(f.timers).toEqual([])
    f.provider.persistence.listBootSessions = list
    const next = grant(harness.applicationBinding.provider)
    const handle = await f.owner.start(next)
    next.lose()
    await f.owner.quiesceAuthorityLoss({ context: next.context, handle })
    await f.owner.drainAuthorityLoss({ context: next.context, handle })
    expect(f.timers.every((timer) => timer.canceled)).toBe(true)
    await f.application.dispose()
  })

  test('loss during boot waits for the original read and does not recover pending turns', async () => {
    const f = await fixture(harness.db),
      g = grant(harness.applicationBinding.provider)
    await f.seed()
    const before = await facts(harness.db),
      entered = deferred(),
      release = deferred()
    const list = f.provider.persistence.listBootSessions.bind(f.provider.persistence)
    f.provider.persistence.listBootSessions = async () => {
      const rows = await list()
      entered.resolve()
      await release.promise
      return rows
    }
    const starting = f.owner.start(g)
    const rejected = Promise.resolve(starting).then(
      () => {
        throw new Error('lost startup unexpectedly became ready')
      },
      (error: unknown) => error,
    )
    await entered.promise
    g.lose()
    f.execution.quiesce(g.context)
    let drained = false
    const draining = f.execution.awaitDrained(g.context).then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    release.resolve()
    expect(await rejected).toMatchObject({ code: 'mcp-test-execution-unavailable' })
    await draining
    expect(await facts(harness.db)).toEqual(before)
    expect(f.timers).toEqual([])
    expect(f.calls).toEqual([])
    await f.application.dispose()
  })

  for (const delayed of ['runtime-read', 'native-claim'] as const) {
    test(`loss during ${delayed} preserves the request and the next owner dispatches it once`, async () => {
      const f = await fixture(harness.db),
        g = grant(harness.applicationBinding.provider)
      await f.seed()
      const entered = deferred(),
        release = deferred()
      if (delayed === 'runtime-read') {
        const resolve = f.effects.resolveRuntime.bind(f.effects)
        f.effects.resolveRuntime = async (name) => {
          const runtime = await resolve(name)
          entered.resolve()
          await release.promise
          return runtime
        }
      } else {
        const claim = f.provider.leaseOperations.claimPending.bind(f.provider.leaseOperations)
        f.provider.leaseOperations.claimPending = async (input) => {
          const token = await claim(input)
          entered.resolve()
          await release.promise
          return token
        }
      }
      const handle = await f.owner.start(g)
      await entered.promise
      g.lose()
      await f.owner.quiesceAuthorityLoss({ context: g.context, handle })
      let drained = false
      const draining = Promise.resolve(
        f.owner.drainAuthorityLoss({ context: g.context, handle }),
      ).then(() => {
        drained = true
      })
      await expect(
        f.execution.start(grant(harness.applicationBinding.provider).context),
      ).rejects.toThrow('prior-lifetime-not-drained')
      expect(drained).toBe(false)
      release.resolve()
      await draining
      const pending = await facts(harness.db)
      expect(pending.turns[0]).toMatchObject({
        id: 'host-turn',
        status: 'queued',
        startedAt: null,
        finishedAt: null,
        failureCode: null,
        cancelRequestedAt: null,
      })
      expect(pending.sessions[0]).toMatchObject({
        id: 'host-session',
        status: 'active',
        endReason: null,
        inFlightTurnId: 'host-turn',
      })
      expect(pending.receipts).toHaveLength(1)
      expect(pending.leases.every((row) => row.leaseTurnId === null)).toBe(true)
      expect(f.calls).not.toContain('run')
      expect(f.calls).not.toContain('cleanup')
      const next = grant(harness.applicationBinding.provider),
        nextHandle = await f.owner.start(next)
      const input = await f.runEntered.promise
      expect(input.turn.id).toBe('host-turn')
      next.lose()
      await f.owner.quiesceAuthorityLoss({ context: next.context, handle: nextHandle })
      expect(input.signal.aborted).toBe(false)
      f.runResult.resolve(f.result)
      await f.owner.drainAuthorityLoss({ context: next.context, handle: nextHandle })
      const settled = await facts(harness.db)
      expect(settled.turns).toHaveLength(1)
      expect(settled.turns[0]?.status).toBe('succeeded')
      expect(settled.sessions[0]?.endReason).toBeNull()
      expect(f.calls.filter((call) => call === 'run')).toHaveLength(1)
      expect(settled.leases[0]?.leaseTurnId).toBeNull()
      await f.application.dispose()
    })
  }

  test('loss drains issued run, verification, lease release and detached capture broadcast before ACK', async () => {
    const f = await fixture(harness.db),
      g = grant(harness.applicationBinding.provider)
    await f.seed()
    const broadcastEntered = deferred(),
      broadcastRelease = deferred()
    const verifyEntered = deferred(),
      verifyRelease = deferred()
    const leaseEntered = deferred(),
      leaseRelease = deferred(),
      settled = deferred()
    let holdCapture = false
    const snapshot = f.provider.persistence.loadBroadcastSnapshot.bind(f.provider.persistence)
    f.provider.persistence.loadBroadcastSnapshot = async (id) => {
      const row = await snapshot(id)
      if (holdCapture) {
        holdCapture = false
        broadcastEntered.resolve()
        await broadcastRelease.promise
      }
      return row
    }
    const settlement = f.provider.persistence.settleTurn.bind(f.provider.persistence)
    f.provider.persistence.settleTurn = async (input) => {
      const value = await settlement(input)
      settled.resolve()
      return value
    }
    const releaseLease = f.provider.leaseOperations.releaseAcknowledged.bind(
      f.provider.leaseOperations,
    )
    f.provider.leaseOperations.releaseAcknowledged = async (token) => {
      leaseEntered.resolve()
      await leaseRelease.promise
      return releaseLease(token)
    }
    const handle = await f.owner.start(g),
      input = await f.runEntered.promise
    holdCapture = true
    await input.sink.append({
      ts: 1000,
      kind: 'text',
      payload: JSON.stringify({ type: 'text', part: { type: 'text', text: 'retained result' } }),
      sessionId: nativeId,
      parentSessionId: null,
      source: 'stream',
    })
    await broadcastEntered.promise
    g.lose()
    await f.owner.quiesceAuthorityLoss({ context: g.context, handle })
    let drained = false
    const draining = Promise.resolve(
      f.owner.drainAuthorityLoss({ context: g.context, handle }),
    ).then(() => {
      drained = true
    })
    expect(input.signal.aborted).toBe(false)
    expect(
      (await f.application.storedQueries.get(actor, f.mcp.id, 'host-session')).turns[0]?.status,
    ).toBe('running')
    f.runResult.resolve({
      ...f.result,
      verifyAfterCapture: async () => {
        verifyEntered.resolve()
        await verifyRelease.promise
        return undefined
      },
    })
    await verifyEntered.promise
    expect(drained).toBe(false)
    verifyRelease.resolve()
    await leaseEntered.promise
    expect(drained).toBe(false)
    leaseRelease.resolve()
    await settled.promise
    expect(drained).toBe(false)
    expect(
      (await f.application.storedQueries.get(actor, f.mcp.id, 'host-session')).turns[0]?.status,
    ).toBe('succeeded')
    broadcastRelease.resolve()
    await draining
    expect(drained).toBe(true)
    expect(f.timers.every((timer) => timer.canceled)).toBe(true)
    expect(input.signal.aborted).toBe(false)
    await f.application.dispose()
  })

  for (const stage of [
    'write-after-commit',
    'capture-after-commit',
    'release-after-commit',
    'release-missed-once',
  ] as const) {
    test(`a ${stage} retries only the original settlement and never reissues its turn`, async () => {
      const f = await fixture(harness.db),
        g = grant(harness.applicationBinding.provider)
      const failed = deferred()
      let unconfirmed = true,
        captures = 0,
        writes = 0,
        releases = 0,
        verifications = 0
      const originalWrite = f.provider.persistence.settleTurn.bind(f.provider.persistence)
      const originalRelease = f.provider.leaseOperations.releaseAcknowledged.bind(
        f.provider.leaseOperations,
      )
      const markCaptureTerminal = f.provider.persistence.markCaptureTerminal.bind(
        f.provider.persistence,
      )
      f.provider.persistence.markCaptureTerminal = async (input) => {
        captures += 1
        await markCaptureTerminal(input)
        if (stage === 'capture-after-commit' && unconfirmed) {
          unconfirmed = false
          failed.resolve()
          throw new Error('original-capture-ack-lost')
        }
      }
      f.provider.persistence.settleTurn = async (input) => {
        writes += 1
        const receipt = await originalWrite(input)
        if (stage === 'write-after-commit' && unconfirmed) {
          unconfirmed = false
          failed.resolve()
          throw new Error('original-turn-write-ack-lost')
        }
        return receipt
      }
      f.provider.leaseOperations.releaseAcknowledged = async (token) => {
        releases += 1
        if (stage === 'release-missed-once' && unconfirmed) {
          unconfirmed = false
          failed.resolve()
          return false
        }
        const receipt = await originalRelease(token)
        if (stage === 'release-after-commit' && unconfirmed) {
          unconfirmed = false
          failed.resolve()
          throw new Error('original-lease-release-ack-lost')
        }
        return receipt
      }
      await f.seed()
      const handle = await f.owner.start(g)
      try {
        await f.runEntered.promise
        f.runResult.resolve({
          ...f.result,
          verifyAfterCapture: async () => {
            verifications += 1
            return undefined
          },
        })
        await failed.promise
        g.lose()
        await f.owner.quiesceAuthorityLoss({ context: g.context, handle })
        await f.owner.drainAuthorityLoss({ context: g.context, handle })
        const stored = await facts(harness.db)
        expect(stored.turns[0]?.status).toBe('succeeded')
        expect(stored.leases[0]?.leaseTurnId).toBeNull()
        expect(stored.turns.map((turn) => turn.id)).toEqual(['host-turn'])
        expect(f.calls.filter((call) => call === 'run')).toHaveLength(1)
        expect(verifications).toBe(1)
        expect(writes).toBe(stage === 'write-after-commit' ? 2 : 1)
        expect(captures).toBe(stage === 'capture-after-commit' ? 2 : 1)
        expect(releases).toBe(
          stage === 'write-after-commit' || stage === 'capture-after-commit' ? 1 : 2,
        )
        expect(stored.turns[0]?.captureState).toBe('complete')
      } finally {
        await f.application.dispose()
      }
    })
  }

  test('a failed close can retry the same unacknowledged release after its original callback becomes provable', async () => {
    const f = await fixture(harness.db),
      g = grant(harness.applicationBinding.provider)
    let proven = false,
      releases = 0
    const original = f.provider.leaseOperations.releaseAcknowledged.bind(f.provider.leaseOperations)
    f.provider.leaseOperations.releaseAcknowledged = async (token) => {
      releases += 1
      return proven ? original(token) : false
    }
    await f.seed()
    const handle = await f.owner.start(g)
    await f.runEntered.promise
    g.lose()
    await f.owner.quiesceAuthorityLoss({ context: g.context, handle })
    f.runResult.resolve(f.result)
    await expect(f.application.dispose()).rejects.toThrow('mcp-test-issued-lease-release-unproven')
    const before = releases
    proven = true
    await f.application.dispose()
    expect(releases).toBe(before + 1)
    expect((await facts(harness.db)).leases[0]?.leaseTurnId).toBeNull()
    expect(f.calls.filter((call) => call === 'run')).toHaveLength(1)
  })

  test('explicit recovery reaps only the original actual child, acknowledges its original lease and preserves its failed result', async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        '-e',
        "console.log('original-diagnostic-ready'); setInterval(() => {}, 1000)",
      ],
      {
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const reader = child.stdout.getReader()
    let f: Awaited<ReturnType<typeof fixture>> | undefined
    try {
      const ready = await reader.read()
      expect(new TextDecoder().decode(ready.value)).toContain('original-diagnostic-ready')
      reader.releaseLock()
      let reaps = 0
      f = await fixture(harness.db, (persistence) => ({
        hasExecution: (turn) => turn.pid !== null,
        reapTurn: async (turn, readNow) => {
          reaps += 1
          expect(turn.pid).toBe(child.pid)
          return killStaleRunProcessTree(
            { pid: turn.pid, startedAt: turn.startedAt, spawnBinaryPath: turn.spawnBinaryPath },
            { now: readNow() },
          )
        },
        recoverReapedTurn: (input) =>
          persistence.recoverQuarantined({
            sessionId: input.session.id,
            turnId: input.turn.id,
            expectedPid: input.turn.pid!,
            now: input.readNow(),
          }),
        cleanupWorkspace: (row) =>
          row.cleanupState === 'quarantined'
            ? { cleanupState: 'quarantined', cleanupErrorCode: row.cleanupErrorCode }
            : { cleanupState: 'complete', cleanupErrorCode: null },
      }))
      const g = grant(harness.applicationBinding.provider)
      await f.seed()
      const handle = await f.owner.start(g)
      await f.runEntered.promise
      await harness.db
        .update(mcpRuntimeTestTurns)
        .set({
          pid: child.pid,
          startedAt: 1000,
          spawnBinaryPath: process.execPath,
        })
        .where(eq(mcpRuntimeTestTurns.id, 'host-turn'))
      g.lose()
      await f.owner.quiesceAuthorityLoss({ context: g.context, handle })
      f.runResult.resolve({ ...f.result, status: 'unreaped' })
      await expect(
        Promise.resolve(f.owner.drainAuthorityLoss({ context: g.context, handle })),
      ).rejects.toThrow('issued-execution-unreaped')
      expect(reaps).toBe(0)
      const recovered = await f.application.recover(actor, f.mcp.id, 'host-session')
      expect(recovered.session.cleanupState).toBe('complete')
      await child.exited
      await f.owner.drainAuthorityLoss({ context: g.context, handle })
      expect(reaps).toBe(1)
      const stored = await facts(harness.db)
      expect(stored.turns[0]?.status).toBe('failed')
      expect(stored.turns[0]?.pid).toBeNull()
      expect(stored.leases[0]?.leaseTurnId).toBeNull()
      expect(f.calls.filter((call) => call === 'run')).toHaveLength(1)
    } finally {
      if (child.exitCode === null) child.kill()
      await child.exited
      if (f) await f.application.dispose()
    }
  }, 30_000)

  for (const missing of ['no-pid', 'command-mismatch', 'recovery-ack-missed'] as const) {
    test(`explicit recovery keeps ${missing} quarantined without releasing the original lease or executing again`, async () => {
      let reaps = 0,
        recoveries = 0
      const f = await fixture(harness.db, () => ({
        hasExecution: (turn) => turn.pid !== null,
        reapTurn: async () => {
          reaps += 1
          return missing === 'command-mismatch' ? 'command-mismatch' : 'not-alive'
        },
        recoverReapedTurn: async () => {
          recoveries += 1
          return false
        },
        cleanupWorkspace: (row) =>
          row.cleanupState === 'quarantined'
            ? { cleanupState: 'quarantined', cleanupErrorCode: row.cleanupErrorCode }
            : { cleanupState: 'complete', cleanupErrorCode: null },
      }))
      const g = grant(harness.applicationBinding.provider)
      await f.seed()
      const handle = await f.owner.start(g)
      await f.runEntered.promise
      if (missing !== 'no-pid') {
        await harness.db
          .update(mcpRuntimeTestTurns)
          .set({
            pid: 12345,
            startedAt: 1000,
            spawnBinaryPath: '/original-diagnostic',
          })
          .where(eq(mcpRuntimeTestTurns.id, 'host-turn'))
      }
      g.lose()
      await f.owner.quiesceAuthorityLoss({ context: g.context, handle })
      f.runResult.resolve({ ...f.result, status: 'unreaped' })
      await expect(
        Promise.resolve(f.owner.drainAuthorityLoss({ context: g.context, handle })),
      ).rejects.toThrow('mcp-test-issued-execution-unreaped')
      await expect(f.application.recover(actor, f.mcp.id, 'host-session')).rejects.toMatchObject({
        code: 'mcp-test-recovery-unproven',
      })
      const stored = await facts(harness.db)
      expect(stored.sessions[0]?.cleanupState).toBe('quarantined')
      expect(stored.turns[0]?.status).toBe('failed')
      expect(stored.turns[0]?.pid).toBe(missing === 'no-pid' ? null : 12345)
      expect(stored.leases[0]?.leaseTurnId).toBe('host-turn')
      expect(reaps).toBe(missing === 'no-pid' ? 0 : 1)
      expect(recoveries).toBe(missing === 'recovery-ack-missed' ? 1 : 0)
      expect(f.calls.filter((call) => call === 'run')).toHaveLength(1)
      await expect(f.application.dispose()).rejects.toThrow('mcp-test-issued-execution-unreaped')
    })
  }

  test('the original healthy owner reconciles quarantine before retrying its retained settlement', async () => {
    let reaps = 0
    const f = await fixture(harness.db, (persistence) => ({
      hasExecution: (turn) => turn.pid !== null,
      reapTurn: async () => {
        reaps += 1
        return 'not-alive'
      },
      recoverReapedTurn: (input) =>
        persistence.recoverQuarantined({
          sessionId: input.session.id,
          turnId: input.turn.id,
          expectedPid: input.turn.pid!,
          now: input.readNow(),
        }),
      cleanupWorkspace: (row) =>
        row.cleanupState === 'quarantined'
          ? { cleanupState: 'quarantined', cleanupErrorCode: row.cleanupErrorCode }
          : { cleanupState: 'complete', cleanupErrorCode: null },
    }))
    const g = grant(harness.applicationBinding.provider)
    await f.seed()
    const handle = await f.owner.start(g)
    await f.runEntered.promise
    await harness.db
      .update(mcpRuntimeTestTurns)
      .set({
        pid: 12345,
        startedAt: 1000,
        spawnBinaryPath: '/original-diagnostic',
      })
      .where(eq(mcpRuntimeTestTurns.id, 'host-turn'))
    f.runResult.resolve({ ...f.result, status: 'unreaped' })
    // Observe the actual retained result rather than assuming one microtask
    // completes the asynchronous persistence and detached capture tails.
    await eventually(
      async () => (await facts(harness.db)).sessions[0]?.cleanupState === 'quarantined',
    )
    f.timers.find((timer) => timer.kind === 'interval' && !timer.canceled)!.callback()
    await eventually(async () => (await facts(harness.db)).sessions[0]?.cleanupState === 'complete')
    g.lose()
    await f.owner.quiesceAuthorityLoss({ context: g.context, handle })
    await f.owner.drainAuthorityLoss({ context: g.context, handle })
    expect(reaps).toBe(1)
    expect((await facts(harness.db)).leases[0]?.leaseTurnId).toBeNull()
    expect(f.calls.filter((call) => call === 'run')).toHaveLength(1)
    await f.application.dispose()
  })

  for (const unproven of ['unreaped', 'release-missed'] as const) {
    test(`an ${unproven} receipt retains its durable outcome and cannot acknowledge host drain`, async () => {
      const f = await fixture(harness.db),
        g = grant(harness.applicationBinding.provider)
      await f.seed()
      if (unproven === 'release-missed')
        f.provider.leaseOperations.releaseAcknowledged = async () => false
      const handle = await f.owner.start(g)
      await f.runEntered.promise
      g.lose()
      await f.owner.quiesceAuthorityLoss({ context: g.context, handle })
      f.runResult.resolve(unproven === 'unreaped' ? { ...f.result, status: 'unreaped' } : f.result)
      const message =
        unproven === 'unreaped'
          ? 'mcp-test-issued-execution-unreaped'
          : 'mcp-test-issued-lease-release-unproven'
      await expect(
        Promise.resolve(f.owner.drainAuthorityLoss({ context: g.context, handle })),
      ).rejects.toThrow(message)
      await expect(f.owner.start(grant(harness.applicationBinding.provider))).rejects.toThrow(
        'prior-lifetime-not-drained',
      )
      const stored = await f.application.storedQueries.get(actor, f.mcp.id, 'host-session')
      expect(stored.turns[0]?.status).toBe(unproven === 'unreaped' ? 'failed' : 'succeeded')
      expect((await facts(harness.db)).leases[0]?.leaseTurnId).toBe('host-turn')
      expect(f.timers.every((timer) => timer.canceled)).toBe(true)
      await expect(f.application.dispose()).rejects.toThrow(message)
    })
  }

  test('a delayed deadline read cannot install a timer after loss and is part of drain', async () => {
    const f = await fixture(harness.db),
      g = grant(harness.applicationBinding.provider)
    const entered = deferred(),
      release = deferred()
    let first = true
    f.provider.persistence.nextDeadline = async () => {
      if (first) {
        first = false
        entered.resolve()
        await release.promise
        return 1001
      }
      return null
    }
    const handle = await f.owner.start(g)
    await entered.promise
    g.lose()
    await f.owner.quiesceAuthorityLoss({ context: g.context, handle })
    let drained = false
    const draining = Promise.resolve(
      f.owner.drainAuthorityLoss({ context: g.context, handle }),
    ).then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    release.resolve()
    await draining
    expect(f.timers.map((timer) => timer.kind)).toEqual(['interval'])
    expect(f.timers[0]?.canceled).toBe(true)
    await f.application.dispose()
  })

  test('ordinary owner pause still cancels through the original shutdown policy', async () => {
    const f = await fixture(harness.db),
      g = grant(harness.applicationBinding.provider)
    await f.seed()
    const handle = await f.owner.start(g),
      input = await f.runEntered.promise
    input.signal.addEventListener(
      'abort',
      () => f.runResult.resolve({ ...f.result, status: 'aborted', exitCode: null }),
      { once: true },
    )
    await handle.stop()
    await handle.drain()
    expect(input.signal.aborted).toBe(true)
    expect((await f.provider.persistence.loadTurn('host-turn'))?.failureCode).toBe(
      'mcp-test-daemon-shutdown',
    )
    expect((await facts(harness.db)).leases[0]?.leaseTurnId).toBeNull()
    await handle.stop()
    await f.application.dispose()
  })

  test('an explicit cancel during a held admission remains canceled after authority loss', async () => {
    const f = await fixture(harness.db),
      g = grant(harness.applicationBinding.provider)
    await f.seed()
    const entered = deferred(),
      release = deferred()
    f.effects.resolveRuntime = async () => {
      entered.resolve()
      await release.promise
      return f.runtime
    }
    const handle = await f.owner.start(g)
    await entered.promise
    await f.application.cancel(actor, f.mcp.id, 'host-session', { turnId: 'host-turn' })
    g.lose()
    await f.owner.quiesceAuthorityLoss({ context: g.context, handle })
    release.resolve()
    await f.owner.drainAuthorityLoss({ context: g.context, handle })
    expect((await f.provider.persistence.loadTurn('host-turn'))?.status).toBe('canceled')
    expect(f.calls).not.toContain('run')
    await f.application.dispose()
  })

  test('defer refuses a real execution receipt and never rewrites its turn', async () => {
    const f = await fixture(harness.db)
    await f.seed()
    await f.provider.persistence.admitTurn({
      sessionId: 'host-session',
      turnId: 'host-turn',
      now: 1000,
      idleDeadlineAt: 601000,
    })
    await f.provider.persistence.recordSpawn({
      sessionId: 'host-session',
      turnId: 'host-turn',
      pid: null,
      spawnedAt: 1000,
      spawnBinaryPath: 'selected-execution',
      fenceAt: 1000,
    })
    const before = await facts(harness.db)
    expect(
      await f.provider.persistence.deferUnspawnedTurn({
        sessionId: 'host-session',
        turnId: 'host-turn',
      }),
    ).toBe(false)
    expect(await facts(harness.db)).toEqual(before)
    await f.application.dispose()
  })
})

import { expect, test } from 'bun:test'
import type { Mcp } from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import { createCrewStationMcpDiagnosticsEffects } from '@/modules/resource-catalog/composition/crewstationMcpDiagnostics'
import type {
  McpDiagnosticRuntime,
  McpDiagnosticEventSink,
} from '@/modules/resource-catalog/application/mcps/runtimeDiagnosticsEffects'
import type {
  McpRuntimeTestSessionRecord,
  McpRuntimeTestTurnRecord,
} from '@/modules/resource-catalog/application/mcps/runtimeTestPersistence'
import type {
  HostedExecution,
  HostedExecutionSink,
} from '@/modules/task-execution/infrastructure/crewstation/execution'
import { HostedExecutionUnknownError } from '@/modules/task-execution/infrastructure/crewstation/execution'
import type { HostedExecutionBinding } from '@/modules/task-execution/infrastructure/crewstation/executionStore'
import type {
  BusinessResult,
  BusinessSubtask,
  BusinessEvent,
  CrewStationBusinessExecution,
} from '@/platform/crewstation/businessExecution'
import type { HostedStartupInventory } from '@/platform/crewstation/startupInventory'
import {
  hostedWorkspaceReference,
  parseHostedWorkspaceReference,
} from '@/modules/source-control/infrastructure/crewstation/workspaceReference'

function fixture(protocol: 'opencode' | 'claude-code' = 'opencode') {
  const calls: string[] = []
  const bindings = new Map<string, HostedExecutionBinding>()
  const row: McpDiagnosticRuntime = {
    id: 'runtime',
    name: 'hosted',
    protocol,
    binaryPath: null,
    enabled: true,
    configDirEnv: null,
    configDirName: null,
    probeFence: 7,
    model: null,
    variant: null,
    temperature: null,
    steps: null,
    maxSteps: null,
    isSandbox: false,
  }
  const mcp: Mcp = {
    id: 'mcp',
    name: 'example',
    type: 'local',
    config: { command: ['example-mcp'] },
    enabled: false,
    description: '',
    schemaVersion: 1,
    createdAt: 1,
    updatedAt: 1,
  }
  const result: BusinessResult = {
    exitCode: 0,
    reason: 'completed',
    stdout: '',
    stderr: '',
    truncated: false,
    finalCursor: '3',
  }
  let platform: BusinessSubtask = {
    id: 'subtask',
    taskId: 'parent',
    kind: 'agent',
    attempt: 1,
    state: 'succeeded',
    executionId: 'runner',
    result,
  }
  let unknown = false,
    released = true,
    writersSettled = true,
    parentExists = true,
    tested = true,
    admitted = true
  let inventory: HostedStartupInventory[] = [],
    inventoryCapability = true
  const observe = async (binding: HostedExecutionBinding, sink: HostedExecutionSink) => {
    await sink.started(binding)
    if (unknown) throw new HostedExecutionUnknownError(binding.executionId, 'transport unavailable')
    const events: BusinessEvent[] = [
      { type: 'session', data: { sessionId: 'native-session' } },
      ...inventory.map((data) => ({ type: 'startup-inventory', data })),
      { type: 'text', data: { text: 'observed output' } },
      { type: 'result', data: result },
    ].map((event, i) => ({
      ...event,
      taskId: 'parent',
      subtaskId: 'subtask',
      attempt: 1,
      cursor: String(i + 1),
      sourceEventId: String(i + 1),
      occurredAt: new Date(1000).toISOString(),
    })) as BusinessEvent[]
    for (const event of events) await sink.event(event)
    await sink.checkpoint()
    return {
      binding,
      result,
      timedOut: false,
      cancelled: false,
      settle: async () => {
        calls.push('settle')
        bindings.set(binding.executionId, { ...binding, state: 'settled', result })
      },
    }
  }
  const executions: HostedExecution = {
    find: async (id) => bindings.get(id) ?? null,
    workspaceSettled: async () =>
      writersSettled && [...bindings.values()].every((b) => b.state === 'settled'),
    async run(intent, sink) {
      calls.push('submit')
      const binding: HostedExecutionBinding = {
        ...intent,
        subtaskId: 'subtask',
        attempt: 1,
        materialDigest: 'digest',
        lastCursor: null,
        result: null,
        state: 'running',
        cancelRequested: false,
        cancelReason: null,
        epoch: 1,
        createdAt: 1000,
      }
      bindings.set(binding.executionId, binding)
      return observe(binding, sink)
    },
    async adopt(id, sink) {
      calls.push('adopt')
      return observe(bindings.get(id)!, sink)
    },
    async cancel() {
      calls.push('cancel')
    },
    observing: () => false,
  }
  const unused = async (): Promise<never> => {
    throw new Error('unexpected platform operation')
  }
  const api: CrewStationBusinessExecution = {
    createTask: unused,
    getTask: unused,
    closeTask: unused,
    pauseTask: unused,
    resumeTask: unused,
    listSubtasks: unused,
    submitSubtask: unused,
    cancelSubtask: unused,
    events: unused,
    readFile: unused,
    streamEvents: () => {
      throw new Error('unexpected platform stream')
    },
    async createMaterial() {
      calls.push('material')
      return { materialId: 'material', digest: 'digest', sizeBytes: 1 }
    },
    async getSubtask() {
      calls.push('read-subtask')
      return platform
    },
    async listFiles() {
      calls.push('list-files')
      return { path: '/work', entries: [], nextCursor: null }
    },
  }
  const effects = createCrewStationMcpDiagnosticsEffects(
    {
      db: new Proxy({} as ProviderNeutralDatabase, {
        get() {
          throw new Error('unexpected task effect')
        },
      }),
      api,
      executions,
      fence: {
        current: () => ({ epoch: 1, leaseId: 'lease', instanceId: 'instance' }),
        assertHeld: async () => undefined,
      },
      profiles: [{ protocol, model: null, agentProfileId: '01a13e6d-3e00-7000-9e3c-6a69d77164b3' }],
      capabilities: async () => ({
        protocolVersion: 3,
        releaseId: 'release',
        agentProfiles: [
          {
            agentProfileId: '01a13e6d-3e00-7000-9e3c-6a69d77164b3',
            computeProfileId: '01a13e6d-3e00-7000-9e3c-6a69d77164b3',
            profileRevision: 2,
            capabilities: {
              events: true,
              mcp: tested,
              usage: 'incremental',
              ...(inventoryCapability ? { startupInventoryVersion: 1 as const } : {}),
            },
          },
        ],
      }),
      reference: hostedWorkspaceReference,
      locate: parseHostedWorkspaceReference,
      helper: {
        async call<T>() {
          calls.push('prepare')
          return undefined as T
        },
      },
      workspaces: {
        async ensure() {
          calls.push('ensure')
          return { businessTaskId: 'parent' }
        },
        async open() {
          calls.push('open')
          return parentExists ? { businessTaskId: 'parent' } : null
        },
        async close() {
          calls.push('close')
          return released
        },
      },
    },
    {
      configuration: { read: () => ({ defaultRuntime: 'hosted' }) },
      loadRuntime: async () => row,
      isRuntimeEligible: () => true,
      observe:
        ({ callId }) =>
        async () => {
          calls.push(`observation:${callId}`)
          return {
            callId: callId!,
            accept: async () => undefined,
            usage: async () => undefined,
            finish: async () => undefined,
          }
        },
      now: () => 1000,
      persistence: {
        async recordSpawn(receipt) {
          expect(receipt.pid).toBeNull()
          expect(receipt.spawnBinaryPath).toBeNull()
          calls.push('ack')
          return admitted
        },
        async recoverQuarantined(receipt) {
          expect(receipt.expectedPid).toBeNull()
          expect(receipt.expectedSpawnedAt).toBeNull()
          calls.push('recover')
          return true
        },
      },
    },
  )
  const session: McpRuntimeTestSessionRecord = {
    id: 'session',
    mcpId: 'mcp',
    ownerUserId: 'owner',
    clientCreateId: 'create',
    clientCreateDigest: 'digest',
    status: 'active',
    endReason: null,
    mcpConfigHash: 'hash',
    runtimeRowId: 'runtime',
    runtimeName: 'hosted',
    runtimeProtocol: protocol,
    runtimeSnapshotJson: '',
    runtimeBinaryPath: 'display',
    runtimeSessionId: null,
    nativeSessionState: 'pending',
    inFlightTurnId: 'turn',
    turnSeq: 1,
    sessionVersion: 1,
    idleDeadlineAt: null,
    continuationBlockedReason: null,
    scratchRoot: effects.workspaceReference('session'),
    cleanupState: 'not-started',
    cleanupErrorCode: null,
    createdAt: 1000,
    updatedAt: 1000,
    endedAt: null,
  }
  const turn: McpRuntimeTestTurnRecord = {
    id: 'turn',
    sessionId: 'session',
    seq: 1,
    clientMessageId: 'message',
    promptText: 'diagnose',
    status: 'running',
    hardDeadlineAt: 2000,
    captureState: 'live',
    captureIncompleteReason: null,
    captureFirstEventSeq: null,
    captureLastEventSeq: 0,
    captureEventBytes: 0,
    cancelRequestedAt: null,
    pid: null,
    spawnedAt: null,
    spawnBinaryPath: null,
    exitCode: null,
    failureCode: null,
    stderrTail: null,
    durationMs: null,
    startedAt: 1000,
    finishedAt: null,
    createdAt: 1000,
  }
  const events: Parameters<McpDiagnosticEventSink['append']>[0][] = []
  const sink: McpDiagnosticEventSink = {
    async append(event) {
      events.push(event)
    },
    async markRootSessionResetPending() {},
    async setRootSessionId(id) {
      calls.push('root:' + id)
    },
    async markTerminal() {
      calls.push('capture-terminal')
    },
  }
  const run = async (
    options: { enabled?: boolean; continuation?: boolean; denyStart?: boolean } = {},
  ) => {
    const runtime = await effects.resolveRuntime(null)
    return effects.runTurn({
      session: options.continuation ? { ...session, runtimeSessionId: 'native-session' } : session,
      turn: options.continuation ? { ...turn, seq: 2 } : turn,
      mcp: { ...mcp, enabled: options.enabled === true },
      runtime,
      sink,
      timeoutMs: 1000,
      signal: new AbortController().signal,
      assertSpawnAllowed: async () => {
        calls.push('admission')
        if (options.denyStart) throw new Error('canceled')
      },
      turnStart: effects.captureTurnStart({ session, turn, readNow: () => 1000 }),
    })
  }
  return {
    effects,
    session,
    turn,
    calls,
    events,
    bindings,
    run,
    row,
    inventory: (value: HostedStartupInventory[]) => {
      inventory = value
    },
    inventoryCapability: (value: boolean) => {
      inventoryCapability = value
    },
    unknown: (value: boolean) => {
      unknown = value
    },
    platform: (value: Partial<BusinessSubtask>) => {
      platform = { ...platform, ...value }
    },
    released: (value: boolean) => {
      released = value
    },
    writers: (value: boolean) => {
      writersSettled = value
    },
    parent: (value: boolean) => {
      parentExists = value
    },
    tested: (value: boolean) => {
      tested = value
    },
    admitted: (value: boolean) => {
      admitted = value
    },
  }
}

for (const protocol of ['opencode', 'claude-code'] as const) {
  test(`hosted MCP ${protocol} verifies the actual typed stream and preserves first observation on replay`, async () => {
    const f = fixture(protocol)
    const verified: HostedStartupInventory = {
      version: 1,
      state: 'verified',
      source: protocol === 'opencode' ? 'opencode-inventory' : 'claude-init',
      mcpServers: [{ name: 'example', status: 'connected' }],
      skills: ['actual-skill'],
    }
    f.inventory([verified, { version: 1, state: 'unavailable', reason: 'late-duplicate' }])
    const result = await f.run()
    expect(result.status).toBe('ok')
    expect(await result.verifyAfterCapture()).toMatchObject({
      observation: 'verified',
      mcpUnusable: [],
    })
    expect(f.events.some((event) => event.kind === 'startup_inventory')).toBe(false)
    const cold = await f.run()
    expect(await cold.verifyAfterCapture()).toMatchObject({ observation: 'verified' })
    expect(f.calls.filter((value) => value === 'submit')).toHaveLength(1)
  })

  test(`hosted MCP ${protocol} never turns a missing or malformed report into success`, async () => {
    const f = fixture(protocol)
    f.inventory([{ version: 1, state: 'malformed', reason: 'inventory-parse-failed' }])
    const result = await f.run()
    expect(result.status).toBe('ok')
    expect(await result.verifyAfterCapture()).toMatchObject({
      observation: 'malformed',
      observationReason: 'inventory-parse-failed',
    })
  })
  test(`hosted MCP ${protocol} shares normalized capture and durable turn identity without a local PID`, async () => {
    const f = fixture(protocol)
    const first = await f.run()
    expect(first.status).toBe('ok')
    expect(first.capturedSessionId).toBe('native-session')
    expect(f.calls.indexOf('ack')).toBeLessThan(f.calls.indexOf('root:native-session'))
    expect(f.events.length).toBeGreaterThan(0)
    expect(
      f.events.every((event) =>
        event.externalEventId?.startsWith('agent:mcp-test:session:mcp:turn:'),
      ),
    ).toBe(true)
    expect(await first.verifyAfterCapture()).toMatchObject({ observation: 'unavailable' })
    await f.run()
    expect(f.calls.filter((c) => c === 'submit')).toHaveLength(1)
    expect(f.calls.filter((c) => c === 'adopt')).toHaveLength(1)
    expect(f.calls.filter((c) => c === 'material')).toHaveLength(1)
    expect(f.calls.filter((c) => c.startsWith('observation:'))).toEqual([
      'observation:aw-hosted-mcp:session:turn',
      'observation:aw-hosted-mcp:session:turn',
    ])
  })
}

test('enabled MCP material is explicitly blocked until the platform native-material contract is available', async () => {
  const f = fixture()
  const result = await f.run({ enabled: true })
  expect(result.status).toBe('spawn-failed')
  expect(result.stderrTail).toContain('CrewStation native configuration materials')
  expect(f.calls).not.toContain('submit')
})

test('MCP continuation preserves the exact native session and start admission precedes external work', async () => {
  const f = fixture()
  await f.run({ continuation: true })
  expect([...f.bindings.values()][0]?.request).toMatchObject({ resumeSessionId: 'native-session' })
  const denied = fixture()
  expect((await denied.run({ denyStart: true })).status).toBe('spawn-failed')
  expect(denied.calls).toEqual(['admission'])
})

test('unknown receipts, changed attempts and restored bindings cannot be reaped or garbage collected', async () => {
  const f = fixture()
  f.unknown(true)
  // §9.2 V1: an observation that can no longer be continued fails the turn
  // with its reason (retryable like any failed turn); the workspace stays held
  // while the binding has not settled.
  expect((await f.run()).status).toBe('exit-nonzero')
  expect(await f.effects.hasExecution(f.turn)).toBe(true)
  const cleanup = {
    scratchRoot: f.session.scratchRoot,
    cleanupState: 'pending' as const,
    cleanupErrorCode: null,
  }
  expect((await f.effects.cleanupWorkspace(cleanup)).cleanupState).toBe('pending')
  f.platform({ attempt: 2 })
  expect(await f.effects.reapTurn(f.turn, () => 1000)).toBe('kill-failed')
  expect(f.calls).not.toContain('adopt')
  f.platform({ attempt: 1 })
  const binding = [...f.bindings.values()][0]!
  f.bindings.set(binding.executionId, {
    ...binding,
    cancelRequested: true,
    cancelReason: 'restored',
  })
  expect(await f.effects.reapTurn(f.turn, () => 1000)).toBe('kill-failed')
  f.bindings.set(binding.executionId, { ...binding, subtaskId: null, attempt: null })
  expect(await f.effects.reapTurn(f.turn, () => 1000)).toBe('kill-failed')
  expect(f.calls.filter((c) => c === 'submit')).toHaveLength(1)
  expect(f.calls).not.toContain('cancel')
  expect(f.calls).not.toContain('close')
})

test('recovery reads the original terminal attempt, then cleanup waits for physical parent release', async () => {
  const f = fixture()
  f.unknown(true)
  await f.run()
  f.unknown(false)
  expect(await f.effects.reapTurn(f.turn, () => 1000)).toBe('not-alive')
  expect(
    await f.effects.recoverReapedTurn({ session: f.session, turn: f.turn, readNow: () => 1000 }),
  ).toBe(true)
  f.released(false)
  const candidate = {
    scratchRoot: f.session.scratchRoot,
    cleanupState: 'pending' as const,
    cleanupErrorCode: null,
  }
  expect((await f.effects.cleanupWorkspace(candidate)).cleanupState).toBe('pending')
  f.released(true)
  expect((await f.effects.cleanupWorkspace(candidate)).cleanupState).toBe('complete')
  expect(
    (await f.effects.cleanupWorkspace({ ...candidate, scratchRoot: '/tmp/another-session' }))
      .cleanupState,
  ).toBe('quarantined')
})

test('workspace inspection never provisions a missing parent and rejects foreign workspace references', async () => {
  const f = fixture()
  f.parent(false)
  expect(await f.effects.workspaceExists(f.session.scratchRoot)).toBe(false)
  // `open` resumes a paused parent but never allocates a missing one (§9.2 V3).
  expect(f.calls).toEqual(['open'])
  expect(await f.effects.workspaceExists(hostedWorkspaceReference('another-owner', '/work'))).toBe(
    false,
  )
  expect(f.calls).not.toContain('ensure')
})

test('runtime snapshots include platform profile revision, require tested MCP capability and reject host binaries', async () => {
  const f = fixture()
  const runtime = await f.effects.resolveRuntime(null)
  expect(JSON.parse(runtime.snapshotJson)).toMatchObject({
    tested: { profileRevision: 2 },
    releaseId: 'release',
  })
  f.inventoryCapability(false)
  await expect(f.effects.resolveRuntime(null)).rejects.toMatchObject({
    code: 'mcp-test-runtime-unsupported',
  })
  f.inventoryCapability(true)
  f.tested(false)
  await expect(f.effects.resolveRuntime(null)).rejects.toMatchObject({
    code: 'mcp-test-runtime-unsupported',
  })
  f.tested(true)
  Object.assign(f.row, { binaryPath: '/usr/bin/local-runtime' })
  await expect(f.effects.resolveRuntime(null)).rejects.toMatchObject({
    code: 'mcp-test-runtime-unsupported',
  })
  Object.assign(f.row, { binaryPath: null, configDirName: '../other-runtime' })
  await expect(f.effects.resolveRuntime(null)).rejects.toMatchObject({
    code: 'mcp-test-runtime-unsupported',
  })
})

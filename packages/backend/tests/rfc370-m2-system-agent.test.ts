import { createCrewStationRuntimeManagement } from '@/modules/task-execution/composition/crewstationRuntimeManagement'
import type { RuntimeRegistryOperations } from '@/modules/runtime-management/application/ports/runtimeRegistry'
import type { HostedRuntimeCapabilities } from '@/modules/runtime-management/public/types'
import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { createCrewStationSystemAgentRunFamily } from '@/modules/task-execution/composition/crewstationSystemAgentRunFamily'
import { executeTaskImageSystemWorkspace } from '@/modules/runtime-management/composition/taskImageMaterial'
import type {
  HostedExecution,
  HostedExecutionSink,
} from '@/modules/task-execution/infrastructure/crewstation/execution'
import { HostedExecutionUnknownError } from '@/modules/task-execution/infrastructure/crewstation/execution'
import type { HostedExecutionBinding } from '@/modules/task-execution/infrastructure/crewstation/executionStore'
import type {
  BusinessEvent,
  BusinessResult,
  CrewStationBusinessExecution,
  CreateBusinessMaterial,
} from '@/platform/crewstation/businessExecution'
import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'
import type { SystemAgentEventSinkV1 } from '@/modules/runtime-management/public/participants'
import type { SystemAgentObservationFactory } from '@/modules/task-execution/application/ports/systemAgentObservation'
import { hostedWorkspaceReference } from '@/modules/source-control/infrastructure/crewstation/workspaceReference'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'aw-hosted-system-'))
  const bindings = new Map<string, HostedExecutionBinding>()
  const helperReceipts = new Map<string, unknown>()
  const materials: CreateBusinessMaterial[] = []
  const calls: string[] = []
  let submissions = 0
  let adoptions = 0
  let unknown = false
  let echoPrompt = false
  let settleError = false
  const result: BusinessResult = {
    exitCode: 0,
    reason: 'completed',
    stdout: '',
    stderr: '',
    truncated: false,
    finalCursor: '3',
  }
  const event = (cursor: string, data: Pick<BusinessEvent, 'type' | 'data'>) =>
    ({
      taskId: 'parent',
      subtaskId: 'agent',
      attempt: 1,
      cursor,
      sourceEventId: cursor,
      occurredAt: new Date(1000).toISOString(),
      ...data,
    }) as BusinessEvent
  const observe = async (binding: HostedExecutionBinding, sink: HostedExecutionSink) => {
    await sink.started(binding)
    if (unknown) throw new HostedExecutionUnknownError(binding.executionId, 'platform unavailable')
    await sink.event(event('1', { type: 'session', data: { sessionId: 'native-session' } }))
    await sink.event(
      event('2', {
        type: 'text',
        data: {
          text:
            echoPrompt && binding.request.kind === 'agent'
              ? binding.request.prompt.match(/awsmoke-[a-f0-9]{16}/)![0]
              : '<port name="result">done</port>',
        },
      }),
    )
    await sink.event(event('3', { type: 'result', data: result }))
    await sink.checkpoint()
    return {
      binding,
      result,
      timedOut: false,
      cancelled: false,
      settle: async () => {
        if (settleError) throw new Error('projection ACK unavailable')
        bindings.set(binding.executionId, { ...binding, state: 'settled', result })
      },
    }
  }
  const executions: HostedExecution = {
    workspaceSettled: async (taskId, path) =>
      [...bindings.values()].every(
        (binding) =>
          binding.taskId !== taskId ||
          binding.state === 'settled' ||
          !binding.request.cwd?.startsWith(path),
      ),
    find: async (id) => bindings.get(id) ?? null,
    async run(intent, sink) {
      submissions++
      const binding: HostedExecutionBinding = {
        ...intent,
        subtaskId: 'agent',
        attempt: 1,
        materialDigest: 'material-digest',
        lastCursor: null,
        result: null,
        state: 'running',
        cancelRequested: false,
        cancelReason: null,
        epoch: 1,
        createdAt: 1000,
      }
      bindings.set(intent.executionId, binding)
      return observe(binding, sink)
    },
    async adopt(id, sink) {
      adoptions++
      return observe(bindings.get(id)!, sink)
    },
    cancel: async () => undefined,
    observing: () => false,
  }
  const helper: WorkspaceHelper = {
    async call<T>(
      _taskId: string,
      operation: string,
      value: unknown,
      options?: Parameters<WorkspaceHelper['call']>[3],
    ): Promise<T> {
      expect(operation).toBe('system-workspace')
      const id = options?.operationId
      if (id && helperReceipts.has(id)) return helperReceipts.get(id) as T
      const result = await executeTaskImageSystemWorkspace(value, root)
      if (id) helperReceipts.set(id, result)
      return result as T
    },
  }
  const api = {
    async createMaterial(_taskId: string, material: CreateBusinessMaterial) {
      materials.push(material)
      return { materialId: 'material', digest: 'material-digest', sizeBytes: 1 }
    },
  } as CrewStationBusinessExecution
  const observations: SystemAgentObservationFactory = {
    async open(input) {
      calls.push(input.callId!)
      return {
        callId: input.callId!,
        accept: async () => undefined,
        usage: async () => undefined,
        finish: async () => undefined,
      }
    },
  }
  const inputs: Parameters<typeof createCrewStationSystemAgentRunFamily>[0] = {
    db: new Proxy({} as PersistenceDb, {
      get() {
        throw new Error('unexpected Task database effect')
      },
    }),
    fence: {
      current: () => ({ epoch: 1, leaseId: 'lease', instanceId: 'instance' }),
      assertHeld: async () => undefined,
    },
    api,
    executions,
    helper,
    reference: hostedWorkspaceReference,
    profiles: [
      {
        protocol: 'opencode',
        model: 'model',
        agentProfileId: '01a13e6d-3e00-7000-9e3c-6a69d77164b3',
      },
    ],
    workspaces: { ensure: async () => ({ businessTaskId: 'parent' }) },
  }
  const factory = createCrewStationSystemAgentRunFamily(inputs)
  const open = () =>
    factory({
      appHome: () => {
        throw new Error('service filesystem must not be used')
      },
      observations: () => observations,
    })
  return {
    root,
    inputs,
    setEcho: () => {
      echoPrompt = true
    },
    setSettleError: () => {
      settleError = true
    },
    open,
    bindings,
    materials,
    calls,
    setUnknown: (value: boolean) => {
      unknown = value
    },
    counts: () => ({ submissions, adoptions }),
    close: () => rmSync(root, { recursive: true, force: true }),
  }
}

test('System Agent calls preserve named scratch, session events and identity across a fresh service binding', async () => {
  const f = fixture()
  try {
    const first = f.open().family
    const events = new Map<string, Parameters<SystemAgentEventSinkV1['append']>[0]>()
    const sink: SystemAgentEventSinkV1 = {
      append: async (event) => {
        events.set(event.externalEventId!, event)
      },
      setRootSessionId: async (id) => {
        expect(id).toBe('native-session')
      },
      markTerminal: async () => undefined,
    }
    const request = {
      feature: 'intent-builder',
      agentName: 'builder',
      prompt: 'build',
      systemPrompt: 'definition',
      protocol: 'opencode' as const,
      model: 'model',
      retainScratchOnSuccess: true,
      observationDemand: {
        kind: 'intent-turn',
        originalId: 'session',
        originalAttempt: 'turn',
        name: 'Intent',
      },
      seedFiles: [{ path: 'inputs/spec.txt', content: 'seed' }],
      eventSink: sink,
    }
    const result = await first.run({
      ...request,
      workspaceScope: first.workspaces.capture({ namespace: 'intent', name: 'turn' }),
    })
    expect(result.status).toBe('ok')
    expect(result.eventText).toBe('<port name="result">done</port>')
    expect(result.capturedSessionId).toBe('native-session')
    expect(result.outputEvidence.terminalResult).toBe('success')
    expect(result.scratchRetained).toBe(true)
    expect(f.materials[0]?.systemPrompt).toBe('definition')
    const binding = [...f.bindings.values()][0]!
    expect(binding.request.kind).toBe('agent')
    const cwd = binding.request.cwd!
    expect(readFileSync(join(f.root, cwd.slice('/work/'.length), 'inputs/spec.txt'), 'utf8')).toBe(
      'seed',
    )
    const second = f.open().family
    const scope = second.workspaces.capture({ namespace: 'intent', name: 'turn' })
    const replay = await second.run({ ...request, workspaceScope: scope })
    expect(replay.eventText).toBe(result.eventText)
    expect(f.counts()).toEqual({ submissions: 1, adoptions: 1 })
    expect(f.materials).toHaveLength(1)
    expect(f.calls[0]).toBe(f.calls[1])
    expect(
      [...events.keys()].every(
        (key) => typeof key === 'string' && key.startsWith(binding.executionId),
      ),
    ).toBe(true)
    expect(events.size).toBe(3)
    expect(
      await second.retainedContents.release({
        retainedRef: replay.retainedRef,
        scope: second.workspaces.withName(scope, 'other'),
      }),
    ).toEqual({ removed: false, reason: 'unsafe-path' })
    const coldCleanup = f.open().family
    expect(
      await coldCleanup.retainedContents.release({
        retainedRef: result.retainedRef,
        scope: coldCleanup.workspaces.capture({ namespace: 'intent', name: 'turn' }),
      }),
    ).toEqual({ removed: true })
    expect(existsSync(join(f.root, cwd.slice('/work/'.length)))).toBe(false)
  } finally {
    f.close()
  }
})

test('an unknown remote System Agent keeps its workspace and is adopted before it can be released', async () => {
  const f = fixture()
  try {
    f.setUnknown(true)
    const first = f.open().family
    const request = {
      feature: 'memory-distill',
      agentName: 'distiller',
      prompt: 'distill',
      systemPrompt: '',
      protocol: 'opencode' as const,
      model: 'model',
      observationDemand: {
        kind: 'memory-distill',
        originalId: 'job',
        originalAttempt: '1',
        name: 'Memory',
      },
    }
    const result = await first.run({
      ...request,
      workspaceScope: first.workspaces.capture({ namespace: 'shared', name: 'job' }),
    })
    // §9.2 V1: an observation that cannot continue fails the run with its
    // reason; its unsettled binding still keeps the scratch until adopted.
    expect(result.status).toBe('exit-nonzero')
    expect(result.scratchRetained).toBe(true)
    const coldCleanup = f.open().family
    expect(
      await coldCleanup.retainedContents.release({
        retainedRef: result.retainedRef,
        scope: coldCleanup.workspaces.capture({ namespace: 'shared', name: 'job' }),
      }),
    ).toEqual({ removed: false, reason: 'remove-failed' })
    f.setUnknown(false)
    const second = f.open().family
    const completed = await second.run({
      ...request,
      workspaceScope: second.workspaces.capture({ namespace: 'shared', name: 'job' }),
    })
    expect(completed.status).toBe('ok')
    expect(f.counts()).toEqual({ submissions: 1, adoptions: 1 })
    expect(completed.scratchRetained).toBe(false)
  } finally {
    f.close()
  }
})

for (const failure of [false, true])
  test(`hosted runtime smoke uses mapped model and durable settlement (failure=${failure})`, async () => {
    const f = fixture()
    f.setEcho()
    if (failure) f.setSettleError()
    const capabilities: HostedRuntimeCapabilities = {
      protocolVersion: 3,
      releaseId: 'release',
      agentProfiles: [
        {
          agentProfileId: f.inputs.profiles[0]!.agentProfileId,
          computeProfileId: '01a13e6d-3e00-7000-9e3c-6a69d77164b3',
          profileRevision: 2,
          capabilities: { events: true, usage: 'incremental', mcp: false },
        },
      ],
    }
    try {
      const management = createCrewStationRuntimeManagement({
        ...f.inputs,
        initialCapabilities: capabilities,
        capabilities: async () => capabilities,
      })({
        appHome: () => {
          throw new Error('native runtime path must not be read')
        },
        configuration: { current: () => ({}), withProbeReceiptFence: (action) => action() },
        runtimeRegistry: new Proxy({} as RuntimeRegistryOperations, {
          get() {
            throw new Error('unsaved probe must not read registry')
          },
        }),
        runtimeTests: { reconcileDurableIntents: async () => undefined },
      })
      const result = await management.runtimes.diagnostics.probe({
        kind: 'unsaved',
        protocol: 'opencode',
        binaryPath: 'cs-agent:opencode',
        model: 'model',
        isSandbox: false,
      })
      expect(result.smoke.conforms).toBe(!failure)
      const binding = [...f.bindings.values()][0]!
      expect(binding.request.kind).toBe('agent')
      if (binding.request.kind !== 'agent') throw new Error('wrong kind')
      expect(binding.request.agentProfileId).toBe(f.inputs.profiles[0]!.agentProfileId)
      expect(binding.state).toBe(failure ? 'running' : 'settled')
      if (failure) expect(result.smoke.detail).toContain('settlement requires recovery')
      expect(f.materials[0]!.systemPrompt).toContain('runtime smoke-test agent')
    } finally {
      f.close()
    }
  })

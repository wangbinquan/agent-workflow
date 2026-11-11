// RFC-408: the task control plane (engine/task/runTask.ts) runs on ports the composition binds. These
// cases lock the binding: every fact is read from the current options, the admission opens the task
// resource session only when the owner's execution authority is available, workspace / rule / lock
// capabilities forward to the implementations the orchestrator used to call, and `prepare` assembles
// the execution state eagerly (pools and locks at preparation, as before the drive's try) while the
// merge recovery, the engine bodies and the drive configuration run only when the control plane asks.
import { expect, test } from 'bun:test'
import { createTaskRunPorts } from '@/modules/task-execution/composition/taskEngineApplication'
import type { TaskExecutionRuntimeComponents } from '@/modules/task-execution/composition/taskExecutionComponents'
import { createExecutionScopeIndex } from '@/modules/task-execution/domain/executionScope'
import type { SchedulerRuntimeTopology } from '@/modules/task-execution/application/ports/taskExecutionTopology'
import type { BoundRunTaskOptions } from '@/modules/task-execution/composition/taskEngineRuntimeOptions'
import { triggerPreflightIssue } from '@/modules/resource-catalog/domain/triggerPreflight'

type Calls = Record<string, unknown[]>

function recorder(calls: Calls, name: string, result: unknown = undefined) {
  return (...args: unknown[]) => {
    ;(calls[name] ??= []).push(args.length === 1 ? args[0] : args)
    return Promise.resolve(result)
  }
}

function fixture() {
  const calls: Calls = {}
  const persistence = (label: string) => ({
    drive: { label: label + ':drive' },
    ownership: { label: label + ':ownership' },
    runtimeLifecycle: { label: label + ':runtimeLifecycle' },
    humanGateLifecycle: { label: label + ':humanGateLifecycle' },
    nodeRuns: { label: label + ':nodeRuns' },
  })
  const raw = {
    taskId: 'task-1',
    log: { name: 'log-1' } as unknown,
    executionContext: { sentinel: 'context-1' } as unknown,
    signal: undefined as AbortSignal | undefined,
    persistence: persistence('p-1') as unknown,
    appHome: '/app-home',
    identityAccess: {
      delegatedRequests: {
        forTaskExecution: recorder(calls, 'forTaskExecution', null) as (
          input: unknown,
        ) => Promise<unknown>,
      },
      taskExecutionResources: { label: 'resources' },
    },
    taskAgentRuns: { materialReferences: { label: 'material' } },
    ensureWorkspaceProfiles: undefined as boolean | undefined,
    workspaceExcludeProfiles: {
      bind(input: unknown) {
        ;(calls.bind ??= []).push(input)
        return { ensure: recorder(calls, 'ensure', { version: 1, digest: 'digest-1' }) }
      },
    },
    dynamicWorkflow: undefined as unknown,
    workgroupTurns: { drive: recorder(calls, 'turns', { kind: 'ok' }) },
    processConcurrencyScope: { label: 'scope' },
    maxConcurrentNodes: 3 as number | undefined,
    maxConcurrentScriptNodes: undefined as number | undefined,
    maxConcurrentCodeHostCalls: 5 as number | undefined,
    multiProcessSubprocessConcurrency: undefined as number | undefined,
    executionPermits: {
      getNodePoolSemaphore: (...args: unknown[]) => {
        ;(calls.pool ??= []).push(args)
        return { pool: args[1] }
      },
      getTaskWriteSem: (taskId: string) => {
        ;(calls.writeSem ??= []).push(taskId)
        return { writeSem: taskId }
      },
      getTaskFanoutSem: (...args: unknown[]) => {
        ;(calls.fanoutSem ??= []).push(args)
        return { fanoutSem: args[0] }
      },
    },
    codeHostConnections: { label: 'connections' },
    // RFC-449: injected with the connections; never part of the driver configuration.
    codeHostRequests: { label: 'requests' },
    codeHostFetch: { label: 'fetch' },
    repositoryPublicationTransport: { label: 'transport' },
  }
  const recovery = { recoverBeforeScope: recorder(calls, 'recoverBeforeScope') }
  const runtimeComponents = {
    wrapperRuntimeFactory: () => ({}) as never,
    mergeRecoveryFactory: (state: unknown, log: unknown) => {
      ;(calls.mergeRecoveryFactory ??= []).push([state, log])
      return recovery as never
    },
  } satisfies TaskExecutionRuntimeComponents
  const topology = { label: 'topology' } as unknown as SchedulerRuntimeTopology
  const ports = createTaskRunPorts(
    raw as unknown as BoundRunTaskOptions,
    topology,
    runtimeComponents,
  )
  return { raw, ports, calls, persistence, topology }
}

const definition = {
  $schema_version: 6,
  name: 'wf',
  nodes: [{ id: 'a', kind: 'agent-single', agentId: 'agent-1' }],
  edges: [],
} as never

function preparation() {
  const scopeIndex = createExecutionScopeIndex(definition)
  return {
    task: { worktreePath: '/worktree', repoGroupName: null } as never,
    collaborators: [
      { userId: 'owner-1', role: 'owner' },
      { userId: 'user-2', role: 'collaborator' },
      { userId: 'user-2', role: 'collaborator' },
      { userId: null, role: 'collaborator' },
    ],
    admission: { label: 'session' } as never,
    definition,
    repos: [],
    triggerContext: null,
    inputsMap: { a: '1' },
    scopeIndex,
    containerOf: new Map(scopeIndex.parentOf),
    topLevelIds: new Set(scopeIndex.rootNodeIds),
  }
}

test('facts and persistence are read from the current options when the control plane asks', () => {
  const { raw, ports, persistence } = fixture()
  expect(ports.taskId).toBe('task-1')
  expect(ports.log).toBe(raw.log as never)
  expect(ports.execution).toBe(raw.executionContext as never)
  raw.executionContext = undefined
  expect(ports.execution).toBeUndefined()
  const controller = new AbortController()
  raw.signal = controller.signal
  expect(ports.signal).toBe(controller.signal)
  expect(ports.persistence.drive).toEqual({ label: 'p-1:drive' } as never)
  raw.persistence = persistence('p-2')
  expect(ports.persistence.drive).toEqual({ label: 'p-2:drive' } as never)
  expect(ports.persistence.ownership).toEqual({ label: 'p-2:ownership' } as never)
  expect(ports.persistence.runtimeLifecycle).toEqual({ label: 'p-2:runtimeLifecycle' } as never)
  expect(ports.persistence.humanGateLifecycle).toEqual({ label: 'p-2:humanGateLifecycle' } as never)
  // The terminal-write helpers keep their own scheduler logger.
  expect(typeof ports.settlementLog.warn).toBe('function')
})

test('the admission opens the resource session only when the execution authority is available', async () => {
  const { raw, ports, calls } = fixture()
  const input = { ownerUserId: 'owner-1', taskId: 'task-1' }
  expect(await ports.admission.admit(input)).toBeNull()
  expect(calls.forTaskExecution).toEqual([input])
  expect(calls.forTaskExecution![0]).toBe(input)
  raw.identityAccess.delegatedRequests.forTaskExecution = recorder(calls, 'admitted', {
    authority: { label: 'authority' },
    actor: { label: 'actor' },
  })
  const session = await ports.admission.admit(input)
  expect(session).not.toBeNull()
  expect(typeof session!.injection).toBe('function')
  expect(Object.isFrozen(session)).toBe(true)
})

test('workspace, rules, dynamic-workflow persistence and the review lock forward to the shared implementations', async () => {
  const { raw, ports, calls } = fixture()
  expect(ports.workspace.ensureProfiles).toBe(false)
  raw.ensureWorkspaceProfiles = true
  expect(ports.workspace.ensureProfiles).toBe(true)
  expect(
    await ports.workspace.ensureExcludeProfile({ workspaceRef: '/wt', directChildMounts: ['lib'] }),
  ).toEqual({ version: 1, digest: 'digest-1' })
  expect(calls.bind).toEqual([{ workspaceRef: '/wt' }])
  expect(calls.ensure).toEqual([{ directChildMounts: ['lib'] }])
  const mounts = [{ ordinal: 0, mountPath: '', worktreePath: '/wt' }] as never[]
  const projected = ports.workspace.project({} as never, mounts)
  expect(projected).toEqual(mounts)
  expect(projected).not.toBe(mounts)

  expect(ports.rules.triggerPreflightIssue).toBe(triggerPreflightIssue)
  // RFC-410: the orchestrator node id is a task-execution domain constant, no longer a port.
  expect(Object.keys(ports.rules)).toEqual(['triggerPreflightIssue'])
  expect(ports.dynamicWorkflow).toBeUndefined()
  const dynamicPersistence = { loadTask: recorder(calls, 'loadTask', null) }
  raw.dynamicWorkflow = { persistence: dynamicPersistence, validation: {} }
  expect(ports.dynamicWorkflow).toBe(dynamicPersistence as never)
  expect(await ports.reviewMutation.run(async () => 'locked')).toBe('locked')
})

test('prepare takes the pools and locks at preparation; recovery, bodies and configuration run on demand', async () => {
  const { raw, ports, calls, topology } = fixture()
  const drive = ports.prepare(preparation() as never)
  expect(calls.pool).toEqual([
    [raw.processConcurrencyScope, 'agent', 3, 'seed-only'],
    [raw.processConcurrencyScope, 'script', 4, 'seed-only'],
    [raw.processConcurrencyScope, 'code-host', 5, 'seed-only'],
  ])
  expect(calls.writeSem).toEqual(['task-1'])
  expect(calls.fanoutSem).toEqual([['task-1', 4]])
  expect(calls.mergeRecoveryFactory).toBeUndefined()

  await drive.recoverBeforeScope()
  const [state, log] = calls.mergeRecoveryFactory![0] as [Record<string, unknown>, unknown]
  expect(log).toBe(raw.log)
  expect(calls.recoverBeforeScope).toHaveLength(1)
  expect(state.taskId).toBe('task-1')
  expect(state.topology).toBe(topology)
  expect(state.taskExecutionResources).toEqual({ label: 'session' })
  expect(state.collaboratorUserIds).toEqual(['user-2'])
  expect(state.scopeRoot).toBe('/worktree')
  expect(state.repoGroupName).toBeNull()
  expect(state.agentSem).toEqual({ pool: 'agent' })
  expect(state.writeSem).toEqual({ writeSem: 'task-1' })
  expect(state.subprocessSem).toEqual({ fanoutSem: 'task-1' })

  expect(await drive.bodies['workgroup-turns']()).toEqual({ kind: 'ok' })
  const turns = calls.turns![0] as Record<string, unknown>
  expect(turns.taskId).toBe('task-1')
  expect(turns.log).toBe(raw.log)
  expect('signal' in turns).toBe(false)
  expect(typeof turns.host).toBe('object')
  expect(() => drive.bodies['dw-generate']()).toThrow('dynamic-workflow-operations-not-composed')

  const config = drive.runtimeConfig()
  expect(config.appHome).toBe('/app-home')
  for (const excluded of [
    'taskId',
    'executionContext',
    'signal',
    'codeHostConnections',
    'codeHostRequests',
    'codeHostFetch',
    'repositoryPublicationTransport',
  ])
    expect(excluded in config.runtime, excluded).toBe(false)
  raw.appHome = ''
  expect(() => drive.runtimeConfig()).toThrow('task drive config requires appHome')
})

// RFC-410: the dynamic-workflow generation engine (engine/task/dynamicWorkflowGenerate.ts) runs on ports the
// composition binds inside the task drive. These cases lock the binding: the dw-generate body reads the `dw`
// checkpoint through the composed dynamic-workflow persistence, mints and parks the confirm-gate holder
// through the task's own node-run persistence, forwards the trigger rule and the workgroup host lane, and the
// layer-one validation port the resource catalog builds judges exactly as the catalog validator does.
// (The "not composed" failure stays locked by rfc408-port-bindings.)
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { initialDwState, WORKFLOW_SCHEMA_VERSION } from '@agent-workflow/shared'
import { createTaskRunPorts } from '@/modules/task-execution/composition/taskEngineApplication'
import type { TaskExecutionRuntimeComponents } from '@/modules/task-execution/composition/taskExecutionComponents'
import { createExecutionScopeIndex } from '@/modules/task-execution/domain/executionScope'
import type { SchedulerRuntimeTopology } from '@/modules/task-execution/application/ports/taskExecutionTopology'
import type { BoundRunTaskOptions } from '@/modules/task-execution/composition/taskEngineRuntimeOptions'
import { composeDynamicWorkflowLayerOneValidation } from '@/modules/resource-catalog/composition/workflowOperations'
import { loadWorkflowValidationContext } from '@/modules/resource-catalog/infrastructure/legacy/workflow.validator'
import { validateWorkflowDef } from '@/modules/resource-catalog/domain/workflowValidator'
import { describeEachProvider } from './helpers/eachProvider'

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
    log: { name: 'log-1', info() {}, warn() {}, error() {}, debug() {} } as unknown,
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

function composedDynamicWorkflow(calls: Calls, snapshot: unknown, hasGateRun = false) {
  return {
    persistence: {
      loadTask: recorder(calls, 'loadTask', snapshot),
      hasAwaitingConfirmationRun: recorder(calls, 'hasGateRun', hasGateRun),
    },
    validation: { load: recorder(calls, 'validationLoad', () => ({ ok: true, issues: [] })) },
  }
}

function nodeRunsRecorder(calls: Calls) {
  return {
    mint: recorder(calls, 'mint', 'gate-run-1'),
    set: recorder(calls, 'set'),
    loadEnvelopeNonce: recorder(calls, 'nonce', ''),
  }
}

test('dw-generate reads the checkpoint through the composed persistence and fails closed on a missing one', async () => {
  const { raw, ports, calls } = fixture()
  raw.dynamicWorkflow = composedDynamicWorkflow(calls, null)
  const drive = ports.prepare(preparation() as never)
  expect(await drive.bodies['dw-generate']()).toEqual({
    kind: 'failed',
    detail: {
      summary: 'dynamic workflow config missing or invalid',
      message: 'workgroup_config_json unreadable or dw state missing',
    },
  })
  expect(calls.loadTask).toEqual(['task-1'])
  expect(calls.validationLoad).toBeUndefined()
})

test('a parked pass re-mints the confirm-gate holder through the task node-run persistence', async () => {
  const { raw, ports, calls } = fixture()
  const snapshot = {
    dwStateJson: JSON.stringify({ ...initialDwState(), phase: 'awaiting_confirm' }),
    workgroupConfig: { runtime: { config: { members: [], goal: 'g', instructions: '' } } },
    triggerContextJson: null,
  }
  raw.dynamicWorkflow = composedDynamicWorkflow(calls, snapshot)
  ;(raw.persistence as Record<string, unknown>).nodeRuns = nodeRunsRecorder(calls)
  const drive = ports.prepare(preparation() as never)
  expect(await drive.bodies['dw-generate']()).toEqual({
    kind: 'awaiting_review',
    detail: { summary: 'dynamic workflow awaiting confirmation', message: 'dw-gate' },
  })
  expect(calls.hasGateRun).toEqual([['task-1', 'dw-gate']])
  expect(calls.mint).toHaveLength(1)
  expect(calls.mint![0]).toMatchObject({ taskId: 'task-1', status: 'pending', cause: 'dw-gate' })
  expect(calls.set).toEqual([
    {
      nodeRunId: 'gate-run-1',
      to: 'awaiting_review',
      allowedFrom: ['pending'],
      reason: 'dw-gate-open',
    },
  ])
  // Parked re-entry never regenerates: no inventory load, no orchestrator run.
  expect(calls.validationLoad).toBeUndefined()
})

test('the trigger rule and the workgroup host lane are the composition implementations', () => {
  const binding = readFileSync(
    resolve(import.meta.dir, '../src/modules/task-execution/composition/taskEngineApplication.ts'),
    'utf8',
  )
  for (const line of [
    'persistence: dynamicWorkflow.persistence,',
    'nodeRuns: opts.persistence.nodeRuns,',
    'validation: dynamicWorkflow.validation,',
    'rules: { triggerPreflightIssue },',
    'host: buildNodeExecutionWorkgroupHooks(state, runtimeComponents.wrapperRuntimeFactory),',
    "import { runDynamicWorkflowGenerate } from '../engine/task/dynamicWorkflowGenerate'",
    // RFC-477: trigger preflight moved from services/execution/ into resource-catalog (taken through its public queries).
    "import { triggerPreflightIssue } from '@/modules/resource-catalog/public/queries'",
  ])
    expect(binding).toContain(line)
})

describeEachProvider('RFC-410 layer-one validation port', (harness) => {
  test('judges with the catalog validator over the inventory of its load', async () => {
    const db = harness.db
    const validate = await composeDynamicWorkflowLayerOneValidation(db).load()
    const definition = {
      $schema_version: WORKFLOW_SCHEMA_VERSION,
      inputs: [],
      nodes: [{ id: 'n1', kind: 'agent-single', agentId: 'missing-agent', agentName: 'missing' }],
      edges: [],
    } as never
    const result = validate(definition)
    expect(result).toEqual(validateWorkflowDef(definition, await loadWorkflowValidationContext(db)))
    expect(result.issues.map((issue) => issue.code)).toContain('agent-not-found')
  })
})

// RFC-405: the agent-single binding only adds task-level facts — the task's run fields, the execution
// context, the current persistence — and forwards what the engine body assembled unchanged. Every
// value is read when the body asks for it. Locks the split between engine (node request) and
// composition (task-level inheritance) that replaced the agent body inside nodeMechanics.ts.
import { expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  createAgentNodeExecutionPorts,
  withTaskRunFields,
} from '@/modules/task-execution/composition/agentNodeExecution'
import type {
  AgentRunLaunch,
  AgentRunRequest,
} from '@/modules/task-execution/application/ports/agentNodeExecution'
import { NOOP_AGENT_RUN_SETTLED_OBSERVER } from '@/modules/task-execution/application/ports/agentRunSettledObserver'
import { findClarifyNode } from '@/modules/task-execution/domain/clarifyRules'
import {
  computeRemaining,
  resolveEffectiveClarifyChannel,
  shouldInjectStopNotice,
} from '@/modules/task-execution/domain/clarifyRules'
import { CLARIFY_FORBIDDEN_PREFIX } from '@agent-workflow/shared'
import { parsePortValidationFailuresJson } from '@/modules/task-execution/application/portOutputValidation'
import type { TaskMechanicsState } from '@/modules/task-execution/composition/taskMechanicsState'
import { continuesClarifyLineage, isClarifyRerunCause } from '@/services/nodeRunMint'
import { agentRefOfNode } from '@/services/ref/runtimeRef'
import { getRuntimeDriver } from '@/services/runtime'
import { decideResumeSessionId } from '@/modules/task-execution/domain/sessionModeFallback'
import { sha256Hex } from '@/util/hash'

type Calls = Record<string, unknown[]>

function recorder(calls: Calls, name: string, result: unknown = undefined) {
  return (...args: unknown[]) => {
    ;(calls[name] ??= []).push(args.length === 1 ? args[0] : args)
    return Promise.resolve(result)
  }
}

function fixture() {
  const calls: Calls = {}
  const opened: unknown[] = []
  const persistence = {
    countAgentTextEvents: recorder(calls, 'countAgentTextEvents', 3),
    listOutputs: async (runId: string) => {
      ;(calls.listOutputs ??= []).push(runId)
      return [
        { portName: 'summary', content: 'prior summary' },
        { portName: 'notes', content: '' },
      ]
    },
    appendEvent: recorder(calls, 'appendEvent'),
    patch: recorder(calls, 'patch', true),
  }
  const collaborationRuntime = {
    resolveBorrowForNode: recorder(calls, 'resolveBorrowForNode', null),
    buildReviewPromptContext: recorder(calls, 'buildReviewPromptContext', undefined),
    getNodeClarifyDirective: recorder(calls, 'getNodeClarifyDirective', 'stop'),
    buildClarifyQueueContext: recorder(calls, 'buildClarifyQueueContext', undefined),
    openAgentClarify: recorder(calls, 'openAgentClarify', { intermediaryNodeRunId: 'gate-1' }),
  }
  const family = (label: string) => ({
    runtimeBindings: {
      ofSession: recorder(calls, label + ':ofSession', 'inherited'),
      resolve: recorder(calls, label + ':resolve', { protocol: 'opencode' }),
    },
    materialReferences: {},
    open(scope: unknown) {
      opened.push({ label, scope })
      throw new Error('opened:' + label)
    },
  })
  const raw = {
    taskId: 'task-1',
    definition: { nodes: [], edges: [] } as unknown,
    triggerContext: { namespace: 'webhook', fields: { id: 'delivery-1' } } as unknown,
    task: {
      repoPath: '/repo',
      baseBranch: 'main',
      worktreePath: '/worktree',
      gitUserName: 'Ada' as string | null,
      gitUserEmail: 'ada@example.test' as string | null,
      platformInputPathsJson: null as string | null,
    },
    repos: [{ mountPath: 'repo-a' }, { mountPath: 'repo-b' }],
    log: { name: 'log-1' },
    agentSem: { name: 'sem-1' },
    taskExecutionResources: { injection: recorder(calls, 'injection', { kind: 'failed' }) },
    opts: {
      appHome: '/app-home',
      defaultPerNodeTimeoutMs: 1_000 as number | undefined,
      defaultNodeRetries: 2 as number | undefined,
      sessionRestartBudget: 1 as number | undefined,
      defaultRuntime: 'opencode' as string | undefined,
      executionContext: { sentinel: 'context-1' } as unknown,
      collaborationRuntime: collaborationRuntime as unknown,
      persistence: { nodeExecution: persistence, nodeRuns: {} } as unknown,
      taskAgentRuns: family('family-1') as unknown,
      observationInvocations: { name: 'observations' },
      memorySnapshots: { name: 'memory-snapshots' },
      memoryInjectionQueries: { name: 'memory-queries' },
      runtimeSessionLeases: { name: 'leases' },
      runtimeRegistry: { name: 'registry' },
      signal: undefined as AbortSignal | undefined,
      subagentLiveCapture: undefined as
        | { pollMs: number; consecutiveFailureLimit: number }
        | undefined,
      agentRunSettled: undefined as unknown,
    },
  }
  const state = raw as unknown as TaskMechanicsState
  return { raw, state, calls, opened, persistence, collaborationRuntime, family }
}

const request = {
  taskId: 'task-1',
  nodeRunId: 'run-1',
  nodeId: 'agent-node',
  inputs: { spec: 'body' },
  templateMeta: { repoPath: '/iso', baseBranch: 'main', taskId: 'task-1', nodeId: 'agent-node' },
} as unknown as AgentRunRequest

test('withTaskRunFields adds only the task-level run fields and forwards the request unchanged', () => {
  const { raw, state } = fixture()
  const sent = withTaskRunFields(state.opts, request) as unknown as Record<string, unknown>
  const taskLevel = {
    observationInvocations: raw.opts.observationInvocations,
    memorySnapshots: raw.opts.memorySnapshots,
    memoryInjectionQueries: raw.opts.memoryInjectionQueries,
    runtimeSessionLeases: raw.opts.runtimeSessionLeases,
    runtimeRegistry: raw.opts.runtimeRegistry,
    persistence: raw.opts.persistence,
  }
  expect(sent).toEqual({ ...(request as unknown as Record<string, unknown>), ...taskLevel })
  for (const [key, value] of Object.entries(request)) expect(sent[key]).toBe(value)
  for (const [key, value] of Object.entries(taskLevel)) expect(sent[key]).toBe(value)
  // Absent optional run fields stay absent rather than becoming explicit undefined.
  expect('signal' in sent).toBe(false)
  expect('subagentLiveCapture' in sent).toBe(false)

  const signal = new AbortController().signal
  raw.opts.signal = signal
  raw.opts.subagentLiveCapture = { pollMs: 50, consecutiveFailureLimit: 2 }
  const withOptional = withTaskRunFields(state.opts, request) as unknown as Record<string, unknown>
  expect(withOptional.signal).toBe(signal)
  expect(withOptional.subagentLiveCapture).toBe(raw.opts.subagentLiveCapture)
  // The engine's own request object is never written to.
  expect('persistence' in (request as unknown as Record<string, unknown>)).toBe(false)
})

test('runAgent opens the family read at call time with the engine launch and the request identity', () => {
  const { raw, state, opened, family } = fixture()
  const ports = createAgentNodeExecutionPorts(state)
  // Swapped after the ports were built: the run must use the current family.
  raw.opts.taskAgentRuns = family('family-2') as unknown
  const launch = {
    workspaceRef: '/iso',
    material: { name: 'material' },
    runtimeBinding: { name: 'binding' },
  } as unknown as AgentRunLaunch
  expect(() => ports.runtime.runAgent(request, launch)).toThrow('opened:family-2')
  expect(opened).toHaveLength(1)
  const { label, scope } = opened[0] as { label: string; scope: Record<string, unknown> }
  expect(label).toBe('family-2')
  expect(scope.workspaceRef).toBe('/iso')
  expect(scope.material).toBe((launch as unknown as Record<string, unknown>).material)
  expect(scope.runtimeBinding).toBe((launch as unknown as Record<string, unknown>).runtimeBinding)
  expect(scope.taskId).toBe('task-1')
  expect(scope.nodeRunId).toBe('run-1')
})

test('runtime bindings and the session-not-found detector use the current family and driver', async () => {
  const { raw, state, calls, family } = fixture()
  const ports = createAgentNodeExecutionPorts(state)
  raw.opts.taskAgentRuns = family('family-3') as unknown
  expect((await ports.runtime.ofSession('session-1')) as unknown).toBe('inherited')
  await ports.runtime.resolve('run-1', 'opencode', 'opencode', null)
  expect(calls['family-3:ofSession']).toEqual(['session-1'])
  expect(calls['family-3:resolve']).toEqual([['run-1', 'opencode', 'opencode', null]])
  expect(calls['family-1:ofSession']).toBeUndefined()
  const stderr = 'Error: session not found'
  expect(ports.runtime.detectSessionNotFound('opencode', stderr)).toBe(
    getRuntimeDriver('opencode').detectSessionNotFound?.(stderr),
  )
})

test('collaboration forwards the four reads unchanged and adds the execution context to openAgentClarify', async () => {
  const { raw, state, calls } = fixture()
  const ports = createAgentNodeExecutionPorts(state)
  const inputs = {
    resolveBorrowForNode: { taskId: 'task-1', nodeId: 'agent-node', iteration: 0 },
    buildReviewPromptContext: { taskId: 'task-1', nodeId: 'agent-node' },
    getNodeClarifyDirective: { taskId: 'task-1', nodeId: 'agent-node' },
    buildClarifyQueueContext: { taskId: 'task-1', nodeId: 'agent-node' },
  }
  await ports.collaboration.resolveBorrowForNode(inputs.resolveBorrowForNode as never)
  await ports.collaboration.buildReviewPromptContext(inputs.buildReviewPromptContext as never)
  expect(
    await ports.collaboration.getNodeClarifyDirective(inputs.getNodeClarifyDirective as never),
  ).toBe('stop')
  await ports.collaboration.buildClarifyQueueContext(inputs.buildClarifyQueueContext as never)
  for (const [name, input] of Object.entries(inputs)) {
    expect(calls[name]).toHaveLength(1)
    expect(calls[name]![0]).toBe(input)
  }

  const clarify = {
    kind: 'self',
    taskId: 'task-1',
    askingNodeId: 'agent-node',
    askingNodeRunId: 'run-1',
    askingShardKey: null,
    iteration: 0,
    intermediaryNodeId: 'clarify-node',
    questions: [],
  } as const
  await ports.collaboration.openAgentClarify(clarify as never)
  expect(calls.openAgentClarify).toEqual([
    { ...clarify, executionContext: raw.opts.executionContext },
  ])
  // Without a context the request goes through as the body built it (no explicit undefined key).
  raw.opts.executionContext = undefined
  await ports.collaboration.openAgentClarify(clarify as never)
  expect(calls.openAgentClarify![1]).toEqual(clarify)
  expect('executionContext' in (calls.openAgentClarify![1] as object)).toBe(false)

  // The collaboration runtime itself is read on use.
  const replaced: Calls = {}
  raw.opts.collaborationRuntime = {
    ...(raw.opts.collaborationRuntime as object),
    resolveBorrowForNode: recorder(replaced, 'resolveBorrowForNode', null),
  }
  await ports.collaboration.resolveBorrowForNode(inputs.resolveBorrowForNode as never)
  expect(replaced.resolveBorrowForNode).toEqual([inputs.resolveBorrowForNode])
  expect(calls.resolveBorrowForNode).toHaveLength(1)
})

test('history reads bind the persistence current at call time and keep their own filters', async () => {
  const { raw, state, calls } = fixture()
  const ports = createAgentNodeExecutionPorts(state)
  expect(await ports.history.countAgentTextEvents('run-1')).toBe(3)
  // RFC-313 P1-2: framework audit events stay out of the "the model spoke" count.
  expect(calls.countAgentTextEvents).toEqual([['run-1', '[rfc']])
  const block = await ports.history.composePriorOutputBlock('prior-run', ['summary', 'notes'])
  expect(calls.listOutputs).toEqual(['prior-run'])
  expect(block).toContain('prior summary')

  const swapped: Calls = {}
  raw.opts.persistence = {
    nodeExecution: { countAgentTextEvents: recorder(swapped, 'countAgentTextEvents', 0) },
    nodeRuns: {},
  }
  expect(await ports.history.countAgentTextEvents('run-2')).toBe(0)
  expect(swapped.countAgentTextEvents).toEqual([['run-2', '[rfc']])
  expect(calls.countAgentTextEvents).toHaveLength(1)
})

test('ledger writes carry the execution context; reads and lists go straight to persistence', async () => {
  const { raw, state, calls } = fixture()
  const ports = createAgentNodeExecutionPorts(state)
  const event = { nodeRunId: 'run-1', kind: 'text', payload: '[rfc042/envelope-followup] {}' }
  await ports.ledger.appendEvent(event as never)
  expect(calls.appendEvent).toEqual([{ ...event, executionContext: raw.opts.executionContext }])
  await ports.ledger.patch({ nodeRunId: 'run-1', patch: { sessionId: 's-1' } } as never)
  expect(calls.patch).toEqual([
    {
      nodeRunId: 'run-1',
      patch: { sessionId: 's-1' },
      executionContext: raw.opts.executionContext,
    },
  ])
  raw.opts.executionContext = undefined
  await ports.ledger.appendEvent(event as never)
  expect(calls.appendEvent![1]).toEqual(event)
})

test('port files are forced relative to the platform fallback mount of the current repos', () => {
  const { raw, state } = fixture()
  const ports = createAgentNodeExecutionPorts(state)
  // Multi-repo: the first mount is the fallback.
  expect(ports.workspace.portFileContainerPaths(['ports/a.md', 'ports/b.md'])).toEqual([
    join('repo-a', 'ports/a.md'),
    join('repo-a', 'ports/b.md'),
  ])
  // A single root repository has no mount prefix.
  raw.repos = [{ mountPath: '' }]
  expect(ports.workspace.portFileContainerPaths(['ports/a.md'])).toEqual(['ports/a.md'])
  expect(ports.workspace.portFileContainerPaths([])).toEqual([])
})

test('task facts, policy, pools, observer and injection are read on use; rules are the shared functions', async () => {
  const { raw, state, calls } = fixture()
  const ports = createAgentNodeExecutionPorts(state)
  raw.task.worktreePath = '/worktree-2'
  raw.task.gitUserName = null
  raw.triggerContext = null
  raw.opts.defaultNodeRetries = undefined
  raw.opts.defaultRuntime = 'claude-code'
  raw.log = { name: 'log-2' }
  raw.agentSem = { name: 'sem-2' }
  expect(ports.task.taskId).toBe('task-1')
  expect(ports.task.worktreePath).toBe('/worktree-2')
  expect(ports.task.gitUserName).toBeNull()
  expect(ports.task.triggerContext).toBeNull()
  expect(ports.policy.defaultNodeRetries).toBeUndefined()
  expect(ports.policy.defaultRuntime).toBe('claude-code')
  expect(ports.policy.appHome).toBe('/app-home')
  expect(ports.log).toBe(raw.log as never)
  expect(ports.agentSem).toBe(raw.agentSem as never)

  expect(ports.observer).toBe(NOOP_AGENT_RUN_SETTLED_OBSERVER)
  const observer = { onAgentRunSettled: () => undefined }
  raw.opts.agentRunSettled = observer
  expect(ports.observer).toBe(observer as never)

  await ports.resources.injection('agent-1')
  expect(calls.injection).toEqual(['agent-1'])

  expect(ports.rules).toEqual({
    agentRefOfNode,
    findClarifyNode,
    computeRemaining,
    resolveEffectiveClarifyChannel,
    shouldInjectStopNotice,
    parsePortValidationFailuresJson,
    isClarifyRerunCause,
    continuesClarifyLineage,
    // RFC-406: the workgroup host's suppressed ask-back message prefix.
    clarifyForbiddenPrefix: CLARIFY_FORBIDDEN_PREFIX,
    // RFC-407: the fan-out shard value's reuse identity.
    shardValueHash: sha256Hex,
    decideResumeSessionId,
  })
})

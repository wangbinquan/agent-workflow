import { expect, test } from 'bun:test'
import type { WorkflowDefinition } from '@agent-workflow/shared'
import { createCodeHostNodeExecutionPorts } from '@/modules/task-execution/composition/codeHostNodeExecution'
import { createReviewNodeExecutionPorts } from '@/modules/task-execution/composition/humanGateNodeExecution'
import { ReviewNodeExecutor } from '@/modules/task-execution/engine/node/review/reviewNodeExecutor'
import {
  createTaskExecutionContext,
  type TaskExecutionContext,
} from '@/modules/task-execution/application/taskExecutionContext'
import type { CodeHostNodeExecutionPorts } from '@/modules/task-execution/application/ports/codeHostNodeExecution'
import type { TaskExecutionPersistence } from '@/modules/task-execution/application/ports/taskExecutionPersistence'
import type {
  TaskExecutionEffectPersistence,
  TaskEffectAttemptPreparation,
  TaskEffectAttemptSettlement,
} from '@/modules/task-execution/application/ports/taskExecutionEffectStore'
import {
  createOwnershipToken,
  createWorkerIdentity,
} from '@/modules/task-execution/domain/ownership'
import type {
  NodeStepOutcome,
  NodeStepRequest,
} from '@/modules/task-execution/domain/nodeExecution'
import type { CodeHostRecoveryDescriptor } from '@/modules/task-execution/domain/codeHostRecovery'
import { Semaphore } from '@/platform/contracts/semaphore'
import { createLogger } from '@/util/log'

/** Missing capabilities fail at the point of use; no permissive no-op fallback. */
function strictPort<T extends object>(members: Partial<T> = {}): T {
  return new Proxy(members, {
    get(target, property, receiver) {
      if (!Reflect.has(target, property)) throw new Error(`unexpected port: ${String(property)}`)
      return Reflect.get(target, property, receiver)
    },
  }) as T
}

const definition: WorkflowDefinition = { $schema_version: 6, nodes: [], edges: [], inputs: [] }
const taskId = 'rfc403-binding-task'
function context(intentId: string): TaskExecutionContext {
  return createTaskExecutionContext({
    intentId,
    token: createOwnershipToken({
      taskId,
      identity: createWorkerIdentity({ ownerId: intentId, daemonGeneration: 'rfc403-generation' }),
      epoch: 1,
      leaseUntil: Date.now() + 60_000,
      ownerRevision: 1,
    }),
    persistence: strictPort<TaskExecutionPersistence>(),
  })
}

test('code-host binding feeds the real observer the exact policy, current persistence and owner context', async () => {
  const prepared: TaskEffectAttemptPreparation[] = []
  const settled: TaskEffectAttemptSettlement[] = []
  const projections: Parameters<TaskExecutionEffectPersistence['settleCodeHostNode']>[0][] = []
  const effects = strictPort<TaskExecutionEffectPersistence>({
    async prepareAndAcquire(input) {
      prepared.push(input)
      return {
        effectId: 'effect',
        attemptId: `attempt-${prepared.length}`,
        attemptNo: prepared.length,
        resourceKeys: input.resourceKeys,
      }
    },
    async settle(input) {
      settled.push(input)
    },
    async settleCodeHostNode(input) {
      projections.push(input)
    },
  })
  type Binding = Parameters<typeof createCodeHostNodeExecutionPorts>[0]
  let selectedEffects = strictPort<TaskExecutionEffectPersistence>()
  const opts: Binding['opts'] & { executionContext?: TaskExecutionContext } = {
    persistence: {
      nodeRuns: strictPort(),
      nodeExecution: strictPort(),
      selection: strictPort(),
      get effects() {
        return selectedEffects
      },
    },
  }
  const ports = createCodeHostNodeExecutionPorts({
    taskId,
    definition,
    containerOf: new Map(),
    triggerContext: null,
    task: { workflowVersion: 1, executionLineageId: taskId, repoUrl: null, repoCount: 1 },
    opts,
    codeHostSem: new Semaphore(1),
    log: createLogger('rfc403'),
  })
  expect(ports.effects.enabled).toBe(false)
  const owner = context('current-code-host-owner')
  opts.executionContext = owner
  selectedEffects = effects
  expect(ports.effects.enabled).toBe(true)
  const policy: Parameters<
    CodeHostNodeExecutionPorts['effects']['createCodeHostEffectAttemptObserver']
  >[0] = {
    action: 'comment.update',
    nodeRunId: 'code-host-run',
    initialRetryAuthority: 'probe',
    identity: {
      executionLineageId: 'lineage',
      operationFamilyKey: 'stable-family',
      operationGeneration: 7,
      operationKey: 'generation-7',
      requestHash: 'request-hash',
      slotPathJson: '[{"slot":1}]',
      slotPathDigest: 'slot-digest',
      resourceKeys: ['code-host:repository', 'code-host:thread'],
    },
  }
  const observer = ports.effects.createCodeHostEffectAttemptObserver(policy)
  const descriptor: CodeHostRecoveryDescriptor = {
    v: 1,
    provider: 'gitlab',
    action: policy.action,
    candidateId: 'candidate',
    method: 'PUT',
    mutationPathname: '/projects/1/notes/2',
    baseUrlDigest: 'base-url-digest',
    connectionGeneration: 'connection-3',
    nodeRunId: null,
    probe: { kind: 'actor-replay' },
  }
  const info = {
    candidateId: 'candidate',
    transportAttempt: 1,
    method: 'PUT',
    pathname: descriptor.mutationPathname,
    recoveryDescriptor: descriptor,
  }
  const first = await observer.beforeSend(info)
  expect(first).not.toBeNull()
  expect(prepared).toHaveLength(1)
  expect(prepared[0]).toMatchObject({
    ...policy.identity,
    token: owner.token,
    intentId: owner.intentId,
    kind: 'code-host-mutation',
    candidateId: 'candidate:t1',
    recoveryClass: 'R-EXACT',
    retryAuthority: 'probe',
  })
  expect(prepared[0]!.token).toBe(owner.token)
  expect(prepared[0]!.resourceKeys).toBe(policy.identity.resourceKeys)
  expect(JSON.parse(prepared[0]!.recoveryDescriptorJson!)).toEqual({
    ...descriptor,
    nodeRunId: policy.nodeRunId,
  })
  await observer.afterSend(first, {
    ...info,
    result: 'response',
    status: 503,
    willRetry: true,
    retryKind: 'transport-policy',
  })
  expect(settled).toHaveLength(1)
  expect(settled[0]).toMatchObject({
    token: owner.token,
    effectId: 'effect',
    attemptId: 'attempt-1',
    state: 'retry-authorized',
  })
  const secondInfo = { ...info, transportAttempt: 2 }
  const second = await observer.beforeSend(secondInfo)
  expect(prepared).toHaveLength(2)
  expect(prepared[1]).toMatchObject({
    ...policy.identity,
    candidateId: 'candidate:t2',
    retryAuthority: 'transport-policy',
  })
  await observer.afterSend(second, {
    ...secondInfo,
    result: 'response',
    status: 200,
    willRetry: false,
    retryKind: 'none',
  })
  const projection = {
    nodeRunId: 'code-host-run',
    status: 'done' as const,
    reason: 'code-host-done',
    finishedAt: 42,
    outputs: [{ portName: 'body', content: 'ok' }],
  }
  expect(await observer.settleTerminal(projection)).toBe(true)
  expect(projections).toHaveLength(1)
  expect(projections[0]!.projection).toBe(projection)
  expect(projections[0]!.settlement).toMatchObject({
    token: owner.token,
    effectId: 'effect',
    attemptId: 'attempt-2',
    state: 'succeeded',
  })
})

test('code-host connection and transport policy remain lazy binding reads', () => {
  type Binding = Parameters<typeof createCodeHostNodeExecutionPorts>[0]
  let reads = 0
  let timeout = 100
  let connections = strictPort<NonNullable<Binding['opts']['codeHostConnections']>>()
  const ports = createCodeHostNodeExecutionPorts({
    taskId,
    definition,
    containerOf: new Map(),
    triggerContext: null,
    task: { workflowVersion: 1, executionLineageId: taskId, repoUrl: null, repoCount: 1 },
    opts: {
      persistence: strictPort(),
      get codeHostConnections() {
        reads += 1
        return connections
      },
      get codeHostRequestTimeoutMs() {
        reads += 1
        return timeout
      },
    },
    codeHostSem: new Semaphore(1),
    log: createLogger('rfc403'),
  })
  expect(reads).toBe(0)
  const current = strictPort<NonNullable<Binding['opts']['codeHostConnections']>>({
    resolve: async () => null,
  })
  connections = current
  timeout = 200
  expect(ports.policy.codeHostConnections).toBe(current)
  expect(ports.policy.codeHostRequestTimeoutMs).toBe(200)
  expect(reads).toBe(2)
})

test('review binding reads the current participant and context and preserves the request and park result', async () => {
  type Binding = Parameters<typeof createReviewNodeExecutionPorts>[0]
  type Runtime = Binding['opts']['collaborationRuntime']
  const received: Parameters<Runtime['dispatchReviewNode']>[0][] = []
  const outcome = {
    kind: 'awaiting_review',
    summary: 'review',
    message: 'awaiting_review',
  } satisfies NodeStepOutcome
  const opts: Binding['opts'] & {
    executionContext?: TaskExecutionContext
    collaborationRuntime: Runtime
  } = {
    appHome: '/rfc403/app',
    collaborationRuntime: strictPort(),
  }
  const ports = createReviewNodeExecutionPorts({
    taskId,
    definition,
    scopeRoot: '/scope/canonical',
    repos: [{ mountPath: 'repo' }],
    opts,
  })
  const executor = new ReviewNodeExecutor(ports)
  const owner = context('current-review-owner')
  opts.executionContext = owner
  opts.collaborationRuntime = strictPort<Runtime>({
    async dispatchReviewNode(input) {
      received.push(input)
      return outcome
    },
  })
  const request: NodeStepRequest<'review'> = {
    node: { id: 'review', kind: 'review' },
    task: { taskId },
    scope: { scopeId: 'wrapper' },
    containerRunId: 'frame-row',
    iteration: 4,
    execution: {},
  }
  expect(await executor.execute(request)).toBe(outcome)
  expect(received).toHaveLength(1)
  expect(received[0]).toEqual({
    taskId,
    appHome: opts.appHome,
    definition,
    node: request.node,
    containerRunId: request.containerRunId,
    iteration: 4,
    scopeRoot: '/scope/canonical',
    repoDirName: 'repo',
    executionContext: owner,
  })
  expect(received[0]!.node).toBe(request.node)
  expect(received[0]!.definition).toBe(definition)
  expect(received[0]!.executionContext).toBe(owner)
  delete opts.executionContext
  expect(await executor.execute(request)).toBe(outcome)
  expect(received[1]).not.toHaveProperty('executionContext')
})

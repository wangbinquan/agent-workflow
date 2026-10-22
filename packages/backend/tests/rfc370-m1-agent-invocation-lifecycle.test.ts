// RFC-370 §9.2 V1 — how a hosted agent node turns the execution layer's
// outcome into its own result. Locks the review fixes: a daemon shutdown /
// authority loss DETACHES (the node ends `aborted` only when the daemon stops,
// so the run stays adoptable instead of reading as a user cancel); an
// unobservable outcome fails the node with its reason; a retention gap marks
// evidence truncated without failing the run; platform usage snapshots become
// token deltas (so `max_total_tokens` and `tok_*` see hosted usage); a refused
// start acknowledgement stops the remote run.
import { expect, test } from 'bun:test'
import { DAEMON_SHUTDOWN_ABORT_REASON } from '@agent-workflow/shared'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type {
  AgentMaterialIntent,
  AgentMaterialWorkspace,
} from '@/modules/runtime-management/public/participants'
import type {
  AgentExecutionRecord,
  AgentExecutionRequest,
  AgentExecutionSink,
} from '@/modules/task-execution/application/ports/agentExecution'
import { createHostedAgentInvocationPreparation } from '@/modules/task-execution/composition/crewstationAgentInvocation'
import {
  HostedExecutionDetachedError,
  HostedExecutionUnknownError,
  type HostedExecution,
  type HostedExecutionResult,
  type HostedExecutionSink,
} from '@/modules/task-execution/infrastructure/crewstation/execution'
import type {
  HostedExecutionBinding,
  HostedExecutionIntent,
} from '@/modules/task-execution/infrastructure/crewstation/executionStore'
import type {
  BusinessEvent,
  BusinessResult,
  CrewStationBusinessExecution,
} from '@/platform/crewstation/businessExecution'
import { createLogger } from '@/util/log'

const unavailable = (): never => {
  throw new Error('unexpected native effect')
}
const workspace: AgentMaterialWorkspace = {
  workspace: {
    owner: 'source-control',
    reference: 'cs-workspace:task/worktrees/task',
    version: null,
  },
  runContent: {
    owner: 'runtime-management',
    reference: 'cs-workspace:task/runs/task/run',
    version: null,
  },
  retainedRef: 'cs-workspace:task/runs/task/run',
  prepare: async () => undefined,
  discard: async () => undefined,
}
const intent = (): AgentMaterialIntent => ({
  protocol: 'opencode',
  injection: { mcps: [] },
  prompt: 'user prompt',
  agentName: 'agent',
  systemPrompt: 'definition',
  injectedMemoryBlock: '',
  resolvedProfiles: [],
  workspace: workspace.workspace,
  runContent: workspace.runContent,
  freshAgentRun: true,
  nodeRunId: 'run',
  log: createLogger('hosted-agent-lifecycle-test'),
})
const okResult: BusinessResult = {
  exitCode: 0,
  reason: 'completed',
  stdout: '',
  stderr: '',
  truncated: false,
  finalCursor: 'c9',
}
let sequence = 0
const event = (type: string, data: unknown, cursor = `c${++sequence}`): BusinessEvent =>
  ({
    taskId: 'parent',
    subtaskId: 'subtask',
    attempt: 1,
    cursor,
    sourceEventId: cursor,
    occurredAt: new Date(1000).toISOString(),
    type,
    data,
  }) as BusinessEvent
const bindingOf = (value: HostedExecutionIntent): HostedExecutionBinding => ({
  ...value,
  subtaskId: 'subtask',
  attempt: 1,
  materialDigest: null,
  lastCursor: null,
  result: null,
  state: 'running',
  cancelRequested: false,
  cancelReason: null,
  epoch: 1,
  createdAt: 1,
})
const outcome = (
  binding: HostedExecutionBinding,
  overrides: Partial<HostedExecutionResult> = {},
): HostedExecutionResult => ({
  binding,
  result: okResult,
  timedOut: false,
  cancelled: false,
  settle: async () => undefined,
  ...overrides,
})

async function execute(
  run: (
    value: HostedExecutionIntent,
    sink: HostedExecutionSink,
    signal?: AbortSignal,
  ) => Promise<HostedExecutionResult>,
  request: AgentExecutionRequest = {},
  options: { acknowledgeStarted?: () => Promise<void> } = {},
) {
  const executions: HostedExecution = {
    workspaceSettled: async () => true,
    find: async () => null,
    run,
    adopt: unavailable,
    cancel: unavailable,
    observing: () => false,
  }
  const api = {
    createMaterial: async () => ({ materialId: 'material', digest: 'digest', sizeBytes: 1 }),
  } as unknown as CrewStationBusinessExecution
  const preparation = createHostedAgentInvocationPreparation({
    db: {} as PersistenceDb,
    fence: {
      current: () => ({ epoch: 1, leaseId: 'lease', instanceId: 'instance' }),
      assertHeld: unavailable,
    },
    api,
    executions,
    taskId: 'task',
    businessTaskId: 'parent',
    cwd: '/work/worktrees/task',
    workspace,
    profiles: [{ protocol: 'opencode', model: null, agentProfileId: 'profile' }],
    skillFiles: async () => [],
    ...(options.acknowledgeStarted === undefined
      ? {}
      : { acknowledgeStarted: options.acknowledgeStarted }),
  })
  const invocation = await (await preparation.compile(intent())).bind()
  const records: AgentExecutionRecord[] = []
  const diagnostics: { line: string; sourceKey?: string }[] = []
  let truncated = 0
  const sink: AgentExecutionSink = {
    record: async (record) => {
      records.push(record)
    },
    diagnostic: async (line, sourceKey) => {
      diagnostics.push({ line, ...(sourceKey === undefined ? {} : { sourceKey }) })
    },
    checkpoint: async () => undefined,
    truncated: async () => {
      truncated += 1
    },
  }
  const pending = invocation.execute(request, sink)
  return { pending, records, diagnostics, truncated: () => truncated }
}

test('a daemon shutdown detaches: the node ends aborted only when the daemon stops', async () => {
  const daemon = new AbortController()
  const detached = Promise.withResolvers<void>()
  const f = await execute(
    async (value) => {
      detached.resolve()
      throw new HostedExecutionDetachedError(value.executionId)
    },
    { signal: daemon.signal },
  )
  let ended = false
  const pending = f.pending.then((result) => {
    ended = true
    return result
  })
  await detached.promise
  await new Promise((resolve) => setTimeout(resolve, 0))
  // Authority moved but the daemon has not stopped yet: the run stays open.
  expect(ended).toBe(false)
  daemon.abort(DAEMON_SHUTDOWN_ABORT_REASON)
  const result = await pending
  expect(result.result).toBe('aborted')
  await result.settle()
})

test('a user cancel before any receipt ends as aborted at once', async () => {
  const user = new AbortController()
  user.abort('user-cancel')
  const f = await execute(
    async (value) => {
      throw new HostedExecutionDetachedError(value.executionId)
    },
    { signal: user.signal },
  )
  expect((await f.pending).result).toBe('aborted')
})

test('an unobservable outcome fails the node with its reason', async () => {
  const f = await execute(async (value) => {
    throw new HostedExecutionUnknownError(value.executionId, 'expired: history expired')
  })
  const result = await f.pending
  expect(result.result).toBe('nonzero-exit')
  expect(result.pumpError).toContain('expired: history expired')
  expect(result.exitCode).toBeNull()
})

test('a retention gap marks evidence truncated without failing the run', async () => {
  const f = await execute(async (value, sink) => {
    const binding = bindingOf(value)
    await sink.started(binding)
    await sink.event(event('gap', { reason: 'retention-expired', earliestCursor: 'c5' }))
    await sink.event(event('text', { text: 'after the gap' }))
    await sink.event(event('result', okResult, 'c9'))
    await sink.checkpoint()
    return outcome(binding)
  })
  const result = await f.pending
  expect(result.result).toBe('ok')
  expect(f.truncated()).toBe(1)
  expect(f.records.map((record) => record.event?.kind)).toEqual(['text', 'step_finish'])
})

test('platform usage snapshots become non-negative token deltas on the records', async () => {
  const usage = (input: number, output: number) =>
    event('usage', {
      measurementId: `m-${input}`,
      scope: 'session',
      mode: 'cumulative',
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      complete: true,
    })
  const f = await execute(async (value, sink) => {
    const binding = bindingOf(value)
    await sink.started(binding)
    await sink.event(usage(10, 5))
    await sink.event(usage(15, 10))
    await sink.event(usage(15, 10))
    await sink.event(event('result', okResult, 'c9'))
    return outcome(binding)
  })
  await f.pending
  expect(f.records.map((record) => record.event?.tokens ?? null)).toEqual([
    { input: 10, output: 5, cacheCreate: 0, cacheRead: 0 },
    { input: 5, output: 5, cacheCreate: 0, cacheRead: 0 },
    null,
    null,
  ])
})

test('stderr output becomes diagnostics with stable source keys', async () => {
  const f = await execute(async (value, sink) => {
    const binding = bindingOf(value)
    await sink.started(binding)
    await sink.event(event('output', { stream: 'stderr', text: 'warning' }, 'c3'))
    await sink.event(event('output', { stream: 'stdout', text: 'ignored' }, 'c4'))
    return outcome(binding)
  })
  await f.pending
  expect(f.diagnostics).toEqual([{ line: 'warning', sourceKey: 'agent:task:run:c3' }])
})

test('a refused start acknowledgement stops the remote run', async () => {
  let observedAbort: unknown
  const f = await execute(
    async (value, sink, signal) => {
      const binding = bindingOf(value)
      await sink.started(binding)
      observedAbort = signal?.reason
      return outcome(binding, {
        cancelled: true,
        result: { ...okResult, exitCode: null, reason: 'cancelled' },
      })
    },
    { acknowledgeStart: true },
    {
      acknowledgeStarted: async () => {
        throw new Error('owner fenced the receipt')
      },
    },
  )
  const result = await f.pending
  expect(observedAbort).toBe('acknowledge-failed')
  expect(result.result).toBe('aborted')
  expect(String(result.acknowledgeError)).toContain('owner fenced the receipt')
})

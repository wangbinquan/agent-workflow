// RFC-370 §9.2 V1/V2 — a hosted script node is a TASK EXECUTION: journaled with
// its node run (`script:<task>:<run>`), adopted after a restart instead of
// resubmitted, its stdout/stderr lines carry stable source keys (replay is
// idempotent) and its outcome is read from the helper's result file, never
// parsed out of output. Interruptions follow the agent rules: a daemon
// shutdown detaches and the run ends with the daemon, a user cancel ends at
// once, an unobservable outcome is a failure, an output gap marks truncation.
import { expect, test } from 'bun:test'
import { DAEMON_SHUTDOWN_ABORT_REASON, type WorkflowNode } from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import type { TaskScriptRunRequest } from '@/modules/task-execution/application/ports/taskScriptRunFamily'
import { createHostedTaskScriptRunFamily } from '@/modules/task-execution/infrastructure/crewstation/taskScriptRunFamily'
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
import type { BusinessEvent } from '@/platform/crewstation/businessExecution'
import { CrewStationApiError } from '@/platform/crewstation/platformApi'
import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'

const unavailable = (): never => {
  throw new Error('unexpected effect')
}
let cursor = 0
const output = (stream: 'stdout' | 'stderr', text: string): BusinessEvent =>
  ({
    taskId: 'parent',
    subtaskId: 'subtask',
    attempt: 1,
    cursor: `c${++cursor}`,
    sourceEventId: `c${cursor}`,
    occurredAt: new Date(0).toISOString(),
    type: 'output',
    data: { stream, text },
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
const platformResult = {
  exitCode: 0,
  reason: 'completed',
  stdout: '',
  stderr: 'platform stderr',
  truncated: false,
  finalCursor: 'end',
}

function fixture(options: {
  readonly existing?: HostedExecutionBinding | null
  readonly outcomeFile?: unknown | null
  readonly run?: (
    value: HostedExecutionIntent,
    sink: HostedExecutionSink,
    signal?: AbortSignal,
  ) => Promise<HostedExecutionResult>
}) {
  const calls: string[] = []
  let submitted: HostedExecutionIntent | undefined
  const defaultRun = async (
    value: HostedExecutionIntent,
    sink: HostedExecutionSink,
  ): Promise<HostedExecutionResult> => {
    const binding = bindingOf(value)
    await sink.started(binding)
    await sink.event(output('stdout', 'first\nsec'))
    await sink.event(output('stdout', 'ond\ntail'))
    await sink.event(output('stderr', 'warn\n'))
    return {
      binding,
      result: platformResult,
      timedOut: false,
      cancelled: false,
      settle: async () => {
        calls.push('settle')
      },
    }
  }
  const executions: HostedExecution = {
    workspaceSettled: async () => true,
    find: async () => options.existing ?? null,
    async run(value, sink, signal) {
      calls.push('run')
      submitted = value
      return (options.run ?? defaultRun)(value, sink, signal)
    },
    async adopt(executionId, sink, signal) {
      calls.push('adopt')
      return (options.run ?? defaultRun)(options.existing ?? bindingOf({} as never), sink, signal)
    },
    cancel: unavailable,
    observing: () => false,
  }
  const helperCalls: { operation: string; value: unknown }[] = []
  const helper: WorkspaceHelper = {
    async call<T>(
      _taskId: string,
      operation: string,
      value: unknown,
      callOptions?: Parameters<WorkspaceHelper['call']>[3],
    ): Promise<T> {
      helperCalls.push({ operation, value })
      if (operation === 'script-interpreter')
        return { path: '/usr/bin/python3', version: 'Python 3.12.1' } as T
      if (operation === 'script-dependencies') {
        await callOptions?.onOutput?.('stdout', 'Collecting requests\nInstalled')
        await callOptions?.onOutput?.('stderr', 'notice\n')
        return { hash: 'deps-hash', libDir: '/work/deps/lib', rootDir: '/work/deps' } as T
      }
      throw new Error(`unexpected helper operation ${operation}`)
    },
  }
  const family = createHostedTaskScriptRunFamily({
    taskId: 'task',
    db: {} as ProviderNeutralDatabase,
    fence: {
      current: () => ({ epoch: 1, leaseId: 'l', instanceId: 'i' }),
      assertHeld: unavailable,
    },
    helper,
    executions,
    api: {
      async readFile(_task, query) {
        calls.push(`read:${query.path}`)
        if (options.outcomeFile === null || options.outcomeFile === undefined)
          throw new CrewStationApiError(404, 'not-found', 'no outcome', {})
        const bytes = Buffer.from(JSON.stringify(options.outcomeFile))
        return {
          path: query.path,
          version: 'v',
          size: bytes.length,
          offset: 0,
          contentBase64: bytes.toString('base64'),
          nextOffset: null,
        }
      },
    },
    workspaces: { ensure: async () => ({ businessTaskId: 'parent' }) },
    path: (reference) => reference.replace(/^cs-workspace:[^/]+/, '/work'),
  })
  return { family, calls, helperCalls, submitted: () => submitted }
}

async function request(
  family: ReturnType<typeof fixture>['family'],
  extra: Partial<TaskScriptRunRequest> = {},
) {
  const interpreter = (await family.resolveInterpreter('python', {}))!
  const stdout: [string, string | undefined][] = []
  const stderr: [string, string | undefined][] = []
  const value: TaskScriptRunRequest = {
    node: { id: 'script', kind: 'script' } as unknown as WorkflowNode,
    inputs: {},
    runContent: family.prepareRunContent('task', 'run'),
    workspaceRef: 'cs-workspace:task/worktrees/task',
    repositories: [{ name: 'repo', reference: 'cs-workspace:task/worktrees/task/repo' }],
    taskId: 'task',
    nodeId: 'script',
    nodeRunId: 'run',
    iteration: 0,
    retryIndex: 0,
    shardKey: null,
    envelopeNonce: 'nonce',
    interpreter,
    dependencies: null,
    onStdoutLine: (line, sourceKey) => {
      stdout.push([line, sourceKey])
    },
    onStderrLine: (line, sourceKey) => {
      stderr.push([line, sourceKey])
    },
    ...extra,
  }
  return { value, stdout, stderr }
}

const helperOutcome = {
  ok: true,
  value: {
    result: {
      outcome: 'exited',
      exitCode: 0,
      stderrTail: 'native tail',
      truncated: { stdout: false, stderr: false },
    },
    failureCode: null,
  },
}

test('one journaled execution: stable line keys, outcome from the result file, settled after reading it', async () => {
  const f = fixture({ outcomeFile: helperOutcome })
  const r = await request(f.family)
  const outcome = await f.family.execute(r.value)
  expect(outcome.failureCode).toBeNull()
  expect(outcome.result).toMatchObject({
    outcome: 'exited',
    exitCode: 0,
    stderrTail: 'native tail',
    rawStdout: 'first\nsecond\ntail',
    truncated: { stdout: false, stderr: false },
  })
  expect(r.stdout).toEqual([
    ['first', 'script:task:run:stdout:0'],
    ['second', 'script:task:run:stdout:1'],
    ['tail', 'script:task:run:stdout:2'],
  ])
  expect(r.stderr).toEqual([['warn', 'script:task:run:stderr:0']])
  const submitted = f.submitted()!
  expect(submitted).toMatchObject({
    executionId: 'script:task:run',
    nodeRunId: 'run',
    request: { kind: 'command', cwd: '/work' },
  })
  expect(submitted.request.kind === 'command' && submitted.request.argv.slice(0, 2)).toEqual([
    'agent-workflow',
    'workspace',
  ])
  // The binding is settled only after its outcome was read.
  expect(f.calls.at(-1)).toBe('settle')
  expect(f.calls.at(-2)).toStartWith('read:.aw/command-results/')
})

test('an existing binding is adopted after a restart instead of resubmitted', async () => {
  const existing = bindingOf({
    executionId: 'script:task:run',
    taskId: 'task',
    nodeRunId: 'run',
    businessTaskId: 'parent',
    requestKey: 'k',
    request: { kind: 'command', name: 'aw run-script script', argv: [] },
  })
  const f = fixture({ existing, outcomeFile: helperOutcome })
  await f.family.execute((await request(f.family)).value)
  expect(f.calls).toContain('adopt')
  expect(f.calls).not.toContain('run')
})

test('without a result file the platform outcome is reported', async () => {
  const f = fixture({
    outcomeFile: null,
    run: async (value, sink) => {
      const binding = bindingOf(value)
      await sink.started(binding)
      return {
        binding,
        result: { ...platformResult, exitCode: null, reason: 'cancelled' },
        timedOut: true,
        cancelled: true,
        settle: async () => undefined,
      }
    },
  })
  const outcome = await f.family.execute((await request(f.family)).value)
  expect(outcome.result).toMatchObject({
    outcome: 'timeout',
    exitCode: null,
    stderrTail: 'platform stderr',
  })
})

test('a retention gap marks both streams truncated', async () => {
  const f = fixture({
    outcomeFile: helperOutcome,
    run: async (value, sink) => {
      const binding = bindingOf(value)
      await sink.started(binding)
      await sink.event({
        ...output('stdout', ''),
        type: 'gap',
        data: { reason: 'retention-expired', earliestCursor: 'later' },
      } as BusinessEvent)
      return {
        binding,
        result: platformResult,
        timedOut: false,
        cancelled: false,
        settle: async () => undefined,
      }
    },
  })
  const outcome = await f.family.execute((await request(f.family)).value)
  expect(outcome.result.truncated).toEqual({ stdout: true, stderr: true })
})

test('a daemon shutdown detaches and the run ends with the daemon; a user cancel ends at once', async () => {
  const daemon = new AbortController()
  const detached = Promise.withResolvers<void>()
  const f = fixture({
    run: async (value) => {
      detached.resolve()
      throw new HostedExecutionDetachedError(value.executionId)
    },
  })
  let ended = false
  const pending = f.family
    .execute((await request(f.family, { signal: daemon.signal })).value)
    .then((outcome) => {
      ended = true
      return outcome
    })
  await detached.promise
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(ended).toBe(false)
  daemon.abort(DAEMON_SHUTDOWN_ABORT_REASON)
  expect((await pending).result.outcome).toBe('aborted')

  const user = new AbortController()
  user.abort('user-cancel')
  const cancelled = await f.family.execute((await request(f.family, { signal: user.signal })).value)
  expect(cancelled.result.outcome).toBe('aborted')
})

test('an unobservable outcome is a failure carrying its reason', async () => {
  const f = fixture({
    run: async (value) => {
      throw new HostedExecutionUnknownError(value.executionId, 'expired: history expired')
    },
  })
  const outcome = await f.family.execute((await request(f.family)).value)
  expect(outcome.result).toMatchObject({ outcome: 'exited', exitCode: null })
  expect(outcome.result.stderrTail).toContain('expired: history expired')
})

test('dependency installation is a workspace command whose output arrives as lines', async () => {
  const f = fixture({})
  const interpreter = (await f.family.resolveInterpreter('python', {}))!
  const lines: string[] = []
  const environment = await f.family.ensureDependencies({
    contentHomeRef: 'cs-workspace:task',
    language: 'python',
    interpreter: f.family.dependencyInterpreter(interpreter),
    specs: ['requests==2.32.0'],
    timeoutMs: 60_000,
    onLine: (stream, line) => {
      lines.push(`${stream}:${line}`)
    },
  })
  expect(environment).toMatchObject({
    kind: 'task-script-dependency-environment',
    hash: 'deps-hash',
  })
  expect(lines).toEqual(['stdout:Collecting requests', 'stderr:notice', 'stdout:Installed'])
  expect(f.helperCalls.at(-1)).toMatchObject({
    operation: 'script-dependencies',
    value: { interpreterPath: '/usr/bin/python3', specs: ['requests==2.32.0'] },
  })
})

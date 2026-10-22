// RFC-370 §9.2 V2 — durable task-image helper commands on a hosted volume,
// owned by Source Control (`hosted_workspace_commands`). The helper outcome is
// read from its result FILE in the volume (never parsed out of output), native
// errors keep their code/status/details, an oversized request is a typed 413
// before any platform call, a daemon shutdown detaches (the next owner settles
// the command from its platform result), a caller abort / deadline cancels and
// waits for the result, and commands whose caller is gone are abandoned
// instead of blocking the volume forever.
import { tablesOf } from '@/platform/persistence/sessionTables'
import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { DAEMON_SHUTDOWN_ABORT_REASON } from '@agent-workflow/shared'
import type {
  BusinessEvent,
  BusinessSubtask,
  CrewStationBusinessExecution,
  SubmitBusinessSubtask,
} from '@/platform/crewstation/businessExecution'
import { CrewStationApiError } from '@/platform/crewstation/platformApi'
import type { CrewStationMutationFence } from '@/platform/crewstation/mutationFence'
import {
  WORKSPACE_ARGUMENT_BUDGET_BYTES,
  WorkspaceCommandFailedError,
  WorkspaceCommandInputTooLargeError,
  WorkspaceCommandStoppedError,
  decodeWorkspaceHelperArguments,
} from '@/platform/crewstation/workspaceProtocol'
import {
  createHostedWorkspaceCommands,
  WorkspaceCommandDetachedError,
  WorkspaceCommandUnknownError,
} from '@/modules/source-control/infrastructure/crewstation/workspaceCommands'
import { DomainError } from '@/util/errors'
import { describeEachProvider } from './helpers/eachProvider'

const unused = async (): Promise<never> => {
  throw new Error('unexpected platform call')
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

describeEachProvider('RFC-370 hosted workspace commands', (harness) => {
  function setup() {
    const state = { epoch: 1, refuse: null as Error | null, eventsError: null as Error | null }
    const fence: CrewStationMutationFence = {
      current: () => ({ epoch: state.epoch, leaseId: 'lease', instanceId: 'instance' }),
      assertHeld: async () => {
        if (state.refuse !== null) throw state.refuse
      },
    }
    const submits: SubmitBusinessSubtask[] = []
    const cancels: string[] = []
    const files = new Map<string, string>()
    let subtasks = 0
    const results = new Map<string, BusinessEvent[]>()
    let stream: (signal?: AbortSignal) => AsyncGenerator<BusinessEvent> = async function* () {
      yield* []
      throw new Error('disconnected')
    }
    const event = (
      subtask: BusinessSubtask,
      cursor: string,
      body:
        | { type: 'output'; text: string }
        | { type: 'result'; reason?: string; exitCode?: number | null },
    ): BusinessEvent =>
      body.type === 'output'
        ? {
            taskId: subtask.taskId,
            subtaskId: subtask.id,
            attempt: subtask.attempt,
            cursor,
            sourceEventId: cursor,
            occurredAt: new Date(0).toISOString(),
            type: 'output',
            data: { stream: 'stdout', text: body.text },
          }
        : {
            taskId: subtask.taskId,
            subtaskId: subtask.id,
            attempt: subtask.attempt,
            cursor,
            sourceEventId: cursor,
            occurredAt: new Date(0).toISOString(),
            type: 'result',
            data: {
              exitCode: body.exitCode === undefined ? 0 : body.exitCode,
              reason: body.reason ?? 'completed',
              stdout: '',
              stderr: 'helper stderr',
              truncated: false,
              finalCursor: cursor,
            },
          }
    const byKey = new Map<string, BusinessSubtask>()
    let submitBehaviour: ((request: SubmitBusinessSubtask) => Promise<void>) | null = null
    const api: CrewStationBusinessExecution = {
      createTask: unused,
      getTask: unused,
      closeTask: unused,
      finalizeTask: unused,
      pauseTask: unused,
      resumeTask: unused,
      listSubtasks: unused,
      createMaterial: unused,
      getSubtask: unused,
      listFiles: unused,
      async submitSubtask(taskId, request) {
        submits.push(request)
        await submitBehaviour?.(request)
        const existing = byKey.get(request.requestKey)
        if (existing !== undefined) return existing
        subtasks += 1
        const subtask: BusinessSubtask = {
          id: `sub-${subtasks}`,
          taskId,
          kind: 'command',
          attempt: 1,
          state: 'running',
          executionId: `exec-${subtasks}`,
        }
        byKey.set(request.requestKey, subtask)
        return subtask
      },
      async cancelSubtask(_taskId, subtaskId, request) {
        cancels.push(`${subtaskId}:${request.requestKey}`)
      },
      async events(_taskId, query) {
        if (state.eventsError !== null) throw state.eventsError
        return { items: results.get(query.subtaskId ?? '') ?? [], hasMore: false, nextCursor: null }
      },
      streamEvents: (_taskId, _query, signal) => stream(signal),
      async readFile(_taskId, query) {
        const content = files.get(query.path)
        if (content === undefined) throw new CrewStationApiError(404, 'not-found', 'no file', {})
        const bytes = Buffer.from(content)
        return {
          path: query.path,
          version: 'v1',
          size: bytes.length,
          offset: 0,
          contentBase64: bytes.toString('base64'),
          nextOffset: null,
        }
      },
    }
    const commands = (now?: () => number) =>
      createHostedWorkspaceCommands({
        db: harness.db,
        fence,
        api,
        workspaces: { ensure: async () => ({ businessTaskId: 'parent-1' }) },
        commandEnvironment: (operation) =>
          operation === 'git-fetch' ? { GIT_TERMINAL_PROMPT: '0' } : undefined,
        ...(now === undefined ? {} : { now }),
      })
    const resultFile = (taskId: string, operationId: string) =>
      `.aw/command-results/${digest(`command:${taskId}:${operationId}`)}.json`
    /** The platform finishes the next submitted subtask with this outcome file. */
    const finish = (
      operationId: string,
      outcome: unknown | null,
      body: { reason?: string; exitCode?: number | null; output?: string } = {},
    ) => {
      const subtask: BusinessSubtask = {
        id: `sub-${subtasks + 1}`,
        taskId: 'parent-1',
        kind: 'command',
        attempt: 1,
        state: 'running',
        executionId: 'exec',
      }
      results.set(subtask.id, [
        ...(body.output === undefined
          ? []
          : [event(subtask, 'c1', { type: 'output', text: body.output })]),
        event(subtask, 'c2', { type: 'result', reason: body.reason, exitCode: body.exitCode }),
      ])
      if (outcome !== null) files.set(resultFile('task-1', operationId), JSON.stringify(outcome))
    }
    const rows = () => {
      const { hostedWorkspaceCommands } = tablesOf(harness.db)
      return harness.db.select().from(hostedWorkspaceCommands)
    }
    return {
      state,
      commands,
      submits,
      cancels,
      files,
      results,
      finish,
      rows,
      event,
      setStream(next: typeof stream) {
        stream = next
      },
      setSubmit(next: typeof submitBehaviour) {
        submitBehaviour = next
      },
    }
  }
  const idle = async function* (signal?: AbortSignal): AsyncGenerator<BusinessEvent> {
    if (signal !== undefined && !signal.aborted)
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))
    yield* []
  }

  test('the helper outcome comes from its result file and a replay never resubmits', async () => {
    const f = setup()
    f.finish('op', { ok: true, value: { ok: 7 } }, { output: 'native log line\n' })
    const lines: string[] = []
    const commands = f.commands()
    expect(
      await commands.call(
        'task-1',
        'exists',
        { path: 'a' },
        {
          operationId: 'op',
          onOutput: (_stream, text) => {
            lines.push(text)
          },
        },
      ),
    ).toEqual({ ok: 7 })
    expect(lines).toEqual(['native log line\n'])
    expect(await commands.call('task-1', 'exists', { path: 'a' }, { operationId: 'op' })).toEqual({
      ok: 7,
    })
    expect(await commands.recover('task-1', 'op')).toEqual({ value: { ok: 7 } })
    expect(f.submits).toHaveLength(1)
    const [submitted] = f.submits
    expect(submitted).toMatchObject({ kind: 'command', cwd: '/work', name: 'aw exists' })
    if (submitted?.kind !== 'command') throw new Error('fixture')
    expect(decodeWorkspaceHelperArguments(submitted.argv.slice(2))).toEqual({
      version: 2,
      operation: 'exists',
      input: { path: 'a' },
      resultPath: `/work/${f.files.keys().next().value}`,
    })
    expect((await f.rows())[0]).toMatchObject({ state: 'settled', operation: 'exists' })
  })

  test('native failures keep their code, HTTP status and details', async () => {
    const f = setup()
    f.finish('conflict', {
      ok: false,
      error: {
        code: 'git-conflict',
        message: 'merge conflict',
        status: 409,
        details: { paths: ['a'] },
      },
    })
    const commands = f.commands()
    for (let replay = 0; replay < 2; replay += 1) {
      const error = await commands
        .call('task-1', 'merge', {}, { operationId: 'conflict' })
        .catch((e: unknown) => e)
      expect(error).toBeInstanceOf(DomainError)
      expect(error).toMatchObject({ code: 'git-conflict', status: 409, details: { paths: ['a'] } })
    }
    f.finish('plain', { ok: false, error: { code: 'ENOENT', message: 'missing' } })
    await expect(
      commands.call('task-1', 'read', {}, { operationId: 'plain' }),
    ).rejects.toBeInstanceOf(WorkspaceCommandFailedError)
  })

  test('a missing outcome file means the helper never finished', async () => {
    const f = setup()
    f.finish('killed', null, { reason: 'oom-killed', exitCode: 137 })
    const error = await f
      .commands()
      .call('task-1', 'diff', {}, { operationId: 'killed' })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(WorkspaceCommandStoppedError)
    expect(error).toMatchObject({ outcome: 'exited', exitCode: 137, stderr: 'helper stderr' })
  })

  test('a request above the container argument budget is a typed 413 before any platform call', async () => {
    const f = setup()
    const error = await f
      .commands()
      .call('task-1', 'write-file', { content: 'x'.repeat(WORKSPACE_ARGUMENT_BUDGET_BYTES) })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(WorkspaceCommandInputTooLargeError)
    expect(error).toMatchObject({ code: 'hosted-command-input-too-large', status: 413 })
    expect(f.submits).toEqual([])
    expect(await f.rows()).toEqual([])
  })

  test('a daemon shutdown detaches; the next owner settles the command from its platform result', async () => {
    const f = setup()
    const shutdown = new AbortController()
    f.setStream(async function* (signal) {
      shutdown.abort(DAEMON_SHUTDOWN_ABORT_REASON)
      yield* idle(signal)
    })
    const first = f.commands()
    await expect(
      first.call('task-1', 'clone', {}, { operationId: 'clone', signal: shutdown.signal }),
    ).rejects.toBeInstanceOf(WorkspaceCommandDetachedError)
    expect(f.cancels).toEqual([])
    expect((await f.rows())[0]?.state).toBe('running')
    expect(await first.hasUnsettledCommands('parent-1')).toBe(true)
    expect(await first.hasUnsettledCommands('other-parent')).toBe(false)
    // Successor: the platform has finished the command meanwhile.
    f.state.epoch = 2
    f.results.set('sub-1', [
      f.event(
        {
          id: 'sub-1',
          taskId: 'parent-1',
          kind: 'command',
          attempt: 1,
          state: 'done',
          executionId: 'e',
        },
        'c9',
        { type: 'result' },
      ),
    ])
    f.files.set(
      `.aw/command-results/${digest('command:task-1:clone')}.json`,
      JSON.stringify({ ok: true, value: 'cloned' }),
    )
    const successor = f.commands()
    await successor.reconcile(new AbortController().signal)
    expect((await f.rows())[0]?.state).toBe('settled')
    expect(await successor.hasUnsettledCommands('parent-1')).toBe(false)
    expect(await successor.recover('task-1', 'clone')).toEqual({ value: 'cloned' })
    expect(f.submits).toHaveLength(1)
  })

  test('a caller abort cancels the remote command once and waits for its platform result', async () => {
    const f = setup()
    const caller = new AbortController()
    f.setStream(async function* (signal) {
      if (f.cancels.length === 0) {
        caller.abort('user-cancel')
        yield* idle(signal)
        return
      }
      yield f.event(
        {
          id: 'sub-1',
          taskId: 'parent-1',
          kind: 'command',
          attempt: 1,
          state: 'done',
          executionId: 'e',
        },
        'c5',
        { type: 'result', reason: 'cancelled', exitCode: null },
      )
    })
    const error = await f
      .commands()
      .call('task-1', 'diff', {}, { operationId: 'abort', signal: caller.signal })
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ outcome: 'aborted' })
    expect(f.cancels).toEqual([`sub-1:aw-command:${digest('command:task-1:abort')}:cancel`])
    expect((await f.rows())[0]?.state).toBe('settled')
  })

  test('the deadline cancels the remote command and reports a timeout', async () => {
    const f = setup()
    f.setStream(async function* (signal) {
      if (f.cancels.length === 0) {
        yield* idle(signal)
        return
      }
      yield f.event(
        {
          id: 'sub-1',
          taskId: 'parent-1',
          kind: 'command',
          attempt: 1,
          state: 'done',
          executionId: 'e',
        },
        'c5',
        { type: 'result', reason: 'cancelled', exitCode: null },
      )
    })
    const error = await f
      .commands()
      .call('task-1', 'diff', {}, { operationId: 'slow', timeoutMs: 0 })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(WorkspaceCommandStoppedError)
    expect(error).toMatchObject({ outcome: 'timeout' })
    expect(f.cancels).toHaveLength(1)
  })

  test('a submission refused by the platform settles the command', async () => {
    const f = setup()
    f.setSubmit(async () => {
      throw new CrewStationApiError(422, 'invalid', 'task is not running', {})
    })
    const commands = f.commands()
    await expect(commands.call('task-1', 'diff', {}, { operationId: 'refused' })).rejects.toThrow(
      'task is not running',
    )
    expect((await f.rows())[0]?.state).toBe('settled')
    expect(await commands.hasUnsettledCommands('parent-1')).toBe(false)
    await expect(
      commands.call('task-1', 'diff', {}, { operationId: 'refused' }),
    ).rejects.toBeInstanceOf(WorkspaceCommandStoppedError)
    expect(f.submits).toHaveLength(1)
  })

  test('an unknown submission is resubmitted with the original request key by the same operation', async () => {
    const f = setup()
    let lose = true
    f.setSubmit(async () => {
      if (lose) {
        lose = false
        throw new Error('connection reset after acceptance')
      }
    })
    const commands = f.commands()
    f.finish('fetch', { ok: true, value: 'fetched' })
    await expect(
      commands.call('task-1', 'git-fetch', {}, { operationId: 'fetch' }),
    ).rejects.toBeInstanceOf(WorkspaceCommandUnknownError)
    expect(await commands.call('task-1', 'git-fetch', {}, { operationId: 'fetch' })).toBe('fetched')
    expect(f.submits).toHaveLength(2)
    expect(f.submits[0]!.requestKey).toBe(f.submits[1]!.requestKey)
    // The operation's environment is frozen with the request.
    expect(f.submits[1]).toMatchObject({ env: { GIT_TERMINAL_PROMPT: '0' } })
  })

  test('never-acknowledged commands whose caller is gone are abandoned, not resubmitted', async () => {
    const f = setup()
    let clock = 1_000
    f.setSubmit(async () => {
      throw new Error('connection reset')
    })
    const stale = f.commands(() => clock)
    await expect(stale.call('task-1', 'diff', {}, { operationId: 'gone' })).rejects.toBeInstanceOf(
      WorkspaceCommandUnknownError,
    )
    await expect(stale.call('task-1', 'diff', {}, { operationId: 'fresh' })).rejects.toBeInstanceOf(
      WorkspaceCommandUnknownError,
    )
    expect(await stale.hasUnsettledCommands('parent-1')).toBe(true)
    // Within the grace period a caller of this process may still come back.
    await stale.reconcile(new AbortController().signal)
    expect((await f.rows()).map((row) => row.state)).toEqual(['submitting', 'submitting'])
    clock += 120_000
    await stale.reconcile(new AbortController().signal)
    expect((await f.rows()).map((row) => row.state)).toEqual(['abandoned', 'abandoned'])
    expect(await stale.hasUnsettledCommands('parent-1')).toBe(false)
    expect(f.submits).toHaveLength(2)
    // A returning caller restarts its own operation with the original key.
    f.setSubmit(null)
    f.finish('gone', { ok: true, value: 'done' })
    expect(await stale.call('task-1', 'diff', {}, { operationId: 'gone' })).toBe('done')
    expect(f.submits[2]!.requestKey).toBe(f.submits[0]!.requestKey)
  })

  test('an observation the platform refuses settles the command instead of retrying forever', async () => {
    const f = setup()
    f.state.eventsError = new CrewStationApiError(404, 'not-found', 'subtask not found', {})
    const commands = f.commands()
    const error = await commands
      .call('task-1', 'diff', {}, { operationId: 'gone' })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(WorkspaceCommandStoppedError)
    expect((await f.rows())[0]).toMatchObject({ state: 'settled' })
    expect(await commands.hasUnsettledCommands('parent-1')).toBe(false)
    expect(JSON.parse((await f.rows())[0]!.outcomeJson!)).toMatchObject({
      reason: 'observation-rejected',
    })
  })

  test('a parent paused before the submit is resumed and the same command repeated', async () => {
    const f = setup()
    let refused = false
    f.setSubmit(async () => {
      if (!refused) {
        refused = true
        throw new CrewStationApiError(409, 'conflict', 'task paused', { code: 'task_paused' })
      }
    })
    f.finish('paused', { ok: true, value: 'ran' })
    expect(await f.commands().call('task-1', 'diff', {}, { operationId: 'paused' })).toBe('ran')
    expect(f.submits).toHaveLength(2)
    expect(f.submits[0]!.requestKey).toBe(f.submits[1]!.requestKey)
  })

  test('a replay with a different request is refused', async () => {
    const f = setup()
    f.finish('op', { ok: true, value: 1 })
    const commands = f.commands()
    await commands.call('task-1', 'write-file', { path: 'a' }, { operationId: 'op' })
    await expect(
      commands.call('task-1', 'write-file', { path: 'b' }, { operationId: 'op' }),
    ).rejects.toThrow('hosted-command-replay-mismatch')
  })

  test('a write refused for a successor lease detaches instead of failing the command', async () => {
    const f = setup()
    f.setStream(async function* () {
      f.state.refuse = new DomainError('execution-standby', 'lease moved', 503)
      yield f.event(
        {
          id: 'sub-1',
          taskId: 'parent-1',
          kind: 'command',
          attempt: 1,
          state: 'running',
          executionId: 'e',
        },
        'c1',
        { type: 'output', text: 'progress' },
      )
    })
    await expect(
      f.commands().call('task-1', 'clone', {}, { operationId: 'moved' }),
    ).rejects.toBeInstanceOf(WorkspaceCommandDetachedError)
    expect(f.cancels).toEqual([])
  })
})

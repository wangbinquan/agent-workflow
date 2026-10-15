import { ulid } from 'ulid'
import { createHash } from 'node:crypto'
import {
  workspaceHelperArguments,
  workspaceHelperResult,
  WorkspaceCommandStoppedError,
  type WorkspaceHelper,
} from '@/platform/crewstation/workspaceProtocol'
import type { HostedExecution, HostedExecutionSink, HostedExecutionResult } from './execution'

export interface HostedWorkspaceHelper extends WorkspaceHelper {
  /** Observe only an already-persisted operation; never invent a cleanup-time execution. */
  recover<T>(taskId: string, operationId: string): Promise<{ value: T } | null>
}

/** The shared command execution is used by workspace effects and scripts. */
export function createHostedWorkspaceHelper(input: {
  readonly executions: HostedExecution
  readonly workspace: { ensure(taskId: string): Promise<{ readonly businessTaskId: string }> }
}): HostedWorkspaceHelper {
  type Options = NonNullable<Parameters<WorkspaceHelper['call']>[3]>
  const collect = async <T>(
    executionId: string,
    options: Options,
    observe: (sink: HostedExecutionSink) => Promise<HostedExecutionResult>,
  ): Promise<T> => {
    let stdout = ''
    const outcome = await observe({
      async started(binding) {
        await options.onStarted?.({
          executionId,
          businessTaskId: binding.businessTaskId,
          subtaskId: binding.subtaskId!,
          attempt: binding.attempt!,
        })
      },
      async event(event) {
        if (event.type !== 'output') return
        if (event.data.stream === 'stdout') {
          stdout += event.data.text
          if (Buffer.byteLength(stdout) > 64 * 1024 * 1024)
            throw new Error('hosted-command-output-limit')
        }
        await options.onOutput?.(event.data.stream, event.data.text)
      },
      checkpoint: async () => undefined,
    })
    if (outcome.result.exitCode !== 0) {
      await outcome.settle()
      throw new WorkspaceCommandStoppedError(
        outcome.timedOut || /timeout|deadline/i.test(outcome.result.reason)
          ? 'timeout'
          : /cancel|abort/i.test(outcome.result.reason)
            ? 'aborted'
            : 'exited',
        outcome.result.exitCode,
        stdout || outcome.result.stdout,
        outcome.result.stderr,
        outcome.result.truncated,
      )
    }
    const parsed = workspaceHelperResult<T>(stdout || outcome.result.stdout)
    await outcome.settle()
    return parsed
  }
  return {
    async recover<T>(taskId: string, operationId: string) {
      const executionId = `workspace:${taskId}:${operationId}`
      if ((await input.executions.find(executionId)) === null) return null
      return {
        value: await collect<T>(executionId, {}, (sink) =>
          input.executions.adopt(executionId, sink),
        ),
      }
    },
    async call<T>(
      taskId: string,
      operation: string,
      value: unknown,
      options: Options = {},
    ): Promise<T> {
      const workspace = await input.workspace.ensure(taskId)
      const operationId = options.operationId ?? ulid()
      const executionId = `workspace:${taskId}:${operationId}`
      const requestKey = `aw-command:${createHash('sha256').update(executionId).digest('hex')}`
      const argv = workspaceHelperArguments(operation, value)
      return collect<T>(executionId, options, (sink) =>
        input.executions.run(
          {
            taskId,
            executionId,
            businessTaskId: workspace.businessTaskId,
            requestKey,
            ...(options.nodeRunId === undefined ? {} : { nodeRunId: options.nodeRunId }),
            timeoutMs: options.timeoutMs ?? 1_800_000,
            request: {
              kind: 'command',
              name: `aw ${operation}`,
              cwd: '/work',
              argv,
              timeoutSeconds: Math.min(
                86_400,
                Math.max(1, Math.ceil((options.timeoutMs ?? 1_800_000) / 1_000)),
              ),
            },
          },
          sink,
          options.signal,
        ),
      )
    },
  }
}

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { CrewStationMutationFence } from '@/platform/crewstation/mutationFence'
import type { CrewStationBusinessExecution } from '@/platform/crewstation/businessExecution'
import { isCrewStationApiError } from '@/platform/crewstation/platformApi'
import {
  parseWorkspaceHelperOutcome,
  WORKSPACE_RESULT_MAX_BYTES,
  workspaceHelperArguments,
  workspaceHelperValue,
  workspaceResultPath,
  type WorkspaceHelper,
} from '@/platform/crewstation/workspaceProtocol'
import type {
  TaskScriptRunFamily,
  TaskScriptInterpreter,
  TaskScriptDependencyEnvironment,
  TaskScriptResult,
} from '../../application/ports/taskScriptRunFamily'
import type { ResolvedInterpreter, ScriptRunOutcome } from '../local/scriptRun'
import type { ScriptDepsEnv } from '../local/scriptDepsEnv'
import {
  createHostedProcessEffectProjection,
  type HostedProcessReceipt,
} from './processEffectProjection'
import { DAEMON_SHUTDOWN_ABORT_REASON } from '@agent-workflow/shared'
import {
  HostedExecutionDetachedError,
  HostedExecutionUnknownError,
  untilDaemonShutdown,
  type HostedExecution,
} from './execution'
import { sha256Hex } from '@/util/hash'

/** Same bound as the native runner's retained stdout (envelope parsing). */
const RETAINED_STDOUT_LIMIT_BYTES = 32 * 1024 * 1024
/** CS commands accept at most one day; a script without a node timeout gets it. */
const UNBOUNDED_SCRIPT_TIMEOUT_MS = 86_400_000

type HostedScriptOutcome = Omit<ScriptRunOutcome, 'result'> & {
  readonly result: Omit<ScriptRunOutcome['result'], 'rawStdout'>
}

/** RFC-370 §9.2 V1/V2 — a script node is a task execution: it is journaled
 * with the node run and adopted after a restart like an agent. Interpreter
 * resolution and dependency preparation are ordinary workspace commands. */
export function createHostedTaskScriptRunFamily(input: {
  readonly taskId: string
  readonly db: PersistenceDb
  readonly fence: CrewStationMutationFence
  readonly helper: WorkspaceHelper
  readonly executions: HostedExecution
  readonly api: Pick<CrewStationBusinessExecution, 'readFile'>
  readonly workspaces: { ensure(taskId: string): Promise<{ readonly businessTaskId: string }> }
  readonly path: (reference: string) => string
}): TaskScriptRunFamily {
  const interpreters = new WeakMap<object, ResolvedInterpreter>()
  const environments = new WeakMap<object, ScriptDepsEnv>()
  const runContents = new WeakMap<object, string>()
  const receipts = new WeakMap<object, HostedProcessReceipt>()
  const get = <T>(map: WeakMap<object, T>, key: object): T => {
    const value = map.get(key)
    if (value === undefined) throw new Error('hosted-script-reference-unavailable')
    return value
  }
  const interpreter = (value: TaskScriptInterpreter) => get(interpreters, value.reference)
  const dependencies = (value: TaskScriptDependencyEnvironment | null) =>
    value === null ? null : get(environments, value.reference)
  const readOutcome = async (
    businessTaskId: string,
    resultPath: string,
  ): Promise<HostedScriptOutcome | null> => {
    try {
      const page = await input.api.readFile(businessTaskId, {
        path: resultPath.replace(/^\/work\/?/, ''),
        offset: 0,
        limit: WORKSPACE_RESULT_MAX_BYTES,
      })
      if (page.nextOffset !== null) throw new Error('hosted-script-result-too-large')
      return workspaceHelperValue<HostedScriptOutcome>(
        parseWorkspaceHelperOutcome(Buffer.from(page.contentBase64, 'base64').toString('utf8')),
      )
    } catch (error) {
      if (isCrewStationApiError(error) && error.status === 404) return null
      throw error
    }
  }
  return {
    async resolveInterpreter(language, overrides) {
      const resolved = await input.helper.call<ResolvedInterpreter | null>(
        input.taskId,
        'script-interpreter',
        { language, overrides },
      )
      if (resolved === null) return null
      const reference = {}
      interpreters.set(reference, resolved)
      return {
        kind: 'task-script-interpreter',
        reference,
        label: resolved.path,
        version: resolved.version,
      }
    },
    describeInterpreterResolution: (language) => `CrewStation task image ${language} interpreter`,
    prepareRunContent(taskId, nodeRunId) {
      const reference = {}
      runContents.set(reference, `/work/runs/${taskId}/${nodeRunId}`)
      return { kind: 'task-script-run-content', reference }
    },
    dependencyInterpreter(value) {
      const reference = {}
      interpreters.set(reference, interpreter(value))
      return { kind: 'task-script-dependency-interpreter', reference }
    },
    async ensureDependencies(request) {
      const target = get(interpreters, request.interpreter.reference)
      // Every preparation is its own command: the native environment cache
      // makes a repeat cheap, and one failed install never poisons a retry.
      const buffers = { stdout: '', stderr: '' }
      const resolved = await input.helper.call<ScriptDepsEnv | null>(
        input.taskId,
        'script-dependencies',
        {
          appHome: '/work',
          language: request.language,
          interpreterPath: target.path,
          interpreterVersion: target.version,
          specs: request.specs,
          timeoutMs: request.timeoutMs,
        },
        {
          ...(request.signal === undefined ? {} : { signal: request.signal }),
          timeoutMs: request.timeoutMs,
          async onOutput(stream, text) {
            buffers[stream] += text
            let newline: number
            while ((newline = buffers[stream].indexOf('\n')) >= 0) {
              const line = buffers[stream].slice(0, newline).replace(/\r$/, '')
              buffers[stream] = buffers[stream].slice(newline + 1)
              await request.onLine?.(stream, line)
            }
          },
        },
      )
      for (const stream of ['stdout', 'stderr'] as const)
        if (buffers[stream]) await request.onLine?.(stream, buffers[stream])
      if (resolved === null) return null
      const reference = {}
      environments.set(reference, resolved)
      return { kind: 'task-script-dependency-environment', reference, hash: resolved.hash }
    },
    async execute(request) {
      const frozen = {
        node: request.node,
        inputs: request.inputs,
        runDir: get(runContents, request.runContent.reference),
        worktreePath: input.path(request.workspaceRef),
        repos: request.repositories.map((repository) => ({
          name: repository.name,
          path: input.path(repository.reference),
        })),
        taskId: request.taskId,
        nodeId: request.nodeId,
        nodeRunId: request.nodeRunId,
        iteration: request.iteration,
        retryIndex: request.retryIndex,
        shardKey: request.shardKey,
        envelopeNonce: request.envelopeNonce,
        interpreter: interpreter(request.interpreter),
        depsEnv: dependencies(request.dependencies),
        timeoutMs: request.timeoutMs,
        killEscalationGraceMs: request.killEscalationGraceMs,
        gitUserName: request.gitUserName,
        gitUserEmail: request.gitUserEmail,
      }
      await request.beforeStart?.({
        project(_persistence, resources) {
          const projection = createHostedProcessEffectProjection<TaskScriptResult>({
            db: input.db,
            fence: input.fence,
            request: frozen,
            ...('writerWorkspace' in resources
              ? { writerWorkspace: resources.writerWorkspace }
              : {}),
          })
          return {
            describe: () => projection.describe(),
            recordSpawnReceipt: ({ receipt, ...record }) =>
              projection.recordSpawnReceipt({
                ...record,
                receipt: get(receipts, receipt.reference),
              }),
            settlementReceipt: (result) => projection.settlementReceipt(result),
          }
        },
      })
      const executionId = `script:${request.taskId}:${request.nodeRunId}`
      const resultPath = workspaceResultPath(sha256Hex(executionId))
      const timeoutMs =
        (request.timeoutMs ?? UNBOUNDED_SCRIPT_TIMEOUT_MS - 60_000) +
        (request.killEscalationGraceMs ?? 5_000) +
        30_000
      const { businessTaskId } = await input.workspaces.ensure(request.taskId)
      const buffers = { stdout: '', stderr: '' }
      const lineNumbers = { stdout: 0, stderr: 0 }
      let rawStdout = ''
      let stdoutTruncated = false
      let outputGap = false
      const line = async (stream: 'stdout' | 'stderr', value: string) => {
        const sourceKey = `${executionId}:${stream}:${lineNumbers[stream]++}`
        await (stream === 'stdout'
          ? request.onStdoutLine?.(value, sourceKey)
          : request.onStderrLine?.(value, sourceKey))
      }
      const sink = {
        async started(binding: {
          businessTaskId: string
          subtaskId: string | null
          attempt: number | null
        }) {
          const reference = {}
          receipts.set(reference, {
            executionId,
            businessTaskId: binding.businessTaskId,
            subtaskId: binding.subtaskId!,
            attempt: binding.attempt!,
          })
          await request.onStarted?.({ kind: 'task-script-start', reference })
        },
        async event(event: { type: string; data: unknown }) {
          if (event.type === 'gap') {
            outputGap = true
            return
          }
          if (event.type !== 'output') return
          const { stream, text } = event.data as { stream: 'stdout' | 'stderr'; text: string }
          if (stream === 'stdout') {
            if (
              Buffer.byteLength(rawStdout) + Buffer.byteLength(text) <=
              RETAINED_STDOUT_LIMIT_BYTES
            )
              rawStdout += text
            else stdoutTruncated = true
          }
          buffers[stream] += text
          let newline: number
          while ((newline = buffers[stream].indexOf('\n')) >= 0) {
            const value = buffers[stream].slice(0, newline).replace(/\r$/, '')
            buffers[stream] = buffers[stream].slice(newline + 1)
            await line(stream, value)
          }
        },
        checkpoint: async () => undefined,
      }
      let result: Omit<TaskScriptResult, 'settlement'>
      let failureCode: HostedScriptOutcome['failureCode'] = null
      try {
        const intent = {
          executionId,
          taskId: request.taskId,
          nodeRunId: request.nodeRunId,
          businessTaskId,
          requestKey: `aw-script:${sha256Hex(executionId)}`,
          request: {
            kind: 'command' as const,
            name: `aw run-script ${request.nodeId}`,
            cwd: '/work',
            argv: workspaceHelperArguments('run-script', frozen, resultPath),
            timeoutSeconds: Math.min(86_400, Math.ceil(timeoutMs / 1_000)),
          },
          timeoutMs,
        }
        const outcome =
          (await input.executions.find(executionId)) === null
            ? await input.executions.run(intent, sink, request.signal)
            : await input.executions.adopt(executionId, sink, request.signal)
        for (const stream of ['stdout', 'stderr'] as const)
          if (buffers[stream]) {
            await line(stream, buffers[stream])
            buffers[stream] = ''
          }
        const helper = await readOutcome(businessTaskId, resultPath)
        await outcome.settle()
        if (helper !== null) {
          failureCode = helper.failureCode
          result = {
            ...helper.result,
            rawStdout,
            truncated: {
              stdout: helper.result.truncated.stdout || stdoutTruncated || outputGap,
              stderr: helper.result.truncated.stderr || outputGap,
            },
          }
        } else {
          result = {
            outcome: outcome.timedOut ? 'timeout' : outcome.cancelled ? 'aborted' : 'exited',
            exitCode: outcome.result.exitCode,
            rawStdout,
            stderrTail: outcome.result.stderr,
            truncated: {
              stdout: stdoutTruncated || outcome.result.truncated,
              stderr: outcome.result.truncated,
            },
          }
        }
      } catch (error) {
        if (error instanceof HostedExecutionDetachedError) {
          // The remote script continues for the next execution owner; the run
          // ends interrupted with the daemon (a user cancel ends at once).
          if (
            request.signal?.aborted !== true ||
            request.signal.reason === DAEMON_SHUTDOWN_ABORT_REASON
          )
            await untilDaemonShutdown(request.signal)
          result = {
            outcome: 'aborted',
            exitCode: null,
            rawStdout,
            stderrTail: error.message,
            truncated: { stdout: true, stderr: true },
          }
        } else if (error instanceof HostedExecutionUnknownError) {
          result = {
            outcome: 'exited',
            exitCode: null,
            rawStdout,
            stderrTail: error.message,
            truncated: { stdout: true, stderr: true },
          }
        } else throw error
      }
      return {
        result: { ...result, settlement: { kind: 'task-script-result', reference: {} } },
        failureCode,
      }
    },
    runtimeParameters(request) {
      const target = interpreter(request.interpreter)
      return JSON.stringify({
        script: {
          interpreter: target.path,
          interpreterVersion: target.version,
          depsHash: dependencies(request.dependencies)?.hash ?? null,
        },
      })
    },
    async recordUnownedStart(request) {
      get(receipts, request.receipt.reference)
      await request.persistence.patch({
        nodeRunId: request.nodeRunId,
        values: {
          runtime: {
            pid: null,
            spawnBinaryPath: null,
            spawnLaunchNonce: null,
          },
          config: {
            runtimeParamsJson: request.runtimeParamsJson,
          },
        },
        ...request.executionContext(),
      })
    },
  }
}

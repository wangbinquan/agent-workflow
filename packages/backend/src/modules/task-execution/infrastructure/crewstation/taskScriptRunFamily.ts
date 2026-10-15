import { createHash } from 'node:crypto'
import type { ProviderNeutralDatabase } from '@/db/query'
import type { CrewStationMutationFence } from '@/platform/crewstation/mutationFence'
import {
  WORKSPACE_RESULT_PREFIX,
  WorkspaceCommandStoppedError,
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
import { HostedExecutionUnknownError } from './execution'

export function createHostedTaskScriptRunFamily(input: {
  readonly taskId: string
  readonly db: ProviderNeutralDatabase
  readonly fence: CrewStationMutationFence
  readonly helper: WorkspaceHelper
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
      const spec = {
        appHome: '/work',
        language: request.language,
        interpreterPath: target.path,
        interpreterVersion: target.version,
        specs: request.specs,
        timeoutMs: request.timeoutMs,
      }
      const resolved = await input.helper.call<ScriptDepsEnv | null>(
        input.taskId,
        'script-dependencies',
        spec,
        {
          operationId: `script-deps:${createHash('sha256').update(JSON.stringify(spec)).digest('hex')}`,
          signal: request.signal,
          timeoutMs: request.timeoutMs,
        },
      )
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
      const buffers = { stdout: '', stderr: '' }
      const line = async (stream: 'stdout' | 'stderr', value: string) => {
        if (value.startsWith(WORKSPACE_RESULT_PREFIX)) return
        await (stream === 'stdout' ? request.onStdoutLine?.(value) : request.onStderrLine?.(value))
      }
      let outcome: Pick<ScriptRunOutcome, 'failureCode'> & {
        result: Omit<TaskScriptResult, 'settlement'>
      }
      try {
        outcome = await input.helper.call<ScriptRunOutcome>(request.taskId, 'run-script', frozen, {
          operationId: `script:${request.nodeRunId}`,
          nodeRunId: request.nodeRunId,
          signal: request.signal,
          timeoutMs:
            (request.timeoutMs ?? 1_800_000) + (request.killEscalationGraceMs ?? 5_000) + 30_000,
          async onStarted(receipt) {
            const reference = {}
            receipts.set(reference, receipt)
            await request.onStarted?.({ kind: 'task-script-start', reference })
          },
          async onOutput(stream, text) {
            buffers[stream] += text
            let newline: number
            while ((newline = buffers[stream].indexOf('\n')) >= 0) {
              const value = buffers[stream].slice(0, newline).replace(/\r$/, '')
              buffers[stream] = buffers[stream].slice(newline + 1)
              await line(stream, value)
            }
          },
        })
      } catch (error) {
        if (error instanceof WorkspaceCommandStoppedError) {
          outcome = {
            failureCode: null,
            result: {
              outcome: error.outcome,
              exitCode: error.exitCode,
              rawStdout: error.stdout,
              stderrTail: error.stderr,
              truncated: { stdout: error.truncated, stderr: error.truncated },
            },
          }
        } else if (error instanceof HostedExecutionUnknownError) {
          outcome = {
            failureCode: null,
            result: {
              outcome: 'unreaped',
              exitCode: null,
              rawStdout: '',
              stderrTail: error.message,
              truncated: { stdout: false, stderr: false },
            },
          }
        } else throw error
      }
      for (const stream of ['stdout', 'stderr'] as const)
        if (buffers[stream]) await line(stream, buffers[stream])
      const result: TaskScriptResult = {
        outcome: outcome.result.outcome,
        exitCode: outcome.result.exitCode,
        rawStdout: outcome.result.rawStdout,
        stderrTail: outcome.result.stderrTail,
        truncated: outcome.result.truncated,
        spawnError: outcome.result.spawnError,
        settlement: { kind: 'task-script-result', reference: {} },
      }
      return { result, failureCode: outcome.failureCode }
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
          pid: null,
          spawnBinaryPath: null,
          spawnLaunchNonce: null,
          runtimeParamsJson: request.runtimeParamsJson,
        },
        ...request.executionContext(),
      })
    },
  }
}

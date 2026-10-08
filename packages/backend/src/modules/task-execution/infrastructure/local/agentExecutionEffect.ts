import type { AgentExecutionParticipants } from '../../application/ports/agentExecutionBinding'
import { ulid } from 'ulid'
import type {
  ExecutionEffectPort,
  ExecutionEffectResult,
  ExecutionStartReceipt,
} from '../../application/ports/executionEffect'
import type { ProcessEffectProjection } from '../../application/ports/processEffectProjection'
import type { TaskExecutionEffectPersistence } from '../../application/ports/taskExecutionEffectStore'
import type { NodeExecutionPersistence } from '../../application/ports/nodeExecutionPersistence'
import {
  createLocalProcessEffectProjection,
  type LocalProcessResources,
} from './processEffectProjection'
import {
  runAgentProcess,
  type AgentProcessRequest,
  type AgentProcessResult,
} from '@/platform/execution/local/agentProcess'
import type { Logger } from '@/util/log'
import type { ObservationNativeProcessFact } from '@agent-workflow/shared'

type NativeStartReceipt = Parameters<NonNullable<AgentProcessRequest['onSpawned']>>[0]

/** Native compatibility owner; never an execution request or result field. */
export interface NativeAgentStartReceiptOwner {
  onSpawned?: (receipt: {
    pid: number | null
    spawnedAt: number
    spawnBinaryPath: string
  }) => void | Promise<void>
}

/** Physical material, PID projection and the original process mechanism stay
 * in this selected native implementation. No registry/Paths/default lookup. */
export function bindLocalAgentExecutionEffect(input: {
  readonly materialRef: string
  readonly command: () => readonly string[]
  readonly workingDirectory: () => string
  readonly environment: () => Record<string, string>
  readonly stdin: () => AgentProcessRequest['stdin']
  readonly requireSpawnReceipt?: true
  readonly nativeStartOwner?: NativeAgentStartReceiptOwner
  readonly observeNativeProcess?: (fact: ObservationNativeProcessFact) => Promise<void>
  readonly taskEffect?: {
    readonly persistence: TaskExecutionEffectPersistence
    readonly nodeExecution: () => NodeExecutionPersistence
    readonly argv: readonly string[]
    readonly cwd: string
    readonly resourceKeys: LocalProcessResources
    readonly observeNativeProcess?: (fact: ObservationNativeProcessFact) => Promise<void>
  }
  /** Native test fixture only; normal execution contracts contain no runner. */
  readonly runNative?: typeof runAgentProcess
}) {
  const executionRef = `aw-execution:${ulid()}`
  const workspaceRef = `aw-execution-workspace:${ulid()}`
  const receipts = new WeakMap<ExecutionStartReceipt, NativeStartReceipt>()
  let terminal: AgentProcessResult | undefined
  let submitted = false
  const runNative = input.runNative ?? runAgentProcess
  const effect: ExecutionEffectPort = {
    async submit(request) {
      if (
        request.executionRef !== executionRef ||
        request.materialRef !== input.materialRef ||
        request.workspaceRef !== workspaceRef
      ) {
        throw new Error('execution-binding-reference-unavailable')
      }
      if (submitted) throw new Error('execution-binding-already-submitted')
      submitted = true
      const observe = async (fact: ObservationNativeProcessFact) => {
        try {
          await input.taskEffect?.observeNativeProcess?.(fact)
          await input.observeNativeProcess?.(fact)
        } catch {
          request.log?.warn('native-process-observation-write-failed')
        }
      }
      const result = await runNative({
        cmd: input.command(),
        cwd: input.workingDirectory(),
        env: input.environment(),
        ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
        ...(request.termGraceMs !== undefined ? { termGraceMs: request.termGraceMs } : {}),
        ...(request.abortSignal !== undefined ? { abortSignal: request.abortSignal } : {}),
        ...(input.stdin()?.mode === 'pipe' ? { stdin: input.stdin() } : {}),
        ...(request.beforeStart !== undefined ? { beforeSpawn: request.beforeStart } : {}),
        ...(request.onStarted !== undefined ||
        input.taskEffect?.observeNativeProcess !== undefined ||
        input.observeNativeProcess !== undefined
          ? {
              onSpawned: async (native: NativeStartReceipt) => {
                const receipt: ExecutionStartReceipt = {
                  executionRef,
                  startedAt: native.spawnedAt,
                }
                receipts.set(receipt, native)
                if (native.pid !== null)
                  await observe({
                    contract: 'native-process-facts-v2',
                    phase: 'spawned',
                    pid: native.pid,
                    launchNonce: native.launchNonce ?? null,
                    spawnedAt: native.spawnedAt,
                    reapedAt: null,
                    drainedAt: null,
                    outcome: null,
                    drainTimedOut: false,
                    pumpError: false,
                  })
                await request.onStarted?.(receipt)
              },
            }
          : {}),
        ...(input.requireSpawnReceipt === true ||
        input.observeNativeProcess !== undefined ||
        input.taskEffect?.observeNativeProcess !== undefined
          ? { requireSpawnReceipt: true }
          : {}),
        ...(request.capture !== undefined ? { capture: request.capture } : {}),
        ...(request.cleanup !== undefined ? { cleanup: request.cleanup } : {}),
        ...(request.log !== undefined ? { log: request.log } : {}),
      })
      terminal = result
      await observe({
        contract: 'native-process-facts-v2',
        phase: 'settled',
        pid: result.pid,
        launchNonce: result.launchNonce ?? null,
        spawnedAt: result.lifecycle?.spawnedAt ?? null,
        reapedAt: result.lifecycle?.reapedAt ?? null,
        drainedAt: result.lifecycle?.drainedAt ?? null,
        outcome: result.outcome,
        drainTimedOut: result.drainTimedOut === true,
        pumpError: result.pumpError !== undefined,
      })
      return {
        executionRef,
        outcome: result.outcome,
        exitCode: result.exitCode,
        rawStdout: result.rawStdout,
        stderrTail: result.stderrTail,
        durationMs: result.durationMs,
        ...(result.spawnError === undefined ? {} : { spawnError: result.spawnError }),
        ...(result.cleanupFailed === undefined ? {} : { cleanupFailed: result.cleanupFailed }),
        ...(result.drainTimedOut === undefined ? {} : { drainTimedOut: result.drainTimedOut }),
        ...(result.pumpError === undefined ? {} : { pumpError: result.pumpError }),
      }
    },
  }
  const nativeReceipt = (receipt: ExecutionStartReceipt): NativeStartReceipt => {
    const native = receipts.get(receipt)
    if (native === undefined) throw new Error('execution-start-receipt-unavailable')
    return native
  }
  const nativeResult = (result: ExecutionEffectResult): AgentProcessResult => {
    if (result.executionRef !== executionRef || terminal === undefined) {
      throw new Error('execution-terminal-receipt-unavailable')
    }
    return terminal
  }
  const localProjection =
    input.taskEffect === undefined
      ? undefined
      : createLocalProcessEffectProjection({
          persistence: input.taskEffect.persistence,
          processKind: 'agent',
          argv: input.taskEffect.argv,
          cwd: input.taskEffect.cwd,
          resourceKeys: input.taskEffect.resourceKeys,
        })
  const projection:
    | ProcessEffectProjection<ExecutionStartReceipt, ExecutionEffectResult>
    | undefined =
    localProjection === undefined
      ? undefined
      : {
          describe: () => localProjection.describe(),
          recordSpawnReceipt: (identity) =>
            localProjection.recordSpawnReceipt({
              ...identity,
              receipt: nativeReceipt(identity.receipt),
            }),
          settlementReceipt: (result) => localProjection.settlementReceipt(nativeResult(result)),
        }
  return {
    effect,
    executionRef,
    materialRef: input.materialRef,
    workspaceRef,
    projection,
    /** The legacy owner still receives its original three fields and receiver. */
    acknowledgeNativeOwner(receipt: ExecutionStartReceipt): void | Promise<void> {
      const native = nativeReceipt(receipt)
      const owner = input.nativeStartOwner
      return owner?.onSpawned?.({
        pid: native.pid,
        spawnedAt: native.spawnedAt,
        spawnBinaryPath: native.spawnBinaryPath,
      })
    },
    async recordLegacyTaskReceipt(receipt: ExecutionStartReceipt, nodeRunId: string) {
      const task = input.taskEffect
      if (task === undefined) throw new Error('execution-task-receipt-participant-unavailable')
      const native = nativeReceipt(receipt)
      await task.nodeExecution().patch({
        nodeRunId,
        values: {
          pid: native.pid,
          spawnBinaryPath: native.spawnBinaryPath,
          spawnLaunchNonce: native.launchNonce ?? null,
        },
      })
    },
    reportUnreaped(
      result: ExecutionEffectResult,
      input: {
        readonly nodeRunId: string
        readonly deadlineMs: number
        readonly log: Logger
      },
    ) {
      const native = nativeResult(result)
      input.log.error('child survived SIGKILL escalation past reap deadline; abandoning', {
        nodeRunId: input.nodeRunId,
        pid: native.pid,
        deadlineMs: input.deadlineMs,
      })
    },
    unreapedMessage(result: ExecutionEffectResult, deadlineMs: number) {
      const native = nativeResult(result)
      return `child-unkillable: pid ${native.pid} survived SIGTERM→SIGKILL escalation past ${deadlineMs}ms; abandoned (detached process group left running)`
    },
  }
}

/** Only this native owner interprets the participant it issued. Another
 * selected implementation owns its own receipt dialect and participant. */
interface NativeAgentExecutionTaskParticipants {
  readonly persistence: TaskExecutionEffectPersistence
  readonly nodeExecution: () => NodeExecutionPersistence
  readonly readOnlyWorkspace: () => boolean
  readonly observeNativeProcess?: (fact: ObservationNativeProcessFact) => Promise<void>
}
const nativeTaskParticipants = new WeakMap<object, NativeAgentExecutionTaskParticipants>()

export function bindLocalAgentExecutionParticipants(
  input: NativeAgentExecutionTaskParticipants,
): AgentExecutionParticipants & Required<Pick<AgentExecutionParticipants, 'taskEffect'>> {
  const taskEffect = Object.freeze({}) as NonNullable<AgentExecutionParticipants['taskEffect']>
  nativeTaskParticipants.set(taskEffect, input)
  return { taskEffect }
}

export function resolveLocalAgentExecutionParticipants(participants?: AgentExecutionParticipants) {
  const reference = participants?.taskEffect
  if (reference === undefined) return undefined
  const native = nativeTaskParticipants.get(reference)
  if (native === undefined) throw new Error('agent-execution-task-participant-unavailable')
  return native
}

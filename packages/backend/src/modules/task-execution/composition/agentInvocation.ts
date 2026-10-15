import type { AgentInvocationBinding } from '../application/ports/agentInvocation'
import type { AgentExecutionRecord } from '../application/ports/agentExecution'
import type {
  ExecutionEffectResult,
  ExecutionStartReceipt,
} from '../application/ports/executionEffect'
import { createProcessEffectAttemptObserver } from '../application/processEffectObserver'
import {
  bindLocalAgentExecutionEffect,
  resolveLocalAgentExecutionParticipants,
  type NativeAgentStartReceiptOwner,
} from '../infrastructure/local/agentExecutionEffect'
import type {
  AgentInvocationProtocol,
  AgentMaterialWorkspace,
} from '@/modules/runtime-management/public/participants'
import { bindNativeAgentMaterialReference } from '@/modules/runtime-management/infrastructure/local/agentMaterialCompiler'
import {
  createLocalAgentMaterialEvidence,
  type NativeAgentMaterialEvidenceHooks,
  type NativeAgentMaterialEvidenceScope,
} from '@/modules/runtime-management/infrastructure/local/agentMaterialEvidence'
import type { AgentSpawnPlan, SpawnPlan } from '@/services/runtime/types'

/** This native compatibility factory receives an already compiled material.
 * All members close over that exact plan and explicit native scope. It never
 * rebuilds a declaration, chooses a driver or reads global paths. */
export function bindNativeAgentInvocation(input: {
  readonly plan: SpawnPlan
  readonly protocol: AgentInvocationProtocol
  readonly workspace: AgentMaterialWorkspace
  readonly evidenceHooks: NativeAgentMaterialEvidenceHooks
  readonly evidenceScope: NativeAgentMaterialEvidenceScope
  readonly workingDirectory: () => string
  /** Task keeps the original early cmd/env snapshot for its execution. */
  readonly taskSnapshot?: {
    readonly command: readonly string[]
    readonly environment: Record<string, string>
  }
  readonly requireSpawnReceipt?: true
  readonly nativeStartOwner?: NativeAgentStartReceiptOwner
  /** Smoke forwards the original callback to the executor. Task/System call
   * cleanup on the material plan, preserving that original receiver. */
  readonly cleanupReceiver: 'material' | 'executor'
  readonly runNative?: Parameters<typeof bindLocalAgentExecutionEffect>[0]['runNative']
}): AgentInvocationBinding {
  // Raw fixture references are first minted at the original execution-binding
  // point; already compiled material retains its existing reference.
  const materialRef = () => bindNativeAgentMaterialReference(input.plan)
  const evidence = createLocalAgentMaterialEvidence({
    hooks: input.evidenceHooks,
    scope: input.evidenceScope,
  })
  const command = () => input.taskSnapshot?.command ?? input.plan.cmd
  const environment = () => input.taskSnapshot?.environment ?? input.plan.env
  let executionBound = false
  return {
    get materialRef() {
      return materialRef()
    },
    get declared() {
      return (input.plan as Partial<AgentSpawnPlan>).declared
    },
    protocol: input.protocol,
    workspace: input.workspace,
    evidence,
    lifecycle: {
      get beforeStart() {
        return input.plan.beforeSpawn
      },
      get cleanup() {
        const cleanup = input.plan.cleanup
        return cleanup === undefined || input.cleanupReceiver === 'executor'
          ? cleanup
          : () => cleanup.call(input.plan)
      },
    },
    async execute(request, sink) {
      if (executionBound) throw new Error('agent-invocation-execution-already-bound')
      executionBound = true
      const task =
        request.task === undefined
          ? undefined
          : resolveLocalAgentExecutionParticipants(request.task.participants)
      const native = bindLocalAgentExecutionEffect({
        materialRef: materialRef(),
        command,
        workingDirectory: input.workingDirectory,
        environment,
        stdin: () => input.plan.stdin,
        ...(input.requireSpawnReceipt === undefined
          ? {}
          : { requireSpawnReceipt: input.requireSpawnReceipt }),
        ...(input.nativeStartOwner === undefined
          ? {}
          : { nativeStartOwner: input.nativeStartOwner }),
        ...(task === undefined
          ? {}
          : {
              taskEffect: {
                persistence: task.persistence,
                nodeExecution: task.nodeExecution,
                argv: command(),
                cwd: input.workingDirectory(),
                // Preserve the exact original writer resource fingerprint.
                resourceKeys: task.readOnlyWorkspace()
                  ? []
                  : { writerWorkspace: input.workingDirectory() },
              },
            }),
        ...(input.runNative === undefined ? {} : { runNative: input.runNative }),
      })
      // RFC-349: the task's durable process effect brackets the child — prepared
      // before spawn, its receipt recorded before any output, settled only after
      // the caller committed its own projection (outcome.settle).
      const processEffect =
        request.task === undefined || task === undefined
          ? undefined
          : createProcessEffectAttemptObserver<ExecutionStartReceipt, ExecutionEffectResult>({
              persistence: task.persistence,
              taskId: request.task.taskId,
              nodeRunId: request.task.nodeRunId,
              processKind: 'agent',
              projection: native.projection!,
              resourceKeys: (description) => description.resourceKeys,
            })
      const protocol = input.protocol
      const interpret = (line: string): AgentExecutionRecord => {
        const observation = protocol.observeSystemEvent?.(line)
        const terminalError = protocol.parseTerminalResultError?.(line)
        return {
          raw: line,
          event: protocol.parseEvent(line),
          ...(observation === undefined ? {} : { observation }),
          ...(terminalError === undefined || terminalError === null ? {} : { terminalError }),
        }
      }
      const taskReceipt = request.task
      let acknowledgeError: unknown
      const result = await native.effect.submit({
        executionRef: native.executionRef,
        materialRef: native.materialRef,
        workspaceRef: native.workspaceRef,
        ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
        ...(request.termGraceMs !== undefined ? { termGraceMs: request.termGraceMs } : {}),
        ...(request.signal !== undefined ? { abortSignal: request.signal } : {}),
        ...(processEffect !== undefined || request.beforeStart !== undefined
          ? {
              beforeStart: async () => {
                await processEffect?.beforeSpawn()
                await request.beforeStart?.()
              },
            }
          : {}),
        ...(taskReceipt !== undefined || request.acknowledgeStart === true
          ? {
              onStarted: async (receipt: ExecutionStartReceipt) => {
                if (taskReceipt !== undefined) {
                  // RFC-108 T9 (AR-14): the spawned binary path is persisted with
                  // the pid so the stale-process reaper matches this binary.
                  if (processEffect === undefined) {
                    await native.recordLegacyTaskReceipt(receipt, taskReceipt.nodeRunId)
                  } else {
                    await processEffect.recordSpawnReceipt(receipt)
                  }
                }
                if (request.acknowledgeStart === true) {
                  try {
                    await native.acknowledgeNativeOwner(receipt)
                  } catch (error) {
                    // A failed owner receipt is a spawn-window rejection: the
                    // executor aborts the child (historical admission fence).
                    acknowledgeError = error
                    throw error
                  }
                }
              },
            }
          : {}),
        capture: {
          onStdoutLine: (line) => sink.record(interpret(line)),
          onStderrLine: (line) => sink.diagnostic(line),
          onStdoutChunkEnd: () => sink.checkpoint('records'),
          onStderrChunkEnd: () => sink.checkpoint('diagnostics'),
          ...(sink.truncated === undefined ? {} : { onLineTruncated: () => sink.truncated!() }),
        },
        ...(request.cleanup === undefined ? {} : { cleanup: request.cleanup }),
        ...(request.log === undefined ? {} : { log: request.log }),
      })
      return {
        result: result.outcome,
        exitCode: result.exitCode,
        stderrTail: result.stderrTail,
        durationMs: result.durationMs,
        ...(result.spawnError === undefined ? {} : { spawnError: result.spawnError }),
        ...(result.pumpError === undefined ? {} : { pumpError: result.pumpError }),
        ...(result.drainTimedOut === undefined ? {} : { drainTimedOut: result.drainTimedOut }),
        ...(result.cleanupFailed === undefined ? {} : { cleanupFailed: result.cleanupFailed }),
        ...(acknowledgeError === undefined ? {} : { acknowledgeError }),
        unreapedMessage: (deadlineMs) => native.unreapedMessage(result, deadlineMs),
        reportUnreaped: (details) => native.reportUnreaped(result, details),
        settle: async () => {
          await processEffect?.settle(result)
        },
      }
    },
  }
}

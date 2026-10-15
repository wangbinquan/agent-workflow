import type { AgentInvocationBinding } from '../application/ports/agentInvocation'
import type {
  AgentExecutionBinding,
  AgentExecutionParticipants,
} from '../application/ports/agentExecutionBinding'
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
    bindExecution(participants?: AgentExecutionParticipants): AgentExecutionBinding {
      if (executionBound) throw new Error('agent-invocation-execution-already-bound')
      executionBound = true
      const task = resolveLocalAgentExecutionParticipants(participants)
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
      return {
        effect: native.effect,
        executionRef: native.executionRef,
        materialRef: native.materialRef,
        workspaceRef: native.workspaceRef,
        projection: native.projection,
        acknowledgeOwner: native.acknowledgeNativeOwner,
        recordTaskReceipt: native.recordLegacyTaskReceipt,
        reportUnreaped: native.reportUnreaped,
        unreapedMessage: native.unreapedMessage,
      }
    },
  }
}

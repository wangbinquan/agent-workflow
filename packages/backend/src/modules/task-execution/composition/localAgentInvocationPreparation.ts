import type { AgentInvocationPreparation } from '../application/ports/agentInvocationPreparation'
import { createAgentInvocationPreparation } from './agentInvocationPreparation'
import { bindNativeAgentInvocation } from './agentInvocation'
import type { AgentMaterialCompiler } from '@/modules/runtime-management/public/participants'
import type { AgentSpawnPlan } from '@/services/runtime/types'

/** Native composition retains the original compiled plan privately. Normal
 * consumers receive only the two-phase preparation and neutral invocation.
 * The selected compiler must use the actual native material body directly. */
export function createLocalAgentInvocationPreparation(input: {
  readonly material: {
    readonly compiler: AgentMaterialCompiler
    nativePlan(materialRef: string): AgentSpawnPlan
  }
  readonly binding: Omit<
    Parameters<typeof bindNativeAgentInvocation>[0],
    'plan' | 'taskSnapshot' | 'evidenceScope'
  >
  readonly evidenceScope: Omit<
    Parameters<typeof bindNativeAgentInvocation>[0]['evidenceScope'],
    'environment'
  >
  readonly taskSnapshot?: true
  readonly onTaskSnapshot?: (
    snapshot: NonNullable<Parameters<typeof bindNativeAgentInvocation>[0]['taskSnapshot']>,
  ) => void
}): AgentInvocationPreparation {
  const material = input.material
  const binding = input.binding
  const evidenceScope = input.evidenceScope
  const taskSnapshot = input.taskSnapshot
  return createAgentInvocationPreparation({
    compiler: material.compiler,
    workspace: binding.workspace,
    cleanupMaterial(compiled) {
      // Called only at the consumer's existing cleanup boundary, including a
      // failure while constructing the late invocation. Keep the plan receiver.
      const plan = material.nativePlan(compiled.materialRef)
      return plan.cleanup?.()
    },
    bind(compiled) {
      const plan = material.nativePlan(compiled.materialRef)
      return bindNativeAgentInvocation({
        plan,
        get protocol() {
          return binding.protocol
        },
        get workspace() {
          return binding.workspace
        },
        get evidenceHooks() {
          return binding.evidenceHooks
        },
        workingDirectory: () => binding.workingDirectory(),
        get requireSpawnReceipt() {
          return binding.requireSpawnReceipt
        },
        get nativeStartOwner() {
          return binding.nativeStartOwner
        },
        get cleanupReceiver() {
          return binding.cleanupReceiver
        },
        get runNative() {
          const runNative = binding.runNative
          return runNative === undefined
            ? undefined
            : (request: Parameters<NonNullable<typeof runNative>>[0]) =>
                runNative.call(binding, request)
        },
        // Task reads its execution cmd/env at the later original binding
        // point; evidence continues reading the same plan's live environment.
        ...(taskSnapshot === true
          ? {
              taskSnapshot: (() => {
                const snapshot = { command: plan.cmd, environment: plan.env }
                input.onTaskSnapshot?.(snapshot)
                return snapshot
              })(),
            }
          : {}),
        evidenceScope: {
          environment: () => plan.env,
          runContent: () => evidenceScope.runContent(),
          sessionLocation: () => evidenceScope.sessionLocation(),
          get liveLocation() {
            const liveLocation = evidenceScope.liveLocation
            return liveLocation === undefined ? undefined : () => liveLocation.call(evidenceScope)
          },
        },
      })
    },
  })
}

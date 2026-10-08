import { getRuntimeDriver } from '@/services/runtime'
import { bindNativeAgentProtocol } from '@/modules/runtime-management/infrastructure/local/agentProtocol'
import {
  bindNativeAgentMaterialWorkspace,
  selectLocalAgentMaterialDefinition,
} from '@/modules/runtime-management/composition/localAgentMaterial'
import type { createLocalRuntimeDiagnosticTargets } from '@/modules/runtime-management/composition/runtimeDiagnosticTargets'
import type { RuntimeSmokeInvocationFamily } from '../application/ports/runtimeSmoke'
import { createLocalAgentInvocationPreparation } from './localAgentInvocationPreparation'
import { createRuntimeSmokeMaterialIntent } from './runtimeSmoke'
import { composeRuntimeSmokeRunFamily } from './runtimeSmokeRunFamily'
import type { SystemAgentObservationFactory } from '../application/ports/systemAgentObservation'

/** The native root pairs the target owner, original material builder and
 * executor. The normal family never receives their physical locations. */
export function composeLocalRuntimeSmokeRunFamily(input: {
  appHome(): string
  readonly targets: ReturnType<typeof createLocalRuntimeDiagnosticTargets>
  readonly observations?: () => SystemAgentObservationFactory
}) {
  const invocations: RuntimeSmokeInvocationFamily = {
    open(request, log) {
      const driver = getRuntimeDriver(request.protocol)
      return {
        materialize() {
          const selected = bindNativeAgentMaterialWorkspace({
            kind: 'smoke',
            appHome: input.appHome(),
          })
          const worktreeDir = selected.locations.workingDirectory
          const runDir = selected.locations.runDirectory
          return {
            workspace: selected.workspace,
            ...(input.observations
              ? {
                  observe: (nonce: string, startedAt: number) =>
                    input.observations!().open({
                      feature: 'runtime-smoke',
                      agentName: 'aw-smoke',
                      protocol: request.protocol,
                      startedAt,
                      demand: {
                        kind: 'runtime-probe',
                        originalId: nonce,
                        originalAttempt: nonce,
                        name: `运行时探测 · ${request.runtimeObservationIdentity?.acceptedName ?? request.protocol}`,
                        purpose: 'system',
                      },
                      ...(request.runtimeObservationIdentity
                        ? { runtimeObservationIdentity: request.runtimeObservationIdentity }
                        : {}),
                    }),
                }
              : {}),
            prepareWorkspace: () => selected.workspace.prepare(),
            async compile(prompt) {
              // These request reads retain the native buildSmokePlan argument
              // order. The second driver/material selection remains in compile.
              const protocol = request.protocol
              const runtimeBinding = input.targets.runtimeBinding(request.target)
              const model = request.model
              const extraArgs = request.extraArgs
              const isSandbox = request.isSandbox === true
              const definition = selectLocalAgentMaterialDefinition(protocol)
              const material = definition.createCompiler({
                workspace(reference) {
                  if (reference !== selected.workspace.workspace)
                    throw new Error('smoke-working-content-reference-unavailable')
                  return worktreeDir
                },
                runContent(reference) {
                  if (reference !== selected.workspace.runContent)
                    throw new Error('smoke-run-content-reference-unavailable')
                  return runDir
                },
                runtimeBinary: (reference) => input.targets.contents.runtimeBinary(reference),
                skill() {
                  throw new Error('smoke-persona-skill-content-unavailable')
                },
                plugin() {
                  throw new Error('smoke-persona-plugin-content-unavailable')
                },
              })
              const preparation = createLocalAgentInvocationPreparation({
                material,
                binding: {
                  protocol: bindNativeAgentProtocol(driver),
                  workspace: selected.workspace,
                  workingDirectory: () => worktreeDir,
                  cleanupReceiver: 'executor',
                  evidenceHooks: driver,
                },
                evidenceScope: {
                  runContent: () => runDir,
                  sessionLocation: () => ({ worktreePath: worktreeDir }),
                },
              })
              return preparation.compile(
                createRuntimeSmokeMaterialIntent(
                  { protocol, runtimeBinding, model, extraArgs, isSandbox },
                  preparation,
                  prompt,
                  log,
                ),
              )
            },
          }
        },
      }
    },
  }
  return composeRuntimeSmokeRunFamily({ invocations })
}

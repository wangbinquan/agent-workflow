import { ulid } from 'ulid'
import type {
  FrozenTaskAgentRuntime,
  TaskAgentRuntimeBindings,
} from '../../application/ports/taskAgentRuntimeBindings'
import type { AgentMaterialContentReference } from '../../application/ports/agentMaterial'
import type { RuntimeExecutionQueries } from '../../public/queries'
import type { NodeRunRuntimePersistence } from '@/modules/task-execution/application/ports/nodeRunRuntimePersistence'
import {
  frozenRuntimeOfSessionWith,
  resolveFrozenRuntimeWith,
  type FrozenRuntime,
} from '@/services/nodeRunMint'

/** The existing persistence/freeze algorithm remains the one implementation.
 * Its native binary column is private to this selected owner and compiler. */
export function createLocalTaskAgentRuntimeBindings(input: {
  readonly persistence: NodeRunRuntimePersistence
  readonly registry: RuntimeExecutionQueries
  readBinaryConfiguration(): Promise<
    { opencodePath?: string | null; claudeCodePath?: string | null } | undefined
  >
}) {
  const binaries = new WeakMap<AgentMaterialContentReference, string>()
  function selected(snapshot: FrozenRuntime): FrozenTaskAgentRuntime {
    const runtimeBinding =
      snapshot.binary === null
        ? null
        : Object.freeze({
            owner: 'runtime-management' as const,
            reference: `aw-task-runtime:${ulid()}`,
            version: null,
          })
    if (runtimeBinding !== null) binaries.set(runtimeBinding, snapshot.binary!)
    return Object.freeze({
      protocol: snapshot.protocol,
      runtimeBinding,
      params: snapshot.params,
      configDir: snapshot.configDir,
      observationIdentity: snapshot.observationIdentity,
    })
  }
  function runtimeBinary(reference: AgentMaterialContentReference): string {
    const binary = binaries.get(reference)
    if (binary === undefined) throw new Error('task-runtime-binding-unavailable')
    return binary
  }
  function native(snapshot: FrozenTaskAgentRuntime): FrozenRuntime {
    const protocol = snapshot.protocol
    const runtimeBinding = snapshot.runtimeBinding
    return {
      protocol,
      binary: runtimeBinding === null ? null : runtimeBinary(runtimeBinding),
      params: snapshot.params,
      configDir: snapshot.configDir,
      observationIdentity: snapshot.observationIdentity,
    }
  }
  const bindings: TaskAgentRuntimeBindings = Object.freeze({
    async resolve(nodeRunId, agentRuntime, defaultRuntime, inheritFrom) {
      // Keep the original configuration await outside the freeze transaction.
      // Its failure, fallback and current-config compatibility are unchanged.
      const inherited = inheritFrom == null ? inheritFrom : native(inheritFrom)
      const binaryConfig = await input.readBinaryConfiguration()
      return selected(
        await resolveFrozenRuntimeWith(
          input.persistence,
          nodeRunId,
          agentRuntime,
          defaultRuntime,
          inherited,
          binaryConfig,
        ),
      )
    },
    async ofSession(sessionId) {
      const snapshot = await frozenRuntimeOfSessionWith(input.persistence, sessionId)
      return snapshot === null ? null : selected(snapshot)
    },
    async internal(request) {
      const resolved = await input.registry.resolveInternalAgentRuntime(request)
      // Internal profiles were read when each child snapshot was frozen,
      // inside that child's original error boundary. Keep those reads late.
      return Object.freeze({
        get protocol() {
          return resolved.protocol
        },
        get runtimeBinding() {
          const binary = resolved.binaryPath
          if (binary === null) return null
          const reference = Object.freeze({
            owner: 'runtime-management' as const,
            reference: `aw-task-runtime:${ulid()}`,
            version: null,
          })
          binaries.set(reference, binary)
          return reference
        },
        get params() {
          return {
            model: resolved.model,
            variant: resolved.variant,
            temperature: resolved.temperature,
            steps: resolved.steps,
            maxSteps: resolved.maxSteps,
            isSandbox: resolved.isSandbox,
          }
        },
        get configDir() {
          return resolved.configDir
        },
        get observationIdentity() {
          return resolved.observationIdentity
        },
      })
    },
  })
  return Object.freeze({ bindings, contents: Object.freeze({ runtimeBinary }) })
}

import { ulid } from 'ulid'
import type { AgentMaterialContentReference } from '../../application/ports/agentMaterial'

/** Only the native selection boundary accepts the existing physical profile column. */
interface NativeSystemRuntimeProfile {
  readonly binaryPath: string | null
}

export function createLocalSystemAgentRuntimeBindings() {
  const binaries = new WeakMap<AgentMaterialContentReference, string>()
  const profileFields = [
    'name',
    'protocol',
    'configDir',
    'model',
    'variant',
    'temperature',
    'steps',
    'maxSteps',
    'isSandbox',
    'extraArgs',
    'observationIdentity',
  ] as const
  function runtimeBinary(reference: AgentMaterialContentReference): string {
    const binary = binaries.get(reference)
    if (binary === undefined) throw new Error('system-runtime-binding-unavailable')
    return binary
  }
  function bindRuntime<T extends NativeSystemRuntimeProfile>(
    profile: T,
  ): Omit<T, 'binaryPath'> & { readonly runtimeBinding: AgentMaterialContentReference | null } {
    // Forward each declared business member at its original consumer read;
    // prototype accessors continue to execute against the actual profile.
    const descriptors: PropertyDescriptorMap = {}
    for (const field of profileFields) {
      descriptors[field] = {
        enumerable: true,
        get: () => (profile as T & Record<string, unknown>)[field],
      }
    }
    descriptors.runtimeBinding = {
      enumerable: true,
      get() {
        const binary = profile.binaryPath
        if (binary == null) return binary
        const reference = Object.freeze({
          owner: 'runtime-management' as const,
          reference: `aw-system-runtime:${ulid()}`,
          version: null,
        })
        binaries.set(reference, binary)
        return reference
      },
    }
    return Object.freeze(Object.defineProperties({}, descriptors)) as Omit<T, 'binaryPath'> & {
      readonly runtimeBinding: AgentMaterialContentReference | null
    }
  }
  return Object.freeze({ bindRuntime, contents: Object.freeze({ runtimeBinary }) })
}

import { ulid } from 'ulid'
import type { AgentMaterialContentReference } from '../../application/ports/agentMaterial'
import { hostname } from 'node:os'
import { z } from 'zod'

const prefix = 'aw-system-runtime-v1:'
const snapshot = z
  .object({ id: z.string().min(1), binary: z.string(), hostname: z.string(), platform: z.string() })
  .strict()

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
    if (binary !== undefined) return binary
    if (
      reference.owner !== 'runtime-management' ||
      reference.version !== null ||
      !reference.reference.startsWith(prefix)
    )
      throw new Error('system-runtime-binding-unavailable')
    let value: unknown
    try {
      value = JSON.parse(
        Buffer.from(reference.reference.slice(prefix.length), 'base64url').toString('utf8'),
      )
    } catch {
      throw new Error('system-runtime-binding-unavailable')
    }
    const parsed = snapshot.safeParse(value)
    if (
      !parsed.success ||
      parsed.data.hostname !== hostname() ||
      parsed.data.platform !== process.platform
    )
      throw new Error('system-runtime-binding-unavailable')
    binaries.set(reference, parsed.data.binary)
    return parsed.data.binary
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
          reference:
            prefix +
            Buffer.from(
              JSON.stringify({
                id: ulid(),
                binary,
                hostname: hostname(),
                platform: process.platform,
              }),
            ).toString('base64url'),
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

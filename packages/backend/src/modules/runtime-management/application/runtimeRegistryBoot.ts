import type {
  RuntimeRegistryOperations,
  RuntimeRegistrySeedConfiguration,
} from './ports/runtimeRegistry'

type RuntimeRegistryBootOperations = Pick<RuntimeRegistryOperations, 'seedBuiltinRuntimes'>

export interface RuntimeRegistryBootInput {
  readonly operations: RuntimeRegistryBootOperations
  readonly configuration?: RuntimeRegistrySeedConfiguration
  readonly onRecoverableFailure: (error: unknown) => void
}

/** Normal boot seeds current built-ins. Epoch-1 repairs belong to conversion. */
export async function initializeRuntimeRegistryBoot(
  input: RuntimeRegistryBootInput,
): Promise<void> {
  try {
    await input.operations.seedBuiltinRuntimes(input.configuration)
  } catch (error) {
    input.onRecoverableFailure(error)
  }
}

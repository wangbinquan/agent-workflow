import type { Config, RuntimeKind } from '@agent-workflow/shared'
import type { ConfigConcurrencyHotApplyCommand } from '../../public/commands'

/** Storage validates schema and preserves unrelated settings on each patch.
 * Preview does not commit; the application owns semantic checks and hot apply. */
export interface ApplicationConfigurationPersistencePort {
  load(): Config | Promise<Config>
  previewPatch(patch: unknown): Config | Promise<Config>
  applyPatch(patch: unknown): Config | Promise<Config>
}

export interface ApplicationConfigurationDependencies {
  readonly persistence: ApplicationConfigurationPersistencePort
  readonly runtimeRegistry: {
    validateDefaultChange(input: {
      readonly previous: string | null | undefined
      readonly next: string
    }): Promise<void>
    invalidateInheritedRuntimeProbeReceipts(protocols: readonly RuntimeKind[]): Promise<number>
  }
  readonly withRuntimeProbeConfigFence: <T>(operation: () => Promise<T>) => Promise<T>
  readonly runtimeTests: {
    reconcileDurableIntents(): Promise<void>
  }
  readonly concurrencyHotApply: ConfigConcurrencyHotApplyCommand
  readonly applied: {
    notify(config: Config): void | Promise<void>
    setLogLevel(level: Config['logLevel']): void | Promise<void>
  }
}

import type { RuntimeKind } from '../../public/types'

/** Capability facts and cache hooks used by the existing registry. */
export interface RuntimeRegistryEffects {
  readonly protocols: readonly RuntimeKind[]
  readonly ownedExtraArgFlags: ReadonlySet<string>
  driver(protocol: RuntimeKind): {
    readonly acceptsExtraArgs?: boolean
    readonly acceptsSandboxCompatibilityMarker?: boolean
    evictBinaryCaches?(binaryPath: string): void
  }
}

/** Original configuration text, before current schema parsing removes legacy keys. */
export interface RuntimeLegacyConfigurationPort {
  readText(): string | Promise<string>
}

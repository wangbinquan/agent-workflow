import type { RuntimeKind } from '../../public/types'

/** Only the capability facts/cache hook and legacy config read used by the existing registry. */
export interface RuntimeRegistryEffects {
  readonly protocols: readonly RuntimeKind[]
  readonly ownedExtraArgFlags: ReadonlySet<string>
  driver(protocol: RuntimeKind): {
    readonly acceptsExtraArgs?: boolean
    readonly acceptsSandboxCompatibilityMarker?: boolean
    evictBinaryCaches?(binaryPath: string): void
  }
  readConfigText(configPath: string): string
}

/** RFC-040 business material wire types. Models, credentials and executable
 * selection belong to the immutable platform profile, not these overlays. */
export interface BusinessMaterialObject {
  readonly objectId: string
  readonly sha256: string
  readonly size: number
}

export type BusinessMaterialFile = {
  readonly path: string
  readonly mode?: number
} & (
  | { readonly content: string; readonly object?: never }
  | { readonly object: BusinessMaterialObject; readonly content?: never }
)

export interface BusinessNativeAgent {
  readonly name: string
  readonly body: string
  readonly agentProfileId?: string
  readonly options: Readonly<Record<string, unknown>>
}

export type BusinessNativeMcp = {
  readonly name: string
  readonly timeoutMs?: number
} & (
  | {
      readonly type: 'remote'
      readonly url: string
      readonly headers?: Readonly<Record<string, string>>
      readonly oauth?:
        | false
        | {
            readonly clientId?: string
            readonly clientSecret?: string
            readonly scope?: string
            readonly redirectUri?: string
          }
    }
  | {
      readonly type: 'local'
      readonly command: readonly string[]
      readonly env?: Readonly<Record<string, string>>
    }
)

export interface BusinessNativePlugin {
  readonly name: string
  readonly entry: string
  readonly files: readonly (
    | (BusinessMaterialFile & { readonly kind: 'file' })
    | { readonly kind: 'symlink'; readonly path: string; readonly target: string }
  )[]
  readonly options?: Readonly<Record<string, unknown>>
}

export interface BusinessNativeConfig {
  readonly version: 1
  readonly protocol: 'opencode' | 'claude-code'
  readonly agent: BusinessNativeAgent
  readonly subagents: readonly BusinessNativeAgent[]
  readonly mcp: readonly BusinessNativeMcp[]
  readonly plugins: readonly BusinessNativePlugin[]
}

export type BusinessEnvironmentValue =
  | string
  | { readonly secret: { readonly configDefinitionId: string } }

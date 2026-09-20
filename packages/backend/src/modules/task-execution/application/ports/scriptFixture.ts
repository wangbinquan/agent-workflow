export interface ScriptFixtureImplementation {
  readonly kind: 'program'
  readonly runtimeKind: 'bash' | 'node' | 'python'
  readonly executableArtifactRef: string
  readonly executableDigest: string
  readonly parameterValuesRef: string | null
  readonly runtimeProfileRef: { readonly id: string; readonly revision: number }
}
export interface ScriptFixtureCheck {
  readonly code: string
  readonly ok: boolean
  readonly detail: string
}
export type ScriptFixtureResult =
  | { readonly kind: 'completed'; readonly rawStdout: string }
  | { readonly kind: 'failed'; readonly checks: readonly ScriptFixtureCheck[] }
export interface ScriptFixtureRunner {
  run(input: {
    readonly implementation: ScriptFixtureImplementation
    readonly inputJson: string
  }): Promise<ScriptFixtureResult>
}

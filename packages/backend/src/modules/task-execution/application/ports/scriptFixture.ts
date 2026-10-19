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

/**
 * RFC-370 §10 V19 — a program tool's frozen source and parameter values, read
 * from the program artifact store the deployment selected (local files under
 * the application home, or platform objects when hosted). A failure names the
 * check that did not hold.
 */
export type ProgramToolSourceResult =
  | { readonly kind: 'ok'; readonly source: string; readonly parameterValuesJson: string }
  | { readonly kind: 'failed'; readonly check: ScriptFixtureCheck }
export interface ProgramToolSource {
  read(
    implementation: Pick<
      ScriptFixtureImplementation,
      'runtimeKind' | 'executableArtifactRef' | 'executableDigest' | 'parameterValuesRef'
    >,
  ): Promise<ProgramToolSourceResult>
}

/** One bounded run of a program against a fixture input, wherever scripts run. */
export interface ScriptFixtureRun {
  readonly runtimeKind: ScriptFixtureImplementation['runtimeKind']
  readonly source: string
  readonly parameterValuesJson: string
  readonly inputJson: string
  readonly timeoutMs: number
}
export type ScriptFixtureRunOutcome =
  | { readonly kind: 'interpreter-unavailable' }
  | { readonly kind: 'failed'; readonly failureCode: string; readonly stderrTail: string }
  | { readonly kind: 'completed'; readonly rawStdout: string }
/** Standalone: an interpreter of the daemon's host; hosted: the task image. */
export interface ScriptFixtureProcess {
  run(input: ScriptFixtureRun): Promise<ScriptFixtureRunOutcome>
}

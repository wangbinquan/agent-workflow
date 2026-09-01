export interface HumanGateTerminalSweepResult {
  readonly sealedSelfRounds: number
  readonly abandonedCrossRounds: number
  readonly canceledRuns: readonly { readonly nodeRunId: string; readonly nodeId: string }[]
}

export interface HumanGateTerminalSweepCommand {
  run(input: {
    readonly taskId: string
    readonly cause: string
    readonly now?: number
  }): Promise<HumanGateTerminalSweepResult>
}

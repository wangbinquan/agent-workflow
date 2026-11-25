export interface PluginGenerationGcInput {
  /** The platform runtime owns this coarse active-execution fence. */
  readonly executionFence: 'clear' | 'busy'
  readonly graceMs?: number
  readonly now?: number
}

export interface PluginGenerationGcReceipt {
  readonly removedGenerationPaths: readonly string[]
}

/** Provider-neutral maintenance command; persistence and filesystem stay private. */
export interface PluginGenerationGcCommand {
  run(input: PluginGenerationGcInput): Promise<PluginGenerationGcReceipt>
}

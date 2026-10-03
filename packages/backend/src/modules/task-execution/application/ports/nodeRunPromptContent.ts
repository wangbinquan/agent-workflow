/** RFC-370: prompt references are interpreted only by the selected content adapter. */
export interface NodeRunPromptContentEffects {
  reference(taskId: string, nodeRunId: string): string
  write(reference: string, prompt: string): void | Promise<void>
  read(reference: string): string | null | Promise<string | null>
}

/** Internal native compatibility contract; the deployment contract remains async-capable. */
export interface SynchronousNodeRunPromptContentEffects extends NodeRunPromptContentEffects {
  write(reference: string, prompt: string): void
  read(reference: string): string | null
}

export interface NodeRunPromptRow {
  readonly promptText: string | null
  readonly promptPath: string | null
}

export interface PromptStorage {
  promptText: string | null
  promptPath: string | null
}

export interface NodeRunPromptReader {
  read(row: NodeRunPromptRow | null | undefined): Promise<string | null>
}

export interface NodeRunPromptOperations extends NodeRunPromptReader {
  store(taskId: string, nodeRunId: string, prompt: string): Promise<PromptStorage>
}

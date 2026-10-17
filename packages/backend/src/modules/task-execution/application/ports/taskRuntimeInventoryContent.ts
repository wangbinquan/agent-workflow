import type { InventorySnapshot } from '@agent-workflow/shared'

/** Live legacy evidence is an implementation-owned location. The presenter
 * consumes stored observations first and never interprets a workspace path. */
export interface TaskRuntimeInventoryContent {
  readLive(input: {
    readonly taskId: string
    readonly nodeRunId: string
  }): Promise<InventorySnapshot | null>
}

// RFC-491: moved from task-execution's infrastructure/local — the in-flight startup inventory read of one node run. The
// run root's layout and the opencode inventory file are this module's knowledge; Task Execution owns the port
// (`TaskRuntimeInventoryContent`) and bootstrap binds this implementation to it, so the shape is written out here.
import type { InventorySnapshot } from '@agent-workflow/shared'
import { readSnapshotFromRunDir, runRootFor } from '@/services/runtime'

export function createLocalTaskRuntimeInventoryContent(): {
  readLive(input: {
    readonly taskId: string
    readonly nodeRunId: string
  }): Promise<InventorySnapshot | null>
} {
  return {
    readLive: ({ taskId, nodeRunId }) =>
      readSnapshotFromRunDir({
        runDir: runRootFor(taskId, nodeRunId),
        nodeKind: 'agent-single',
        pureMode: process.env.OPENCODE_PURE === '1' || process.env.OPENCODE_PURE === 'true',
      }),
  }
}

import type { TaskRuntimeInventoryContent } from '../../application/ports/taskRuntimeInventoryContent'
import { readSnapshotFromRunDir, runRootFor } from '@/services/runtime'

export function createLocalTaskRuntimeInventoryContent(): TaskRuntimeInventoryContent {
  return {
    readLive: ({ taskId, nodeRunId }) =>
      readSnapshotFromRunDir({
        runDir: runRootFor(taskId, nodeRunId),
        nodeKind: 'agent-single',
        pureMode: process.env.OPENCODE_PURE === '1' || process.env.OPENCODE_PURE === 'true',
      }),
  }
}

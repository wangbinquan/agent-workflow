import type { TaskMemorySnapshotPort } from '@/modules/task-execution/composition/required-ports'
import {
  formatMemoryBlockFromSnapshot,
  memoryFencingForNonce,
  parseInjectedSnapshotJson,
} from '../../domain/injectionRendering'

export function composeTaskMemorySnapshotPort(): TaskMemorySnapshotPort {
  return {
    renderSnapshot: (snapshot, nonce) =>
      formatMemoryBlockFromSnapshot(snapshot, memoryFencingForNonce(nonce)),
    parseSnapshotJson: (raw) => parseInjectedSnapshotJson(raw),
  }
}

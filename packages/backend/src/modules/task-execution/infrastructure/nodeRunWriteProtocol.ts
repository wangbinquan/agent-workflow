import { consumedInputColumns } from './consumedInputsParticipant'
import type {
  NodeRunLifecycleWrite,
  NodeRunProjectionWrite,
} from '../application/ports/nodeRunWrites'
import { taskCheckpointProjectionPatch } from './taskCheckpointCodec'

/**
 * II-a：目标表分组在 epoch-1 合成原有单行语句，保留 standalone CAS 的原子性与事务边界。
 * 生命周期 / merge CAS 的谓词仍由各自协议持有；II-b 才在 CAS 命中后逐表落库。
 * 不解析再编码任何已有 JSON 字符串。
 */
export function nodeRunLifecycleWriteColumns(write: NodeRunLifecycleWrite = {}) {
  return {
    ...write.identity,
    ...write.runtime,
    ...write.result,
    ...consumedInputColumns(write.inputs),
  }
}

export function nodeRunProjectionWriteColumns(
  write: NodeRunProjectionWrite,
  mountPaths: readonly string[],
) {
  const { pendingSubResolves: _pending, ...checkpoint } = write.checkpoint ?? {}
  return {
    ...write.identity,
    ...write.config,
    ...write.runtime,
    ...write.result,
    ...consumedInputColumns(write.inputs),
    ...taskCheckpointProjectionPatch(checkpoint, mountPaths),
  }
}

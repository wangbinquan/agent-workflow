// Task-owned cleanup receipt; provider participation and physical operations are inputs.
import { isolationCleanupRequest } from './isolationEffectRequest'
import type { IsoHandle, DiscardLock } from '@/platform/contracts/isolationWorkspace'
import type { IsolationCleanupBinding, Logger } from '../../application/ports/executionKernel'
import { sha256Hex } from '../../domain/digest'

export async function discardNodeIso(
  binding: IsolationCleanupBinding,
  handle: IsoHandle,
  log?: Logger,
  writeSem?: DiscardLock,
): Promise<void> {
  if (handle.passthrough) return // in-place run — the canonical worktree is NOT ours to remove
  const createLocalEffectAttemptObserver = binding.cleanupEffectFactory(handle.taskId)
  const effect = createLocalEffectAttemptObserver?.({
    taskId: handle.taskId,
    // RFC-356 P0-1：effect 账本要的是**真实行 id**，不是物理 iso 键。
    // 喂合成键 ⇒ readLineage 返 null ⇒ beforeAct 抛 task-continuation-stale，
    // 而这一句在 try 之外、调用点又是裸 await，异常会穿出 runAssembly。
    nodeRunId: handle.dbNodeRunId,
    kind: 'workspace-cleanup',
    stableActionOrdinal: 'isolation-cleanup',
    candidateId: 'node-isolation-discard',
    request: isolationCleanupRequest(handle.dbNodeRunId, handle.nodeRunId, handle.repos),
    resourceKeys: [
      `isolation:${handle.taskId}:${handle.nodeRunId}`,
      ...handle.repos.map((repo) => `workspace:${sha256Hex(repo.canonWorktreePath)}`),
    ],
  })
  await effect?.beforeAct()
  let partialFailures = 0
  try {
    const disposition = await binding.discardIsolatedWorkspace(handle, log, writeSem, (count) => {
      partialFailures = count
    })
    await effect?.succeed({
      repoCount: handle.repos.length,
      partialFailures,
      retained: disposition?.retained === true,
    })
  } catch (error) {
    await effect?.fail(error, { repoCount: handle.repos.length, partialFailures })
    throw error
  }
}

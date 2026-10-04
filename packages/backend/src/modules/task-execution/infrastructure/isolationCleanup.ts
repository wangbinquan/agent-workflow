// Task-owned cleanup receipt; physical Git/worktree/ref operations remain native.
import { createLocalEffectAttemptObserver } from '../application/localEffectObserver'
import { currentTaskExecutionContext } from '../composition/sqliteTaskExecutionContext'
import {
  discardIsolationWorkspace,
  type DiscardLock,
  type IsoHandle,
} from '@/platform/workspace/local/isolation'
import { sha256Hex } from '@/util/hash'
import type { Logger } from '@/util/log'

export async function discardNodeIso(
  handle: IsoHandle,
  log?: Logger,
  writeSem?: DiscardLock,
): Promise<void> {
  if (handle.passthrough) return // in-place run — the canonical worktree is NOT ours to remove
  const context = currentTaskExecutionContext(handle.taskId)
  const effect =
    context === undefined
      ? undefined
      : createLocalEffectAttemptObserver({
          persistence: context.persistence.effects,
          taskId: handle.taskId,
          // RFC-356 P0-1：effect 账本要的是**真实行 id**，不是物理 iso 键。
          // 喂合成键 ⇒ readLineage 返 null ⇒ beforeAct 抛 task-continuation-stale，
          // 而这一句在 try 之外、调用点又是裸 await，异常会穿出 runAssembly。
          nodeRunId: handle.dbNodeRunId,
          kind: 'workspace-cleanup',
          stableActionOrdinal: 'isolation-cleanup',
          candidateId: 'node-isolation-discard',
          request: {
            v: 1,
            dbNodeRunId: handle.dbNodeRunId,
            isoKey: handle.nodeRunId,
            repos: handle.repos.map((repo) => ({
              worktreeDirName: repo.worktreeDirName,
              isoWorktreePathDigest: sha256Hex(repo.isoWorktreePath),
            })),
          },
          resourceKeys: [
            `isolation:${handle.taskId}:${handle.nodeRunId}`,
            ...handle.repos.map((repo) => `workspace:${sha256Hex(repo.canonWorktreePath)}`),
          ],
          context,
        })
  await effect?.beforeAct()
  let partialFailures = 0
  try {
    await discardIsolationWorkspace(handle, log, writeSem, (count) => {
      partialFailures = count
    })
    await effect?.succeed({ repoCount: handle.repos.length, partialFailures })
  } catch (error) {
    await effect?.fail(error, { repoCount: handle.repos.length, partialFailures })
    throw error
  }
}

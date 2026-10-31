// RFC-188 — the ONE assembly for the shared mechanics of "an isolated agent
// run". Extracted from FIVE hand-copied sites in scheduler.ts (runOneNode
// §段③ / dispatchFanoutShard / dispatchFanoutAggregator / buildWorkgroupHooks.
// runHostNode / replayPendingMerges — the workgroup copy's own header used to
// admit "copied from the fanout-shard dispatch path"), where every merge/
// abandon/lock-window evolution had to be mirrored by hand and RFC-184/186/187
// each shipped a bug born from exactly that drift.
//
// Deliberately NOT owned here (design.md §T1 修订):
//   - node_run minting / retry loops / prompt & runNode argument assembly /
//     clarify session creation — per-site semantics;
//   - the iso KEEP-vs-DISCARD finally discipline and semaphore sets — they
//     genuinely differ per site (mainline keepIso on park; shard holds
//     global+subprocess). One rule IS shared since the RFC-210 impl-gate
//     A1-fix: every site keeps the iso when the merge/snapshot phase THROWS —
//     the publish path hard-fails before the node tree is persisted, so the
//     iso can be the sole copy of the run's submodule work;
//   - the merge-throw disposition: mainline/shard/aggregator stamp
//     `mark-merge-failed` in their catch, the workgroup hook deliberately
//     leaves 'pending-merge' for entry replay — mergeBackAndSettle therefore
//     throws RAW and each site keeps its own catch (markMergeFailed helper).
//
// Conflict resolution and physical workspace operations are explicit inputs.
import { isolationMergeRequest } from './isolationEffectRequest'
import { persistIsoNodeTree } from './isolation'
import type { IsoHandle, MergeBackConflict } from '@/platform/contracts/isolationWorkspace'
import type {
  IsolatedAgentRunBinding,
  WriteSemLike,
  Logger,
} from '../../application/ports/executionKernel'
import { sha256Hex } from '../../domain/digest'

function contextInput(binding: IsolatedAgentRunBinding) {
  return binding.executionContext === undefined
    ? {}
    : { executionContext: binding.executionContext }
}

export interface MergeSettleOutcome {
  kind: 'merged' | 'conflict-human'
  /** Unresolved-conflict summary (conflict-human only). */
  detail?: string
}

/**
 * RFC-130 §段③ / §6.2-§6.3, extracted (RFC-188): snapshot the iso final state,
 * persist the node trees, then — under ONE brief writeSem window — 3-way
 * merge-back into canonical and (on conflict) run the injected resolver; settle
 * the row's merge_state to 'merged' or 'conflict-human'.
 *
 * - `nodeTrees` given (crash REPLAY: the iso worktree may be gone) ⇒ the
 *   snapshot+persist phase is skipped and the persisted trees drive the merge.
 * - Git-level failures THROW RAW — the merge-throw disposition is per-site
 *   (markMergeFailed vs the workgroup hook's leave-for-replay, see header).
 * - Holding writeSem across the (rare) conflict resolution is the §6.2/D5
 *   tradeoff — the resolver's runNode bypasses the node pool (§7 no-cycle);
 *   moving the agent out of the lock is the separately-RFC'd T5b.
 */
export async function mergeBackAndSettle(args: {
  binding: IsolatedAgentRunBinding
  writeSem: WriteSemLike
  handle: IsoHandle
  nodeRunId: string
  nodeTrees?: Record<string, string>
  via: 'live' | 'replay'
  /**
   * RFC-193 K1：EXTRA container-relative force-include paths for the FINAL
   * snapshot — the producing run's own just-emitted port files
   * (RunResult.portFilePaths container-relativized by the caller; the
   * DB-aggregated roster in the handle predates this run's INSERT) and the
   * wrapper-final re-aggregation. Replay runs skip the snapshot (trees
   * persisted pre-crash), so no roster is needed there.
   */
  extraForcedContainerPaths?: string[]
  conflictResolver: (
    conflicts: MergeBackConflict[],
    containerPath: string,
  ) => Promise<{ allResolved: boolean; detail: string }>
  log?: Logger
}): Promise<MergeSettleOutcome> {
  const { binding, writeSem, handle, nodeRunId, via, log } = args
  const effect = binding.createLocalEffectAttemptObserver({
    taskId: handle.taskId,
    nodeRunId,
    kind: 'isolation-merge',
    stableActionOrdinal: 'isolation-merge',
    candidateId: `node-isolation-merge:${via}`,
    request: isolationMergeRequest(nodeRunId, via, args.nodeTrees !== undefined, handle.repos),
    resourceKeys: [
      `isolation:${handle.taskId}:${handle.nodeRunId}`,
      ...handle.repos.map((repo) => `workspace:${sha256Hex(repo.canonWorktreePath)}`),
    ],
  })
  // RFC-193 K1（Codex 实现门 P1）：merge 前把 roster 重聚合并写回 handle——
  // 并发 sibling 可能在本 handle 创建【之后】归档了同一 ignored 路径并已 merge
  // 进 canonical；canonical 侧（ours）快照若仍用建 handle 时的旧 roster，会漏
  // 掉 sibling 的文件，3-way merge 把本 run 的版本当 clean add 静默覆写（而非
  // 报冲突）。此刻 sibling 的 INSERT 已落库（INSERT 先于 merge-back），重聚合
  // 能看到；并上 extra（本 run 自己的产出）后统一喂给 final 与 ours 两侧。
  if (!handle.passthrough) {
    const fresh = await binding.artifactPaths.forcedPaths(handle.taskId)
    const union = [...new Set([...fresh, ...(args.extraForcedContainerPaths ?? [])])]
    for (const r of handle.repos) {
      r.forcedRepoRelPaths = binding.workspace.repoRelForcedPaths(union, r.mountPath)
    }
  }
  let nodeTrees = args.nodeTrees
  if (nodeTrees === undefined) {
    nodeTrees = await binding.workspace.snapshotIsolatedWorkspace(handle, log)
    await persistIsoNodeTree(binding, nodeRunId, nodeTrees, handle)
  }
  const trees = nodeTrees
  // Snapshotting stays parallel in each private iso. Only the canonical merge
  // window is queued. The durable fence now covers that exact window and its
  // DB settlement, so a sibling waits for normal contention instead of
  // failing merely because it reached mergeBackAndSettle concurrently.
  return writeSem.run(async () => {
    let prepared = false
    try {
      await effect?.beforeAct()
      prepared = effect !== undefined
      const mergeRes = await binding.workspace.mergeIsolatedWorkspace(
        handle,
        trees,
        log,
        // RFC-210 T25: reuse the SAME injected resolver for a conflicted submodule.
        // It runs synchronously inside merge-back, so a resolution folds straight
        // into the parent's tree and the merge continues — no separate convergence
        // path, and nothing new for the caller to wire.
        async (subConflict) => {
          const res = await args.conflictResolver([subConflict], handle.containerPath)
          return { resolved: res.allResolved }
        },
      )
      const resolution = mergeRes.clean
        ? undefined
        : await args.conflictResolver(mergeRes.conflicts, handle.containerPath)
      const merge =
        resolution === undefined || resolution.allResolved
          ? ({ kind: 'merged' } as const)
          : ({ kind: 'conflict-human', detail: resolution.detail } as const)
      if (merge.kind === 'merged') {
        await binding.mergeStates.transition({
          nodeRunId,
          event: { kind: 'mark-merged', via },
          ...contextInput(binding),
        })
        await effect?.succeed({ outcome: 'merged', via, repoCount: handle.repos.length })
        return { kind: 'merged' }
      }
      // RFC-210: persist which submodules are still unresolved BEFORE parking.
      // The fail-closed gate in completeHumanResolvedConflict reads this back on
      // resume; without it a crash between park and resume would lose the fact that
      // a submodule conflict is open, and the parent-level re-probe would find the
      // parent clean and declare the repo resolved.
      await persistPendingSubResolves(binding, nodeRunId, handle)
      await binding.mergeStates.transition({
        nodeRunId,
        event: { kind: 'park-conflict-human', via },
        ...contextInput(binding),
      })
      await effect?.succeed({ outcome: 'conflict-human', via, repoCount: handle.repos.length })
      return { kind: 'conflict-human', detail: merge.detail }
    } catch (error) {
      if (prepared) await effect?.fail(error, { via, repoCount: handle.repos.length })
      throw error
    }
  })
}

/**
 * RFC-210 — merge the current `pendingSubResolves` into the already-persisted
 * submodule topology, leaving `subBases` / `poolDir` untouched.
 *
 * Read-modify-write rather than a fresh object: the bases were written at iso
 * creation and are what the eventual re-merge needs; only the unresolved set is
 * new information.
 */
async function persistPendingSubResolves(
  binding: IsolatedAgentRunBinding,
  nodeRunId: string,
  handle: IsoHandle,
): Promise<void> {
  if (handle.passthrough) return
  if (!handle.repos.some((r) => r.pendingSubResolves.length > 0)) return
  await binding.nodeExecution.patch({
    nodeRunId,
    values: {
      checkpoint: {
        pendingSubResolves: handle.repos.map((repo) => ({
          mountPath: repo.mountPath,
          poolDirs: repo.poolDirs,
          subBases: repo.subBases,
          pendingSubResolves: repo.pendingSubResolves,
        })),
      },
    },
    ...contextInput(binding),
  })
}

/**
 * RFC-130 robustness / RFC-144 §5 — the merge-throw stamp three sites share:
 * flip the row to 'merge-failed' (try-variant so a CAS loss can never mask the
 * ORIGINAL git error) and report whether the flip landed. The workgroup hook
 * deliberately does NOT call this (leave-for-replay, see module header).
 */
export async function markMergeFailed(
  binding: IsolatedAgentRunBinding,
  nodeRunId: string,
  reason: string,
  log?: Logger,
): Promise<void> {
  const flipped = await binding.mergeStates.tryTransition({
    nodeRunId,
    event: { kind: 'mark-merge-failed', reason },
    ...contextInput(binding),
  })
  if (!flipped) log?.warn('merge_state flip to merge-failed lost/illegal', { nodeRunId })
}

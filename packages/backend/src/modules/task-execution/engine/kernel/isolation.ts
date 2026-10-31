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
import { isolationCreateRequest } from './isolationEffectRequest'
import type { CanonRepo, IsoHandle, IsoRepo } from '@/platform/contracts/isolationWorkspace'
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

/**
 * RFC-130 §段①: branch the isolated worktree under a brief writeSem window.
 * The ONE lock-window shape all five sites (incl. the mainline fresh-session
 * retry re-branch) must share — holding writeSem across the snapshot keeps a
 * sibling merge-back from advancing canonical mid-snapshot.
 */
export async function createIsoUnderLock(args: {
  writeSem: WriteSemLike
  appHome: string
  taskId: string
  /** Iso path/ref key — the mainline passes its ORIGINAL row id across the
   *  whole retry loop (D17); other sites pass the run's own id. */
  isoKeyRunId: string
  canonRepos: CanonRepo[]
  /** RFC-193 K1：必达清单在原语内部聚合（archive_json → 容器相对），调用方
   *  结构性无法忘带——base 快照缺清单会让 ignored 端口文件断在下游 iso 跳。 */
  binding: IsolatedAgentRunBinding
  log?: Logger
}): Promise<IsoHandle> {
  const scope = await args.binding.workspace.acquire({
    taskId: args.taskId,
    storageRootRef: args.appHome,
    repositories: args.canonRepos.map((repo) => ({
      repositoryRef: repo.repoPath,
      workspaceRef: repo.worktreePath,
      mount: repo.mountPath,
      baseBranch: repo.baseBranch,
    })),
  })
  // 聚合在锁外（纯读）；快照在锁内（防 sibling merge-back 推进 canonical）。
  const forcedContainerPaths = await args.binding.artifactPaths.forcedPaths(args.taskId)
  const effect = args.binding.createLocalEffectAttemptObserver({
    taskId: args.taskId,
    nodeRunId: args.isoKeyRunId,
    kind: 'isolation-create',
    stableActionOrdinal: 'isolation-create',
    candidateId: 'node-isolation-create',
    // 基键；选键阶段换代后的物理键仍落在 succeed 的 isoGeneration 上。
    request: isolationCreateRequest(args.isoKeyRunId, args.canonRepos, forcedContainerPaths),
    resourceKeys: [
      `isolation:${args.taskId}:${args.isoKeyRunId}`,
      ...args.canonRepos.map((repo) => `workspace:${sha256Hex(repo.worktreePath)}`),
    ],
  })
  // The existing task write semaphore is a queue, not a rejection boundary.
  // Acquire the durable workspace fence only after this caller reaches the
  // short snapshot/create window, and release it before the next waiter enters.
  // Preparing the effect before `writeSem.run` turned ordinary fan-out into a
  // resource conflict while the first sibling was merely using its lock turn.
  return args.writeSem.run(async () => {
    // RFC-356 L4 —— 选键在 durable effect fence **之前**（design §10 偏离项 1）。
    // 它是对「本任务自己那条路径」的幂等清理：同一 iso 键不可能有并发创建者（同一
    // node run），整段又在 writeSem 内；崩在回收中途没有 receipt 也无妨，下一次尝试
    // 会重新派生。把每一代都各起一个 effect 反而会让一次逻辑创建落多条账。
    const chosen = await scope.chooseGeneration(args.isoKeyRunId, args.log)
    await effect?.beforeAct()
    try {
      const handle = await scope.create({
        // Physical generation and the real row identity remain separate.
        key: chosen.key,
        dbNodeRunId: args.isoKeyRunId,
        forcedContainerPaths: [...forcedContainerPaths],
        ...(args.log !== undefined ? { log: args.log } : {}),
      })
      await effect?.succeed({
        passthrough: handle.passthrough,
        containerPathDigest: sha256Hex(handle.containerPath),
        repoCount: handle.repos.length,
        isoGeneration: chosen.generation,
      })
      return handle
    } catch (error) {
      await effect?.fail(error)
      throw error
    }
  })
}

/**
 * RFC-130: persist the iso base columns after createNodeIso (single vs multi-repo,
 * design.md §3.2). merge_state='isolating' marks the row as an isolated run whose
 * agent has not yet finished — deriveFrontier treats it as not-yet-complete.
 * RFC-144: the write goes through the merge_state CAS (NULL → isolating); the
 * iso base columns ride along atomically as transition extras.
 */
export async function persistIsoBase(
  binding: IsolatedAgentRunBinding,
  nodeRunId: string,
  handle: IsoHandle,
): Promise<void> {
  if (handle.passthrough) return // in-place run — leave iso columns NULL (golden-lock)
  await binding.mergeStates.transition({
    nodeRunId,
    event: { kind: 'begin-isolation' },
    extra: {
      runtime: {
        isoWorktreePath: handle.containerPath,
      },
      checkpoint: {
        checkpoints: handle.repos.map((repo) => ({
          mountPath: repo.mountPath,
          isolationBase: repo.baseSnapshot,
          submodules: submodulesFor(repo),
        })),
      },
    },
    ...contextInput(binding),
  })
}

/**
 * RFC-210 — serialize one repo's submodule topology, or null when it has none.
 *
 * NULL rather than `{}` for the submodule-free case (the overwhelming majority)
 * keeps those rows byte-identical to pre-RFC-210 and lets replay distinguish
 * "this repo has no submodules" from "the topology was never recorded".
 *
 * Gated on subBases AND poolDirs: a submodule the node itself added has a pool
 * but no base (impl-gate A3-fix), and dropping it here would strand its
 * crash-replay on a poolless topology.
 */
function submodulesFor(
  repo: IsoRepo,
): { poolDirs: Record<string, string>; subBases: Record<string, string> } | undefined {
  if (Object.keys(repo.subBases).length === 0 && Object.keys(repo.poolDirs).length === 0)
    return undefined
  return { poolDirs: repo.poolDirs, subBases: repo.subBases }
}

/** RFC-130: persist the iso node_tree columns + merge_state on agent success (D15).
 *  RFC-144: isolating → pending-merge via the merge_state CAS; the former
 *  `mergeState: string` parameter was a dead knob (all 4 callers passed the
 *  literal 'pending-merge') — the event now fixes the target.
 *
 *  RFC-210 impl-gate A3-fix: when the caller passes the handle, the submodule
 *  topology columns are RE-persisted alongside the trees. The snapshot phase
 *  can extend the topology (a submodule the node itself added gets a pool
 *  created at publish time); a crash between here and the merge would replay
 *  with the CREATION-time topology otherwise, and the new path's objects —
 *  though durable in their pool — would be invisible to the replay. */
export async function persistIsoNodeTree(
  binding: IsolatedAgentRunBinding,
  nodeRunId: string,
  nodeTrees: Record<string, string>,
  handle?: IsoHandle,
): Promise<void> {
  const mounts =
    handle === undefined ? Object.keys(nodeTrees) : handle.repos.map((repo) => repo.mountPath)
  const checkpoints = mounts.map((mountPath) => {
    const repo = handle?.repos.find((item) => item.mountPath === mountPath)
    return {
      mountPath,
      nodeTree: nodeTrees[mountPath],
      ...(repo === undefined ? {} : { submodules: submodulesFor(repo) }),
    }
  })
  await binding.mergeStates.transition({
    nodeRunId,
    event: { kind: 'mark-pending-merge' },
    extra: {
      checkpoint: {
        checkpoints,
        checkpointMountPaths: mounts,
        checkpointComponents: handle === undefined ? ['nodeTree'] : ['nodeTree', 'submodules'],
      },
    },
    ...contextInput(binding),
  })
}

import { bindMergeConflictPorts } from './mergeConflictResolution'
import { createAgentNodeExecutionPorts, sourcePortKindOf } from './agentNodeExecution'
import { createFanoutAttempts } from '../engine/node/agent-single/fanoutAttempts'
import { bindIsolationCleanup } from '../infrastructure/executionKernelBinding'
import { workspaceSessionFor } from './executionWorkspaceBinding'
// RFC-339 — task-execution-owned loop/git/fanout wrapper mechanics.

import { copyPortArchive } from '@/platform/content/locations/portArchive'
import { prepareConsumedInputs } from '../infrastructure/consumedInputsParticipant'
import { taskCheckpointRefs, type TaskRepositoryCheckpoint } from '../domain/taskCheckpoint'
import type { WorkflowNode } from '@agent-workflow/shared'
// RFC-271 T6d — RuntimeRef 域的单一解析点（三处 agentId 裸读收口于此）。
// `getAgentById` 的 import 随之删除：scheduler 不再自己查 agent 行。
import { fanoutInnerAgentRefKey } from '@/services/ref/runtimeRef'

import {
  consumedMapsEqual,
  parseConsumedJson,
} from '@/modules/task-execution/application/runProvenance'
import { encodeConsumedEdges } from '../infrastructure/runSelection/consumedCodec'
import { encodeWrapperProgress } from '@/modules/task-execution/domain/wrapperProgress'
import type { Logger } from '@/util/log'
// RFC-060 PR-E: splitDiff* imports removed — they were used only by the
// agent-multi fan-out path (now deleted). wrapper-fanout consumes a `list<T>`
// shardSource instead of slicing a string diff.
import {
  // snapshotNodeIsoFinal / mergeBackNodeIso remain imported for the WRAPPER
  // merge path only (mergeBackWrapperIso — outside RFC-188's agent-site
  // scope). Wrapper CREATE shares createIsoUnderLock with every AGENT site so
  // sibling `git worktree add` mutations cannot race in the common repository.
  discardNodeIso,
} from '@/modules/task-execution/engine/kernel/isolationCleanup'
import { type IsoHandle } from '@/platform/contracts/isolationWorkspace'
import type { IsolationWorkspaceScope } from '@/modules/source-control/public/types'
import {
  workspaceRecord,
  snapshotIsolatedWorkspace,
  mergeIsolatedWorkspace,
} from '../infrastructure/isolationWorkspaceView'
import { restoredSubmodules } from '../infrastructure/executionWorkspaceSession'
import { describeEffectError } from '../domain/effectErrorDescription'
// RFC-188: the shared assembly for isolated agent runs — iso lock-window,
// iso-column persistence and the merge-back/settle block (formerly five
// hand-copies in this file).
import {
  createIsoUnderLock,
  persistIsoBase,
  persistIsoNodeTree,
} from '@/modules/task-execution/engine/kernel/isolation'
// RFC-210 replay: submodule topology read-back + the fail-closed gate around it.
import { parseIsoSubmodules } from '@/modules/task-execution/domain/isoSubmodules'
import type { TaskMechanicsState } from './taskMechanicsState'
import { isolatedRunBinding } from '@/modules/task-execution/composition/executionMechanismBindings'
import { resolveMergeConflicts } from '@/modules/task-execution/engine/node/shared/resolveMergeConflicts'
import {
  resolveUpstreamInputs,
  readPortRowAtFrame,
} from '@/modules/task-execution/application/nodeInputs'
import { completeFrameMerges } from './executionMergeRecovery'
import type { WrapperDataPort } from '../application/ports/wrapperData'
import { loadFrameChain } from '../application/frameChain'
import { resolveSourceFrameInScope } from '../domain/environmentChain'
import type { WrapperScopeDriverPort } from '../application/ports/wrapperScopeDriver'
import type {
  WrapperWorkspacePort,
  WrapperWorkspaceScene,
} from '../application/ports/wrapperWorkspace'
import type { FanoutAttemptPort } from '../application/ports/fanoutAttempt'

export interface WrapperMechanicsPorts {
  readonly data: WrapperDataPort
  readonly scopeDriver: WrapperScopeDriverPort
  readonly workspace: WrapperWorkspacePort
  readonly fanoutAttempts: FanoutAttemptPort
}

export function createWrapperMechanicsPorts(
  state: TaskMechanicsState,
  executionLog: Logger,
): WrapperMechanicsPorts {
  const scenes = new Map<symbol, { readonly handle: IsoHandle; readonly kind: string }>()
  const sceneRecord = (scene: WrapperWorkspaceScene) => {
    const record = scenes.get(scene.key)
    if (record === undefined) throw new Error(`wrapper-workspace-scene-missing:${scene.kind}`)
    return record
  }
  const diffableRepos = (scene: WrapperWorkspaceScene) => {
    const { handle } = sceneRecord(scene)
    return (
      handle.passthrough
        ? state.repos.map((repo) => ({
            path: repo.worktreePath,
            mountPath: repo.mountPath,
            readonly: repo.readonly,
          }))
        : handle.repos.map((repo, index) => ({
            path: repo.isoWorktreePath,
            mountPath: state.repos[index]?.mountPath ?? repo.mountPath,
            readonly: state.repos[index]?.readonly ?? false,
          }))
    )
      .filter((repo) => !repo.readonly)
      .map((repo) => ({ path: repo.path, mountPath: repo.mountPath }))
  }

  const data: WrapperDataPort = {
    definition: state.definition,
    fanoutMaxShardTotal: state.opts.fanoutMaxShardTotal ?? 256,
    fanoutAgentKey: fanoutInnerAgentKey,
    async resolveFanoutAgent(node) {
      const agentId = fanoutInnerAgentRefKey(node as Record<string, unknown>)
      if (agentId === null) return { kind: 'missing' }
      const resolution = await state.taskExecutionResources.injection(agentId)
      return resolution.kind === 'ok' ? { kind: 'ok', agent: resolution.spec.agent } : resolution
    },
    sourcePortKind: (nodeId, portName) => sourcePortKindOf(state, nodeId, portName),
    consumedProvenanceMatches(priorJson, current) {
      return consumedMapsEqual(parseConsumedJson(priorJson), current)
    },
    reportDiagnostic(input) {
      executionLog[input.level](input.message, input.fields)
    },
    persistProgress: async (runId, progress) => {
      await state.opts.persistence.nodeExecution.patch({
        nodeRunId: runId,
        values: {
          runtime: {
            wrapperProgressJson: encodeWrapperProgress(progress),
          },
        },
        ...(state.opts.executionContext === undefined
          ? {}
          : { executionContext: state.opts.executionContext }),
      })
    },
    // RFC-354: `frame` is the READER's frame — the body frame `(generation,
    // round)` a loop evaluates its exit condition / output bindings in. The
    // producing node is read in the frame the environment chain resolves it
    // to: a body node locally, a node outside the wrapper as a captured free
    // variable (one generation row outward per enclosing wrapper). A source
    // that is not lexically visible fails loudly instead of reading ''.
    readPort: async (nodeId, portName, frame) => {
      const chain = await loadFrameChain(
        (id: string) => state.opts.persistence.nodeExecution.read(id),
        frame,
      )
      const scopeRow =
        frame.containerRunId === null ? undefined : chain.lookup(frame.containerRunId)
      const resolved = resolveSourceFrameInScope({
        sourceNodeId: nodeId,
        scope: scopeRow?.nodeId ?? null,
        parents: state.containerOf,
        frame,
        containerRowById: chain.lookup,
      })
      if (!resolved.ok) {
        throw new Error(
          `closure-binding-unresolved: port '${nodeId}.${portName}' is not visible from frame ` +
            `${frame.containerRunId ?? 'top'}#${frame.iteration} (${resolved.reason}${resolved.scopeId === null ? '' : ` at ${resolved.scopeId}`})`,
        )
      }
      return await readPortRowAtFrame(
        state.opts.persistence.nodeExecution,
        state.taskId,
        nodeId,
        portName,
        resolved.frame,
        state.definition.nodes.find((node) => node.id === nodeId)?.kind,
      )
    },
    resolveInputs: (nodeId, frame) =>
      resolveUpstreamInputs(
        state.opts.persistence.nodeExecution,
        state.taskId,
        state.definition.edges,
        nodeId,
        frame,
        executionLog,
        state.definition,
        state.containerOf,
      ),
    async recordConsumed(runId, consumed) {
      await state.opts.persistence.nodeExecution.patch({
        nodeRunId: runId,
        values: {
          inputs: {
            ...prepareConsumedInputs({ record: consumed }),
          },
        },
        ...(state.opts.executionContext === undefined
          ? {}
          : { executionContext: state.opts.executionContext }),
      })
    },
    async priorFanoutConsumed(nodeId, iteration, excludeRunId) {
      return state.opts.persistence.nodeExecution.snapshotRead(async (snapshot) => {
        const rows = await snapshot.list({ taskId: state.taskId, nodeId, iteration })
        const previous = (
          await snapshot.selection.familyHistory(
            state.taskId,
            {
              nodeId,
              iteration,
              runIds: rows.filter((row) => row.id !== excludeRunId).map((row) => row.id),
            },
            { topLevelOnly: true, consumedOnly: true },
          )
        ).at(-1)
        if (previous === undefined) return null
        return encodeConsumedEdges(await snapshot.selection.consumed(previous.id))
      })
    },
    async outputOf(runId, portName) {
      const row = (await state.opts.persistence.nodeExecution.listOutputs(runId)).find(
        (output) => output.portName === portName,
      )
      return row === undefined
        ? null
        : {
            content: row.content,
            kind: row.kind,
            archiveJson: copyPortArchive(row.archiveJson),
            active: row.active,
          }
    },
    async upsertOutput(input) {
      await state.opts.persistence.nodeExecution.upsertOutputs({
        nodeRunId: input.runId,
        outputs: [
          {
            portName: input.portName,
            content: input.content,
            kind: input.kind ?? null,
            archiveJson: copyPortArchive(input.archiveJson ?? null),
            active: input.active ?? true,
          },
        ],
        ...(state.opts.executionContext === undefined
          ? {}
          : { executionContext: state.opts.executionContext }),
      })
    },
  }

  const workspace: WrapperWorkspacePort = {
    async open(generation) {
      const handle = await createOrRebuildWrapperIso(state, generation.runId, generation.previous)
      const key = Symbol(generation.runId)
      scenes.set(key, { handle, kind: generation.kind })
      return Object.freeze({ key, kind: generation.kind, passthrough: handle.passthrough })
    },
    async captureGitEntry(scene, capturePreDirty) {
      const scope = workspaceRecord(sceneRecord(scene).handle).scope
      const repos = diffableRepos(scene)
      const primaryMount = repos.some((repo) => repo.mountPath === '')
        ? ''
        : (repos[0]?.mountPath ?? '')
      const entry = await state.writeSem.run(async () => {
        const baselines: Record<string, string> = {}
        const preDirtyByRepo: Record<string, Record<string, string>> = {}
        for (const repo of repos) {
          const baseline = await captureHead(scope, repo.path)
          baselines[repo.mountPath] = baseline
          preDirtyByRepo[repo.mountPath] = capturePreDirty
            ? await captureGitPreDirty(scope, repo.path, baseline, executionLog)
            : {}
        }
        return { baselines, preDirtyByRepo }
      })
      return { ...entry, primaryMount }
    },
    changedFiles(scene, baselines, preDirtyByRepo) {
      const scope = workspaceRecord(sceneRecord(scene).handle).scope
      return state.writeSem.run(async () => {
        const output: string[] = []
        for (const repo of diffableRepos(scene)) {
          const baseline = baselines[repo.mountPath] ?? ''
          const preDirty = preDirtyByRepo[repo.mountPath] ?? {}
          const all = await scope.changedFiles(repo.path, baseline || 'HEAD')
          const candidates = all.filter((path) => preDirty[path] !== undefined)
          const kept =
            candidates.length === 0
              ? all
              : await (async () => {
                  const post = await scope.blobHashes(repo.path, candidates)
                  return all.filter(
                    (path) => preDirty[path] === undefined || post[path] !== preDirty[path],
                  )
                })()
          for (const path of kept) {
            output.push(repo.mountPath === '' ? path : `${repo.mountPath}/${path}`)
          }
        }
        return output
      })
    },
    async merge(input) {
      const { handle } = sceneRecord(input.scene)
      const result = await mergeBackWrapperIso(
        state,
        handle,
        input.runId,
        input.node,
        input.iteration,
        executionLog,
      )
      return result.kind === 'merge-failed' ? { kind: 'merge-failed', message: result.msg } : result
    },
  }

  const scopeDriver: WrapperScopeDriverPort = {
    drive(input) {
      const { handle, kind } = sceneRecord(input.workspace)
      const innerState: TaskMechanicsState = handle.passthrough
        ? state
        : {
            ...state,
            repos: handle.repos.map((repo, index) => ({
              ...state.repos[index]!,
              ordinal: state.repos[index]!.ordinal,
              repoPath: repo.repoPath,
              worktreePath: repo.isoWorktreePath,
              mountPath:
                kind === 'wrapper-loop'
                  ? (state.repos[index]?.mountPath ?? repo.mountPath)
                  : repo.mountPath,
              readonly: kind === 'wrapper-loop' ? (state.repos[index]?.readonly ?? false) : false,
              baseBranch: repo.baseBranch,
              baseCommit: repo.baseSnapshot,
            })),
            scopeRoot: handle.containerPath,
          }
      const label = kind === 'wrapper-loop' ? 'loop' : 'git'
      const scopeLog = executionLog.child(`${label}:${input.scope.wrapperId}`)
      // RFC-370 — a revived body first finishes the merge-backs a crash or a
      // lost execution lease interrupted in it, into this wrapper's worktree.
      return completeFrameMerges(
        innerState,
        { containerRunId: input.containerRunId, iteration: input.iteration },
        scopeLog,
      ).then(() =>
        state.driveScope(innerState, {
          scopeId: input.scope.wrapperId,
          scopeIds: new Set(input.scope.directNodeIds),
          containerRunId: input.containerRunId,
          iteration: input.iteration,
          log: scopeLog,
        }),
      )
    },
  }

  // RFC-407: the fan-out lines run in the agent executor on its ports.
  const fanoutAttempts = createFanoutAttempts(createAgentNodeExecutionPorts(state), executionLog)

  return { data, scopeDriver, workspace, fanoutAttempts }
}

// -----------------------------------------------------------------------------
// RFC-040 — wrapper resume helpers shared by the loop and Git strategies.
//
// Why they exist: before RFC-040, both wrappers silently swallowed
// `awaiting_human` / `awaiting_review` signals from their inner scope (only
// `canceled` / `failed` were matched) and either kept iterating (loop) or
// computed a diff against a half-finished worktree (git). The result was N
// ghost clarify/review rows and, for git, a wrong final diff. The fix is to
// (a) bubble the awaiting signal up unchanged, (b) persist enough state on
// the wrapper's node_run so the dispatcher can resume from the same loop
// iteration / git baseline when the user answers clarify or decides review,
// and (c) reuse the existing wrapper node_run row on resume instead of
// minting a fresh one. See design/RFC-040-wrapper-await-bubble/design.md §4.
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// wrapper-fanout (RFC-060) — fan a list<T> shardSource into N parallel inner
// dispatches, optionally aggregated by an inner role='aggregator' agent.
//
// PR-D v1 inner-kind support: agent-single only. agent-multi / wrapper-*
// / review / clarify / clarify-cross-agent / output / input inside a
// wrapper-fanout's inner subgraph are PR-D2 scope and fail at runtime with
// `wrapper-fanout-v1-unsupported-inner-kind` (the user gets a clear error
// rather than silent wrong behavior). The validator emits a static warning
// for the nested wrapper-fanout case; runtime rejection here is the
// secondary safety net.
//
// Lifecycle (RFC-053 compatible — D.T8):
//   pending → running → done | failed
// Shard child rows are minted with parentNodeRunId=wrapperRunId so they
// don't bubble into latestPerNode of the wrapper's parent scope.
// -----------------------------------------------------------------------------

/**
 * RFC-223 (PR-3a impl-gate H2): the CANONICAL dedup / lookup key for a
 * wrapper-fanout inner agent node — its stamped `agentId`. Used by BOTH the
 * inner-agent-map hydration and per-shard dispatch. A name-only node returns
 * null and fails closed.
 */
export function fanoutInnerAgentKey(node: {
  agentId?: unknown
  agentName?: unknown
}): string | null {
  // RFC-271 T6d：判据收到 `services/ref/runtimeRef.ts` 的单一读取点。
  // 语义与返回值逐字不变——name-only 节点仍返回 null 并 fail closed。
  return fanoutInnerAgentRefKey(node)
}

// -----------------------------------------------------------------------------
// wrapper-git (P-3-03 + nested via P-4-03) — RFC-040 makes it bubble
// awaiting_* and resumable.
//
// The wrapper takes a baseline = HEAD, recursively executes its inner scope
// once, then computes the diff vs the baseline. This works for unnested
// wrappers and for wrapper-loop-in-wrapper-git (the inner scope can itself
// contain a wrapper-loop). On RFC-040 resume the baseline is read from
// persisted progress — we MUST NOT re-capture HEAD on resume because the
// worktree has already diverged from the original pre-inner state while the
// inner agent was running; the final diff is meant to be against pre-inner,
// not pre-resume.
// -----------------------------------------------------------------------------

async function captureHead(scope: IsolationWorkspaceScope, worktreePath: string): Promise<string> {
  try {
    const r = await scope.head(worktreePath)
    if (r.exitCode === 0) return r.stdout.trim()
  } catch {
    /* empty fixture in tests */
  }
  return ''
}

// RFC-098 B3 (audit S-4, adversarial-review revision #9) — preDirty caps.
// Beyond either limit the capture DEGRADES TO THE EMPTY SET: the finalize
// subtraction then removes nothing, which is exactly the pre-fix cumulative
// behavior — over-report, never drop a real change. (A "paths-only" degrade
// was explicitly rejected: subtracting by bare path would drop files the
// inner scope genuinely rewrote.)
const GIT_PRE_DIRTY_MAX_ENTRIES = 4096
const GIT_PRE_DIRTY_MAX_JSON_BYTES = 256 * 1024

/**
 * RFC-098 B3 (audit S-4) — sample the worktree's pre-existing dirty set
 * `{path: blobSha | 'deleted'}` at git-wrapper FRESH MINT, right after the
 * baseline capture and inside the same task-write-lock window (no sibling
 * writer can be mid-write while we sample). Best-effort by design: any git
 * failure (no commits yet, fixture without a repo, hash race) degrades to the
 * empty set with a warn — entry must never fail the wrapper, and the empty
 * set only over-reports. Resume NEVER calls this (it reads the persisted map
 * from wrapperProgress; re-capturing after the inner scope started would
 * swallow the inner scope's own writes into the pre-set — silent UNDER-report,
 * worse than today).
 */
async function captureGitPreDirty(
  scope: IsolationWorkspaceScope,
  worktreePath: string,
  baseline: string,
  log: Logger,
): Promise<Record<string, string>> {
  try {
    const paths = await scope.changedFiles(worktreePath, baseline || 'HEAD')
    if (paths.length === 0) return {}
    if (paths.length > GIT_PRE_DIRTY_MAX_ENTRIES) {
      log.warn('git wrapper preDirty over entry cap — degrading to empty set (over-report)', {
        worktreePath,
        entries: paths.length,
        cap: GIT_PRE_DIRTY_MAX_ENTRIES,
      })
      return {}
    }
    const hashes = await scope.blobHashes(worktreePath, paths)
    const bytes = new TextEncoder().encode(JSON.stringify(hashes)).byteLength
    if (bytes > GIT_PRE_DIRTY_MAX_JSON_BYTES) {
      log.warn('git wrapper preDirty over JSON-size cap — degrading to empty set (over-report)', {
        worktreePath,
        bytes,
        cap: GIT_PRE_DIRTY_MAX_JSON_BYTES,
      })
      return {}
    }
    return hashes
  } catch (err) {
    log.warn('git wrapper preDirty capture failed — degrading to empty set (over-report)', {
      worktreePath,
      error: describeEffectError(err),
    })
    return {}
  }
}

/**
 * RFC-130 T11 — create (fresh mint) or rebuild (resume) the wrapper-canonical iso
 * for a wrapper node. Fresh: snapshot the task canonical into an iso worktree keyed
 * by the wrapper's run id + persist its base. Resume: rebuild the handle pointing at
 * the SAME worktree (kept across a park — carrying the inner scope's accumulated
 * changes — so it must NOT be recreated). A non-git task worktree (mock harness)
 * yields a passthrough handle (the wrapper runs directly on the task canonical).
 */
export async function createOrRebuildWrapperIso(
  state: TaskMechanicsState,
  wrapperRunId: string,
  existing: {
    checkpoints: readonly TaskRepositoryCheckpoint[]
  } | null,
): Promise<IsoHandle> {
  const { taskId } = state
  // RFC-144 (Codex impl-gate P2) — same-row wrapper revival: a revived wrapper
  // row may arrive with a SETTLED prior generation ('merged': crash inside
  // mergeBackWrapperIso got its pending-merge replayed at entry;
  // 'conflict-human': canceled while parked). This run opens a NEW isolation
  // generation on the same row — re-enter 'isolating' so the strict machine's
  // mark-pending-merge (from=isolating) holds at the wrapper's merge-back.
  // isolating (mid-run revival, the common case) and NULL (fresh row /
  // passthrough) rows never emit this.
  const cur = await state.opts.persistence.nodeExecution.read(wrapperRunId)
  // RFC-356 T15 —— 这棵 wrapper iso 的**物理键**。
  //
  // 它不一定等于 `wrapperRunId`：RFC-356 的代际自愈会在残留清不掉时把键推进成
  // `{原键}-2`，而路径的 basename 就是键（`isoKeyOf`，RFC-210 round 6 P2）。
  //
  // ⚠️ **顺序约束**：必须用 CAS **之前**读到的 `cur`。下面 `merged` 再入分支的
  // reenter CAS 会显式把 `isoWorktreePath` 写成 null，之后再读就只剩 wrapperRunId
  // 可派生——那恰好是代际自愈已经放弃的那个阻塞目录。挪动这个读取点会静默失效。
  const scope = await workspaceSessionFor(state).scope()
  const wrapperIsoKey = await scope.recoverKey(cur?.isoWorktreePath ?? null, wrapperRunId)
  let effectiveExisting = existing
  if (cur !== null && (cur.mergeState === 'merged' || cur.mergeState === 'conflict-human')) {
    if (cur.mergeState === 'merged') {
      // Impl-gate P2 second half: the prior generation's delta is ALREADY in
      // canonical — the new generation must branch from the CURRENT canonical,
      // NOT the stale gen-1 base. A three-way merge against the old base would
      // treat gen-1 files (now in canon) as `ours` additions and resurrect
      // content the new generation deleted.
      //
      // ORDER (impl-gate P2 rounds 3-5): the reenter CAS runs FIRST — it is the
      // ownership claim. A concurrent reviver that also read 'merged' loses the
      // CAS here and throws BEFORE any destructive cleanup (it can never remove
      // the winner's freshly-built iso). The CAS ATOMICALLY clears the base
      // columns + wrapperProgressJson, so a crash anywhere after it leaves an
      // isolating row with NULL base/progress — the next resume re-detects
      // "generation start" from durable state and the stale-iso cleanup below
      // (derived paths only, no column values needed) makes the re-create
      // idempotent. conflict-human re-entry keeps base + progress: its delta
      // never reached canonical (D27), so the old base/baseline stay the
      // correct merge/diff anchors.
      await state.opts.persistence.mergeStates.transition({
        nodeRunId: wrapperRunId,
        event: { kind: 'reenter-isolation' },
        extra: {
          runtime: {
            isoWorktreePath: null,
            wrapperProgressJson: null,
          },
          checkpoint: {
            checkpoints: state.repos.map((repo) => ({
              mountPath: repo.mountPath,
              isolationBase: undefined,
            })),
          },
        },
        ...(state.opts.executionContext === undefined
          ? {}
          : { executionContext: state.opts.executionContext }),
      })
      effectiveExisting = null
    } else {
      await state.opts.persistence.mergeStates.transition({
        nodeRunId: wrapperRunId,
        event: { kind: 'reenter-isolation' },
        ...(state.opts.executionContext === undefined
          ? {}
          : { executionContext: state.opts.executionContext }),
      })
    }
  }
  if (effectiveExisting !== null) {
    const baseSnapshots = taskCheckpointRefs(effectiveExisting.checkpoints, 'isolationBase')
    if (Object.keys(baseSnapshots).length > 0) {
      const taskBaseHeads: Record<string, string> = {}
      for (const repo of state.repos) {
        taskBaseHeads[repo.mountPath] = (await scope.head(repo.worktreePath)).stdout.trim()
      }
      return await workspaceSessionFor(state).restore({
        // 这个 handle **要拿去 merge-back**：指错路径不是少清一个目录，
        // 而是把不存在的树当成节点产物去合并，属硬故障。
        key: wrapperIsoKey,
        dbNodeRunId: wrapperRunId,
        workspaceRef: cur?.isoWorktreePath ?? null,
        baseSnapshots,
        taskBaseHeads,
        forcedContainerPaths: [...(await state.opts.persistence.artifactPaths.forcedPaths(taskId))],
        // RFC-210: a rebuilt wrapper iso merges back like any other, so it
        // carries the same submodule topology. (The discard-only rebuild below
        // deliberately does not — it needs paths and refs, nothing else.)
        submodules: restoredSubmodules(parseIsoSubmodules(effectiveExisting.checkpoints)),
      })
    }
    // No persisted iso base (legacy / passthrough row) — fall through to create.
  }
  if (existing !== null) {
    // Reaching CREATE for a row that has lived before (merged re-entry, or a
    // crash inside a prior re-entry window that cleared the base columns): a
    // stale iso worktree may still sit at this wrapper's derived path, and
    // `git worktree add` fails LOUDLY on an existing dir — without cleanup the
    // task would wedge on every resume. discardNodeIso only needs the derived
    // paths + refs (base snapshot VALUES are unused for removal), so a handle
    // rebuilt with empty snapshot maps cleans up regardless of what the crash
    // left behind. Tolerant: nothing there → warn-and-continue.
    await discardNodeIso(
      bindIsolationCleanup(),
      await workspaceSessionFor(state).restore({
        // 只做 discard，路径缺失可容忍（比 :1662 那处低一档风险）。
        key: wrapperIsoKey,
        dbNodeRunId: wrapperRunId,
        workspaceRef: cur?.isoWorktreePath ?? null,
        baseSnapshots: {},
        taskBaseHeads: {},
      }),
      state.log,
      state.writeSem,
    )
  }
  // Wrapper-private canonicals and ordinary sibling agent isos mutate the same
  // repository's `.git/worktrees` registry. They MUST share the task write
  // semaphore; otherwise a top-level wrapper and a slow sibling can overlap
  // `git worktree add`, leaving a partially initialized registration whose
  // `commondir` cannot be read. Keep only the short create/snapshot window
  // locked — wrapper execution itself remains concurrent.
  const handle = await createIsoUnderLock({
    writeSem: state.writeSem,
    appHome: state.opts.appHome,
    taskId,
    isoKeyRunId: wrapperRunId,
    canonRepos: state.repos,
    binding: isolatedRunBinding(state),
    log: state.log,
  })
  if (!handle.passthrough) await persistIsoBase(isolatedRunBinding(state), wrapperRunId, handle)
  return handle
}

/**
 * RFC-130 T11 — merge a completed wrapper's total delta (its wrapper-canonical)
 * back into the parent (task) canonical as ONE unit, exactly like a node merge-back
 * (§6). Clean → merge_state='merged' (D15 lets downstream consume) + iso discarded;
 * conflict → merge agent, unresolved → the wrapper is parked conflict-human (iso
 * kept) — the caller returns awaiting_human; a merge-back error → merge-failed, the
 * caller fails the wrapper. Shared by the git + loop (+ fanout) wrappers so the
 * merge-back semantics can't fork.
 */
async function mergeBackWrapperIso(
  state: TaskMechanicsState,
  wrapperIso: IsoHandle,
  wrapperRunId: string,
  node: WorkflowNode,
  iteration: number,
  log: Logger,
): Promise<
  // RFC-144 naming收敛: the parked-conflict variant is 'conflict-human' — same
  // vocabulary as the merge_state column and the node-path union above (the
  // old 'awaiting_human' kind said what the TASK would do, not what the row
  // is; callers translate conflict-human → awaiting_human scope outcome).
  | { kind: 'merged' }
  | { kind: 'conflict-human'; detail: string }
  | { kind: 'merge-failed'; msg: string }
> {
  const { taskId } = state
  try {
    // RFC-193 K1: re-aggregate at wrapper-final time — the wrapper handle is
    // the one LONG-LIVED handle (inner nodes archived new port files during
    // its lifetime; the create-time roster predates them, design §4.5).
    const nodeTrees = await snapshotIsolatedWorkspace(wrapperIso, log, [
      ...(await state.opts.persistence.artifactPaths.forcedPaths(taskId)),
    ])
    // RFC-210 impl-gate: the handle rides along so a topology the snapshot
    // extended (submodule added inside the wrapper) survives into crash replay.
    await persistIsoNodeTree(isolatedRunBinding(state), wrapperRunId, nodeTrees, wrapperIso)
    const merge = await state.writeSem.run(async () => {
      const mr = await mergeIsolatedWorkspace(wrapperIso, nodeTrees, log)
      if (mr.clean) return { kind: 'merged' as const }
      const res = await resolveMergeConflicts(bindMergeConflictPorts(state), {
        conflicts: mr.conflicts,
        containerPath: wrapperIso.containerPath,
        conflictNodeRunId: wrapperRunId,
        nodeId: node.id,
        iteration,
      })
      return res.allResolved
        ? { kind: 'merged' as const }
        : { kind: 'conflict-human' as const, detail: res.detail }
    })
    if (merge.kind !== 'merged') {
      await state.opts.persistence.mergeStates.transition({
        nodeRunId: wrapperRunId,
        event: { kind: 'park-conflict-human', via: 'live' },
        ...(state.opts.executionContext === undefined
          ? {}
          : { executionContext: state.opts.executionContext }),
      })
      // D10: merge_state and status remain orthogonal. This adapter owns only
      // the merge fact; WrapperRunLedger performs the one status CAS and
      // WrapperRuntime publishes only after that write commits.
      return { kind: 'conflict-human', detail: merge.detail }
    }
    await state.opts.persistence.mergeStates.transition({
      nodeRunId: wrapperRunId,
      event: { kind: 'mark-merged', via: 'live' },
      ...(state.opts.executionContext === undefined
        ? {}
        : { executionContext: state.opts.executionContext }),
    })
    await discardNodeIso(bindIsolationCleanup(), wrapperIso, log, state.writeSem)
    return { kind: 'merged' }
  } catch (err) {
    const msg = describeEffectError(err)
    const flipped = await state.opts.persistence.mergeStates.tryTransition({
      nodeRunId: wrapperRunId,
      event: { kind: 'mark-merge-failed', reason: msg },
      ...(state.opts.executionContext === undefined
        ? {}
        : { executionContext: state.opts.executionContext }),
    })
    if (!flipped) {
      log.warn('merge_state flip to merge-failed lost/illegal', { nodeRunId: wrapperRunId })
    }
    return { kind: 'merge-failed', msg }
  }
}

// RFC-060 PR-E: runFanOutNode (the M3 agent-multi fan-out implementation)
// was removed. wrapper-fanout (RFC-060) is now the sole fan-out mechanism;
// see FanoutStrategy for the replacement.

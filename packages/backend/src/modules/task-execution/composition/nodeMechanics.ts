// RFC-334 W2-C — production node and workgroup-host mechanics.
// Per-kind selection lives in the closed registry; wrapper bodies are owned by
// the RFC-339 WrapperRuntime and consume this file only through typed ports.

import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { nodeRunEvents, nodeRunOutputs, nodeRuns, taskCollaborators, tasks } from '@/db/schema'
import type { DbTxSync } from '@/db/txSync'
import type { CollaborationNodeGatePort } from '@/modules/task-execution/application/ports/collaborationNodeGate'
import { resolveNodeActivationForDispatch } from '@/modules/task-execution/application/resolveNodeActivation'
import {
  decideRetryShape,
  DEFAULT_SESSION_RESTART_BUDGET,
  type EnvelopeFollowupOutcome,
  type RetryShapeState,
} from '@/modules/task-execution/domain/envelopeRetryPolicy'
import {
  collectDataflowInboundEdges,
  collectImplicitInboundRefs,
  nodeKindIndex,
} from '@/modules/task-execution/domain/inboundEdges'
import { pickInheritableRunConfig } from '@/modules/task-execution/public/commands'
import { retryAttemptCap } from '@/platform/contracts/retryAttemptCap'
import {
  dispatchCrossClarifyNode,
  findClarifyNode,
  resolveCrossNodeStopped,
} from '@/services/clarify/service'
import { buildClarifyQueueContext } from '@/services/clarifyQueue'
import {
  computeRemaining,
  resolveEffectiveClarifyChannel,
  shouldInjectStopNotice,
} from '@/services/clarifyRounds'
import { executeCodeHostCall } from '@/services/codeHost/call'
import { resolveCodeHostConnectionsFromKeyFile } from '@/services/codeHost/connections'
import { resolveProjectFallback } from '@/services/codeHost/project'
import { probeCodeHostMutation } from '@/services/codeHost/recoveryProbe'
import { CLARIFY_FORBIDDEN_PREFIX, parsePortValidationFailuresJson } from '@/services/envelope'
import {
  currentMaxInvocationDepth,
  ensureChildTaskBudget,
  registerKnownChildTask,
} from '@/services/execution/childBudget'
import {
  childClosureSubset,
  frozenWorkflowFromClosure,
  frozenWorkgroupFromClosure,
  type FrozenWorkgroupRef,
} from '@/services/execution/closure'
import { watchTaskTerminal } from '@/services/execution/executionWatch'
import { getExecutionOutcome } from '@/services/execution/outcome'
import { resolveInjection } from '@/services/execution/resolveInjection'
import type {
  LegacyNodeResult,
  LegacyTaskMechanicsState,
} from '@/services/execution/taskMechanicsState'
import { freezeBinaryConfig } from '@/services/execution/runtimeConfigFreeze'
import { pickFreshestRun, pickUpstreamSourceRun } from '@/services/freshness'
import {
  createIsoUnderLock,
  markMergeFailed,
  mergeBackAndSettle,
  persistIsoBase,
  type MergeSettleOutcome,
} from '@/services/isolatedAgentRun'
import {
  setNodeRunStatus,
  setNodeRunStatusTx,
  transitionMergeState,
  transitionNodeRunStatus,
  tryTransitionMergeState,
} from '@/services/lifecycle'
import {
  buildMergeAgent,
  buildMergeResolvePrompt,
  mergeResolveNodeId,
  type MergeConflictManifest,
} from '@/services/mergeAgent'
import {
  discardNodeIso,
  MergeAgentChildUnreapedError,
  rebuildIsoHandle,
  resolveConflictWithAgent,
  type IsoHandle,
  type MergeBackConflict,
} from '@/services/nodeIsolation'
import {
  continuesClarifyLineage,
  frozenRuntimeOfSession,
  isClarifyRerunCause,
  loadRunEnvelopeNonce,
  mintNodeRun,
  resolveFrozenRuntime,
  resolveSchedulerRunRow,
} from '@/services/nodeRunMint'
import { forcedPortPathsForTask, toContainerRelative } from '@/services/portArtifacts'
import { resolveNodeAgentRef } from '@/services/ref/runtimeRef'
import { buildReviewPromptContext, dispatchReviewNode } from '@/services/review'
import { runNode, type RunResult } from '@/services/runner'
import { getRuntimeDriver, runRootFor } from '@/services/runtime'
import { resolveInternalAgentRuntime } from '@/services/runtimeRegistry'
import { runAssembly, type IsoLike } from '@/services/schedulerAssembly'
import {
  ensureScriptDepsEnv,
  ScriptDepsInstallError,
  type ScriptDepsEnv,
} from '@/services/scriptDepsEnv'
import { extractScriptPorts } from '@/services/scriptPorts'
import {
  describeInterpreterResolution,
  resolveScriptInterpreter,
  runScriptProcess,
} from '@/services/scriptRun'
import {
  decideResumeSessionId,
  type ClarifyInlineFallbackReason,
} from '@/services/sessionModeFallback'
import { getNodeClarifyDirectiveRow } from '@/services/taskClarifyDirective'
import {
  createCodeHostEffectAttemptObserver,
  createProcessEffectAttemptObserver,
  decodeLineageSlotPath,
  encodeLineageSlotPath,
  taskExecutionRequestHash as executionEffectRequestHash,
  operationFamilyKey,
  taskExecutionModule,
  withCurrentTaskExecutionMutation,
  withTaskExecutionMutation,
  type LineageSlot,
  type ProcessEffectAttemptObserver,
  type TaskExecutionContext,
} from '@/services/taskExecutionParticipants'
import { resolveBorrowForNode } from '@/services/taskQuestionDispatch'
import {
  type WorkgroupEngineHooks,
  type WorkgroupHostRunRequest,
  type WorkgroupHostRunResult,
} from '@/services/workgroup/engine'
import {
  dismissOpenClarifyParksForAutonomous,
  isTaskClarifySuppressed,
} from '@/services/workgroup/lifecycle'
import { ConflictError, DomainError, NotFoundError, ValidationError } from '@/util/errors'
import { runGit, worktreeFilesChanged } from '@/util/git'
import { sha256Hex } from '@/util/hash'
import { type Logger } from '@/util/log'
import { Paths } from '@/util/paths'
import { TASK_CHANNEL, taskBroadcaster } from '@/ws/broadcaster'
import type {
  ClarifyCrossAgentNode,
  ClarifyNode,
  EnvelopeFollowupReason,
  FailureCode,
  TriggerContext,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
} from '@agent-workflow/shared'
import {
  agentHasClarifyChannel,
  buildPriorOutputBlock,
  DAEMON_RESTART_ERROR_SUMMARY,
  DAEMON_SHUTDOWN_ABORT_REASON,
  DEFAULT_PROTOCOL_RETRY_BUDGET,
  describeWrapperKind,
  DISPATCH_CALL_POLICY,
  findClarifyNodeForAgent,
  findCrossClarifyNodeForQuestioner,
  findDesignerNodeForCrossClarify,
  findQuestionerNodeForCrossClarify,
  followupPolicyForFailure,
  isCodeHostAction,
  IsoSubmodulesSchema,
  maskScriptEnvValues,
  readScriptDependencies,
  readScriptEnv,
  readScriptLanguage,
  renderCallWorkgroupGoalTemplate,
  resolveClarifySessionMode,
  resolveCrossClarifySessionMode,
  resolveScriptReadonly,
  resolveWorkflowSourceRef,
  SCRIPT_PERMANENT_FAILURE_CODES,
  scriptOutputMode,
  TERMINAL_TASK_STATUSES,
  type ScriptLanguage,
  type Permission,
  type StartTask,
} from '@agent-workflow/shared'
import { and, asc, desc, eq, notLike, sql } from 'drizzle-orm'
import { mkdirSync } from 'node:fs'
import { basename } from 'node:path'
import { ulid } from 'ulid'

/**
 * RFC-284 T20（§4）—— 子任务继承面的唯一登记：buildChildDeps 按本清单整体透传，
 * 新增 RunTaskOptions 字段时**必须**在测试的处置表里表态（inherit / per-task /
 * dropped-独立供给），编译期穷尽（satisfies Record<keyof RunTaskOptions,…>）
 * 防「看起来像可继承」的字段被顺手漏配或顺手多配。
 *
 * 实施偏差（相对 design 草稿的「拆 inheritable 嵌套子对象」）：字面嵌套会让
 * RunTaskOptions/StartTaskDeps 的全部构造点与测试夹具连坐改形，而两型 15 个
 * 同名字段的注释各自承载调度语义/路由接线两套契约、不宜合并——注册表 + Pick
 * 派生型给出同等单源与更强的双向锁，类型面零搬迁。
 */
type NodeStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'failed'
  | 'canceled'
  | 'interrupted'
  | 'skipped'
  | 'exhausted'
  | 'awaiting_review'
  | 'awaiting_human'

export type SchedulerState = LegacyTaskMechanicsState

/** D6/Q5 compatibility: a historical NULL owner is deliberately not the
 * literal system account and therefore carries no permissions. */
const OWNERLESS_SYSTEM_USER_ID = '__system__'
const OWNERLESS_LEGACY_ACTOR: Actor = Object.freeze({
  user: Object.freeze({
    id: OWNERLESS_SYSTEM_USER_ID,
    username: OWNERLESS_SYSTEM_USER_ID,
    displayName: OWNERLESS_SYSTEM_USER_ID,
    role: 'user',
    status: 'active',
  }),
  source: 'daemon',
  permissions: new Set<Permission>(),
  authorityRevision: 0,
})

async function delegatedCallActor(
  state: SchedulerState,
  kind: 'call-workflow' | 'call-workgroup',
  ownerUserId: string | null,
  parentNodeRunId: string,
): Promise<Actor | null> {
  if (ownerUserId === null) return OWNERLESS_LEGACY_ACTOR
  const delegated = state.opts.identityAccess?.delegatedRequests
  if (delegated === undefined) throw new Error('identity-access-runtime-not-composed')
  const admission = await delegated.forCall({
    kind,
    ownerUserId,
    parentTaskId: state.taskId,
    parentNodeRunId,
  })
  return (admission?.actor as unknown as Actor | undefined) ?? null
}

/** RFC-282 C1-2 — config binary fallbacks for the mint-time freeze. Read at
 *  freeze time (same read-current family as the old per-entry resolution),
 *  then immutable on the node_run row. */
/** Required production entrypoint: callers must provide the complete topology. */
// RFC-332 W2-B: task-level hydrate/claim/engine-selection/settle moved to
// composition/taskEngineApplication.ts. This file owns the concrete non-wrapper
// node mechanics reached through the closed RFC-334 executor registry.
// -----------------------------------------------------------------------------
// RFC-164 — workgroup engine integration. The engine (workgroupRunner.ts) owns
// orchestration; this hook owns the MECHANICS of one host-node run, copied
// from the fanout-shard dispatch path (iso worktree + frozen runtime +
// runNode + merge-back + clarify session). Kept here so workgroupRunner never
// imports scheduler.ts (module-cycle ban — binary-build incident memory).
// -----------------------------------------------------------------------------

export async function executeWorkgroupHostMechanics(
  state: SchedulerState,
  req: WorkgroupHostRunRequest,
  collaboration: CollaborationNodeGatePort,
): Promise<WorkgroupHostRunResult> {
  const { db, taskId, task, opts, log, definition } = state
  const injection = await resolveInjection(db, req.agent, { appHome: opts.appHome, log })
  if (injection.kind === 'failed') {
    await setNodeRunStatus({
      db,
      nodeRunId: req.nodeRunId,
      to: 'failed',
      allowedFrom: ['pending'],
      reason: 'wg-injection-failed',
      extra: { finishedAt: Date.now(), errorMessage: injection.message },
    })
    broadcastNodeStatus(taskId, req.nodeRunId, req.nodeId, 'failed')
    return { status: 'failed', outputs: {}, errorMessage: injection.message }
  }

  let iso: IsoHandle
  // RFC-210 impl-gate A1-fix (review round 2): a merge/snapshot THROW keeps
  // the iso. The publish path hard-fails BEFORE the node tree is persisted,
  // so entry replay has nothing to work from and the iso can hold the sole
  // copy of the run's submodule work.
  // RFC-287 T6：本线改走骨架。它是五条里处置最全的一条——四种跳合并/覆写全用到。
  // 切法：spawn **把早退结局原样打包传出**（判别式返回），骨架只管相位与清理，
  // 从而不必重构 spawn 之后那段带多处早退的分支（clarify 停靠两种结局、canceled、
  // 非 done），逐字保住其语义。
  let keepHookIso = false
  let hookIso: IsoHandle | null = null
  type HostSpawn =
    | { kind: 'early'; out: WorkgroupHostRunResult }
    | { kind: 'ran'; result: RunResult; projected: Record<string, string> }
  return await runAssembly<Record<string, never>, HostSpawn, WorkgroupHostRunResult>(
    {},
    {
      // RFC-208：许可由骨架自己取自己放——外面先抢再传进来会留出「抢到许可 ~
      // 进 runAssembly」这段无人兜底的窗口。全五条线同一口径。
      pools: [state.agentSem],
      iso: {
        create: async () => {
          hookIso = await createIsoUnderLock({
            writeSem: state.writeSem,
            appHome: opts.appHome,
            taskId,
            db,
            isoKeyRunId: req.nodeRunId,
            canonRepos: state.repos,
            log,
          })
          iso = hookIso
          return hookIso
        },
        persistBase: 'in-setup',
        persist: async (h: IsoLike) => {
          if (!h.passthrough) await persistIsoBase(db, req.nodeRunId, task.repoCount, iso)
        },
      },
      onIsoSetupFailure: (err) => {
        const message = err instanceof Error ? err.message : String(err)
        log.warn('workgroup host-node iso setup failed', { nodeRunId: req.nodeRunId, message })
        return { status: 'failed', outputs: {}, errorMessage: `iso-setup-failed: ${message}` }
      },
      spawn: async (): Promise<HostSpawn> => {
        const frozen = await resolveFrozenRuntime(
          db,
          req.nodeRunId,
          req.agent.runtime,
          opts.defaultRuntime,
          null,
          freezeBinaryConfig(opts.configPath),
        )
        // Round-trip a human's answered clarify back to the workgroup LEADER.
        // When the leader host run is a `clarify-answer` rerun — it asked a human
        // via <workflow-clarify>, the human answered, and the STANDARD dispatch
        // minted this pending row (nodeId=__wg_leader__, cause='clarify-answer')
        // which workgroupRunner adopts as req.nodeRunId — buildClarifyQueueContext
        // returns the flat `## Clarify Q&A` block. renderUserPrompt emits it in
        // `sections`, independent of the workgroup protocol block that owns
        // `trailing`, and the 'delegated' directive (RFC-183) keeps the run out
        // of mandatory clarify-only mode. Without it the leader never sees the answers
        // it asked for and re-asks / proceeds on wrong assumptions (Codex review 1
        // P1 — the workgroup half of the RFC-023 round-trip was unwired).
        //
        // LEADER-ONLY (Codex review 2 P1): selectAgentQueue selects AND ages purely
        // by consumerNodeId with NO shardKey scoping (clarifyQueue.ts). The leader
        // is a singleton host node (shardKey=null), so its queue is unambiguous.
        // But EVERY member assignment shares the one __wg_member__ node (separated
        // only by node_runs.shard_key), so injecting there would cross-contaminate
        // — member B's run would receive member A's answered Q&A and B's output
        // would age A's queue. Member human-clarify round-trip therefore needs
        // shardKey-scoped queue selection (a change to the shared clarify
        // machinery) and stays deferred; a member's answers simply don't return
        // yet (no corruption, unlike the unscoped inject).
        // RFC-172 (route 2, R2-T7): round-trip the human's answered clarify back to ANY host node
        // (leader or member), SCOPED to this run's shard. On a clarify-answer rerun the dispatch minted
        // this pending row on the asking run's own shard (S0–S3); passing that shard to
        // buildClarifyQueueContext makes selectAgentQueue (R2-T3) isolate the queue per assignment.
        // A leader run is shardKey=null → pass `undefined` (node-scoped = exact pre-route-2 leader
        // behavior); a member run passes its assignment shard so concurrent members never inject each
        // other's Q&A. Fresh (non-answer) turns get an empty queue → no injection.
        const runRow = (
          await db
            .select({ shardKey: nodeRuns.shardKey, envelopeNonce: nodeRuns.envelopeNonce })
            .from(nodeRuns)
            .where(eq(nodeRuns.id, req.nodeRunId))
            .limit(1)
        )[0]
        const runShardKey = runRow?.shardKey ?? null
        const clarifyQueue = await buildClarifyQueueContext({
          db,
          definition,
          taskId,
          consumerNodeId: req.nodeId,
          dispatchedRunId: req.nodeRunId,
          shardKey: runShardKey === null ? undefined : runShardKey,
          iteration: 0,
          envelopeNonce: runRow?.envelopeNonce ?? '',
        })
        // RFC-184: workgroup host runs project the member agent's outputs to the
        // role's wg_* protocol ports and clear outputKinds, so runNode parses/
        // returns the wg ports and never validates the member's own business
        // output kinds (F42SE root cause). resolveInjection above already
        // ran on the ORIGINAL req.agent (skills/mcp/deps are unaffected by this
        // projection). Dynamic orchestrator runs leave hostOutputPorts unset →
        // no projection (design.md §2.2/§2.4).
        const hostAgent =
          req.hostOutputPorts !== undefined
            ? { ...req.agent, outputs: req.hostOutputPorts, outputKinds: undefined }
            : req.agent
        const result = await runNode({
          taskId,
          nodeRunId: req.nodeRunId,
          nodeId: req.nodeId,
          agent: hostAgent,
          triggerContext: null,
          // RFC-184 §2.4: host runs never persist their protocol ports into
          // node_run_outputs (they'd trip clarify-aging runIdsWithOutput).
          ...(req.hostOutputPorts !== undefined
            ? { persistDeclaredOutputs: false, warnMissingDeclaredPorts: false }
            : {}),
          runtime: frozen.protocol,
          runtimeBinary: frozen.binary,
          runtimeParams: frozen.params,
          runtimeConfigDir: frozen.configDir,
          inputs: {},
          worktreePath: iso.repos[0]?.isoWorktreePath ?? task.worktreePath,
          gitUserName: task.gitUserName,
          gitUserEmail: task.gitUserEmail,
          templateMeta: {
            repoPath: iso.repos[0]?.isoWorktreePath ?? task.repoPath,
            baseBranch: task.baseBranch,
            taskId,
            nodeId: req.nodeId,
            repos: iso.repos.map((r, i) => ({
              repoPath: r.repoPath,
              worktreePath: r.isoWorktreePath,
              worktreeDirName: r.worktreeDirName,
              // RFC-248: 同上——`{{__repo_names__}}` 要渲染挂载路径。
              mountPath: state.repos[i]?.mountPath ?? r.worktreeDirName,
              baseBranch: r.baseBranch,
            })),
          },
          promptTemplate: req.promptTemplate,
          // Workgroup turns and the dynamic-workflow orchestrator hand us a
          // COMPLETE framework-composed prompt. Its fenced goal/charter/messages
          // are data, not a second workflow template: preserving this boundary
          // keeps literal `{{token}}` text byte-for-byte.
          expandPromptTemplate: false,
          ...(req.workgroupProtocolBlock !== undefined
            ? { workgroupProtocolBlock: req.workgroupProtocolBlock }
            : {}),
          ...(opts.defaultPerNodeTimeoutMs !== undefined
            ? { timeoutMs: opts.defaultPerNodeTimeoutMs }
            : {}),
          // Voluntary ask-back: the channel is wired (host snapshot) but never
          // mandatory — workgroup members produce wg_result unless they choose
          // to ask a human (design §5). RFC-183: directive 'delegated' — BOTH
          // the invite (WG_CLARIFY_BLOCK inside the workgroup protocol block,
          // only when the group is not autonomous) and the acceptance verdict
          // live OUTSIDE the ADT, so the runner's directive-driven reject
          // (which now fires on 'suppressed') must not apply here.
          // RFC-181 C (impl-gate P1/P2): suppression is NOT a dispatch-frozen
          // directive — the per-task PATCH can flip `autonomous` mid-run in
          // EITHER direction, so runNode resolves the oracle below at ENVELOPE
          // time (live both ways) and closes a suppressed run as
          // failed:clarify-forbidden BEFORE terminal persistence.
          clarifyChannel: { kind: 'self', directive: 'delegated', injectStopNotice: false },
          ...(req.clarifyEnabled !== undefined
            ? {
                clarifySuppressed: () =>
                  // RFC-207 §3.4a — dispatch-time floor. This turn's prompt carried no
                  // ask-back invite, so it must not be allowed to ask merely because the
                  // roster gained a human while it was running; the new human takes
                  // effect from the NEXT turn. The live read handles the other
                  // direction (a human leaving mid-flight must silence it at once).
                  req.clarifyEnabled === false
                    ? Promise.resolve(true)
                    : isTaskClarifySuppressed(db, taskId, req.nodeId, runShardKey),
              }
            : {}),
          ...(clarifyQueue !== undefined
            ? { clarifyContext: { flatBlock: clarifyQueue.block } }
            : {}),
          skills: injection.spec.skills,
          dependents: injection.spec.dependents,
          mcps: injection.spec.mcps,
          plugins: injection.spec.plugins,
          appHome: opts.appHome,
          ...(opts.binaryOverride ? { binaryOverride: opts.binaryOverride } : {}),
          db,
          log,
          ...(opts.signal ? { signal: opts.signal } : {}),
          ...(opts.subagentLiveCapture !== undefined
            ? { subagentLiveCapture: opts.subagentLiveCapture }
            : {}),
        })
        const early = await (async (): Promise<WorkgroupHostRunResult | null> => {
          if (result.processUnreaped === true) keepHookIso = true
          broadcastNodeStatus(taskId, req.nodeRunId, req.nodeId, result.status)
          if (result.status === 'canceled') {
            return {
              status: 'canceled',
              outputs: {},
              ...(result.errorMessage !== undefined ? { errorMessage: result.errorMessage } : {}),
              ...(result.processUnreaped === true ? { processUnreaped: true as const } : {}),
            }
          }
          if (result.clarify !== undefined) {
            // RFC-181 C — a clarify envelope survived runNode's envelope-time
            // oracle (resolver said "allowed" when it fired). The toggle can still
            // land BETWEEN that read and the session insert below (impl-gate
            // P1-③), so: (a) one fresh pre-create check narrows the window; (b)
            // the post-create compensation after the insert closes it — both
            // return the same suppressed failure the workgroup runner re-prompts
            // on. The row is already terminal `done` here (valid clarify keeps
            // status=done), hence the allowTerminal correction so the DB row, the
            // broadcast and the RFC-182 room card all tell the truth.
            const lateSuppress = async (): Promise<WorkgroupHostRunResult> => {
              const dropped = result.clarify?.questions.length ?? 0
              const suppressedMsg = `${CLARIFY_FORBIDDEN_PREFIX}: ask-back disabled mid-run (autonomous); dropped ${dropped} question(s)`
              await setNodeRunStatus({
                db,
                nodeRunId: req.nodeRunId,
                to: 'failed',
                allowedFrom: ['done'],
                allowTerminal: true,
                reason: 'wg-clarify-suppressed-late',
                extra: {
                  finishedAt: Date.now(),
                  errorMessage: suppressedMsg,
                  failureCode: 'clarify-forbidden',
                },
              })
              broadcastNodeStatus(taskId, req.nodeRunId, req.nodeId, 'failed')
              // failureCode mirrors the DB column so the engine's soft-reject branch
              // routes structurally (RFC-145: errorMessage is human breadcrumbs, never
              // a machine key) — without it this late path forced a startsWith match.
              return {
                status: 'failed',
                outputs: {},
                errorMessage: suppressedMsg,
                failureCode: 'clarify-forbidden',
              }
            }
            if (
              req.clarifyEnabled !== undefined &&
              (await isTaskClarifySuppressed(db, taskId, req.nodeId, runShardKey))
            ) {
              return await lateSuppress()
            }
            // RFC-172 (route 2, R2-T7): human ask-back is now enabled for EVERY workgroup host node
            // (leader AND members), no longer leader-only. The dispatch/mint pipeline (S0–S3) mints each
            // member's clarify-answer rerun on ITS OWN shard, and selectAgentQueue (R2-T3) + the run's
            // shardKey passed to buildClarifyQueueContext below scope the queue per assignment — so a
            // member's answer round-trips to its own run with no cross-contamination between concurrent
            // members and no dangling `processing` entry. (The interim reject that guarded the unwired
            // member path — a failed result with a not-supported error — is removed.)
            const clarifyNodeId = findClarifyNodeForAgent(definition, req.nodeId)
            if (clarifyNodeId === undefined) {
              return { status: 'failed', outputs: {}, errorMessage: 'clarify-no-channel' }
            }
            const currentRunRow = (
              await db.select().from(nodeRuns).where(eq(nodeRuns.id, req.nodeRunId)).limit(1)
            )[0]
            // RFC-172 (route 2, R2-T6): host clarify GENERATION — count this (node, iteration, shard)'s
            // prior DONE clarify generations (shardKey-aware; mirrors the normal-node path ~scheduler.ts
            // 3540) instead of the old hardcoded 0. A host run (leader OR member) asking a SECOND round
            // otherwise shares the first round's clarify node_run (findClarifyNodeRunForShard is
            // idempotent on iterationIndex → its questions overwrite the first's and selectAgentQueue's
            // per-origin resolve turns ambiguous). shardKey-scoped so concurrent members count only
            // their OWN prior generations.
            const askingGeneration = currentRunRow
              ? (
                  await priorDoneGenerationsForRun(db, {
                    taskId,
                    nodeId: req.nodeId,
                    iteration: currentRunRow.iteration,
                    shardKey: currentRunRow.shardKey ?? null,
                    id: currentRunRow.id,
                  })
                ).length
              : 0
            await collaboration.openAgentClarify({
              kind: 'self',
              taskId,
              askingNodeId: req.nodeId,
              askingNodeRunId: req.nodeRunId,
              askingShardKey: currentRunRow?.shardKey ?? null,
              intermediaryNodeId: clarifyNodeId,
              iteration: askingGeneration,
              questions: result.clarify.questions,
              ...(result.clarify.truncationWarnings.length > 0
                ? { truncationWarnings: result.clarify.truncationWarnings }
                : {}),
            })
            // RFC-181 C impl-gate P1-③ — close the check→insert TOCTOU: a toggle
            // that landed between the pre-create read and the insert above left a
            // session A2 never saw (the PATCH-side dismissal ran against an empty
            // set). Re-check AFTER the insert and compensate through the same A2
            // primitive — idempotent against a concurrent PATCH-side dismissal
            // (both CAS on awaiting_human, the loser no-ops).
            if (
              req.clarifyEnabled !== undefined &&
              (await isTaskClarifySuppressed(db, taskId, req.nodeId, runShardKey))
            ) {
              const dismissed = await dismissOpenClarifyParksForAutonomous(db, taskId)
              // 182 impl-gate P1 — only rewrite the asking run when the dismissal
              // actually took the session down. Zero dismissals means an answer
              // beat this re-check (session already answered / continuation
              // minted): flipping done→failed then would show「已回答并续跑」and
              //「反问已压制」on the SAME turn. The answer won — keep the normal
              // awaiting result (status quo ante for that race).
              if (dismissed.dismissedSessions > 0) return await lateSuppress()
            }
            return {
              status: 'awaiting',
              outputs: {},
              clarifyQuestionCount: result.clarify.questions.length,
            }
          }
          if (result.status !== 'done') {
            return {
              status: 'failed',
              outputs: {},
              errorMessage: result.errorMessage ?? `run-${result.status}`,
              // RFC-185 e2e hardening — carry the structured code so the workgroup
              // engine can route envelope-missing into its protocol-retry channel
              // (RFC-145 ratchet: never route on errorMessage text).
              ...(result.failureCode !== undefined ? { failureCode: result.failureCode } : {}),
              ...(result.processUnreaped === true ? { processUnreaped: true as const } : {}),
            }
          }
          return null
        })()
        // RFC-184 §2.3: a projected host run's declared-but-omitted wg_* ports come
        // back as '' (parseEnvelope materializes them). Drop those so the workgroup
        // runner's `outputs[port] !== undefined` required/optional checks see
        // "omitted" (undefined), not an empty string that would fail JSON.parse and
        // be mis-flagged a protocol violation. No-op when not a host run.
        const projectOutputs = (outputs: Record<string, string>): Record<string, string> =>
          req.hostOutputPorts !== undefined
            ? Object.fromEntries(Object.entries(outputs).filter(([, v]) => v !== ''))
            : outputs
        if (early !== null) return { kind: 'early', out: early }
        return { kind: 'ran', result, projected: projectOutputs(result.outputs) }
      },
      keepFromOutcome: (s) => s.kind === 'ran' && s.result.processUnreaped === true,
      mergePhase: (_c, s) => {
        if (s.kind === 'early') {
          // clarify 停靠 / canceled / 非 done：结局已在窗口内产出，keep 由 spawn
          // 里既有的 keepHookIso 赋值决定（processUnreaped 那一维经 keepFromOutcome）。
          return { skip: 'park', keep: keepHookIso, then: { produce: async () => s.out } }
        }
        if (!(iso as IsoHandle).passthrough && req.discardWrites === true) {
          // RFC-167 (Codex impl-gate P1): the orchestrator GENERATION run must
          // never mutate the canonical worktree — validation and the human
          // confirm gate happen AFTER this run, so even a syntactically perfect
          // (let alone malformed or later-rejected) attempt's worktree writes
          // are dropped wholesale. The iso row closes as 'abandoned' (this
          // generation's delta never reaches canonical — exactly the abandon
          // semantics), so runTask-entry replays can never materialize it;
          // discardNodeIso in the finally removes the worktree itself.
          return {
            skip: 'abandon',
            keep: false,
            then: {
              produce: async () => {
                await tryTransitionMergeState({
                  db,
                  nodeRunId: req.nodeRunId,
                  event: { kind: 'abandon', reason: 'discard-writes' },
                })
                return { status: 'done' as const, outputs: s.projected }
              },
            },
          }
        }
        if ((iso as IsoHandle).passthrough) {
          return { skip: 'passthrough', keep: keepHookIso, then: 'settle' }
        }
        return 'merge'
      },
      mergeBack: {
        run: async () => {
          const merge = await (async (): Promise<MergeSettleOutcome> => {
            return await mergeBackAndSettle({
              db,
              writeSem: state.writeSem,
              handle: iso as IsoHandle,
              nodeRunId: req.nodeRunId,
              repoCount: task.repoCount,
              via: 'live',
              conflictResolver: (conflicts, containerPath) =>
                resolveMergeConflicts(state, {
                  conflicts,
                  containerPath,
                  conflictNodeRunId: req.nodeRunId,
                  nodeId: req.nodeId,
                  iteration: 0,
                }),
              log,
            })
            return merge
          })()
          return merge
        },
        disposition: {
          // RFC-187 T8：本线的 finally 无条件清理 iso，许不起「留着给人解」的承诺；
          // 留状态不留树会让下次 resume 去找已 GC 的提交并打挂整个任务。故 abandon。
          onConflictHuman: (detail) => ({
            keep: false,
            produce: async () => {
              await tryTransitionMergeState({
                db,
                nodeRunId: req.nodeRunId,
                event: { kind: 'abandon', reason: 'wg-merge-conflict-unresolved' },
              })
              return {
                status: 'failed',
                outputs: {},
                errorMessage: `merge-back-conflict (merge agent could not resolve): ${detail}`,
              }
            },
          }),
          // 刻意的 per-site 差异：抛出保留 iso 并**重抛**，merge_state 留在
          // pending-merge 交给 entry replay——与 DAG 各线的 markMergeFailed 相反。
          onThrow: () => ({ keep: true, then: 'rethrow' as const }),
        },
      },
      onUnhandledThrow: (err) => {
        const msg = err instanceof Error ? err.message : String(err)
        log.error('workgroup host-node run failed', { nodeRunId: req.nodeRunId, error: msg })
        return { status: 'failed', outputs: {}, errorMessage: msg }
      },
      discardIso: async (h: IsoLike) => {
        await discardNodeIso(h as IsoHandle, log, state.writeSem)
      },
      settle: async (_c, s) =>
        s.kind === 'ran'
          ? { status: 'done', outputs: s.projected }
          : { status: 'failed', outputs: {}, errorMessage: 'unreachable' },
      log,
    },
  )
}

export function buildWorkgroupEngineSupport(
  state: SchedulerState,
): Omit<WorkgroupEngineHooks, 'runHostNode'> {
  const { taskId } = state
  return {
    broadcastNodeStatus: (nodeRunId, nodeId, status) =>
      broadcastNodeStatus(taskId, nodeRunId, nodeId, status as NodeStatus),
    // RFC-187 §4 — canonical delta for the zero-delta-done warn. Throws (engine
    // swallows) when there's no base commit to diff against.
    // RFC-187 §4 (Codex impl-gate P1) — sum the delta over EVERY canonical repo at its
    // own worktree/base. The old form diffed `task.worktreePath`, which for a multi-repo
    // task is a NON-git parent container: git threw, `warnIfZeroDeltaDone` swallowed it,
    // and the zero-delta warning silently never fired for multi-repo tasks at all.
    // Single-repo is unchanged (repos[0].worktreePath === task.worktreePath).
    getCanonicalFilesChanged: async () => {
      const diffable = state.repos.filter((r) => r.baseCommit !== null)
      if (diffable.length === 0) {
        throw new Error('no base commit on any repo — cannot compute canonical delta')
      }
      const perRepo = await Promise.all(
        diffable.map((r) => worktreeFilesChanged(r.worktreePath, r.baseCommit as string)),
      )
      return perRepo.reduce((sum, n) => sum + n, 0)
    },
  }
}

// -----------------------------------------------------------------------------
// RFC-042 — same-session envelope follow-up decision.
//
// When an attempt fails with a recognized envelope-format error (none / both /
// clarify-malformed) AND opencode itself exited cleanly AND we captured a
// session id AND the model emitted at least one text line, the next retry
// attempt should resume the SAME opencode session and send a short follow-up
// prompt (see shared `renderEnvelopeFollowupPrompt`) rather than rolling back
// to the pre-snapshot and starting from scratch. Any other failure shape —
// non-zero exit / crash / timeout / no session id captured / no text produced
// / non-envelope errorMessage — falls back to the legacy fresh-session retry
// path (rollback + new spawn).
//
// Pure function intentionally — easy to unit-test the 8-case truth table
// without standing up the whole scheduler.
// -----------------------------------------------------------------------------

export interface PreviousAttemptShape {
  status: 'done' | 'failed' | 'canceled' | null
  exitCode: number | null
  /**
   * RFC-145: the machine-readable failure taxonomy the runner declared at its
   * stamp point (persisted on `node_runs.failure_code`). Replaces the old
   * errorMessage-prefix parsing — errorMessage is human breadcrumbs only and
   * is deliberately NOT part of this shape anymore. NULL = no follow-up-able
   * failure (legacy rows were backfilled by migration 0077).
   */
  failureCode: FailureCode | null
  sessionId: string | null
  /** Count of `kind='text'` rows the runner persisted for the previous run. */
  agentTextCount: number
  /**
   * RFC-049: structured port-validation failures the previous attempt's
   * runner persisted to `node_runs.port_validation_failures_json`. Defaults
   * to undefined; callers that have the JSON-parsed array can thread it
   * through here so the scheduler can route per-kind repair text via
   * `composePerKindRepairBlocks`. When failureCode is 'port-validation-failed'
   * but this field is missing (e.g. legacy rows pre-RFC-049 / malformed JSON
   * degraded by parsePortValidationFailuresJson), the followup still fires but
   * `failures` in the decision is an empty array — degraded mode: prompt still
   * nudges the agent, just without per-port specifics.
   */
  portValidationFailures?: ReadonlyArray<{
    port: string
    kind: string
    subReason: string
    detail?: string
  }>
}

/**
 * RFC-042 的续跑判定结论。
 *
 * RFC-334 起它就是 TaskExecution 的 `EnvelopeFollowupOutcome` 本身，不再在
 * scheduler 里重述一遍结构。`decideRetryShape`（形状判定）与该值同属
 * task-execution/domain；渲染域 `reason` 与 `failures` 元素仍复用 shared 契约。
 */
export type EnvelopeFollowupDecision = EnvelopeFollowupOutcome

/**
 * RFC-145: table lookup replaces the old 7-branch order-sensitive
 * errorMessage-startsWith chain. The runner declares `failureCode` at the
 * same stamp that writes errorMessage; FOLLOWUP_POLICY (shared/prompt.ts)
 * projects the 7-value producer domain onto the 6-value render reason —
 * including the previously implicit clarify-forbidden → envelope-missing
 * downgrade, now an explicit table row. Order sensitivity is gone: the
 * runner distinguishes malformed-port vs port-validation at the source
 * (parse layer vs validation layer — mutually exclusive by construction).
 */
/**
 * RFC-313 实现门 P1-2 —— 框架自写的 `kind='text'` 审计事件的统一载荷前缀。
 *
 * 它们（`[rfc042/envelope-followup]` / `[rfc049/port-validation-followup]` /
 * `[rfc313/session-restart]`）与模型输出共用 `kind='text'`，因此「这一轮模型说过话吗」
 * 的计数必须把它们排除，否则判据恒真。三个 producer 与本前缀的一致性由
 * `packages/backend/tests/rfc313-source-locks.test.ts` 断言。
 */
export const FRAMEWORK_AUDIT_EVENT_PREFIX = '[rfc'

/**
 * RFC-313 实现门 P1-2 —— 「这一轮模型自己说过话吗」的计数。
 *
 * 抽成函数而不是内联查询，是为了让它**可直测**：内联在 `runOneNode` 闭包里的版本只能
 * 靠源码锁间接保护，而这条判据一旦失真，RFC-042 的续跑判据与 RFC-313 的形状判定会一起
 * 走偏（详见 {@link FRAMEWORK_AUDIT_EVENT_PREFIX}）。
 */
export async function countAgentTextEvents(db: DbClient, nodeRunId: string): Promise<number> {
  const row = await db
    .select({ c: sql<number>`count(*)` })
    .from(nodeRunEvents)
    .where(
      and(
        eq(nodeRunEvents.nodeRunId, nodeRunId),
        eq(nodeRunEvents.kind, 'text'),
        notLike(nodeRunEvents.payload, `${FRAMEWORK_AUDIT_EVENT_PREFIX}%`),
      ),
    )
  return Number(row[0]?.c ?? 0)
}

export function decideEnvelopeFollowup(prev: PreviousAttemptShape): EnvelopeFollowupDecision {
  if (prev.status !== 'failed') return { followup: false }
  if (prev.exitCode !== 0) return { followup: false }
  if (prev.sessionId === null || prev.sessionId === '') return { followup: false }
  if (prev.agentTextCount <= 0) return { followup: false }
  if (prev.failureCode === null) return { followup: false }
  const policy = followupPolicyForFailure(prev.failureCode)
  if (policy === undefined) return { followup: false }
  return {
    followup: true,
    reason: policy.reason,
    failures:
      prev.failureCode === 'port-validation-failed' ? (prev.portValidationFailures ?? []) : [],
  }
}

export function shouldRetryNodeFailure(
  failureCode: FailureCode | null | undefined,
  processUnreaped = false,
): boolean {
  // A fresh native session id does not conflict with the old id's lease. If
  // the old child may still be alive, retrying would therefore create two
  // writers in the same worktree even though both individual ids are leased.
  if (processUnreaped) return false
  // 2026-08-04 audit: a terminal error the RUNTIME reported about itself (auth
  // rejected, usage limit, gateway error) does not become true by replaying the
  // same inputs.
  if (failureCode === 'runtime-result-error') return false
  return true
}

// RFC-096: `buildFreshestSettledPerNode` moved to freshness.ts alongside the
// comparator (audit S-13 / WP-3).

// -----------------------------------------------------------------------------
// RFC-076 PR-B — deriveFrontier (the dispatch brain; PURE, and LIVE: runScope
// calls it every dispatch tick — the stale "currently UNWIRED / NOT yet called"
// claims removed by RFC-094, audit S-26).
// -----------------------------------------------------------------------------
//
// Re-derives the dispatchable frontier from node_runs each tick, replacing the
// batch model's mutable completed/remaining snapshot + rescan/recompute
// reconcile. Composes fix A's areTransitiveUpstreamsCompleted + PR-A's
// isDispatchable / wrapperHasFreshInnerWork, plus RFC-092's pending-anchor
// row-id release (mid-run clarify answer / review decision pickup, audit S-1).
// The row-ordering primitives (isFresherNodeRun / buildFreshestSettledPerNode)
// live in freshness.ts since RFC-096. Pure-function locks: derive-frontier.test.ts.

// -----------------------------------------------------------------------------
// per-node execution
// -----------------------------------------------------------------------------

export type OneNodeResult = LegacyNodeResult

export interface OneNodeArgs {
  node: WorkflowNode
  iteration: number
  log: Logger
}

// RFC-188: persistIsoBase / persistIsoNodeTree moved to isolatedAgentRun.ts
// (shared by all five assembly sites + replay) — imported above.

export function parseIsoJsonMap(s: string | null): Record<string, string> {
  if (s === null || s === '') return {}
  try {
    const o = JSON.parse(s) as unknown
    return o !== null && typeof o === 'object' ? (o as Record<string, string>) : {}
  } catch {
    return {}
  }
}

/** RFC-210 round 6 P2 — the run id that KEYS the physical iso (worktree path +
 *  ref namespaces), recovered from the persisted container path. A
 *  process-retry keeps the original row's iso (D17) while its DB row is the
 *  retry mint; falling back to the row id preserves pre-column-era rows. */
export function isoKeyOf(isoWorktreePath: string | null, rowId: string): string {
  if (isoWorktreePath === null || isoWorktreePath === '') return rowId
  const base = basename(isoWorktreePath)
  return base === '' ? rowId : base
}

/**
 * RFC-210 — read a node_run's persisted submodule topology back for replay.
 *
 * Defensive parse: a row that fails the schema is treated as ABSENT rather than
 * half-trusted. Absence matters — `replaySubmodulesMissing` below turns it into a
 * refusal instead of letting merge-back run parent-only, which for a gitlink both
 * sides moved silently resolves as "take theirs" and discards the sibling node's
 * submodule commits.
 */
export function parseIsoSubmodules(
  row: { isoSubmodulesJson: string | null; isoSubmodulesReposJson: string | null },
  repoCount: number,
): Record<
  string,
  {
    subBases: Record<string, string>
    poolDirs: Record<string, string>
    pendingSubResolves: string[]
  }
> {
  const raw = repoCount === 1 ? row.isoSubmodulesJson : row.isoSubmodulesReposJson
  if (raw === null || raw === '') return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (repoCount === 1) {
      const one = IsoSubmodulesSchema.safeParse(parsed)
      // `pendingSubResolves` MUST be carried through. Dropping it here (it used
      // to be filtered out by this very projection) left the fail-closed gate in
      // completeHumanResolvedConflict reading a permanently empty list on the
      // only production path that reaches it — replayConflictHumanResolutions.
      return one.success
        ? {
            '': {
              subBases: one.data.subBases,
              poolDirs: one.data.poolDirs,
              pendingSubResolves: one.data.pendingSubResolves ?? [],
            },
          }
        : {}
    }
    if (parsed === null || typeof parsed !== 'object') return {}
    const out: Record<
      string,
      {
        subBases: Record<string, string>
        poolDirs: Record<string, string>
        pendingSubResolves: string[]
      }
    > = {}
    for (const [dir, v] of Object.entries(parsed as Record<string, unknown>)) {
      const one = IsoSubmodulesSchema.safeParse(v)
      if (one.success)
        out[dir] = {
          subBases: one.data.subBases,
          poolDirs: one.data.poolDirs,
          pendingSubResolves: one.data.pendingSubResolves ?? [],
        }
    }
    return out
  } catch {
    return {}
  }
}

/**
 * RFC-130 §6.2 — attempt to auto-resolve merge-back conflict(s) with the built-in
 * merge agent. For each conflicted repo, spins a resolve-iso from the conflicted
 * merged tree and dispatches the merge agent there (as a child node_run under the
 * conflicting run, `cause='merge-resolve'`). The dispatch is a DIRECT `runNode`
 * call — it deliberately does NOT acquire a node-pool slot, because the caller
 * holds `writeSem` across §6.2 and a pool wait here would close the writeSem↔pool
 * cycle (§7 deadlock analysis). Framework self-checks the resolution (D6); on
 * success the resolution is materialized into the canonical worktree and the
 * resolve-iso discarded, on failure the resolve-iso is preserved for awaiting_human.
 *
 * Runtime: `resolveInternalAgentRuntime(mergeAgentRuntime → mergeAgentModel →
 * defaultRuntime)`. Threading `mergeAgentRuntime`/`mergeAgentModel` from config →
 * RunTaskOptions is a follow-up (mirrors commit&push Settings wiring); until then
 * the merge agent runs on the task's `defaultRuntime`.
 */
export async function resolveMergeConflicts(
  state: SchedulerState,
  opts: {
    conflicts: MergeBackConflict[]
    containerPath: string
    conflictNodeRunId: string
    nodeId: string
    iteration: number
  },
): Promise<{ allResolved: boolean; detail: string }> {
  const { db, task, log } = state
  const rt = await resolveInternalAgentRuntime(db, {
    runtimeName: state.opts.mergeAgentRuntime,
    deprecatedModel: state.opts.mergeAgentModel,
    defaultRuntime: state.opts.defaultRuntime,
  })
  const mergeNodeId = mergeResolveNodeId(opts.nodeId, opts.iteration)
  const runAgent = async (
    _legacyPrompt: string,
    cwd: string,
    manifest: MergeConflictManifest,
  ): Promise<void> => {
    const sessionRunId = await mintNodeRun(db, {
      taskId: task.id,
      nodeId: mergeNodeId,
      status: 'pending',
      cause: 'merge-resolve',
      iteration: opts.iteration,
      overrides: { parentNodeRunId: opts.conflictNodeRunId },
    })
    const frozen = await resolveFrozenRuntime(
      db,
      sessionRunId,
      null,
      null,
      {
        protocol: rt.protocol,
        binary: rt.binaryPath,
        params: {
          model: rt.model,
          variant: rt.variant,
          temperature: rt.temperature,
          steps: rt.steps,
          maxSteps: rt.maxSteps,
          isSandbox: rt.isSandbox,
        },
        configDir: rt.configDir, // RFC-154: frozen with the rest of the snapshot
      },
      // Codex impl-gate P1-2: same config-head fold as the commit-session site.
      freezeBinaryConfig(state.opts.configPath),
    )
    const envelopeNonce = await loadRunEnvelopeNonce(db, sessionRunId)
    const mergeAgent = buildMergeAgent()
    // RFC-282 B2 — single-resolver derivation (writeSem held: signal threaded).
    const mergeInjection = await resolveInjection(db, mergeAgent, {
      appHome: state.opts.appHome,
      log: log.child('merge'),
      ...(state.opts.signal ? { signal: state.opts.signal } : {}),
    })
    if (mergeInjection.kind === 'failed') {
      throw new Error(`merge injection resolve failed: ${mergeInjection.message}`)
    }
    // DIRECT runNode — bypasses the node pool on purpose (§7 deadlock avoidance).
    const mergeAgentResult = await runNode({
      taskId: task.id,
      nodeRunId: sessionRunId,
      nodeId: mergeNodeId,
      agent: mergeAgent,
      triggerContext: null,
      expandPromptTemplate: false,
      runtime: frozen.protocol,
      runtimeBinary: frozen.binary,
      runtimeParams: frozen.params,
      runtimeConfigDir: frozen.configDir, // RFC-154: frozen config-dir profile
      inputs: {},
      worktreePath: cwd,
      promptTemplate: buildMergeResolvePrompt({ manifest, envelopeNonce }),
      templateMeta: {
        repoPath: cwd,
        baseBranch: task.baseBranch,
        taskId: task.id,
        nodeId: mergeNodeId,
        iteration: opts.iteration,
        repos: state.repos,
        ...(state.repoGroupName !== null ? { repoGroupName: state.repoGroupName } : {}),
      },
      // RFC-282 B2 — same single-resolver derivation as commit-push above.
      skills: mergeInjection.spec.skills,
      dependents: mergeInjection.spec.dependents,
      mcps: mergeInjection.spec.mcps,
      plugins: mergeInjection.spec.plugins,
      appHome: state.opts.appHome,
      db,
      log: log.child('merge'),
      gitUserName: task.gitUserName,
      gitUserEmail: task.gitUserEmail,
      ...(state.opts.binaryOverride ? { binaryOverride: state.opts.binaryOverride } : {}),
      ...(state.opts.signal ? { signal: state.opts.signal } : {}),
      // RFC-208: this was the ONLY runNode call site without a timeout, and it
      // runs inside the per-task writeSem — so a merge agent that hangs blocks
      // every other writer for that task (review decisions, clarify dispatch)
      // with no SIGTERM→SIGKILL escalation ever armed. Same budget as every
      // other node.
      ...(state.opts.defaultPerNodeTimeoutMs !== undefined
        ? { timeoutMs: state.opts.defaultPerNodeTimeoutMs }
        : {}),
    })
    if (mergeAgentResult.processUnreaped === true) {
      throw new MergeAgentChildUnreapedError()
    }
  }
  let allResolved = true
  const parts: string[] = []
  for (const conflict of opts.conflicts) {
    const outcome = await resolveConflictWithAgent(conflict, {
      containerPath: opts.containerPath,
      runAgent,
      log,
    })
    if (!outcome.resolved) {
      allResolved = false
      // RFC-187 §4-2 — say what DID land: per-path salvage already
      // materialized the clean paths, so the park note must not read as
      // "the whole delta was dropped" (workgroup room note rides this).
      const salvageNote =
        conflict.salvagedPaths.length > 0
          ? ` (${conflict.salvagedPaths.length} clean path(s) already landed)`
          : ''
      parts.push(
        `${conflict.worktreeDirName || '(repo)'}: ${outcome.unresolved.map((e) => e.path).join(', ')}${salvageNote}`,
      )
    }
  }
  return { allResolved, detail: parts.join('; ') }
}

// =============================================================================
// RFC-243 §6.2 — call-workflow node: invoke another workflow as an independent
// child task running INSIDE this node's iso worktree. From the parent's
// perspective the node is agent-shaped: derive iso → run (the child task) →
// write outputs → merge back; conflict parking, merge_state gating, replay and
// GC all reuse the RFC-130 machinery. Recovery (daemon restart, reap) re-enters
// through the SAME function: the frontier redispatches the interrupted row and
// the adoption block decides attach / resume-child / finalize instead of
// re-launching (design §4.2 — minting here would abandonSupersededMergeStates
// the child's canonical iso generation, so adoption NEVER mints).
// =============================================================================

const CALL_CHILD_OBSERVE_MS = 5_000

/** Bounded wait proving a child's daemon-restart interrupt is this process going down. */
const SHUTDOWN_CONFIRM_MS = 2_000

interface CallLedger {
  callHumanWaitMs: number
  callHumanWaitSince: number | null
}

function parseCallLedger(json: string | null): CallLedger {
  if (json === null || json === '') return { callHumanWaitMs: 0, callHumanWaitSince: null }
  try {
    const o = JSON.parse(json) as { callHumanWaitMs?: unknown; callHumanWaitSince?: unknown }
    return {
      callHumanWaitMs:
        typeof o.callHumanWaitMs === 'number' && o.callHumanWaitMs >= 0 ? o.callHumanWaitMs : 0,
      callHumanWaitSince:
        typeof o.callHumanWaitSince === 'number' && o.callHumanWaitSince > 0
          ? o.callHumanWaitSince
          : null,
    }
  } catch {
    return { callHumanWaitMs: 0, callHumanWaitSince: null }
  }
}

export async function runCallWorkflowNode(
  state: SchedulerState,
  args: OneNodeArgs,
): Promise<OneNodeResult> {
  const { db, task, taskId, definition, opts, writeSem, log } = state
  const { node, iteration } = args
  const taskRow = task as unknown as {
    refClosureJson?: string | null
    /** RFC-271 T6e：v2 边键的 source —— 本任务正在跑的工作流 id。 */
    workflowId?: string | null
    invocationDepth?: number | null
    parentTaskId?: string | null
    ownerUserId?: string | null
  }

  const isWorkgroupCall = node.kind === 'call-workgroup'
  const selectorField = isWorkgroupCall ? 'workgroupName' : 'workflowName'
  const workflowName = pickString(node, selectorField) ?? undefined
  if (workflowName === undefined) {
    return {
      kind: 'failed',
      summary: `call node is missing its ${selectorField} selector`,
      message: 'workflow-call-ref-missing',
    }
  }
  // RFC-271 T6e：v2 闭包按边取（source = 本任务的工作流 id + 该 call 节点 id）；
  // v1 存量闭包由 accessor 内部回退到按名字取，**零迁移**。
  const callSource =
    typeof taskRow.workflowId === 'string' && taskRow.workflowId.length > 0
      ? { workflowId: taskRow.workflowId, nodeId: node.id }
      : undefined
  const frozen = isWorkgroupCall
    ? null
    : frozenWorkflowFromClosure(taskRow.refClosureJson ?? null, workflowName, callSource)
  const frozenGroup = isWorkgroupCall
    ? frozenWorkgroupFromClosure(taskRow.refClosureJson ?? null, workflowName, callSource)
    : null
  if ((isWorkgroupCall ? frozenGroup : frozen) === null) {
    return {
      kind: 'failed',
      summary: `${isWorkgroupCall ? 'workgroup' : 'workflow'} '${workflowName}' is missing from the frozen call closure`,
      message: 'workflow-call-ref-missing',
    }
  }

  const { inputs: upstreamInputs, consumed: consumedUpstream } = await resolveUpstreamInputs(
    db,
    taskId,
    definition.edges,
    node.id,
    iteration,
    log,
    definition,
    state.containerOf,
  )
  const consumedUpstreamJson = JSON.stringify(consumedUpstream)

  // ---- locate the row: adopt an in-flight/interrupted call row, else reuse
  // pending, else mint (agent-path idiom; fanout shard rows never reach here —
  // the validator rejects call nodes inside wrapper-fanout in v1).
  const sameNodeIterRuns = await db
    .select()
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.taskId, taskId),
        eq(nodeRuns.nodeId, node.id),
        eq(nodeRuns.iteration, iteration),
      ),
    )
    .orderBy(asc(nodeRuns.startedAt))
  let adoptedChildTaskId: string | null = null
  let launchedChildId: string | null = null
  let liveIso: IsoHandle | null = null
  // RFC-287 T8：取行前奏收编，但**领养区不进收编**——它复用一条 running /
  // interrupted / canceled 的行并就地转 running，与「铸行」是两码事（下面的
  // RFC-243-LOCK 说明为什么这里绝不能 mint）。以 preResolve 回调短路：拿到
  // latestExisting 后本线自己判领养，命中即整段前奏不执行。
  const resolvedCallRow = await resolveSchedulerRunRow({
    db,
    taskId,
    nodeId: node.id,
    iteration,
    consumedUpstreamJson,
    rows: sameNodeIterRuns,
    inheritReviewIteration: true,
    clearAgentOverride: true,
    trackRetryIndex: true,
    broadcastPending: (id) => broadcastNodeStatus(taskId, id, node.id, 'pending'),
    preResolve: async (latestExisting) => {
      // RFC-243-LOCK:adoption-no-mint-begin — this block re-attaches; minting
      // here would abandonSupersededMergeStates the child's canonical iso.
      // 实现门 P1-5：领养判据按「这一代是否已收尾」而不是单看 running/interrupted。
      // daemon shutdown 的收尾会把调用行落成 canceled（RFC-095 revival 语义下它
      // 仍是可复活行），只认 running/interrupted 会漏掉领养 → 重新 mint → 同一
      // 父任务下重复发起第二个子任务（rfc243-call-workflow 恢复矩阵实测）。
      // done/failed/exhausted 是已收尾代：retry 会 mint 新行，那条行 childTaskId
      // 为空，自然走下面的发起分支。
      const ADOPTABLE_CALL_ROW_STATUSES = new Set(['pending', 'running', 'interrupted', 'canceled'])
      if (
        latestExisting === undefined ||
        latestExisting.childTaskId === null ||
        latestExisting.childTaskId === undefined ||
        !ADOPTABLE_CALL_ROW_STATUSES.has(latestExisting.status)
      ) {
        return null
      }
      adoptedChildTaskId = latestExisting.childTaskId
      if (latestExisting.status !== 'running') {
        // Wrapper-revive escape hatch (RFC-053/095 precedent): the parked /
        // reaped / shutdown-canceled call row RESUMES in place — never a fresh
        // mint (see header).
        await setNodeRunStatus({
          db,
          nodeRunId: latestExisting.id,
          to: 'running',
          allowedFrom: ['pending', 'interrupted', 'canceled'],
          allowTerminal: true,
          reason: 'call-adoption',
        })
        broadcastNodeStatus(taskId, latestExisting.id, node.id, 'running')
      }
      log.info('call node adopted its in-flight child task', {
        nodeId: node.id,
        childTaskId: adoptedChildTaskId,
      })
      return { nodeRunId: latestExisting.id }
      // RFC-243-LOCK:adoption-no-mint-end
    },
  })
  const nodeRunId = resolvedCallRow.nodeRunId
  const latestExisting = resolvedCallRow.latestExisting
  if (!resolvedCallRow.adopted) {
    await transitionNodeRunStatus({ db, nodeRunId, event: { kind: 'mark-running' } })
    broadcastNodeStatus(taskId, nodeRunId, node.id, 'running')

    // ---- gates BEFORE side effects: depth, then the global child budget
    // (ancestor-exempt scan grants — §3.2; the wait holds NO locks).
    const maxDepth = currentMaxInvocationDepth(opts.maxInvocationDepth)
    const childDepth = (taskRow.invocationDepth ?? 0) + 1
    if (childDepth > maxDepth) {
      await failCallRow(
        db,
        taskId,
        nodeRunId,
        node.id,
        'invocation-depth-exceeded',
        `invocation depth ${childDepth} exceeds the configured ceiling ${maxDepth}`,
      )
      return {
        kind: 'failed',
        summary: `invocation depth ${childDepth} exceeds the configured ceiling ${maxDepth}`,
        message: 'invocation-depth-exceeded',
      }
    }
    const budget = await ensureChildTaskBudget(db, () => opts.maxActiveChildTasks ?? 8)
    const ancestors: string[] = [taskId]
    {
      let cursor = taskRow.parentTaskId ?? null
      while (cursor !== null && !ancestors.includes(cursor)) {
        ancestors.push(cursor)
        const row = await db
          .select({ parentTaskId: tasks.parentTaskId })
          .from(tasks)
          .where(eq(tasks.id, cursor))
          .get()
        cursor = row?.parentTaskId ?? null
      }
    }
    let hold: Awaited<ReturnType<typeof budget.acquire>>
    try {
      hold = await budget.acquire(ancestors, {
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      })
    } catch {
      await failCallRow(
        db,
        taskId,
        nodeRunId,
        node.id,
        'canceled',
        'canceled while queued for a child-task slot',
        'canceled',
      )
      return { kind: 'canceled', summary: 'task canceled', message: 'signal aborted' }
    }

    // ---- D: derive the child's workspace from THIS node's iso (slot first,
    // snapshot second — the agent path's slot-then-iso ordering, so a
    // long budget queue cannot serve the child a stale base).
    try {
      liveIso = await createIsoUnderLock({
        writeSem,
        appHome: opts.appHome,
        taskId,
        db,
        isoKeyRunId: nodeRunId,
        canonRepos: state.repos,
        log,
      })
    } catch (err) {
      hold.release()
      const msg = err instanceof Error ? err.message : String(err)
      await failCallRow(
        db,
        taskId,
        nodeRunId,
        node.id,
        'iso-setup-failed',
        `isolated worktree setup failed: ${msg}`,
      )
      return {
        kind: 'failed',
        summary: 'isolated worktree setup failed',
        message: 'iso-setup-failed',
      }
    }
    if (!liveIso.passthrough) await persistIsoBase(db, nodeRunId, task.repoCount, liveIso)
    const childIso: IsoHandle = liveIso

    // ---- L: launch the child through the executor facade. The child task id
    // is pre-minted so the call row's childTaskId stamp lands BEFORE the
    // child INSERT — a crash between the two surfaces as `child-deleted`
    // (dangling stamp) instead of a duplicate child on redispatch.
    const childId = ulid()
    withTaskExecutionMutation({
      db,
      taskId,
      run: (tx) =>
        tx.update(nodeRuns).set({ childTaskId: childId }).where(eq(nodeRuns.id, nodeRunId)).run(),
    })
    try {
      if (isWorkgroupCall) {
        await launchCallWorkgroupChild(state, {
          node,
          nodeRunId,
          childId,
          frozenGroup: frozenGroup!,
          workgroupName: workflowName,
          inputs: upstreamInputs,
          iso: childIso,
          childDepth,
          iteration,
          inheritedShardKey: latestExisting?.shardKey ?? null,
        })
      } else {
        await launchCallChild(state, {
          node,
          nodeRunId,
          childId,
          frozen: frozen!,
          workflowName,
          inputs: upstreamInputs,
          iso: childIso,
          childDepth,
        })
      }
      hold.bind(childId)
      registerKnownChildTask(childId)
      launchedChildId = childId
    } catch (err) {
      hold.release()
      withTaskExecutionMutation({
        db,
        taskId,
        run: (tx) =>
          tx.update(nodeRuns).set({ childTaskId: null }).where(eq(nodeRuns.id, nodeRunId)).run(),
      })
      await discardNodeIso(liveIso, log, writeSem)
      const code =
        err instanceof ValidationError || err instanceof DomainError || err instanceof NotFoundError
          ? err.code
          : 'child-launch-failed'
      const msg = err instanceof Error ? err.message : String(err)
      await failCallRow(db, taskId, nodeRunId, node.id, code, `child launch failed: ${msg}`)
      return { kind: 'failed', summary: `child launch failed: ${msg}`, message: code }
    }
  }
  if (adoptedChildTaskId === null && launchedChildId === null) {
    // unreachable — both arms either set an id or returned; guard for TS + drift.
    return {
      kind: 'failed',
      summary: 'call node resolved no child task',
      message: 'child-launch-failed',
    }
  }
  const childTaskId: string = adoptedChildTaskId ?? (launchedChildId as string)

  // ---- W: await the child's terminal state, keeping the §4.5 human-wait
  // ledger current (observed at CALL_CHILD_OBSERVE_MS granularity) and
  // re-driving an interrupted child once per observation (design §4.2 ②).
  // 实现门 P2-1 — the human-wait ledger belongs to ONE invocation generation:
  // adopt the persisted account only when re-attaching the SAME row; a fresh
  // mint (retry supersession) starts at zero, otherwise the superseded
  // generation's wait would be deducted twice (callRowHumanWait sums ALL call
  // rows of the task).
  let ledger =
    adoptedChildTaskId !== null
      ? parseCallLedger(latestExisting?.wrapperProgressJson ?? null)
      : parseCallLedger(null)
  const persistLedger = async (): Promise<void> => {
    try {
      withTaskExecutionMutation({
        db,
        taskId,
        run: (tx) =>
          tx
            .update(nodeRuns)
            .set({ wrapperProgressJson: JSON.stringify(ledger) })
            .where(eq(nodeRuns.id, nodeRunId))
            .run(),
      })
    } catch {
      // Best-effort progress telemetry; the child terminal observation remains authoritative.
    }
  }
  const observeChild = async (): Promise<void> => {
    const row = await db
      .select({ status: tasks.status })
      .from(tasks)
      .where(eq(tasks.id, childTaskId))
      .get()
    const awaiting =
      row !== undefined && (row.status === 'awaiting_review' || row.status === 'awaiting_human')
    const now = Date.now()
    if (awaiting && ledger.callHumanWaitSince === null) {
      ledger = { ...ledger, callHumanWaitSince: now }
      await persistLedger()
    } else if (!awaiting && ledger.callHumanWaitSince !== null) {
      ledger = {
        callHumanWaitMs: ledger.callHumanWaitMs + Math.max(0, now - ledger.callHumanWaitSince),
        callHumanWaitSince: null,
      }
      await persistLedger()
    }
  }

  let resumeAttempted = false
  let outcomeStatus: string
  for (;;) {
    const obsTimer = setInterval(() => {
      void observeChild().catch(() => {})
    }, CALL_CHILD_OBSERVE_MS)
    let watched: Awaited<ReturnType<typeof watchTaskTerminal>>
    try {
      watched = await watchTaskTerminal(db, childTaskId, {
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        pollMs: 20_000,
      })
    } finally {
      clearInterval(obsTimer)
      await observeChild().catch(() => {})
    }
    if (watched.kind === 'aborted') {
      const shutdown = isShutdownAbort(opts.signal)
      if (!shutdown) {
        // User cancel — cascade into the child (belt; cancelTask's own child
        // enumeration is the suspenders) and settle the row canceled.
        try {
          await state.topology.schedulerDriver.cancelChild({
            taskId: childTaskId,
            cascadeFromParent: true,
          })
        } catch (error) {
          // Preserve the legacy terminal/race tolerance without swallowing a
          // missing or broken topology adapter as cancellation success.
          if (
            !(
              (error instanceof ConflictError && error.code === 'task-not-cancelable') ||
              error instanceof NotFoundError
            )
          ) {
            throw error
          }
        }
        await failCallRow(db, taskId, nodeRunId, node.id, 'canceled', 'task canceled', 'canceled')
        return { kind: 'canceled', summary: 'task canceled', message: 'signal aborted' }
      }
      // Daemon shutdown: leave the row running — boot reap flips it to
      // interrupted and adoption re-attaches on resume (child stays revivable).
      return { kind: 'canceled', summary: 'daemon shutdown', message: 'signal aborted' }
    }
    if (watched.kind === 'missing') {
      await failCallRow(
        db,
        taskId,
        nodeRunId,
        node.id,
        'child-deleted',
        `child task '${childTaskId}' row disappeared before finalize`,
      )
      return {
        kind: 'failed',
        summary: `child task '${childTaskId}' was deleted before its result was consumed`,
        message: 'child-deleted',
      }
    }
    outcomeStatus = watched.status
    // 实现门 P1-5 实测缺陷：daemon 关停时子任务先落 `interrupted`，watch 因此
    // 以 terminal（而非 aborted）返回；若继续按终态映射，就会把「整机关停」
    // 误判成「子任务不可恢复」→ 调用行 failed → 父任务 failed（而非可恢复的
    // interrupted），resume 时该行已终态、不再被领养 → 重复发起第二个子任务、
    // 旧子任务沦为孤儿。关停期一律不收尾：保持行 running，交给 boot reap 翻
    // interrupted，由 resume 的 adoption 续上（design §4.2）。
    if (isShutdownAbort(opts.signal)) {
      return { kind: 'canceled', summary: 'daemon shutdown', message: 'signal aborted' }
    }
    if (outcomeStatus === 'interrupted' && !resumeAttempted) {
      // §4.2 ② — parent-driven child recovery (independent of autoResumeOnBoot).
      resumeAttempted = true
      try {
        // RFC-285 B3 Q6（用户拍板）：resume 是既有子任务行的执行延续，
        // **豁免** owner-inactive 检查——D7 边界只拦「新任务创建」两臂。
        const childRuntime = buildChildRuntime(state)
        await state.topology.schedulerDriver.resumeChild({
          taskId: childTaskId,
          runtime: childRuntime,
        })
        continue
      } catch (error) {
        // A missing/broken driver method is a composition defect, not a child
        // lifecycle race. Preserve the legacy re-read path for business
        // failures, but never disguise a TypeError as successful reattachment.
        if (error instanceof TypeError) throw error
        const fresh = await db
          .select({ status: tasks.status, errorSummary: tasks.errorSummary })
          .from(tasks)
          .where(eq(tasks.id, childTaskId))
          .get()
        if (
          fresh !== undefined &&
          !(TERMINAL_TASK_STATUSES as readonly string[]).includes(fresh.status)
        ) {
          continue // someone else revived it — re-attach
        }
        // 实现门 P1-5 加固：`task-active` means ANOTHER in-process driver still
        // owns the child (a shutdown still draining, a concurrent resume). Its
        // row may read terminal for the moment, but the owner is the authority
        // — re-attach and let the watch settle instead of declaring failure.
        if (state.topology.schedulerDriver.isTaskActive(childTaskId)) {
          await Bun.sleep(200)
          resumeAttempted = false
          continue
        }
        // 实现门 P1-5 实测缺陷（时序无关判据）：a child interrupted by the
        // DAEMON RESTART is not "unrecoverable" — the process is going down and
        // the parent's own row is about to be reaped to interrupted too.
        // Writing a terminal failure here would (a) fail the parent instead of
        // leaving it resumable and (b) drop the call row out of the adoption
        // set, so the next resume launches a SECOND child and orphans the
        // first. `opts.signal` is NOT a reliable discriminator — the child's
        // abort can land before the parent controller fires.
        if (
          fresh?.errorSummary === DAEMON_RESTART_ERROR_SUMMARY &&
          (await awaitShutdownAbort(opts.signal, SHUTDOWN_CONFIRM_MS))
        ) {
          return { kind: 'canceled', summary: 'daemon shutdown', message: 'signal aborted' }
        }
        await failCallRow(
          db,
          taskId,
          nodeRunId,
          node.id,
          'child-interrupted',
          `child task '${childTaskId}' is interrupted and could not be resumed`,
        )
        return {
          kind: 'failed',
          summary: `child task '${childTaskId}' is interrupted and could not be resumed`,
          message: 'child-interrupted',
        }
      }
    }
    break
  }

  // ---- terminal child → finalize. Non-done children map per design §6.2.
  const outcome = await getExecutionOutcome(db, childTaskId)
  if (outcome.status === 'canceled') {
    const cascade = outcome.error?.message === 'canceled-by-parent-cascade'
    if (cascade) {
      await failCallRow(
        db,
        taskId,
        nodeRunId,
        node.id,
        'canceled',
        'canceled with parent',
        'canceled',
      )
      return { kind: 'canceled', summary: 'task canceled', message: 'canceled-with-parent' }
    }
    await failCallRow(
      db,
      taskId,
      nodeRunId,
      node.id,
      'child-canceled',
      `child task '${childTaskId}' was canceled directly`,
    )
    return {
      kind: 'failed',
      summary: `child task '${childTaskId}' was canceled outside this parent`,
      message: 'child-canceled',
    }
  }
  if (outcome.status === 'interrupted') {
    // 实现门 P1-5（同一判据，终态映射侧）：daemon-restart 中断留给 boot reap
    // + adoption，绝不写成 call 行的终态失败。
    if (
      outcome.error?.summary === DAEMON_RESTART_ERROR_SUMMARY &&
      (await awaitShutdownAbort(opts.signal, SHUTDOWN_CONFIRM_MS))
    ) {
      return { kind: 'canceled', summary: 'daemon shutdown', message: 'signal aborted' }
    }
    await failCallRow(
      db,
      taskId,
      nodeRunId,
      node.id,
      'child-interrupted',
      `child task '${childTaskId}' stayed interrupted`,
    )
    return {
      kind: 'failed',
      summary: `child task '${childTaskId}' is interrupted and could not be resumed`,
      message: 'child-interrupted',
    }
  }
  if (outcome.status !== 'done') {
    const summary = outcome.error?.summary ?? `child task '${childTaskId}' failed`
    await failCallRow(
      db,
      taskId,
      nodeRunId,
      node.id,
      'child-task-failed',
      `${summary}${outcome.error?.message ? ` (${outcome.error.message})` : ''}`,
    )
    return {
      kind: 'failed',
      summary: `child task failed: ${summary}`,
      message: 'child-task-failed',
    }
  }

  // ---- F: copy the child's projected outputs onto the call row (idempotent —
  // the merge_state-staged replay re-enters here). archiveJson rides along so
  // forcedPortPathsForTask keeps covering child-produced gitignored files.
  // 实现门 P1-3 — a call-workgroup node declares EXACTLY one output (`result`).
  // dw-mode children project raw workflow ports; collapse them into `result`
  // (lexicographic `## name` sections, design §6.3) so the declared port is
  // never silently empty.
  const projectedOutputs: typeof outcome.outputs = isWorkgroupCall
    ? Object.hasOwn(outcome.outputs, 'result')
      ? { result: outcome.outputs.result! }
      : {
          result: {
            content: Object.entries(outcome.outputs)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([name, v]) => `## ${name}\n${v.content}`)
              .join('\n\n'),
            kind: 'text',
          },
        }
    : outcome.outputs
  for (const [portName, v] of Object.entries(projectedOutputs)) {
    // RFC-306 D17: a branch closed INSIDE the child keeps propagating in the
    // parent graph — the child's inactive port projects onto an inactive parent
    // port, so a reusable "decider" workflow can be called as a sub-workflow.
    const active = v.active !== false
    withTaskExecutionMutation({
      db,
      taskId,
      run: (tx) =>
        tx
          .insert(nodeRunOutputs)
          .values({
            nodeRunId,
            portName,
            content: v.content,
            kind: v.kind,
            archiveJson: v.archiveJson ?? null,
            active,
          })
          .onConflictDoUpdate({
            target: [nodeRunOutputs.nodeRunId, nodeRunOutputs.portName],
            set: { content: v.content, kind: v.kind, archiveJson: v.archiveJson ?? null, active },
          })
          .run(),
    })
  }
  // Row goes done BEFORE merge (runner precedent) — downstream still gates on
  // merge_state (deriveFrontier D15), so nothing dispatches early.
  const currentRow = await db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)).get()
  if (currentRow !== undefined && currentRow.status !== 'done') {
    await setNodeRunStatus({
      db,
      nodeRunId,
      to: 'done',
      allowedFrom: ['running'],
      extra: { finishedAt: Date.now() },
      reason: 'call-child-done',
    })
    broadcastNodeStatus(taskId, nodeRunId, node.id, 'done')
  }

  // ---- M: merge the iso (the child's canonical) back into the parent
  // canonical, staged by merge_state (design §4.2 R):
  //   merged         → outputs re-written above; nothing to merge.
  //   conflict-human → still parked; resume replay owns completion.
  //   pending-merge  → the task-entry replayPendingMerges already merged (or
  //                    will on next resume) — treat like merged here if it
  //                    settled, else leave for replay.
  //   isolating/null → live merge (snapshots the iso final state itself).
  const mergeStateNow = currentRow?.mergeState ?? null
  if (mergeStateNow === 'conflict-human') {
    return {
      kind: 'awaiting_human',
      summary: 'merge conflict awaiting human resolution',
      message: 'merge-conflict',
    }
  }
  if (mergeStateNow === null && liveIso === null) {
    // Passthrough/mock harness adoption: nothing persisted to merge.
    return { kind: 'ok', summary: `child task ${childTaskId} done`, message: '' }
  }
  if (mergeStateNow !== 'merged') {
    let handle = liveIso
    if (handle === null) {
      // Adoption after restart — rebuild from persisted columns (replay idiom).
      const baseSnapshots: Record<string, string> = {}
      if (task.repoCount === 1) {
        if (currentRow?.isoBaseSnapshot != null) baseSnapshots[''] = currentRow.isoBaseSnapshot
      } else {
        Object.assign(baseSnapshots, parseIsoJsonMap(currentRow?.isoBaseSnapshotReposJson ?? null))
      }
      if (Object.keys(baseSnapshots).length === 0) {
        await markMergeFailed(db, nodeRunId, 'call adoption: iso base snapshot missing', log)
        return {
          kind: 'failed',
          summary: 'call adoption could not rebuild the iso handle (base snapshot missing)',
          message: 'merge-back-failed',
        }
      }
      const taskBaseHeads: Record<string, string> = {}
      for (const repo of state.repos) {
        const h = await runGit(repo.worktreePath, ['rev-parse', 'HEAD'])
        taskBaseHeads[repo.worktreeDirName] = h.stdout.trim()
      }
      const submodules =
        currentRow !== undefined ? parseIsoSubmodules(currentRow, task.repoCount) : {}
      handle = rebuildIsoHandle({
        appHome: state.opts.appHome,
        taskId,
        nodeRunId: isoKeyOf(currentRow?.isoWorktreePath ?? null, nodeRunId),
        canonRepos: state.repos,
        baseSnapshots,
        taskBaseHeads,
        submodules,
        forcedContainerPaths: await forcedPortPathsForTask(db, taskId),
      })
    }
    if (!handle.passthrough) {
      try {
        const merge = await mergeBackAndSettle({
          db,
          writeSem,
          handle,
          nodeRunId,
          repoCount: task.repoCount,
          via: 'live',
          conflictResolver: (conflicts, containerPath) =>
            resolveMergeConflicts(state, {
              conflicts,
              containerPath,
              conflictNodeRunId: nodeRunId,
              nodeId: node.id,
              iteration,
            }),
          log,
        })
        if (merge.kind === 'conflict-human') {
          log.warn('call merge-back conflict unresolved → awaiting_human', {
            nodeId: node.id,
            detail: merge.detail,
          })
          return {
            kind: 'awaiting_human',
            summary: `merge conflict unresolved: ${merge.detail}`,
            message: 'merge-conflict',
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log.warn('call merge-back failed', { nodeId: node.id, error: msg })
        await markMergeFailed(db, nodeRunId, msg, log)
        return {
          kind: 'failed',
          summary: `merge-back failed: ${msg}`,
          message: 'merge-back-failed',
        }
      }
    }
    await discardNodeIso(handle, log, writeSem)
  }
  return { kind: 'ok', summary: `child task ${childTaskId} done`, message: '' }
}

/** Settle a call row into a terminal status with its failure metadata. */
async function failCallRow(
  db: DbClient,
  taskId: string,
  nodeRunId: string,
  nodeId: string,
  failureCode: string,
  errorMessage: string,
  to: 'failed' | 'canceled' = 'failed',
): Promise<void> {
  const ok = await setNodeRunStatus({
    db,
    nodeRunId,
    to,
    allowedFrom: ['pending', 'running'],
    extra: { finishedAt: Date.now(), errorMessage, failureCode },
    reason: 'call-settle',
  })
    .then(() => true)
    .catch(() => false)
  if (ok) broadcastNodeStatus(taskId, nodeRunId, nodeId, to)
}

function isShutdownAbort(signal: AbortSignal | undefined): boolean {
  if (signal === undefined || !signal.aborted) return false
  return signal.reason === DAEMON_SHUTDOWN_ABORT_REASON
}

/**
 * RFC-243 实现门 P1-5 — confirm that a child's `daemon-restart` interrupt is
 * THIS daemon going down, by waiting (bounded) for the parent's own shutdown
 * abort. The child's abort routinely lands first (abortAllActiveTasks iterates
 * one map), so an instantaneous `signal.aborted` check is not a discriminator.
 * Confirmed ⇒ the caller yields without writing a terminal row and the
 * parent's ordinary shutdown path (`cancelTaskRow`) records `interrupted`,
 * keeping the whole tree resumable. NOT confirmed (e.g. a stale interrupt
 * inherited from a previous crash that resume could not clear) ⇒ the caller
 * keeps its genuine `child-interrupted` failure.
 */
async function awaitShutdownAbort(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<boolean> {
  if (signal === undefined) return false
  if (signal.aborted) return signal.reason === DAEMON_SHUTDOWN_ABORT_REASON
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(false)
    }, timeoutMs)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve(signal.reason === DAEMON_SHUTDOWN_ABORT_REASON)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function buildChildRuntime(state: SchedulerState) {
  return {
    ...(state.triggerContext === null ? {} : { triggerContext: state.triggerContext }),
    actorUserId:
      (state.task as unknown as { ownerUserId?: string | null }).ownerUserId ?? undefined,
    runConfig: pickInheritableRunConfig(state.opts),
  }
}

/** Child launch deps assembled from the parent scheduler's runtime options. */
function buildChildDeps(state: SchedulerState) {
  const { db } = state
  const runtime = buildChildRuntime(state)
  return {
    db,
    schedulerDriver: state.topology.schedulerDriver,
    // RFC-292: child/grandchild tasks inherit the root launch fact atomically
    // with their parent linkage; they never re-read a webhook delivery.
    ...(runtime.triggerContext === undefined ? {} : { triggerContext: runtime.triggerContext }),
    actorUserId: runtime.actorUserId,
    // RFC-284 T20：继承面整体透传（唯一登记 INHERITABLE_RUN_CONFIG_KEYS）。
    // 历史逐字段展开的三段关键注释（RFC-282 收尾门 configPath 漏斗第三段 /
    // RFC-266 两个 daemon-wide 池 resize-on-read 连坐 / RFC-269 code-host 池同理）
    // 已并入注册表与处置表测试——漏配从「人肉记得展开」变「编译期表态」。
    ...runtime.runConfig,
  }
}

/** L — assemble and fire the child launch through the executor facade. */
async function launchCallChild(
  state: SchedulerState,
  args: {
    node: WorkflowNode
    nodeRunId: string
    childId: string
    frozen: { id: string; version: number; definition: unknown }
    workflowName: string
    inputs: Record<string, string>
    iso: IsoHandle
    childDepth: number
  },
): Promise<void> {
  const { db, task, taskId } = state
  const taskRow = task as unknown as {
    refClosureJson?: string | null
    ownerUserId?: string | null
  }
  const { node, nodeRunId, childId, frozen, workflowName, inputs, iso, childDepth } = args
  const frozenSnapshotJson = JSON.stringify(frozen.definition)

  // Child collaborators = the parent task's members (D11).
  const memberRows = await db
    .select({ userId: taskCollaborators.userId, role: taskCollaborators.role })
    .from(taskCollaborators)
    .where(eq(taskCollaborators.taskId, taskId))
  const collaboratorUserIds = [
    ...new Set(
      memberRows
        .filter((m) => m.role !== 'owner' && m.userId !== null)
        .map((m) => m.userId as string),
    ),
  ]

  const limits = ((): { maxDurationMs?: number; maxTotalTokens?: number } => {
    const raw = (node as unknown as Record<string, unknown>).limits
    if (typeof raw !== 'object' || raw === null) return {}
    const o = raw as { maxDurationMs?: unknown; maxTotalTokens?: unknown }
    return {
      ...(typeof o.maxDurationMs === 'number' ? { maxDurationMs: o.maxDurationMs } : {}),
      ...(typeof o.maxTotalTokens === 'number' ? { maxTotalTokens: o.maxTotalTokens } : {}),
    }
  })()

  const nodeTitle = pickString(node, 'title') ?? node.id
  const childName = `${task.name} › ${nodeTitle}`.slice(0, 255)

  // The synthesized 'inherited' space: the child's canonical IS this call
  // node's iso worktree(s); cleanup carries ZERO worktrees + no owned root
  // (borrowed semantics — the iso lifecycle stays with the parent).
  const primary = iso.repos[0]
  const space = {
    kind: state.repos.length > 1 ? ('multi' as const) : ('single' as const),
    spaceKind: 'inherited' as const,
    taskId: childId,
    worktreePath:
      state.repos.length > 1 ? iso.containerPath : (primary?.isoWorktreePath ?? task.worktreePath),
    branch: task.branch ?? `agent-workflow/${childId}`,
    baseCommit: primary?.baseSnapshot ?? null,
    earlyError: null,
    resolvedSources: [],
    nodePaths: [],
    cleanup: {
      taskId: childId,
      ownedRoot: null,
      worktrees: [],
      state: 'owned' as const,
      report: null,
    },
    repos: iso.repos.map((r, i) => ({
      repoIndex: i,
      repoPath: r.repoPath,
      repoUrl: null,
      cachedRepoId: null,
      baseBranch: r.baseBranch,
      branch: task.branch ?? `agent-workflow/${childId}`,
      baseCommit: r.baseSnapshot ?? null,
      worktreePath: r.isoWorktreePath,
      worktreeDirName: r.worktreeDirName,
      mountPath: r.worktreeDirName,
      subdir: '',
      readonly: false,
      submoduleInitOk: true,
      submoduleInitError: null,
      hasSubmodules: false,
    })),
  }

  const payload: StartTask = {
    workflowId: frozen.id,
    name: childName,
    inputs,
    ...(collaboratorUserIds.length > 0 ? { collaboratorUserIds } : {}),
    ...limits,
    // publication belongs to the parent (D12): no workingBranch, no auto push.
    autoCommitPush: false,
  } as StartTask

  const { startExecution } = await import('@/services/execution/executor')
  // RFC-285 B3 + RFC-347：closed delegated factory 取代伪造幽灵与
  // central inherited-Actor facade。owner 失活/缺行 → 子任务拒启（外层
  // catch 把 code 直通 failCallRow → 节点以 call-owner-inactive 失败）；
  // NULL owner legacy 行按 Q5 的 pure projection 放行。
  const actor = await delegatedCallActor(
    state,
    'call-workflow',
    taskRow.ownerUserId ?? null,
    nodeRunId,
  )
  if (actor === null) {
    throw new ValidationError(
      'call-owner-inactive',
      `task owner '${taskRow.ownerUserId}' is not an active user; refusing to start call child`,
    )
  }
  await startExecution(
    db,
    actor,
    {
      kind: 'workflow',
      refId: frozen.id,
      invoker: {
        type: 'node',
        parentTaskId: taskId,
        parentNodeRunId: nodeRunId,
        invocationDepth: childDepth,
      },
      payload,
    },
    {
      ...buildChildDeps(state),
      materializedSpace: space,
      callLaunch: {
        parentTaskId: taskId,
        parentNodeRunId: nodeRunId,
        invocationDepth: childDepth,
        frozenSnapshotJson,
        refClosureJson: childClosureSubset(
          taskRow.refClosureJson ?? null,
          frozen.definition as Parameters<typeof childClosureSubset>[1],
          // RFC-271 T6e：子集裁剪要用**子工作流自己的 id** 当 source（v2 边键）。
          // 调用点本来就持有 frozen.id，此前只是没传进去。
          frozen.id,
        ),
      },
    },
  )
  void workflowName
}

/**
 * RFC-243 §6.3 — bare goalTemplate expansion. {{port}} tokens read the
 * resolved upstream inputs; repo-shaped builtin tokens describe the CHILD's
 * workspace (the call-node iso); identity tokens describe the CALLER context.
 * Unknown tokens render '' (validator §5 already nudges at edit time). The
 * rendered string is LITERAL for the child — the workgroup prompt layer's
 * literal-render protection (2026-07-27) keeps embedded `{{…}}` inert.
 */
function renderCallGoal(
  template: string,
  inputs: Record<string, string>,
  triggerContext: TriggerContext | null,
  meta: {
    taskId: string
    nodeId: string
    iteration: number
    shardKey: string | null
    repos: ReadonlyArray<{ isoWorktreePath: string; worktreeDirName: string; baseBranch: string }>
  },
): string {
  const primary = meta.repos[0]
  const builtins: Record<string, string> = {
    __repo_path__: primary?.isoWorktreePath ?? '',
    __base_branch__: primary?.baseBranch ?? '',
    __task_id__: meta.taskId,
    __node_id__: meta.nodeId,
    __iteration__: String(meta.iteration),
    __shard_key__: meta.shardKey ?? '',
    __repo_count__: String(meta.repos.length),
    __repo_names__: meta.repos.map((r) => r.worktreeDirName || '(root)').join(', '),
    __repos__: meta.repos
      .map((r) => `- ${r.worktreeDirName || '(root)'}: ${r.isoWorktreePath}`)
      .join('\n'),
  }
  const rendered = renderCallWorkgroupGoalTemplate({
    template,
    inputs,
    builtins,
    triggerContext,
  })
  if (!rendered.ok && rendered.code === 'trigger-context-missing') {
    throw new ValidationError(
      'trigger-context-missing',
      'workgroup goal requires webhook trigger context',
    )
  }
  if (!rendered.ok) {
    throw new ValidationError(
      'workflow-invalid',
      `workgroup goal contains an invalid template ref (${rendered.reason})`,
    )
  }
  return rendered.value
}

/** L (workgroup arm) — frozen-group launch through the RFC-243 frozen face. */
async function launchCallWorkgroupChild(
  state: SchedulerState,
  args: {
    node: WorkflowNode
    nodeRunId: string
    childId: string
    frozenGroup: FrozenWorkgroupRef
    workgroupName: string
    inputs: Record<string, string>
    iso: IsoHandle
    childDepth: number
    iteration: number
    inheritedShardKey: string | null
  },
): Promise<void> {
  const { db, task, taskId } = state
  const taskRow = task as unknown as {
    ownerUserId?: string | null
  }
  const { node, nodeRunId, childId, frozenGroup, inputs, iso, childDepth } = args

  const goalTemplate = pickString(node, 'goalTemplate') ?? ''
  const goal = renderCallGoal(goalTemplate, inputs, state.triggerContext, {
    taskId,
    nodeId: node.id,
    iteration: args.iteration,
    shardKey: args.inheritedShardKey,
    repos: iso.repos.map((r) => ({
      isoWorktreePath: r.isoWorktreePath,
      worktreeDirName: r.worktreeDirName,
      mountPath: r.worktreeDirName,
      subdir: '',
      readonly: false,
      baseBranch: r.baseBranch,
    })),
  })

  const memberRows = await db
    .select({ userId: taskCollaborators.userId, role: taskCollaborators.role })
    .from(taskCollaborators)
    .where(eq(taskCollaborators.taskId, taskId))
  const collaboratorUserIds = [
    ...new Set(
      memberRows
        .filter((m) => m.role !== 'owner' && m.userId !== null)
        .map((m) => m.userId as string),
    ),
  ]

  const limits = ((): { maxDurationMs?: number; maxTotalTokens?: number } => {
    const raw = (node as unknown as Record<string, unknown>).limits
    if (typeof raw !== 'object' || raw === null) return {}
    const o = raw as { maxDurationMs?: unknown; maxTotalTokens?: unknown }
    return {
      ...(typeof o.maxDurationMs === 'number' ? { maxDurationMs: o.maxDurationMs } : {}),
      ...(typeof o.maxTotalTokens === 'number' ? { maxTotalTokens: o.maxTotalTokens } : {}),
    }
  })()
  const nodeTitle = pickString(node, 'title') ?? node.id
  const childName = `${task.name} › ${nodeTitle}`.slice(0, 255)
  const primary = iso.repos[0]
  const space = {
    kind: state.repos.length > 1 ? ('multi' as const) : ('single' as const),
    spaceKind: 'inherited' as const,
    taskId: childId,
    worktreePath:
      state.repos.length > 1 ? iso.containerPath : (primary?.isoWorktreePath ?? task.worktreePath),
    branch: task.branch ?? `agent-workflow/${childId}`,
    baseCommit: primary?.baseSnapshot ?? null,
    earlyError: null,
    resolvedSources: [],
    nodePaths: [],
    cleanup: {
      taskId: childId,
      ownedRoot: null,
      worktrees: [],
      state: 'owned' as const,
      report: null,
    },
    repos: iso.repos.map((r, i) => ({
      repoIndex: i,
      repoPath: r.repoPath,
      repoUrl: null,
      cachedRepoId: null,
      baseBranch: r.baseBranch,
      branch: task.branch ?? `agent-workflow/${childId}`,
      baseCommit: r.baseSnapshot ?? null,
      worktreePath: r.isoWorktreePath,
      worktreeDirName: r.worktreeDirName,
      mountPath: r.worktreeDirName,
      subdir: '',
      readonly: false,
      submoduleInitOk: true,
      submoduleInitError: null,
      hasSubmodules: false,
    })),
  }

  const { startWorkgroupTaskFromFrozen } = await import('@/services/workgroup/launch')
  // RFC-285 B3 + RFC-347：本臂不消费 legacy projection，但同经 closed
  // delegated factory 做 owner preflight；失败经外层 catch 落
  // call-owner-inactive。
  if (
    (await delegatedCallActor(state, 'call-workgroup', taskRow.ownerUserId ?? null, nodeRunId)) ===
    null
  ) {
    throw new ValidationError(
      'call-owner-inactive',
      `task owner '${taskRow.ownerUserId}' is not an active user; refusing to start call child`,
    )
  }
  await startWorkgroupTaskFromFrozen(
    db,
    {
      frozenGroup: frozenGroup.group as Parameters<
        typeof startWorkgroupTaskFromFrozen
      >[1]['frozenGroup'],
      workgroupId: frozenGroup.id,
      goal,
      name: childName,
      collaboratorUserIds,
      ...limits,
    },
    {
      ...buildChildDeps(state),
      materializedSpace: space,
      callLaunch: {
        parentTaskId: taskId,
        parentNodeRunId: nodeRunId,
        invocationDepth: childDepth,
        // The host snapshot is composed INSIDE the frozen launch face (it
        // needs the runtime config); the workgroupLaunch dep drives the
        // snapshot — this arm only carries the parent linkage + closure rules.
        frozenSnapshotJson: null,
        refClosureJson: null,
      },
    },
  )
}

// ---------------------------------------------------------------------------
// RFC-253 — script node dispatch.
//
// Structurally parallel to the agent branch below, but it cannot SHARE that
// code: the agent path's semaphore/iso/retry block sits after the
// `kind !== 'agent-single'` guard, so a script node never reaches it
// (design-gate F6). What IS shared are the primitives — the pool semaphore
// (RFC-266: the script one), the RFC-130
// isolation helpers, mintNodeRun, setNodeRunStatus, the envelope parser — which
// is where the invariants actually live.
// ---------------------------------------------------------------------------

/**
 * RFC-269 — one outbound code-host API call.
 *
 * Deliberately much shorter than `runScriptNode`: there is no iso worktree (it
 * writes no files), no subprocess (the daemon issues the request itself), and
 * **no node-level retry
 * loop**. That last one is a decision, not an omission: the executor already
 * retries at the HTTP layer where it can tell a safe retry from an unsafe one
 * (D18 — 429 always, 5xx/network only for idempotent methods). Re-running the
 * whole node on top of that would re-POST comments that may well have landed.
 * A human can still retry the node by hand; that is a judgement call, not an
 * automatic one.
 */
export async function runCodeHostCallNode(
  state: SchedulerState,
  args: OneNodeArgs,
): Promise<OneNodeResult> {
  const { db, task, taskId, definition, opts, log, codeHostSem } = state
  const { node, iteration } = args

  const provider = pickString(node, 'provider')
  const action = pickString(node, 'action')
  if (provider !== 'gitlab' && provider !== 'github') {
    return {
      kind: 'failed',
      summary: `code-host node ${node.id} has no valid provider`,
      message: 'code-host-param-invalid',
    }
  }
  if (action === null || !isCodeHostAction(action)) {
    return {
      kind: 'failed',
      summary: `code-host node ${node.id} has no action`,
      message: 'code-host-param-invalid',
    }
  }

  const { inputs: upstreamInputs, consumed } = await resolveUpstreamInputs(
    db,
    taskId,
    definition.edges,
    node.id,
    iteration,
    log,
    definition,
    state.containerOf,
  )

  // Row selection mirrors the script/agent branches exactly: adopt the pending
  // row if one exists (that is what `retryNode` mints for a user-requested
  // retry and what the cascade mints downstream), otherwise take the next
  // retry index. Minting unconditionally would leave the placeholder pending
  // forever and make `isFresherNodeRun` pick between two rows for the same
  // attempt.
  const consumedUpstreamJson = JSON.stringify(consumed)
  const sameNodeIterRuns = await db
    .select()
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.taskId, taskId),
        eq(nodeRuns.nodeId, node.id),
        eq(nodeRuns.iteration, iteration),
      ),
    )
    .orderBy(asc(nodeRuns.startedAt))
  // RFC-287 T8：取行前奏收编。本线两处与其余三线不同，**都不能统一掉**：
  //   · 不追 retryIndex —— 代码平台调用没有节点级重试（只有 HTTP 幂等重试）；
  //   · 不广播 pending —— 它铸完立刻转 running（下方），多播一条 WS 事件会让
  //     前台看到一个根本不存在的 pending 态。
  const { nodeRunId } = await resolveSchedulerRunRow({
    db,
    taskId,
    nodeId: node.id,
    iteration,
    consumedUpstreamJson,
    rows: sameNodeIterRuns,
    inheritReviewIteration: false,
    clearAgentOverride: false,
    trackRetryIndex: false,
    broadcastPending: null,
  })
  await setNodeRunStatus({
    db,
    nodeRunId,
    to: 'running',
    allowedFrom: ['pending'],
    reason: 'code-host-call-start',
    extra: {},
  })
  broadcastNodeStatus(taskId, nodeRunId, node.id, 'running')

  const settle = async (
    to: 'done' | 'failed',
    reason: string,
    extra: Record<string, unknown>,
  ): Promise<void> => {
    await setNodeRunStatus({
      db,
      nodeRunId,
      to,
      allowedFrom: ['running'],
      reason,
      extra: { finishedAt: Date.now(), ...extra },
    })
    broadcastNodeStatus(taskId, nodeRunId, node.id, to)
  }

  // 注入优先（测试注 stub）；生产没人注入，落到密钥文件懒解析——见
  // `resolveCodeHostConnectionsFromKeyFile` 的注释：这条接线曾经整条断开。
  const connections =
    opts.codeHostConnections ?? resolveCodeHostConnectionsFromKeyFile(db, Paths.secretKeyFile)
  const connection = connections?.resolve(provider) ?? null
  if (connection === null) {
    await settle('failed', 'code-host-not-configured', {
      errorMessage: `no ${provider} connection is configured; set its base URL and token in Settings`,
      failureCode: 'code-host-not-configured',
    })
    return {
      kind: 'failed',
      summary: `${provider} is not configured`,
      message: 'code-host-not-configured',
    }
  }

  const params: Record<string, string> = {}
  const rawParams = (node as unknown as { params?: unknown }).params
  if (rawParams !== null && typeof rawParams === 'object' && !Array.isArray(rawParams)) {
    for (const [key, value] of Object.entries(rawParams as Record<string, unknown>)) {
      if (typeof value === 'string') params[key] = value
    }
  }
  const rawRequest = (node as unknown as { request?: unknown }).request
  const timeoutMs =
    typeof (node as unknown as { timeoutMs?: unknown }).timeoutMs === 'number'
      ? (node as unknown as { timeoutMs: number }).timeoutMs
      : opts.codeHostRequestTimeoutMs

  const attemptObserver = (() => {
    if (opts.executionContext === undefined) return undefined
    const run = db
      .select({
        continuationSlotKey: nodeRuns.continuationSlotKey,
        lineageSlotPathJson: nodeRuns.lineageSlotPathJson,
        operationGeneration: nodeRuns.operationGeneration,
      })
      .from(nodeRuns)
      .where(eq(nodeRuns.id, nodeRunId))
      .get()
    const executionLineageId = task.executionLineageId ?? taskId
    const fallbackPath: readonly LineageSlot[] = [
      {
        stableNodeKey: 'task-root',
        frozenOccurrenceKey: executionLineageId,
        workflowRevision: task.workflowVersion,
      },
      {
        stableNodeKey: node.id,
        frozenOccurrenceKey: run?.continuationSlotKey ?? `${node.id}:${iteration}`,
        workflowRevision: task.workflowVersion,
      },
    ]
    let slotPath: readonly LineageSlot[] = fallbackPath
    try {
      if (run?.lineageSlotPathJson !== null && run?.lineageSlotPathJson !== undefined) {
        slotPath = decodeLineageSlotPath(run.lineageSlotPathJson)
      }
    } catch {
      // Legacy/imported rows use the deterministic task/node fallback above.
    }
    const slotPathJson = encodeLineageSlotPath(slotPath)
    const slotPathDigest = sha256Hex(slotPathJson)
    const operationKey = `${run?.continuationSlotKey ?? node.id}:code-host:${action}`
    const familyKey = operationFamilyKey({
      executionLineageId,
      slotPath,
      effectKind: 'code-host-mutation',
      stableActionOrdinal: `${node.id}:${iteration}:${action}`,
    })
    const attemptPlan = taskExecutionModule.effects.planCodeHostAttempt({
      db,
      executionLineageId,
      operationFamilyKey: familyKey,
    })
    const objectCoordinates = Object.fromEntries(
      ['project', 'mr', 'issue', 'thread', 'comment', 'draft', 'pipeline', 'job', 'sha', 'workflow']
        .filter((key) => params[key] !== undefined)
        .map((key) => [key, params[key]]),
    )
    return createCodeHostEffectAttemptObserver({
      db,
      context: opts.executionContext as TaskExecutionContext,
      action,
      nodeRunId,
      initialRetryAuthority: attemptPlan.retryAuthority,
      identity: {
        executionLineageId,
        operationFamilyKey: familyKey,
        operationGeneration: attemptPlan.operationGeneration,
        operationKey,
        requestHash: executionEffectRequestHash({
          provider,
          action,
          params,
          request: rawRequest ?? null,
          upstreamInputs,
        }),
        slotPathJson,
        slotPathDigest,
        resourceKeys: [
          `code-host:${provider}:${sha256Hex(
            JSON.stringify({ baseUrl: connection.baseUrl, ...objectCoordinates }),
          )}`,
        ],
      },
    })
  })()

  const release = await codeHostSem.acquire()
  let outcome: Awaited<ReturnType<typeof executeCodeHostCall>>
  try {
    let recoveryCycle = 0
    for (;;) {
      outcome = await executeCodeHostCall(
        {
          provider,
          action,
          params,
          ...(rawRequest !== undefined ? { request: rawRequest as never } : {}),
          allowDestructive:
            (node as unknown as { allowDestructive?: unknown }).allowDestructive === true,
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        },
        {
          connection,
          ctx: { ports: upstreamInputs, triggerContext: state.triggerContext },
          projectFallback: resolveProjectFallback({
            provider,
            baseUrl: connection.baseUrl,
            repositoryUrlPrefixes: connection.repositoryUrlPrefixes,
            repoUrl: task.repoUrl,
            repoCount: task.repoCount,
          }),
          ...(opts.codeHostFetch !== undefined ? { fetchImpl: opts.codeHostFetch } : {}),
          ...(opts.codeHostResponseMaxBytes !== undefined
            ? { maxResponseBytes: opts.codeHostResponseMaxBytes }
            : {}),
          ...(attemptObserver !== undefined ? { attemptObserver } : {}),
        },
      )
      if (outcome.ok || attemptObserver?.outcomeUnknown() !== true) break
      const descriptor = attemptObserver.terminalRecoveryDescriptor()
      if (descriptor === null) break
      const probe = await probeCodeHostMutation({
        descriptor,
        resolveConnection: (targetProvider) =>
          targetProvider === provider ? connection : (connections?.resolve(targetProvider) ?? null),
        ...(opts.codeHostFetch !== undefined ? { fetchImpl: opts.codeHostFetch } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      })
      if (probe.kind === 'definitely-not-applied' && recoveryCycle > 0) break
      const resolution = attemptObserver.resolveTerminalProbe(probe)
      if (resolution === 'applied' && probe.kind === 'applied') {
        outcome = {
          ok: true,
          status: probe.responseStatus,
          body: probe.responseBody,
          truncated: false,
          method: descriptor.method,
          pathname: descriptor.mutationPathname,
        }
        break
      }
      if (resolution !== 'retry-authorized') break
      recoveryCycle += 1
    }
  } finally {
    release()
  }

  if (!outcome.ok) {
    const outcomeUnknown = attemptObserver?.outcomeUnknown?.() === true
    const failureCode = outcomeUnknown ? 'task-execution-outcome-unknown' : outcome.code
    const errorMessage = outcomeUnknown
      ? `${outcome.message}; the remote mutation outcome is unknown. Automatic continuation is paused, while an actor may use Resume/Retry/Sync to start the next audited generation.`
      : outcome.message
    const finishedAt = Date.now()
    const settledWithEffect =
      attemptObserver?.settleTerminal((tx) => {
        setNodeRunStatusTx({
          tx,
          nodeRunId,
          to: 'failed',
          allowedFrom: ['running'],
          reason: failureCode,
          extra: { finishedAt, errorMessage, failureCode },
        })
      }) === true
    if (settledWithEffect) broadcastNodeStatus(taskId, nodeRunId, node.id, 'failed')
    else {
      await settle('failed', failureCode, {
        errorMessage,
        failureCode,
      })
    }
    return {
      kind: 'failed',
      summary: outcomeUnknown ? 'remote mutation outcome unknown' : outcome.summary,
      message: failureCode,
    }
  }

  const persistOutputs = (tx: DbTxSync | DbClient): void => {
    for (const value of [
      { nodeRunId, portName: 'response', content: outcome.body },
      { nodeRunId, portName: 'status', content: String(outcome.status) },
    ]) {
      tx.insert(nodeRunOutputs)
        .values(value)
        .onConflictDoUpdate({
          target: [nodeRunOutputs.nodeRunId, nodeRunOutputs.portName],
          set: { content: value.content },
        })
        .run()
    }
  }
  const finishedAt = Date.now()
  const settledWithEffect =
    attemptObserver?.settleTerminal((tx) => {
      persistOutputs(tx)
      setNodeRunStatusTx({
        tx,
        nodeRunId,
        to: 'done',
        allowedFrom: ['running'],
        reason: 'code-host-call-done',
        extra: { finishedAt },
      })
    }) === true
  if (settledWithEffect) broadcastNodeStatus(taskId, nodeRunId, node.id, 'done')
  else {
    withTaskExecutionMutation({ db, taskId, run: persistOutputs })
    await settle('done', 'code-host-call-done', {})
  }
  return {
    kind: 'ok',
    summary: `${outcome.method} ${outcome.pathname} → ${outcome.status}`,
    message: '',
  }
}

export async function runScriptNode(
  state: SchedulerState,
  args: OneNodeArgs,
): Promise<OneNodeResult> {
  // RFC-266: the SCRIPT pool, not the agent pool — a second-scale script must
  // not queue behind multi-minute agent runs (and cannot starve them either).
  const { db, task, taskId, definition, opts, log, scriptSem, writeSem } = state
  const { node, iteration } = args

  const language = readScriptLanguage(node)
  if (language === undefined) {
    return { kind: 'failed', summary: `script node ${node.id} has no language`, message: 'invalid' }
  }
  const isReadonly = resolveScriptReadonly(node)

  const { inputs: upstreamInputs, consumed: consumedUpstream } = await resolveUpstreamInputs(
    db,
    taskId,
    definition.edges,
    node.id,
    iteration,
    log,
    definition,
    state.containerOf,
  )
  const consumedUpstreamJson = JSON.stringify(consumedUpstream)

  // Row selection mirrors the agent branch: adopt a pending row if one exists,
  // otherwise mint the next retry index.
  const sameNodeIterRuns = await db
    .select()
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.taskId, taskId),
        eq(nodeRuns.nodeId, node.id),
        eq(nodeRuns.iteration, iteration),
      ),
    )
    .orderBy(asc(nodeRuns.startedAt))
  // RFC-287 T8：取行前奏收编（脚本线不继承 reviewIteration、不写 agentOverrideName
  // ——它没有评审轮次也没有代理借用；其余四维与 agent 线同）。
  const resolvedRow = await resolveSchedulerRunRow({
    db,
    taskId,
    nodeId: node.id,
    iteration,
    consumedUpstreamJson,
    rows: sameNodeIterRuns,
    inheritReviewIteration: false,
    clearAgentOverride: false,
    trackRetryIndex: true,
    broadcastPending: (id) => broadcastNodeStatus(taskId, id, node.id, 'pending'),
  })
  let nodeRunId = resolvedRow.nodeRunId
  const retryIndex = resolvedRow.retryIndex

  const interpreter = await resolveScriptInterpreter(language, opts.scriptInterpreters ?? {})
  if (interpreter === null) {
    await setNodeRunStatus({
      db,
      nodeRunId,
      to: 'failed',
      allowedFrom: ['pending'],
      reason: 'script-interpreter-missing',
      extra: {
        finishedAt: Date.now(),
        // 带上解析链的逐环结果，而不是只报结论——四环（which / 推导 / 存在 / 探测）
        // 失败时长得一模一样，光看结论排不了障（RFC-253 T41 的 Windows 首红实证）。
        errorMessage:
          `no ${language} interpreter available on this host: ` +
          describeInterpreterResolution(language, opts.scriptInterpreters ?? {}),
        failureCode: 'script-interpreter-missing',
      },
    })
    broadcastNodeStatus(taskId, nodeRunId, node.id, 'failed')
    return {
      kind: 'failed',
      summary: `script node ${node.id}: ${language} interpreter not found`,
      message: 'script-interpreter-missing',
    }
  }

  const maxRetries = opts.defaultNodeRetries ?? DEFAULT_PROTOCOL_RETRY_BUDGET

  // RFC-287 T5c：本线改走 `runAssembly` 骨架的**模式 B**（跨 attempt 窗口）。
  // 一次 scriptSem 许可 + 一棵 iso 的窗口内由 retryPolicy 驱动多次 attempt；
  // 与 agent 线相反，脚本线**每次重试都换新树**（D24：否则上一次的文件写入会与
  // 这一次叠加）。四处逐 attempt 语义逐字保住：信号取消早退、永久失败中断、
  // 逐次铸行+广播+落基线、succeeded 驱动合并。
  let isoHandle: IsoHandle | null = null
  const isoKeyRunId = nodeRunId
  let succeeded = false
  let lastFailure: { code: string; message: string } | null = null
  let canceledMsg: string | null = null

  const createScriptIso = async (): Promise<IsoHandle> => {
    isoHandle = await createIsoUnderLock({
      writeSem,
      appHome: opts.appHome,
      taskId,
      db,
      isoKeyRunId,
      canonRepos: state.repos,
      log,
    })
    return isoHandle
  }

  return await runAssembly<Record<string, never>, ScriptAttemptOutcome, OneNodeResult>(
    {},
    {
      pools: [scriptSem],
      iso: {
        create: createScriptIso,
        // 落基线在许可保护的主 try 内（与 agent 线同档；抛出经 finally 释放后继续
        // 传播——design §10.10 的按线声明）。
        persistBase: 'in-window',
        persist: async () => {
          if (isoHandle !== null) await persistIsoBase(db, nodeRunId, task.repoCount, isoHandle)
        },
      },
      onIsoSetupFailure: (err) => {
        log.warn('script iso worktree setup failed', {
          nodeId: node.id,
          error: err instanceof Error ? err.message : String(err),
        })
        return {
          kind: 'failed',
          // 文案与 failure code 逐字保持迁移前——它是**对外**的失败分类，改名等于
          // 让既有按 `iso-setup-failed` 归类的消费方静默失配（T14 实现门抓到的漂移）。
          summary: 'isolated worktree setup failed',
          message: 'iso-setup-failed',
        }
      },
      spawn: async (_c, attempt) => {
        // **只有 attempt 0** 在这里短路。理由是它与迁移前逐字同位：那时循环顶的
        // 取消检查发生在铸行**之前**，所以直接返回不会遗留任何未终结的行。
        //
        // attempt ≥ 1 绝不能在这里短路（二轮实现门 A-1）：那时 `onNextAttempt` 已经
        // 铸出一条 pending 行并把它标成 isolating。迁移前的代码在换树/铸行之后是
        // **无条件**进入 `runOneScriptAttempt` 的，由它把新行终结为 canceled；在这里
        // 提前返回会跳过那一步，于是留下永不运行也永不终结的孤儿行——正是 preAttempt
        // 想消灭的形态，只是触发点从「取消发生在轮顶之前」挪到了「取消发生在
        // discardIso / iso.create / onNextAttempt 的某个 await 里」。preAttempt 只能
        // 覆盖轮顶那一瞬，覆盖不了这段异步窗口，所以两者缺一不可。
        if (attempt === 0 && opts.signal?.aborted === true) {
          canceledMsg = 'signal aborted'
          return { kind: 'canceled' as const, summary: 'task canceled', message: 'signal aborted' }
        }
        const outcome = await runOneScriptAttempt(state, {
          node,
          nodeRunId,
          iteration,
          retryIndex: retryIndex + attempt,
          inputs: upstreamInputs,
          interpreter,
          isoHandle,
          isReadonly,
          language,
        })
        if (outcome.kind === 'done') succeeded = true
        else if (outcome.kind === 'canceled') canceledMsg = outcome.message
        else lastFailure = { code: outcome.message, message: outcome.summary }
        return outcome
      },
      retryPolicy: {
        shouldRetry: (outcome, attempt) => {
          if (outcome.kind === 'done' || outcome.kind === 'canceled') return false
          // Permanent failures gain nothing from another attempt.
          if ((SCRIPT_PERMANENT_FAILURE_CODES as readonly string[]).includes(outcome.message)) {
            return false
          }
          return attempt < maxRetries
        },
        // 换树 / 铸行 / 落基线之前先看取消——迁移前这一检查在循环最顶上，落进
        // 骨架时只剩 spawn 入口一处，于是取消若落在换树窗口里会留下一条永不运行
        // 的孤儿 pending 行（T14 实现门抓到的回归，见骨架 preAttempt 的注释）。
        preAttempt: () => {
          if (opts.signal?.aborted !== true) return null
          canceledMsg = 'signal aborted'
          return { kind: 'canceled' as const, summary: 'task canceled', message: 'signal aborted' }
        },
        // D24：每次重试换新树——这正是让重跑一个写文件的脚本变安全的原因。
        isoOnRetry: 'always-recreate',
        onIsoRecreateFailure: (err) => {
          lastFailure = {
            code: 'iso-recreate-failed',
            message: err instanceof Error ? err.message : String(err),
          }
          return {
            kind: 'failed',
            summary: lastFailure.message,
            message: lastFailure.code,
          }
        },
        onNextAttempt: async (attempt) => {
          nodeRunId = await mintNodeRun(db, {
            taskId,
            nodeId: node.id,
            status: 'pending',
            cause: 'process-retry',
            retryIndex: retryIndex + attempt,
            iteration,
            overrides: { consumedUpstreamRunsJson: consumedUpstreamJson },
          })
          broadcastNodeStatus(taskId, nodeRunId, node.id, 'pending')
          if (isoHandle !== null) await persistIsoBase(db, nodeRunId, task.repoCount, isoHandle)
        },
      },
      mergePhase: (_c, outcome) => {
        if (outcome.kind === 'canceled') {
          return {
            skip: 'not-done',
            keep: false,
            then: {
              produce: async () => ({
                kind: 'canceled' as const,
                summary: 'task canceled',
                message: canceledMsg ?? 'signal aborted',
              }),
            },
          }
        }
        // readonly 的产物永不合回主干（一次性副本），且 settle 先于 done 写。
        if (!succeeded || isReadonly) return { skip: 'not-done', keep: false, then: 'settle' }
        if (isoHandle === null || isoHandle.passthrough) {
          return { skip: 'passthrough', keep: false, then: 'settle' }
        }
        return 'merge'
      },
      mergeBack: {
        run: async () => {
          const iso = isoHandle as IsoHandle
          const merge = await mergeBackAndSettle({
            db,
            writeSem,
            handle: iso,
            nodeRunId,
            repoCount: task.repoCount,
            via: 'live',
            conflictResolver: (conflicts, containerPath) =>
              resolveMergeConflicts(state, {
                conflicts,
                containerPath,
                conflictNodeRunId: nodeRunId,
                nodeId: node.id,
                iteration,
              }),
            log,
          })
          return merge
        },
        disposition: {
          onConflictHuman: (detail) => ({
            // 显式保留（T5a 起不再依赖 finally 谓词碰巧为假）。
            keep: true,
            produce: async () => ({
              kind: 'awaiting_human' as const,
              summary: `merge conflict unresolved: ${detail}`,
              message: 'merge-conflict',
            }),
          }),
          onThrow: (err) => ({
            keep: true,
            then: {
              produce: async () => {
                const msg = err instanceof Error ? err.message : String(err)
                await markMergeFailed(db, nodeRunId, msg, log)
                return {
                  kind: 'failed' as const,
                  summary: `script node ${node.id} merge failed`,
                  message: `merge-back-failed: ${msg}`,
                }
              },
            },
          }),
        },
      },
      // 不要在这里 `.catch(() => {})`：骨架自己会 catch 并 `log.warn('iso discard
      // failed')`，本地先吞掉等于把那条约定好的告警变成永不可达，残留工作树 / ref
      // 的清理失败就彻底没了痕迹（T14 实现门）。
      discardIso: async (h: IsoLike) => {
        await discardNodeIso(h as IsoHandle, log, writeSem)
      },
      settle: async () => {
        if (succeeded) return { kind: 'ok', summary: '', message: '' }
        return {
          kind: 'failed',
          summary: lastFailure?.message ?? `script node ${node.id} failed`,
          message: lastFailure?.code ?? 'script-nonzero-exit',
        }
      },
      log,
    },
  )
}

interface ScriptAttemptArgs {
  node: WorkflowNode
  nodeRunId: string
  iteration: number
  retryIndex: number
  inputs: Record<string, string>
  interpreter: Awaited<ReturnType<typeof resolveScriptInterpreter>> & object
  isoHandle: IsoHandle | null
  isReadonly: boolean
  language: ScriptLanguage
}

type ScriptAttemptOutcome =
  | { kind: 'done' }
  | { kind: 'failed'; summary: string; message: string }
  | { kind: 'canceled'; message: string }

/** One attempt: dependencies → spawn → ports → terminal row. */
async function runOneScriptAttempt(
  state: SchedulerState,
  a: ScriptAttemptArgs,
): Promise<ScriptAttemptOutcome> {
  const { db, task, taskId, opts, log } = state
  const runDir = runRootFor(taskId, a.nodeRunId)
  mkdirSync(runDir, { recursive: true })

  // The iso handle is created before every attempt, including readonly. The
  // scope-root fallback exists only for defensive compatibility with a
  // passthrough handle implementation.
  const worktreePath = a.isoHandle?.repos[0]?.isoWorktreePath ?? state.scopeRoot
  // Every repo this attempt may touch — the boundary must match the paths
  // `AW_REPOS_JSON` hands the script, not just the primary one.
  //
  // `name` is the RFC-248 canonical repo key (the mount path), not the legacy
  // `worktreeDirName` — the latter loses the nesting for a repo-group member
  // mounted at `a/b`.
  const repoProjection =
    a.isoHandle === null
      ? state.repos.map((r) => ({ name: r.mountPath, path: r.worktreePath }))
      : a.isoHandle.repos.map((r, i) => ({
          name: state.repos[i]?.mountPath ?? r.worktreeDirName,
          path: r.isoWorktreePath,
        }))
  // Dependencies are deterministic and prebuilt-only, but otherwise run with
  // the daemon's natural toolchain and network access.
  let depsEnv: ScriptDepsEnv | null = null
  const specs = readScriptDependencies(a.node)
  if (specs.length > 0) {
    try {
      depsEnv = await ensureScriptDepsEnv({
        appHome: opts.appHome,
        language: a.language,
        interpreterPath: a.interpreter.path,
        interpreterVersion: a.interpreter.version,
        specs,
        timeoutMs: opts.scriptDepsInstallTimeoutMs ?? 10 * 60 * 1000,
        ...(opts.signal === undefined ? {} : { signal: opts.signal }),
        onLine: async (stream: 'stdout' | 'stderr', line: string) => {
          withTaskExecutionMutation({
            db,
            taskId,
            run: (tx) =>
              tx
                .insert(nodeRunEvents)
                .values({
                  nodeRunId: a.nodeRunId,
                  ts: Date.now(),
                  kind: stream === 'stderr' ? 'stderr' : 'text',
                  payload: JSON.stringify({ phase: 'deps-install', line }),
                })
                .run(),
          })
        },
        log,
      })
    } catch (err) {
      const detail = err instanceof ScriptDepsInstallError ? err.detail : String(err)
      const message = err instanceof Error ? err.message : String(err)
      await setNodeRunStatus({
        db,
        nodeRunId: a.nodeRunId,
        to: 'failed',
        allowedFrom: ['pending', 'running'],
        reason: 'script-deps-install-failed',
        extra: {
          finishedAt: Date.now(),
          errorMessage: `${message}\n${detail}`.slice(0, 4000),
          failureCode: 'script-deps-install-failed',
        },
      })
      broadcastNodeStatus(taskId, a.nodeRunId, a.node.id, 'failed')
      return { kind: 'failed', summary: message, message: 'script-deps-install-failed' }
    }
  }

  const envelopeNonce = await loadRunEnvelopeNonce(db, a.nodeRunId)

  // RFC-253 T28 — resolved once and shared by every diagnostic sink below, so
  // no sink can drift into persisting what another one masks.
  const scriptEnv = readScriptEnv(a.node)

  // DB first, then broadcast — a client must never observe `running` for a row
  // the database still calls `pending`.
  await setNodeRunStatus({
    db,
    nodeRunId: a.nodeRunId,
    to: 'running',
    allowedFrom: ['pending'],
    reason: 'script-dispatch',
    extra: { startedAt: Date.now() },
  })
  broadcastNodeStatus(taskId, a.nodeRunId, a.node.id, 'running')

  let processEffect: ProcessEffectAttemptObserver | undefined
  const outcome = await runScriptProcess({
    node: a.node,
    inputs: a.inputs,
    runDir,
    worktreePath,
    // 2026-08-04 audit: hand the script the paths it is actually allowed to
    // touch. This used to be the CANONICAL worktree while a non-readonly node
    // runs in its iso copy — so a script that followed the documented
    // `AW_REPOS_JSON` contract wrote outside its isolation: EPERM on macOS,
    // and on Linux a silent write into the appHome tmpfs that evaporated at
    // exit. The agent path next door already resolves iso paths for the same
    // reason (`{{__repos__}}` below).
    repos: repoProjection.map((r) => ({ name: r.name, path: r.path })),
    taskId,
    nodeId: a.node.id,
    nodeRunId: a.nodeRunId,
    iteration: a.iteration,
    retryIndex: a.retryIndex,
    shardKey: null,
    envelopeNonce,
    interpreter: a.interpreter,
    depsEnv,
    ...(opts.defaultPerNodeTimeoutMs === undefined
      ? {}
      : { timeoutMs: opts.defaultPerNodeTimeoutMs }),
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    beforeSpawn: async ({ argv, cwd }) => {
      processEffect = createProcessEffectAttemptObserver({
        db,
        taskId,
        nodeRunId: a.nodeRunId,
        processKind: 'script',
        argv,
        cwd,
        resourceKeys: a.isReadonly ? [] : [`workspace:${sha256Hex(worktreePath)}`],
      })
      await processEffect?.beforeSpawn()
    },
    gitUserName: task.gitUserName,
    gitUserEmail: task.gitUserEmail,
    onSpawned: async ({ pid, spawnBinaryPath, launchNonce }) => {
      // Persist before reading a single byte of output: a daemon crash after
      // this point leaves the boot reaper something to match (design-gate P0-3).
      const persist = (tx: DbTxSync | DbClient) =>
        tx
          .update(nodeRuns)
          .set({
            pid,
            spawnBinaryPath,
            spawnLaunchNonce: launchNonce ?? null,
            runtimeParamsJson: JSON.stringify({
              script: {
                interpreter: a.interpreter.path,
                interpreterVersion: a.interpreter.version,
                depsHash: depsEnv?.hash ?? null,
              },
            }),
          })
          .where(eq(nodeRuns.id, a.nodeRunId))
          .run()
      if (processEffect === undefined) {
        withTaskExecutionMutation({ db, taskId, run: persist })
      } else {
        processEffect.recordSpawnReceipt({ pid, spawnBinaryPath, launchNonce }, persist)
      }
    },
    requireSpawnReceipt: true,
    onStdoutLine: async (line) => {
      // NOT masked, deliberately: stdout is the DATA channel. Its bytes become
      // the port value verbatim (AC-27), so masking this mirror would show the
      // operator something the downstream node never sees. A script that prints
      // its own credential to stdout has published it as data.
      withTaskExecutionMutation({
        db,
        taskId,
        run: (tx) =>
          tx
            .insert(nodeRunEvents)
            .values({
              nodeRunId: a.nodeRunId,
              ts: Date.now(),
              kind: 'text',
              payload: JSON.stringify({ line }),
            })
            .run(),
      })
    },
    onStderrLine: async (line) => {
      // RFC-253 T28 — stderr is the DIAGNOSTIC channel and these rows are a
      // read surface (node-run events route, /session reconstruction, WS
      // replay). Masking only the failure detail below was not enough: that
      // value is `stderrTail`, a strict SUFFIX of the very bytes this sink
      // stores, so the same secret stayed in the clear one table over.
      withTaskExecutionMutation({
        db,
        taskId,
        run: (tx) =>
          tx
            .insert(nodeRunEvents)
            .values({
              nodeRunId: a.nodeRunId,
              ts: Date.now(),
              kind: 'stderr',
              payload: JSON.stringify({ line: maskScriptEnvValues(line, scriptEnv) }),
            })
            .run(),
      })
    },
    log,
  })

  if (outcome.result.outcome === 'aborted') {
    const daemonShutdown = opts.signal?.reason === DAEMON_SHUTDOWN_ABORT_REASON
    await setNodeRunStatus({
      db,
      nodeRunId: a.nodeRunId,
      to: daemonShutdown ? 'interrupted' : 'canceled',
      allowedFrom: ['running'],
      reason: 'script-aborted',
      extra: { finishedAt: Date.now(), exitCode: outcome.result.exitCode },
    })
    processEffect?.settle(outcome.result)
    broadcastNodeStatus(taskId, a.nodeRunId, a.node.id, daemonShutdown ? 'interrupted' : 'canceled')
    return { kind: 'canceled', message: daemonShutdown ? 'daemon-shutdown' : 'canceled' }
  }

  if (outcome.result.truncated.stdout) {
    withTaskExecutionMutation({
      db,
      taskId,
      run: (tx) =>
        tx
          .insert(nodeRunEvents)
          .values({
            nodeRunId: a.nodeRunId,
            ts: Date.now(),
            kind: 'error',
            payload: JSON.stringify({ truncated: 'stdout' }),
          })
          .run(),
    })
  }

  let failureCode = outcome.failureCode
  // impl-gate M5: single-port mode promises the port value IS stdout, byte for
  // byte. The rolling tail keeps the END and discards the HEAD, so a truncated
  // capture would hand downstream a value silently missing its beginning — a
  // JSON or CSV payload turned into an illegal fragment — while the node
  // reported success. Envelope mode already fails closed here (no opening tag
  // ⇒ `script-envelope-missing`); single-port mode needs the same treatment
  // rather than being the one place this product corrupts data quietly.
  if (
    failureCode === null &&
    outcome.result.truncated.stdout &&
    scriptOutputMode(a.node) === 'single'
  ) {
    failureCode = 'script-output-truncated'
  }
  // 2026-08-04 audit: `spawnError` had NO reader anywhere in the repo, and a
  // spawn that never started has an empty stderr tail — so "the script process
  // could not start" reached the user with a blank detail and nothing to act
  // on. Prefer the spawn reason (already translated by `explainSpawnEnoent`,
  // so a missing cwd is not reported as a missing bwrap) and fall back to the
  // stderr tail for processes that did start.
  let errorMessage: string | null =
    failureCode === null
      ? null
      : (outcome.result.spawnError ?? outcome.result.stderrTail.slice(-2000))
  const ports: Record<string, string> = {}
  /** RFC-306: ports this script closed with `active="false"`. */
  const inactivePorts = new Set<string>()

  if (failureCode === null) {
    const extraction = extractScriptPorts({
      node: a.node,
      rawStdout: outcome.result.rawStdout,
      nonce: envelopeNonce,
    })
    if (extraction.kind === 'ok') {
      Object.assign(ports, extraction.ports)
      for (const p of extraction.inactivePorts) inactivePorts.add(p)
    } else {
      failureCode = extraction.code
      errorMessage = extraction.detail
    }
  }

  // RFC-253 T28 — the persisted failure detail is a read surface: stderr tails
  // and envelope excerpts must not re-leak env values the workflow read path
  // masks. Port values stay byte-exact; only diagnostics are masked.
  if (errorMessage !== null) {
    errorMessage = maskScriptEnvValues(errorMessage, scriptEnv)
  }

  if (failureCode !== null) {
    await setNodeRunStatus({
      db,
      nodeRunId: a.nodeRunId,
      to: 'failed',
      allowedFrom: ['running'],
      reason: failureCode,
      extra: {
        finishedAt: Date.now(),
        exitCode: outcome.result.exitCode,
        errorMessage,
        failureCode,
      },
    })
    processEffect?.settle(outcome.result)
    broadcastNodeStatus(taskId, a.nodeRunId, a.node.id, 'failed')
    return {
      kind: 'failed',
      summary: errorMessage ?? `script exited ${String(outcome.result.exitCode)}`,
      message: failureCode,
    }
  }

  for (const [portName, content] of Object.entries(ports)) {
    // RFC-306: a script closes a branch the same way an agent does; the flag has
    // to reach the row or the marker is decoration.
    withTaskExecutionMutation({
      db,
      taskId,
      run: (tx) =>
        tx
          .insert(nodeRunOutputs)
          .values({
            nodeRunId: a.nodeRunId,
            portName,
            content,
            active: !inactivePorts.has(portName),
          })
          .run(),
    })
  }
  // RFC-276 regression fix: a readonly script's iso is discarded without a
  // merge-back, but its 'isolating' stamp must still SETTLE — deriveFrontier's
  // D15 gate only completes done rows whose merge_state is settled, so a
  // done+isolating row wedges the scope forever ("scheduler stalled / no ready
  // nodes in scope"; pre-RFC-276 readonly scripts ran in place and stayed NULL).
  // Settled BEFORE the done write so no done+unsettled state is ever observable.
  if (a.isReadonly && a.isoHandle !== null && !a.isoHandle.passthrough) {
    await transitionMergeState({
      db,
      nodeRunId: a.nodeRunId,
      event: { kind: 'discard-readonly' },
    })
  }
  await setNodeRunStatus({
    db,
    nodeRunId: a.nodeRunId,
    to: 'done',
    allowedFrom: ['running'],
    reason: 'script-done',
    extra: { finishedAt: Date.now(), exitCode: outcome.result.exitCode },
  })
  processEffect?.settle(outcome.result)
  broadcastNodeStatus(taskId, a.nodeRunId, a.node.id, 'done')
  return { kind: 'done' }
}

// -----------------------------------------------------------------------------
// RFC-306 — branch judgment + skip row (design §6.2)
// -----------------------------------------------------------------------------

/**
 * Decide whether `node` runs this iteration. Returns `null` to proceed with the
 * ordinary dispatch, or a settled OneNodeResult when the node was skipped.
 *
 * Three details are load-bearing:
 *
 *  1. **Provenance.** The skipped row stores the same `consumed_upstream_runs_json`
 *     an executed row would. That is what lets `isNodeRunFresh` mark the skip
 *     stale once an upstream re-runs, so retrying the deciding node re-opens the
 *     branch (D10 / AC-10). Without it the frontier would re-dispatch the node on
 *     every tick forever — the skip would look like it is "flapping".
 *
 *  2. **Mint pending → mark-skipped**, not a direct `skipped` mint: `skipped` is
 *     not in MintableNodeRunStatus, and the lifecycle table already owns the
 *     `pending → skipped` edge. A crash between the two writes leaves a pending
 *     row, which the orphan reaper flips to `interrupted` and the next pass
 *     re-judges — self-healing, no wedged state.
 *
 *  3. **`force_activated` is read from the LATEST row at this (node, iteration)**
 *     — retryNode stamps it on the placeholder it mints, and this is the read
 *     that turns "run anyway" into an actual run (§10).
 */
export async function judgeBranchActivation(
  state: SchedulerState,
  node: WorkflowNode,
  iteration: number,
): Promise<OneNodeResult | null> {
  const { db, taskId, definition, log } = state
  // Fast path: a node with NO inbound dependency at all can never be branched
  // away (graph roots included), so a workflow that uses no branch ports pays
  // zero extra queries per dispatch — "existing behavior is unchanged" has to
  // hold for cost as well as for outcome.
  //
  // The implicit refs are part of this test, not just of the judgment below:
  // review and output nodes carry their dependency in `inputSource` /
  // `ports[].bind` and often have no edge at all, so an edges-only fast path
  // would return early for exactly the two kinds design-gate P1#2 is about.
  const hasInbound =
    collectDataflowInboundEdges(definition.edges, node.id, nodeKindIndex(definition)).length > 0 ||
    collectImplicitInboundRefs(node as { kind: string; inputSource?: unknown; ports?: unknown })
      .length > 0
  if (!hasInbound) return null
  const existing = await db
    .select()
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.taskId, taskId),
        eq(nodeRuns.nodeId, node.id),
        eq(nodeRuns.iteration, iteration),
      ),
    )
  const latest = pickFreshestRun(existing, { topLevelOnly: true })
  const forceActivated = latest?.forceActivated === true

  const decision = await resolveNodeActivationForDispatch({
    db,
    taskId,
    definition,
    node,
    iteration,
    parents: state.containerOf,
    ...(forceActivated ? { forceActivated: true } : {}),
  })
  if (decision.activation.kind === 'active') return null

  const consumedJson = JSON.stringify(decision.consumed)
  // Design-gate P1#8 — a skip must SETTLE the node's current anchor, not park a
  // terminal sibling next to it. Two anchors matter:
  //
  //   pending      — minted out of band by a clarify answer / review iterate.
  //                  Leaving it behind means the row resolver later reuses it and
  //                  runs the node against the very branch decision that closed
  //                  it, and (because that row is OLDER than the skip row) the
  //                  skip stays "latest" and the scope can stall. Reuse it.
  //   awaiting_*   — a parked human gate. Leaving it behind keeps an actionable
  //                  item in the review inbox for a branch nobody will run.
  //                  Supersede it, then record the skip.
  //
  // Anything else (done / failed / interrupted / canceled / absent) is a settled
  // generation; the skip is a NEW generation on top of it, so it mints normally.
  let nodeRunId: string
  if (latest?.status === 'pending') {
    nodeRunId = latest.id
    withTaskExecutionMutation({
      db,
      taskId,
      run: (tx) =>
        tx
          .update(nodeRuns)
          .set({ consumedUpstreamRunsJson: consumedJson })
          .where(eq(nodeRuns.id, nodeRunId))
          .run(),
    })
    await transitionNodeRunStatus({
      db,
      nodeRunId,
      event: { kind: 'mark-skipped', reason: decision.activation.reason },
      extra: { finishedAt: Date.now() },
    })
  } else {
    if (latest?.status === 'awaiting_review' || latest?.status === 'awaiting_human') {
      await transitionNodeRunStatus({
        db,
        nodeRunId: latest.id,
        event: { kind: 'cancel-by-supersede', reason: 'branch-skipped' },
        extra: { finishedAt: Date.now() },
      })
      broadcastNodeStatus(taskId, latest.id, node.id, 'canceled')
    }
    nodeRunId = await mintNodeRun(db, {
      taskId,
      nodeId: node.id,
      status: 'pending',
      cause: 'branch-skip',
      iteration,
      overrides: { consumedUpstreamRunsJson: consumedJson },
    })
    await transitionNodeRunStatus({
      db,
      nodeRunId,
      event: { kind: 'mark-skipped', reason: decision.activation.reason },
      extra: { finishedAt: Date.now() },
    })
  }
  broadcastNodeStatus(taskId, nodeRunId, node.id, 'skipped')
  log.info('node skipped — inbound branch inactive', {
    nodeId: node.id,
    iteration,
    reason: decision.activation.reason,
    inactiveFrom: decision.edges
      .filter((e) => e.activation.kind === 'inactive')
      .map((e) => `${e.sourceNodeId}.${e.sourcePortName}`),
  })
  return { kind: 'ok', summary: '', message: 'branch-skipped' }
}

export async function runOutputNode(
  state: SchedulerState,
  args: OneNodeArgs,
): Promise<OneNodeResult> {
  const { db, taskId, definition } = state
  const { node, iteration } = args
  // Output nodes are display-only sinks: no subprocess, no envelope. The
  // node's declared `ports[]` bindings resolve to upstream (nodeId, portName)
  // pairs (the canonical form, mirroring wrapper-loop's outputBindings; see
  // workflow.validator.ts §output binding validation). We mint a virtual
  // `done` node_run and snapshot each bound port's content into
  // node_run_outputs so the detail page reads outputs uniformly and
  // lifecycle invariant T3 (task done ⟹ every output node has a done run)
  // is satisfied.
  const bindings = readBindings(node, 'ports')
  const projected: Array<{
    binding: Binding
    row: Awaited<ReturnType<typeof readPortRowAtIteration>>
  }> = []
  const consumed: Record<string, string> = {}
  for (const b of bindings) {
    const resolved = resolveWorkflowSourceRef(definition, b.bind, node.id, state.containerOf)
    if (!resolved.ok) {
      return {
        kind: 'failed',
        summary: `output node ${node.id}: source '${b.bind.nodeId}.${b.bind.portName}' is not exposed by wrapper '${resolved.wrapperId}'`,
        message: 'wrapper-output-boundary-missing',
      }
    }
    // RFC-193 D16: copy kind + archive reference with the content — an
    // output node is pure projection, its row must stay artifact-readable.
    const row = await readPortRowAtIteration(
      db,
      taskId,
      resolved.source.nodeId,
      resolved.source.portName,
      iteration,
    )
    if (row.runId !== null) consumed[resolved.source.nodeId] = row.runId
    projected.push({ binding: b, row })
  }
  const nrId = await mintNodeRun(db, {
    taskId,
    nodeId: node.id,
    status: 'done',
    cause: 'io-virtual',
    iteration,
    overrides: { consumedUpstreamRunsJson: JSON.stringify(consumed) },
  })
  for (const { binding, row } of projected) {
    withTaskExecutionMutation({
      db,
      taskId,
      run: (tx) =>
        tx
          .insert(nodeRunOutputs)
          .values({
            nodeRunId: nrId,
            portName: binding.name,
            content: row.content,
            kind: row.kind,
            archiveJson: row.archiveJson,
            // RFC-306: an output node is pure projection, and that includes the
            // branch state. With joinMode 'any' the node itself can be active while
            // ONE of its bound sources sits on a closed branch — that port then
            // renders as "not produced" instead of as a genuine empty result.
            active: row.active,
          })
          .run(),
    })
  }
  broadcastNodeStatus(taskId, nrId, node.id, 'done')
  return { kind: 'ok', summary: '', message: '' }
}

export async function runInputNode(
  state: SchedulerState,
  args: OneNodeArgs,
): Promise<OneNodeResult> {
  const { db, taskId, inputsMap } = state
  const { node, iteration } = args
  const inputKey = pickString(node, 'inputKey')
  if (inputKey === null) {
    return {
      kind: 'failed',
      summary: `input node ${node.id} missing inputKey`,
      message: 'invalid',
    }
  }
  const value = inputsMap[inputKey] ?? ''
  const nrId = await mintNodeRun(db, {
    taskId,
    nodeId: node.id,
    status: 'done',
    cause: 'io-virtual',
    iteration,
  })
  // RFC-004: an input node's single output port is named after its inputKey,
  // so edges authored on the canvas resolve to the visible handle label.
  withTaskExecutionMutation({
    db,
    taskId,
    run: (tx) =>
      tx
        .insert(nodeRunOutputs)
        .values({ nodeRunId: nrId, portName: inputKey, content: value })
        .run(),
  })
  broadcastNodeStatus(taskId, nrId, node.id, 'done')
  return { kind: 'ok', summary: '', message: '' }
}

export async function runReviewNode(
  state: SchedulerState,
  args: OneNodeArgs,
): Promise<OneNodeResult> {
  const { db, taskId, definition, opts } = state
  const { node, iteration } = args
  return dispatchReviewNode({
    db,
    taskId,
    appHome: opts.appHome,
    definition,
    node,
    iteration,
    // RFC-193 D9: the review's fallback read root is THIS scope's canonical.
    scopeRoot: state.scopeRoot,
    repoDirName: state.repos[0]?.worktreeDirName ?? '',
  })
}

export async function runCrossClarifyNode(
  state: SchedulerState,
  args: OneNodeArgs,
): Promise<OneNodeResult> {
  const { db, taskId, definition } = state
  const { node, iteration } = args
  // RFC-056: cross-clarify nodes are activated by the questioner emitting
  // <workflow-clarify> — the runner forwards into createClarifyRound(kind='cross')
  // which mints a fresh node_run row and parks it at 'awaiting_human'. The
  // scheduler should NOT eagerly insert a pending row on every scan; doing
  // so accumulates orphan pending rows (one per scheduler tick, the user
  // saw 21 pile up on a parked task) because nothing consumes them — the
  // runner path always inserts its OWN row via createClarifyRound(kind='cross')
  // rather than upgrading whatever the scheduler pre-baked.
  //
  // Two legitimate scheduler responsibilities remain:
  //   1. Persistent-stop short-circuit: if this node has a prior
  //      directive='stop' session, mark a fresh done row so cascade
  //      reruns of the cross-clarify branch can advance past it without
  //      parking awaiting_human.
  //   2. Missing-questioner runtime defense: validator should catch
  //      this earlier, but if the workflow snapshot has no questioner
  //      wired, fail explicitly.
  //
  // For the common case (no stop, has questioner), do NOTHING — the
  // runner will create the node_run when the questioner emits clarify.
  // If a live row already exists (pending or awaiting_human) from a
  // prior runner-side creation, also do nothing — idempotency guard.
  const liveRows = await db
    .select({ status: nodeRuns.status })
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.taskId, taskId),
        eq(nodeRuns.nodeId, node.id),
        eq(nodeRuns.iteration, iteration),
      ),
    )
  const hasLive = liveRows.some((r) => r.status === 'pending' || r.status === 'awaiting_human')
  if (hasLive) {
    return { kind: 'ok', summary: '', message: 'cross-clarify-live-row-exists' }
  }
  // Validator runtime defense: a node without a questioner means the
  // workflow is malformed — fail and let the user see it in the UI.
  if (findQuestionerNodeForCrossClarify(definition, node.id) === undefined) {
    const failId = await mintNodeRun(db, {
      taskId,
      nodeId: node.id,
      status: 'pending',
      cause: 'cross-clarify-guard',
      iteration,
    })
    await setNodeRunStatus({
      db,
      nodeRunId: failId,
      to: 'failed',
      allowedFrom: ['pending'],
      reason: 'cross-clarify-input-source-missing-at-runtime',
      extra: { finishedAt: Date.now() },
    })
    return {
      kind: 'failed',
      summary: `cross-clarify node ${node.id} has no questioner input`,
      message: 'cross-clarify-input-source-missing-at-runtime',
    }
  }
  // Persistent-stop check: if the questioner node's node-level clarify directive is
  // 'stop', mint a done row immediately so the workflow advances past this point
  // without parking awaiting_human.
  // RFC-132 T7: the questioner node's directive (task_node_clarify_directives) is the
  // single source of truth (answer-stop + canvas toggle both write it; node
  // last-write-wins subsumes the RFC-123 recency gate). The questioner is guaranteed
  // to exist here (the missing-questioner guard above already failed the node), so the
  // fallback is defensive only.
  const reenableQuestionerNodeId = findQuestionerNodeForCrossClarify(definition, node.id)
  const stopped = reenableQuestionerNodeId
    ? await resolveCrossNodeStopped(db, taskId, reenableQuestionerNodeId)
    : false
  if (stopped) {
    const stopRunId = await mintNodeRun(db, {
      taskId,
      nodeId: node.id,
      status: 'pending',
      cause: 'cross-clarify-guard',
      iteration,
    })
    // RFC-217 T9: the pending→done short-circuit transition (+ its reason
    // string) is owned by the clarify service — single dispatch policy.
    const dispatched = await dispatchCrossClarifyNode({
      db,
      taskId,
      crossClarifyNodeId: node.id,
      nodeRunId: stopRunId,
      definition,
    })
    // Codex impl-gate P2-3: honor the helper's verdict. A user flipping the
    // questioner's directive stop→continue between the outer read and the
    // helper's re-read leaves the fresh row PENDING ('awaiting') — reporting
    // completion then would let clients disagree with persisted state and
    // strand the pending row. Retire the speculative mint and fall through
    // to the common awaiting path (the runner mints its own row on emit).
    if (dispatched.kind !== 'short-circuit-stop') {
      await setNodeRunStatus({
        db,
        nodeRunId: stopRunId,
        to: 'canceled',
        allowedFrom: ['pending'],
        reason: 'cross-clarify-stop-race',
        extra: { finishedAt: Date.now() },
      })
      return { kind: 'ok', summary: '', message: 'cross-clarify-stop-race' }
    }
    broadcastNodeStatus(taskId, stopRunId, node.id, 'done')
    return { kind: 'ok', summary: '', message: 'cross-clarify-persistent-stop' }
  }
  // Common path: no live row, no persistent stop, questioner valid. Don't
  // pre-create — the runner's createClarifyRound(kind='cross') will create a row
  // when the questioner emits <workflow-clarify>. Return ok so the
  // dispatcher marks this node "scheduled for this pass"; the lifecycle
  // hand-off to awaiting_human happens later via the runner path.
  return { kind: 'ok', summary: '', message: '' }
}

export async function runAgentSingleNode(
  state: SchedulerState,
  args: OneNodeArgs,
  collaboration: CollaborationNodeGatePort,
): Promise<OneNodeResult> {
  const { db, task, taskId, definition, opts, agentSem, writeSem, log } = state
  const { node, iteration } = args

  // RFC-271 T6d：解析走统一 resolver（services/ref/runtimeRef.ts），但**两个错误码
  // 与归属逐字不变**——主派发是节点级失败，与 fanout hydration 的静默跳过不同。
  const agentIdRef = pickString(node, 'agentId')
  const agentName = pickString(node, 'agentName') ?? agentIdRef ?? node.id
  const resolvedAgent = await resolveNodeAgentRef(db, node, DISPATCH_CALL_POLICY)
  if (!resolvedAgent.ok && resolvedAgent.reason === 'missing') {
    return {
      kind: 'failed',
      summary: `node ${node.id} missing canonical agentId`,
      message: 'agent-identity-missing',
    }
  }
  if (!resolvedAgent.ok) {
    return { kind: 'failed', summary: `agent '${agentName}' not found`, message: 'agent-not-found' }
  }
  // RFC-223 (T15): persisted workflow identity is the frozen id. A name-only
  // node is corrupt/quarantined data and was rejected above.
  const nodeAgent = resolvedAgent.value
  // RFC-132 ③ (借壳收官): the borrow ledgers are move-semantics (RFC-131 T4) and the immediate
  // ledger is deleted, so resolveBorrowForNode never returns an agent anymore — its remaining
  // job is the multi-ledger duplicate-execution REJECT (designer + dispatched self/q both open
  // on this home). Keep the call for that reject; the node always runs its OWN agent.
  // ConflictError surfaces as a node-level failure (don't reject the scope tick — runTask would
  // fail the WHOLE task).
  try {
    await resolveBorrowForNode(db, taskId, node.id, iteration, definition)
  } catch (err) {
    if (err instanceof ConflictError) {
      return { kind: 'failed', summary: err.message, message: err.code }
    }
    throw err
  }
  const agent = nodeAgent

  // RFC-060 PR-E: agent-multi NodeKind was removed in favor of wrapper-fanout.
  // The agent-single path below is now the sole agent dispatch path.
  // RFC-074: resolveUpstreamInputs now also returns the provenance map of which
  // upstream run each input was read from; recorded on every row this dispatch
  // mints/reuses so read-time freshness can later tell if an upstream advanced.
  const { inputs: upstreamInputs, consumed: consumedUpstream } = await resolveUpstreamInputs(
    db,
    taskId,
    definition.edges,
    node.id,
    iteration,
    log,
    definition,
    state.containerOf,
  )
  const consumedUpstreamJson = JSON.stringify(consumedUpstream)
  // RFC-022: expand the agent.dependsOn closure before resolving skills so
  // closure-member skills get unioned into the same OPENCODE_CONFIG_DIR
  // staging dir. A cycle / missing-dep here is fatal — the agent.ts save
  // guard normally prevents it; hitting one at runtime implies an external
  // SQL edit or a race against another writer. Fail loudly instead of
  // silently spawning with a broken closure.
  const injection = await resolveInjection(db, agent, { appHome: opts.appHome, log })
  if (injection.kind === 'failed') return injection
  const { dependents, skills: resolvedSkills, mcps, plugins } = injection.spec
  const promptTemplate = pickString(node, 'promptTemplate') ?? undefined
  const nodeTimeoutMs = opts.defaultPerNodeTimeoutMs
  // RFC-042: retries default to 3 so recoverable failure modes (in particular
  // the model forgetting to emit a `<workflow-output>` / `<workflow-clarify>`
  // envelope after a long tool-using session) get a chance to recover via
  // same-session follow-up before the task is failed. RFC-115: the per-node
  // `retries` override is removed — the budget is the global
  // config.defaultNodeRetries (shared default only for mock/unwired callers).
  //
  // RFC-313: 预算从一个数变成两个维度——`followupBudget` 是「同一个会话内还能追问
  // 几次」，`restartBudget` 是「这个会话被判定为无可救药后还能整体换几次干净会话」。
  // `maxRetries` 由二者的乘积公式导出，且是 attempt 数量的**唯一权威**：两个预算
  // 决定的是每次重试长什么形状（见 decideFollowupForRetry），不是还能不能再来一次。
  // restartBudget=0 时 retryAttemptCap 退化成 1+followupBudget，逐字等于 RFC-313 前。
  const followupBudget = opts.defaultNodeRetries ?? DEFAULT_PROTOCOL_RETRY_BUDGET
  const restartBudget = opts.sessionRestartBudget ?? DEFAULT_SESSION_RESTART_BUDGET
  const maxRetries = retryAttemptCap(followupBudget, restartBudget) - 1

  // RFC-005: when this node is being re-run because a downstream review node
  // was rejected/iterated, surface the rendered comments / rejection reason
  // through the {{__review_comments__}} / {{__review_rejection__}} tokens.
  // Returns undefined for first runs and for runs whose latest downstream
  // decision is approve/pending — see buildReviewPromptContext.
  const reviewContext = await buildReviewPromptContext(db, opts.appHome, node.id, taskId, iteration)
  // RFC-023: when this node has a clarify channel wired AND a clarify_iteration
  // > 0, surface the last-round Q&A through {{__clarify_*}} tokens / auto-
  // appended sections. The protocol block is appended by the runner when
  // hasClarifyChannel is true, regardless of whether there's prior context
  // (the agent needs to know it MAY ask back even on the first round).
  const hasClarifyChannel = agentHasClarifyChannel(definition, node.id)
  // RFC-056: the questioner's __clarify__ port may be wired into a
  // clarify-cross-agent node instead of (or as well as) a RFC-023 clarify
  // node. When at least one cross-clarify target exists we instruct the
  // runner to disable the 5-question cap on the envelope parser.
  // RFC-165: renamed from `clarifyMode` — that name now belongs to the clarify
  // NODE field ('optional'); this local is the channel wiring FAMILY.
  const channelKind: 'self' | 'cross' =
    findCrossClarifyNodeForQuestioner(definition, node.id) !== undefined ? 'cross' : 'self'
  // RFC-132 (PR-C): the designer's External Feedback is no longer a separate context — its questions
  // ride the unified flat clarify queue (buildClarifyQueueContext), which selects by effective target
  // regardless of the `__external_feedback__` topology, so the scheduler needs no external-feedback
  // topology gate here anymore.

  // Pick up an existing pending node_run at this iteration; otherwise create
  // a fresh run with retry_index = max-existing-in-iter + 1 (or 0).
  const sameNodeIterRuns = await db
    .select()
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.taskId, taskId),
        eq(nodeRuns.nodeId, node.id),
        eq(nodeRuns.iteration, iteration),
      ),
    )
    .orderBy(asc(nodeRuns.startedAt))
  // RFC-287 T8：取行前奏收编到 `resolveSchedulerRunRow`（四线单一实现）。
  // RFC-074 PR-C: no clarifyIteration inheritance — freshness is pure id-order
  // and the clarify generation is derived from prior-done id-order at dispatch
  // time. A process retry's External Feedback / Prior Output / questioner Q&A
  // context all key off id-order / the RFC-070 consumed-by stamps, so nothing
  // needs to be carried forward on the row.
  const resolvedRow = await resolveSchedulerRunRow({
    db,
    taskId,
    nodeId: node.id,
    iteration,
    consumedUpstreamJson,
    rows: sameNodeIterRuns,
    inheritReviewIteration: true,
    clearAgentOverride: true,
    trackRetryIndex: true,
    broadcastPending: (id) => broadcastNodeStatus(taskId, id, node.id, 'pending'),
  })
  let nodeRunId = resolvedRow.nodeRunId
  const retryIndex = resolvedRow.retryIndex
  const latestExisting = resolvedRow.latestExisting
  const inheritedReviewIteration = latestExisting?.reviewIteration ?? 0
  const inheritedShardKey = latestExisting?.shardKey ?? null
  const inheritedParentNodeRunId = latestExisting?.parentNodeRunId ?? null
  let envelopeNonce = await loadRunEnvelopeNonce(db, nodeRunId)

  // Lock order: writeSem ≺ (agentSem | scriptSem) ≺ subprocessSem (no cycles —
  // RFC-098 survey §wp5-4). RFC-266 split the old single `globalSem` into two
  // independent pools; an executor takes exactly ONE of them and never both, so
  // the split adds no new ordering edge. RFC-130 §7 SUPERSEDED the RFC-098 B1
  // "writer acquires writeSem before its global slot" model (which existed to
  // stop queued writers starving readers): there is no whole-run write lock now
  // — each node runs in its OWN isolated worktree, so writeSem is held only for
  // the brief snapshot-at-dispatch (§段①) + merge-back (§段③), never across the
  // multi-minute agent run. The pool slot is the real DAG-parallelism cap now
  // (writeSem + pool are never held together — §7.2 deadlock analysis; the merge
  // agent bypasses the pool to avoid a cycle).
  // §段①: snapshot canonical worktree(s) + branch an isolated worktree under a
  // brief writeSem window. On failure release the slot and fail the node (the
  // canonical worktree is never touched, so nothing to roll back).
  // The iso path + refs are keyed by the ORIGINAL nodeRunId (`isoKeyRunId`) — it
  // stays stable across the internal retry loop (which mints fresh node_run rows),
  // so a same-session follow-up keeps the exact same iso worktree (D17).
  const isoKeyRunId = nodeRunId
  let isoHandle: IsoHandle

  let lastResult: RunResult | null = null
  let lastError: string | null = null
  // RFC-122 (same-session follow-up fix): the PRIOR attempt's
  // effectiveHasClarifyChannel. A same-session envelope follow-up re-anchors the
  // agent on "the format previously specified in this session"; that is only
  // valid when this attempt runs in the SAME mode (clarify vs output) as the
  // prior one. A per-attempt STOP-toggle flip can switch the mode mid-loop (e.g.
  // attempt 0 clarify-only → attempt 1 output), and the prior session never
  // emitted the now-needed protocol. When the mode flips we bypass the follow-up
  // and rebuild the FULL renderUserPrompt instead. Seeded false (attempt 0 never
  // follows up). Within a retry loop only nodeStopOverride varies per attempt, so
  // a flip ⟺ a toggle change ⇒ golden-lock: no toggle ⇒ never flips.
  let priorAttemptClarifyActive = false

  // RFC-287 T7：本线迁入装配骨架（**模式 B**——一次许可 + 一棵 iso 贯穿全部 attempt，
  // 窗口内由 retryPolicy 驱动多次 spawn；D17 要求同会话续跑必须落在同一棵树上）。
  //
  // **拆分手术**：窗口只到「合并相位收束」为止，clarify 落库那段收尾**留在窗口外**。
  // 现状顺序是「先释放许可 + 按 keep 清理 iso，再建 clarify 轮次」；把收尾挪进窗口
  // 会让 daemon 级 agent 许可多握住一段 DB 写——那是行为变更，不是重构。故 TResult
  // 取判别式：窗口内已定局的直接回传，需要窗口外收尾的回 `{ kind: 'ran' }`。
  type AgentWindowOut =
    | { kind: 'settled'; out: OneNodeResult }
    | { kind: 'ran'; result: RunResult | null }
  // keepIf 里算出的 RFC-042 续跑决策 memo。骨架保证每轮重试的调用序是
  // keepIf →〔换树〕→ onNextAttempt → spawn（rfc287-t2 骨架单测钉死），所以
  // onNextAttempt / spawn 读到的一定是本轮的决策。
  let followupDecision: EnvelopeFollowupDecision = { followup: false }
  let followupResumeSessionId: string | undefined
  // RFC-313: 重试形状的跨 attempt 状态（只在本次 dispatch 的闭包内有意义，不持久化
  // ——daemon 重启 / 人工 retryNode 都会重新进入执行器并从零开始，与既有 attempt
  // 计数语义一致）。`pendingRestartReason` 只有 `decideFollowupForRetry` 一个写者
  // （每轮先复位再按形状赋值），spawn 侧只读——于是「上一轮的告知漏进这一轮」这个
  // 窗口从结构上就不存在。
  let retryShapeState: RetryShapeState = { followupChainLen: 0, restartsUsed: 0 }
  let pendingRestartReason: EnvelopeFollowupReason | undefined
  // RFC-313 实现门 P1-1：上一次 attempt 观察到的 STOP 开关值（undefined = 还没有过
  // attempt）。用它在 keepIf 里判断「本轮有没有待处理的模式翻转」——依据是紧邻上面
  // 那条既有不变量：**retry 循环内只有 nodeStopOverride 逐 attempt 变化，所以
  // 「翻转」⟺「开关变了」**。因此这里不是把 effectiveHasClarifyChannel 再导一遍
  // （那会是第二处导出、必然漂移），而是复用同一个 `getNodeClarifyDirectiveRow` 源。
  let priorAttemptStopOverride: boolean | undefined

  /**
   * 每次重试前奏：算 RFC-042 续跑决策。它同时**就是**「要不要留用同一棵树」的判据
   * ——续跑必须在同一棵树上恢复（D17），换新会话则丢弃重建。
   */
  const decideFollowupForRetry = async (prev: RunResult | null): Promise<boolean> => {
    followupDecision = { followup: false }
    followupResumeSessionId = undefined
    // 本函数是 pendingRestartReason 的唯一写者：每轮先复位，再按形状赋值，
    // 这样 spawn 侧只读不清，也就不存在「上一轮的告知漏进这一轮」的窗口。
    pendingRestartReason = undefined
    if (prev !== null) {
      // RFC-313 实现门 P1-2：**框架自写的审计事件也是 kind='text'**（rfc042 续跑、
      // rfc049 端口校验、rfc313 会话升级三处，都写在**新铸的那一行**上），所以不过滤
      // 的话第 1 次之后每一次 attempt 的计数恒 ≥1 —— RFC-042 那条「模型必须说过话」
      // 的判据在第 2 次起就失效了（这是 RFC-042 就有的缺陷，RFC-313 只是多加了一个
      // producer；按用户拍板在本 RFC 内一并修，因为整条形状判定正架在这个判据上）。
      // 排除判据是载荷前缀：框架审计载荷一律以 `[rfc` 开头，由 rfc313-source-locks
      // 的断言钉死。误伤面是保守的——万一模型的正文真以 `[rfc` 开头，结果只是这一轮
      // 退回 fresh（换会话重来），不会错误地续跑一个没说过话的会话。
      const agentTextCount = await countAgentTextEvents(db, nodeRunId)
      // RFC-049: read the structured port-validation failures the prior
      // attempt's runner persisted (NULL → undefined; malformed JSON →
      // null via parsePortValidationFailuresJson, then coerced to
      // undefined for the decision input). decideEnvelopeFollowup uses
      // the failures array to populate the per-port repair prompt; absent
      // / empty arrays degrade gracefully (followup still fires on the
      // outer prefix, but the prompt skips per-kind specifics).
      const priorRunRow = (
        await db
          .select({ pvf: nodeRuns.portValidationFailuresJson })
          .from(nodeRuns)
          .where(eq(nodeRuns.id, nodeRunId))
          .limit(1)
      )[0]
      const priorFailures = parsePortValidationFailuresJson(priorRunRow?.pvf ?? null)
      followupDecision = decideEnvelopeFollowup({
        status: prev.status,
        exitCode: prev.exitCode,
        failureCode: prev.failureCode ?? null,
        sessionId: prev.sessionId ?? null,
        agentTextCount,
        ...(priorFailures !== null ? { portValidationFailures: priorFailures } : {}),
      })
      // RFC-313: RFC-042 的五条判据（上一行）只回答「这次失败可不可以在同一个会话里
      // 改」；能改**不代表还应该继续在这个会话里改**——上下文已经打满 / 模型陷在
      // 循环里时，追问是零收益甚至负收益的自旋（每条纠错提示还在加剧根因）。形状由
      // 共享纯函数在判据之上再判一层：链未触顶 → 接续；触顶且有升级预算 → 主动换
      // 一个干净会话重来；判据落空 → 维持既有的全新会话重试（不吃升级预算）。
      // RFC-313 实现门 P1-1：升级会丢树 + 扣预算，而一次待处理的 STOP 翻转按 RFC-122
      // 应当「保树 + 走完整 prompt」。keepIf 跑在 spawn 之前，若不在这里看一眼开关，
      // 链顶恰逢翻转时升级会抢先生效，把用户的正常翻转执行成升级（AC-8 违反 + 未合并
      // 成果丢失）。只读这一个值、只在挂了 clarify 通道时读。
      const stopOverrideNow = hasClarifyChannel
        ? (await getNodeClarifyDirectiveRow(db, taskId, node.id))?.directive === 'stop'
        : false
      const clarifyFlipPending =
        priorAttemptStopOverride !== undefined && stopOverrideNow !== priorAttemptStopOverride
      const { shape, next } = decideRetryShape({
        followup: followupDecision,
        state: retryShapeState,
        followupBudget,
        restartBudget,
        ...(clarifyFlipPending ? { suppressRestart: true } : {}),
      })
      retryShapeState = next
      if (shape.kind === 'followup') {
        followupResumeSessionId = prev.sessionId ?? undefined
      } else {
        // 升级 / 全新会话都不发短提示：把 RFC-042 的决策收回，后续所有「followup
        // 才做」的动作（抄 envelopeNonce、带 resumeSessionId、跳过记忆注入与清单）
        // 因此自动不做——这正是本 RFC 改动面极小的原因。
        followupDecision = { followup: false }
        pendingRestartReason = shape.kind === 'restart' ? shape.reason : undefined
      }
    }
    // 续跑 ⇒ 留用同一棵树（D17）；换新会话（升级或崩溃后重来）⇒ 骨架负责丢弃 + 重建。
    return followupDecision.followup
  }

  /**
   * 每次重试的副作用（骨架在「iso 处置之后、spawn 之前」调用）：铸新行、把 iso 列
   * 抄到新行、广播、写审计事件。`attempt` 是绝对序号（retryIndex + 骨架轮次）。
   */
  const prepareRetryAttempt = async (attempt: number): Promise<void> => {
    {
      {
        // RFC-074 PR-C: a process-retry within the same clarify round surfaces
        // the answered Q&A via id-order generation derivation + the RFC-070
        // consumed-by stamps, not a carried clarifyIteration. shardKey /
        // parentNodeRunId still belong to this run-of-the-node and persist.
        nodeRunId = await mintNodeRun(db, {
          taskId,
          nodeId: node.id,
          status: 'pending',
          cause: 'process-retry',
          retryIndex: attempt,
          iteration,
          overrides: {
            reviewIteration: inheritedReviewIteration,
            shardKey: inheritedShardKey,
            parentNodeRunId: inheritedParentNodeRunId,
            consumedUpstreamRunsJson: consumedUpstreamJson,
            ...(followupDecision.followup && envelopeNonce.length > 0 ? { envelopeNonce } : {}),
          },
        })
        envelopeNonce = await loadRunEnvelopeNonce(db, nodeRunId)
        broadcastNodeStatus(taskId, nodeRunId, node.id, 'pending')
        // RFC-130: carry the iso columns onto the freshly-minted retry row so a
        // crash mid-retry can still find the iso worktree (the physical iso is
        // keyed by isoKeyRunId and shared across the invocation's attempts).
        await persistIsoBase(db, nodeRunId, task.repoCount, isoHandle)

        // RFC-042 / RFC-049: surface the follow-up decision as an audit
        // event so operators can replay how a green run recovered from a
        // failed prior attempt. Written on the FRESH row (so it sits in the
        // events list for the attempt that's about to run, not the failed
        // prior attempt). reason='port-validation' uses its own tag /
        // payload shape (RFC-049 §A6) so log aggregators can filter the
        // two failure classes apart.
        if (followupDecision.followup) {
          if (followupDecision.reason === 'port-validation') {
            // One audit row per failing port — keeps the payload symmetric
            // with how runner.ts persists multiple failures in the JSON
            // column (today fail-fast → always length 1, but the schema is
            // ready for the future batch-validate path).
            const failures =
              followupDecision.failures.length > 0
                ? followupDecision.failures
                : [{ port: '', kind: '', subReason: '' }]
            for (const f of failures) {
              withTaskExecutionMutation({
                db,
                taskId,
                run: (tx) =>
                  tx
                    .insert(nodeRunEvents)
                    .values({
                      nodeRunId,
                      ts: Date.now(),
                      kind: 'text',
                      payload: `[rfc049/port-validation-followup] ${JSON.stringify({
                        rfc: 'RFC-049',
                        port: f.port,
                        kind: f.kind,
                        subReason: f.subReason,
                        retryAttempt: attempt,
                      })}`,
                    })
                    .run(),
              })
            }
          } else {
            const followupReason = followupDecision.reason
            withTaskExecutionMutation({
              db,
              taskId,
              run: (tx) =>
                tx
                  .insert(nodeRunEvents)
                  .values({
                    nodeRunId,
                    ts: Date.now(),
                    kind: 'text',
                    payload: `[rfc042/envelope-followup] ${JSON.stringify({
                      rfc: 'RFC-042',
                      reason: followupReason,
                      retryAttempt: attempt,
                    })}`,
                  })
                  .run(),
            })
          }
        }

        // RFC-313: 主动会话升级的审计行。写在**新铸的那一行**上（与 rfc042 的续跑
        // 事件同址同形），于是任务详情页的事件流里，「接续」与「换脑重来」是两条可
        // 区分的痕迹——用户拍板不新增 rerun cause，事件流就是唯一的区分面。
        // 与上面的 followup 分支互斥：升级时 followupDecision 已被收回成 false。
        if (pendingRestartReason !== undefined) {
          withTaskExecutionMutation({
            db,
            taskId,
            run: (tx) =>
              tx
                .insert(nodeRunEvents)
                .values({
                  nodeRunId,
                  ts: Date.now(),
                  kind: 'text',
                  payload: `[rfc313/session-restart] ${JSON.stringify({
                    rfc: 'RFC-313',
                    reason: pendingRestartReason,
                    abandonedAfterFollowups: followupBudget,
                    restartsUsed: retryShapeState.restartsUsed,
                    retryAttempt: attempt,
                  })}`,
                })
                .run(),
          })
        }
      }
    }
  }

  /**
   * 一次 attempt 的完整机身（骨架每轮调一次）。`k` 是骨架轮次（0 起），绝对 attempt
   * 序号 = retryIndex + k —— 与迁移前 `for (attempt = retryIndex; …)` 的取值逐一对应。
   * 返回本次的 RunResult；跨 attempt 的携带量（lastResult / lastError / nodeRunId /
   * isoHandle / envelopeNonce / priorAttemptClarifyActive）仍是闭包上的 let，语义不变。
   */
  const runOneAttempt = async (): Promise<RunResult | null> => {
    // RFC-130: the RFC-092/098 pre-snapshot (git stash create → pre_snapshot
    // columns) is GONE — the iso model never writes the canonical worktree, so
    // there is nothing to roll back. Retry re-branches a fresh iso from the
    // current canonical state (see the fresh-session block above). The
    // pre_snapshot columns + rollbackNodeRunWorktrees stay in the schema as
    // defense-in-depth (design.md D10) but are no longer written here.

    try {
      // RFC-023: read this row so the prompt context surfaces the prior
      // round's Q&A. The row may have been minted at any of three sites
      // (pendingExisting, retry-mint, clarify-rerun mint from clarify
      // service); reading off the DB guarantees we see whatever each path set.
      const currentRunRow = (
        await db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)).limit(1)
      )[0]
      const currentShardKey = currentRunRow?.shardKey ?? null

      // RFC-074 PR-C: the clarify "generation" is derived from id-order, NOT
      // the retired `clarifyIteration` counter. The prior top-level `done`
      // rows for this node at the same (iteration, shardKey), minted before
      // this run (id < current), each represent an earlier completed clarify
      // generation; their count is the generation index the counter used to
      // hold. `done` (not canceled) so review-iterate supersede markers don't
      // inflate it, and parentNodeRunId === null so fan-out shard children
      // don't either.
      const priorDoneGenerations = currentRunRow
        ? await priorDoneGenerationsForRun(db, {
            taskId,
            nodeId: node.id,
            iteration: currentRunRow.iteration,
            shardKey: currentShardKey,
            id: currentRunRow.id,
          })
        : []
      const clarifyGeneration = priorDoneGenerations.length

      // RFC-026: resolve sessionMode from the clarify node attached to this
      // agent (if any). `inline` only takes effect when the current run IS
      // a clarify-driven rerun.
      // RFC-098 WP-10 (audit S-25): "is a clarify-driven rerun" is read off
      // the row itself now — the mint factory records WHY every row exists
      // (node_runs.rerun_cause, migration 0044) and gate-2 switches on it
      // instead of the old `clarifyGeneration > 0 && retryIndex === 0`
      // proxy:
      //   - 'clarify-answer' / 'cross-clarify-questioner-rerun' → TRUE
      //     (the same logical round continues after a human answered);
      //   - 'process-retry' → FALSE (design.md §7 forbids inline resume on
      //     technical retries — deterministic retry behavior);
      //   - fresh scheduler mints ('initial' / 'stale-redispatch' /
      //     'revival') → FALSE (no prior session of the same round);
      //   - NULL (pre-0044 row dispatched across a daemon upgrade) → FALSE
      //     (documented boundary degradation — see isClarifyRerunCause).
      // The (consumerKind × cause) truth table is pinned by
      // rfc098-rerun-cause-gates.test.ts.
      const clarifyNodeForGate = hasClarifyChannel
        ? findClarifyNodeForAgent(definition, node.id)
        : undefined
      const clarifyNodeObjForGate = clarifyNodeForGate
        ? (findClarifyNode(definition, clarifyNodeForGate) as ClarifyNode | undefined)
        : undefined
      // RFC-056 A16: a cross-clarify questioner rerun honors the cross-clarify
      // node's `sessionModeForQuestioner`. The self-clarify findClarifyNode
      // lookup above returns undefined for the cross node (it is not a
      // `clarify` kind), so without this the questioner would silently stay
      // isolated even when the user picked inline in the editor. Resolve the
      // cross node via the SAME helper `channelKind` itself uses
      // (findCrossClarifyNodeForQuestioner) rather than reusing
      // clarifyNodeForGate: a questioner can wire BOTH a self-clarify and a
      // cross-clarify `__clarify__` edge, and findClarifyNodeForAgent returns
      // whichever edge is first — if the self edge wins, clarifyNodeForGate
      // points at the self clarify node and the cross node's
      // sessionModeForQuestioner would be silently ignored. (Codex review #3.)
      const crossQuestionerNodeId =
        channelKind === 'cross' ? findCrossClarifyNodeForQuestioner(definition, node.id) : undefined
      const crossQuestionerNode = crossQuestionerNodeId
        ? (definition.nodes.find(
            (n) => n.id === crossQuestionerNodeId && n.kind === 'clarify-cross-agent',
          ) as ClarifyCrossAgentNode | undefined)
        : undefined
      const sessionMode = crossQuestionerNode
        ? resolveCrossClarifySessionMode(crossQuestionerNode)
        : clarifyNodeObjForGate
          ? resolveClarifySessionMode(clarifyNodeObjForGate)
          : 'isolated'
      const isClarifyRerun = isClarifyRerunCause(currentRunRow?.rerunCause)
      const priorSessionId =
        isClarifyRerun && currentRunRow
          ? await readPriorAgentSessionId(db, {
              taskId,
              agentNodeId: node.id,
              shardKey: currentShardKey,
              iteration: currentRunRow.iteration,
              beforeId: currentRunRow.id,
            })
          : null
      // RFC-026 fallback reasons recorded via `recordClarifyInlineEvent`
      // below:
      //   - 'missing-session-id'           — decideResumeSessionId, pre-spawn
      //   - 'session-not-found'            — stderr inspection, post-spawn
      //   - 'session-resume-unsupported'   — reserved for an explicit
      //                                      behavior/capability probe (not
      //                                      inferred from a version string)
      const resumeDecision = decideResumeSessionId({
        sessionMode: isClarifyRerun ? sessionMode : 'isolated',
        sourceSessionId: priorSessionId,
      })
      if (resumeDecision.fallbackReason !== undefined) {
        await recordClarifyInlineEvent(db, nodeRunId, {
          level: 'warning',
          reason: resumeDecision.fallbackReason,
          extra: { clarifyGeneration },
        })
      }

      // RFC-132 (PR-C): the designer's §6 update-mode prior output is no longer fetched here (the
      // cross-clarify-specific designer working-draft fetch + its dedicated prior-output block are
      // gone). A designer responding to feedback now surfaces its working draft through the SAME
      // generalized RFC-119 prior-output path every other rerun uses (`freshestPriorRunWithOutput`
      // below). RFC-141 removed the RFC-120 §18 pure-override handoff suppression that used to
      // gate it — an override target now sees its own draft too.

      // RFC-132 (PR-C): the standing continue/stop directive is read SOLELY from the per-(task,
      // asking-node) clarify state (design §7) — the per-round directive concept is gone. The flat
      // injector (buildClarifyQueueContext) carries no directive; the scheduler drives
      // effectiveHasClarifyChannel / clarifyStopped / clarifyStopNotice from nodeDirective /
      // nodeStopOverride below. So the former per-role SELECT fork + the per-round directive-override
      // plumbing (which only fed the round-grouped injectors) are gone — selectAgentQueue queries
      // every role in one shot.
      //
      // RFC-122 (H1 fix): read the node directive AT DISPATCH (parallel to RFC-056 resolveCrossNodeStopped)
      // INSIDE the retry loop so EVERY attempt's freshly-minted process-retry row reads the LATEST
      // toggle (a flip while attempt N runs is honored by attempt N+1). Gated on hasClarifyChannel
      // (self-clarify AND cross-questioner both wire the same `__clarify__` source port); every
      // other node skips the read ⇒ undefined ⇒ nodeStopOverride=false.
      // RFC-123 (B1): read the FULL directive (not just === 'stop') so an explicit 'continue' toggle
      // can re-open a stopped channel (nodeStopOverride flips false → resolveEffectiveClarifyChannel
      // re-opens). No row ⇒ undefined ⇒ byte-for-byte unchanged.
      const nodeDirectiveRow = hasClarifyChannel
        ? await getNodeClarifyDirectiveRow(db, taskId, node.id)
        : undefined
      const nodeDirective = nodeDirectiveRow?.directive
      const nodeStopOverride = nodeDirective === 'stop'
      // RFC-132 (PR-C): the SINGLE unified deferred injector. selectAgentQueue pulls this node's
      // whole agent queue — self / questioner / designer / manual — in ONE query (design §2
      // "consumerKind 消失"), binds it to this rerun (承接 marker), and renders one flat
      // `## Clarify Q&A` block (§5). It replaces the former split self/questioner + designer
      // injectors: a designer's questions now ride the SAME block (§5 ②b), so there is no separate
      // designer External-Feedback context / `## External Feedback` section. Called for EVERY agent
      // node — an override / borrow target can hold a
      // reassigned question yet wire no clarify channel of its own (this mirrors the pre-PR-C
      // UNCONDITIONAL per-node-queue designer call). An empty queue ⇒ undefined ⇒ no injection.
      const clarifyQueue = await buildClarifyQueueContext({
        db,
        definition,
        taskId,
        consumerNodeId: node.id,
        dispatchedRunId: nodeRunId,
        iteration,
        envelopeNonce,
        // RFC-026: an inline resume is an incremental message. Entries
        // bound to earlier clarify runs already live in that OpenCode
        // transcript; inject only the unbound/current-run delta. Isolated
        // and fallback runs still receive the complete un-aged queue.
        currentRunOnly: resumeDecision.inlineMode,
      })
      // RFC-141: the RFC-120 §18 pure-override handoff suppression (`suppressPriorOutput`) is
      // GONE by user ruling — the reassigned Q&A rides the flat block below, and the prior-output
      // sections render alongside it as the node's own background.
      const clarifyContext =
        clarifyQueue === undefined
          ? undefined
          : {
              // renderUserPrompt emits this verbatim + skips the legacy round-grouped sections.
              flatBlock: clarifyQueue.block,
              iteration: String(clarifyGeneration),
              remaining: computeRemaining(definition, node.id, clarifyGeneration),
              // Inline session resume suppresses input re-injection, swaps the trailing
              // reminder, and carries only the queue delta not already in the transcript.
              ...(resumeDecision.inlineMode ? { mode: 'inline' as const } : {}),
            }
      // effectiveHasClarifyChannel is the "mandatory ask-back is ACTIVE" signal
      // threaded to the runner + renderUserPrompt (RFC-100). It is TRUE only
      // when the agent is in a genuine clarify round and must ask back:
      //   - hasClarifyChannel: the agent wired a clarify channel, AND
      //   - directive !== 'stop' (RFC-023): the user has not clicked
      //     "Stop clarifying" — a stop round finalizes with <workflow-output>;
      //     the answersBlock already carries the STOP CLARIFYING sentence. The
      //     next round walks back through scheduleAgentNode and re-derives the
      //     flag, so 'stop' naturally scopes to one rerun, AND
      //   - (reviewContext === undefined || isClarifyRerun) (RFC-100 + Codex
      //     review #1 fix): a review reject/iterate RE-PRODUCTION run is NOT a
      //     clarify round — it must produce <workflow-output> to address the
      //     reviewer's comments, so reviewContext disables mandatory ask-back for
      //     it (without this a clarify-channel designer could never satisfy a
      //     review iterate; its v2 output would be rejected as clarify-required).
      //     BUT a clarify-answer rerun that happens DURING a review-iterate cycle
      //     (the designer asked back, the user answered) IS a clarify round and
      //     must honor its directive — so isClarifyRerun re-enables the gate
      //     there. Otherwise a "Keep clarifying" answer mid-review would be
      //     bypassed and the agent could finalize before the user clicks Stop.
      //     RFC-183: on a pure iterate/reject re-production the runner now
      //     REJECTS a voluntary <workflow-clarify> (directive 'suppressed'
      //     ⇒ disposition 'reject') — output is the only accepted reply.
      //
      // RFC-122: extracted to the pure `resolveEffectiveClarifyChannel` oracle
      // and extended with the per-(task, asking-node) `nodeStopOverride` term —
      // the on-canvas "停止反问" toggle forces ask-back off here for BOTH self and
      // cross. `nodeStopOverride=false` reproduces the exact pre-RFC-122 boolean
      // (golden-lock).
      //
      // RFC-183 (Codex design-gate P2#1/P2#4): the oracle's isClarifyRerun
      // input is LINEAGE-aware, not current-cause-only. A clarify-answer /
      // cross-questioner round that dies technically continues as
      // cause='process-retry' (attempt loop) or — across a daemon restart —
      // cause='revival'; both sit outside isClarifyRerunCause BY DESIGN
      // (RFC-098 修订 #11: that gate owns inline-resume / Q&A derivation).
      // Feeding the raw cause here made those continuation rounds degrade
      // to 'suppressed' — zero clarify bytes, and post-RFC-183 a hard
      // reject — against the user's "Keep clarifying". The persisted cause
      // chain decides instead; the inline-resume gate above deliberately
      // keeps the raw `isClarifyRerun` (technical retries never resume).
      const lineageCauses = currentRunRow
        ? await lineageCausesNewestFirst(db, {
            taskId,
            nodeId: node.id,
            iteration: currentRunRow.iteration,
            shardKey: currentShardKey,
            id: currentRunRow.id,
          })
        : []
      const clarifyLineageContinues = continuesClarifyLineage(lineageCauses)
      const effectiveHasClarifyChannel = resolveEffectiveClarifyChannel({
        hasClarifyChannel,
        // RFC-132 (PR-C): the standing directive is the node clarify state (design §7); the flat
        // context carries none. nodeStopOverride already covers `=== 'stop'`, so this is redundant
        // with it but kept explicit for the oracle's contract (golden-lock).
        contextDirective: nodeDirective,
        nodeStopOverride,
        reviewActive: reviewContext !== undefined,
        isClarifyRerun: clarifyLineageContinues,
      })
      // RFC-123 follow-up (user「强制停止」): is the node EXPLICITLY stopped? RFC-132 (PR-C): a
      // 'stop' answer already writes the per-node clarify state (clarifySeal.setNodeClarifyDirective),
      // so the node directive IS the single source — `nodeStopOverride` alone captures both the canvas
      // toggle AND a latest answered 'stop'. Threaded to the runner so a disobedient
      // <workflow-clarify> is REJECTED (no session) under an explicit stop, while review reruns
      // (reviewActive && !isClarifyRerun) keep emitting clarify.
      const clarifyStopped = hasClarifyChannel && nodeStopOverride
      // RFC-165 (F12): the wired SELF-clarify node may declare
      // clarifyMode:'optional' — the channel is offered, never enforced.
      // Precedence stopped > optional > mandatory/suppressed; every rerun
      // (initial / retry / post-answer) recomputes from the same static
      // node field, so answering a round can never re-escalate the node to
      // mandatory. Cross channels carry no clarifyMode (undefined ⇒ off).
      const clarifyOptional = hasClarifyChannel && clarifyNodeObjForGate?.clarifyMode === 'optional'
      // RFC-122 (H2 fix), RFC-132 (PR-C): inject the standalone STOP CLARIFYING trailer whenever the
      // node is stopped. The flat block NEVER carries a per-question directive trailer (§5), so —
      // unlike the round-grouped path — the trailer's ONLY source is this notice. `contextDirective:
      // undefined` makes shouldInjectStopNotice return `nodeStopOverride` (the block can never
      // already carry it), so a stopped node always gets exactly one STOP trailer (first run /
      // review-rerun / answered-stop alike).
      const clarifyStopNotice = shouldInjectStopNotice({
        nodeStopOverride,
        contextDirective: undefined,
      })
      // RFC-122 (same-session follow-up fix): a same-session envelope follow-up
      // (renderEnvelopeFollowupPrompt) re-anchors on "the format previously
      // specified in this session" WITHOUT re-emitting the full protocol. If the
      // per-attempt STOP toggle flipped this attempt's clarify-vs-output mode
      // relative to the prior attempt, that format was never specified in the
      // resumed session — so bypass the follow-up and let the FULL
      // renderUserPrompt render the correct protocol (output-port list +
      // clarifyStopNotice, or the mandatory ask-back block) from scratch.
      // Bidirectional (stop→output AND output→stop). Golden-lock: with no toggle
      // the mode is stable across attempts ⇒ false ⇒ follow-up path unchanged.
      const clarifyModeFlip =
        followupDecision.followup && priorAttemptClarifyActive !== effectiveHasClarifyChannel
      priorAttemptClarifyActive = effectiveHasClarifyChannel
      // RFC-313 实现门 P1-1：与上一行同址更新——两个「上一次 attempt 的观察值」必须
      // 在同一个点写，否则它们会各自漂移到不同的 attempt 边界上。
      priorAttemptStopOverride = nodeStopOverride
      // RFC-119 / RFC-132 (PR-C) / RFC-141: generalized prior-output for ANY rerun — review
      // reject/iterate (supersede→canceled), manual retry, cascade, resume, clarify-answer,
      // mandatory ask-back rounds, override handoffs, AND the cross-clarify designer (whose
      // dedicated prior-output path was removed — a designer responding to feedback surfaces
      // its working draft through THIS single path). RFC-141 (user ruling) removed two former
      // gates:
      //   - RFC-119 D6 "mandatory ask-back suppresses" — its "nearly impossible" premise was
      //     disproved (a node with a done draft re-enters ask-back on every new answer batch;
      //     evidence: QMGP5 agent_m7p3n1 retry 17). renderUserPrompt now picks the ask-back
      //     directive variant off the same hasClarifyChannel signal that picks the trailing
      //     protocol, so the wording cannot contradict the clarify-only round.
      //   - RFC-120 §18 "pure-override handoff suppresses" — the override target now sees its
      //     own draft as background; the reassigned Q&A rides `## Clarify Q&A`.
      // Still skipped on inline session resume (the resumed session already holds the prior
      // output — re-injecting wastes tokens and re-anchors on stale text).
      // D10: on a review-ITERATE, RFC-014's `## Sibling Outputs` already carries the sibling ports;
      // restrict to the iterate-target port so the two don't duplicate. review-reject / non-review
      // reruns → all ports (onlyPorts undef).
      let priorOutputUpdate: { block: string } | undefined
      if (currentRunRow !== undefined && !resumeDecision.inlineMode) {
        const priorRun = await freshestPriorRunWithOutput(db, {
          taskId,
          nodeId: node.id,
          iteration: currentRunRow.iteration,
          shardKey: currentShardKey,
          id: currentRunRow.id,
        })
        if (priorRun !== undefined) {
          const onlyPorts =
            reviewContext?.iterateTargetPort !== undefined
              ? new Set([reviewContext.iterateTargetPort])
              : undefined
          const block = await composePriorOutputBlock(
            db,
            priorRun.id,
            agent.outputs ?? [],
            onlyPorts,
            envelopeNonce,
          )
          if (block.length > 0) priorOutputUpdate = { block }
        }
      }
      if (resumeDecision.inlineMode && resumeDecision.resumeSessionId !== undefined) {
        await recordClarifyInlineEvent(db, nodeRunId, {
          level: 'info',
          sessionIdPrefix: resumeDecision.resumeSessionId.slice(0, 8),
          extra: { clarifyGeneration },
        })
      }
      // RFC-042: follow-up attempts re-use the prior attempt's opencode
      // session id (captured above into `followupResumeSessionId`) AND swap
      // the prompt for a short re-anchor directive. The RFC-026 inline
      // clarify-rerun resume path only fires on the FIRST attempt of a
      // clarify-driven rerun (rows whose rerun_cause is in the gate-2 set;
      // follow-up attempt rows are minted cause='process-retry' and gate
      // FALSE) so the two paths cannot fight over the same
      // `resumeSessionId` slot. When both contexts are present,
      // follow-up wins because it expresses what THIS attempt is for.
      // RFC-122 (mode-flip session-clear): a STOP-toggle mode flip already
      // bypasses the same-session follow-up PROMPT (clarifyModeFlip → full
      // renderUserPrompt). Don't then resume the prior (wrong-mode) opencode
      // session for it — the prior session is clarify-only or output-only and
      // resuming it would feed the full fresh-mode prompt into a contradictory
      // conversation. On a flip we fall to resumeDecision.resumeSessionId, which
      // for a process-retry ('isolated') is undefined ⇒ a FRESH session matching
      // the full prompt. Golden-lock: no flip ⇒ `&& !clarifyModeFlip` is a no-op
      // ⇒ same-session resume byte-identical to today. (The worktree rollback +
      // pre-snapshot stay gated on followupDecision.followup — see the RFC-122
      // residual note: downgrading those needs the directive at loop top, which
      // is entangled with buildPromptContext; tracked as a follow-up.)
      // RFC-127 F1 + Codex impl-gate P2: a same-attempt envelope follow-up
      // (followupResumeSessionId is THIS attempt's own session) stays paired with
      // envelopeFollowup mode (the runner renders only the short repair prompt).
      // (RFC-132 ③: the borrowed-row special case is gone with the borrow ledger —
      // a node always runs its own agent, so the inline resume is always its own.)
      const effectiveResumeSessionId =
        followupDecision.followup && !clarifyModeFlip
          ? followupResumeSessionId
          : resumeDecision.resumeSessionId
      // RFC-132 (PR-C): the follow-up strong-bias trailer (renderEnvelopeFollowupPrompt) fires on
      // clarifyDirective==='continue'. When effectiveHasClarifyChannel is true the node IS in
      // ask-back ("keep clarifying") mode, so the directive is 'continue' by construction. Gate on a
      // non-empty flat queue (clarifyContext defined) to preserve the legacy "no trailer on a
      // first-ever run with no answered round" behavior (the per-round directive was undefined
      // there).
      const followupClarifyDirective =
        followupDecision.followup && effectiveHasClarifyChannel && clarifyContext !== undefined
          ? ('continue' as const)
          : undefined
      // RFC-111 D15: read the runtime frozen onto this node_run, or freeze it
      // now (agent.runtime ?? config.defaultRuntime) on the first dispatch.
      // resume/retry of the same row read the frozen value so a mutated
      // agent / default can't re-route a captured session to the wrong runtime.
      // RFC-112 P1: a retry / clarify-rerun mints a FRESH row but may carry a
      // prior session id — inherit that session owner's frozen (protocol,
      // binary) so the id + runtime stay a pair across the new row.
      const inheritedRuntime =
        effectiveResumeSessionId !== undefined
          ? await frozenRuntimeOfSession(db, effectiveResumeSessionId)
          : null
      const frozenRuntime = await resolveFrozenRuntime(
        db,
        nodeRunId,
        agent.runtime,
        state.opts.defaultRuntime,
        inheritedRuntime,
        freezeBinaryConfig(state.opts.configPath),
      )
      lastResult = await runNode({
        taskId,
        nodeRunId,
        nodeId: node.id,
        agent,
        triggerContext: state.triggerContext,
        runtime: frozenRuntime.protocol,
        runtimeBinary: frozenRuntime.binary,
        runtimeParams: frozenRuntime.params,
        runtimeConfigDir: frozenRuntime.configDir, // RFC-154: frozen config-dir profile
        inputs: upstreamInputs,
        // RFC-130 D16: the opencode cwd + ALL path-bearing template tokens point
        // at the ISOLATED worktree, not the canonical one — otherwise the agent
        // would be told (via {{__repo_path__}} / {{__repos__}}) to edit a path
        // outside its isolation. repos[].repoPath stays the source repo (an origin
        // reference, not a cwd); repos[].worktreePath becomes the per-repo iso.
        worktreePath: isoHandle.repos[0]?.isoWorktreePath ?? task.worktreePath,
        // Trusted platform-input mounts identify a digital-employee action.
        // Its Agent may edit business files but Git lifecycle is platform-only.
        ...(task.platformInputPathsJson !== null
          ? { gitMutationPolicy: 'read-only' as const }
          : {}),
        // RFC-067: thread per-task Git commit identity through to the runner
        // so `git commit` invocations inside the agent inherit the
        // task-scoped author + committer. Both NULL → runner skips
        // injection and falls back to daemon's default git config.
        gitUserName: task.gitUserName,
        gitUserEmail: task.gitUserEmail,
        templateMeta: {
          repoPath: isoHandle.repos[0]?.isoWorktreePath ?? task.repoPath,
          baseBranch: task.baseBranch,
          taskId,
          nodeId: node.id,
          iteration,
          // RFC-066: per-repo metadata for the {{__repos__}} /
          // {{__repo_names__}} / {{__repo_count__}} placeholders.
          repos: isoHandle.repos.map((r) => ({
            repoPath: r.repoPath,
            worktreePath: r.isoWorktreePath,
            worktreeDirName: r.worktreeDirName,
            mountPath: r.worktreeDirName,
            subdir: '',
            readonly: false,
            baseBranch: r.baseBranch,
          })),
        },
        ...(promptTemplate !== undefined ? { promptTemplate } : {}),
        ...(nodeTimeoutMs !== undefined ? { timeoutMs: nodeTimeoutMs } : {}),
        ...(reviewContext !== undefined ? { reviewContext } : {}),
        // RFC-132 (PR-C): a single flat clarifyContext (self/questioner/designer merged, §5). No
        // separate designer External-Feedback context — the designer's Q&A rides
        // clarifyContext.flatBlock.
        ...(clarifyContext !== undefined ? { clarifyContext } : {}),
        ...(priorOutputUpdate !== undefined ? { priorOutputUpdate } : {}),
        ...(effectiveResumeSessionId !== undefined
          ? { resumeSessionId: effectiveResumeSessionId }
          : {}),
        // RFC-148: the followup quartet is ONE PromptMode value now. The
        // followup arm carries the session id (unrepresentable without one
        // — decideEnvelopeFollowup only fires when the prior attempt
        // captured a session). RFC-122: a same-session follow-up is
        // bypassed when the STOP toggle flipped this attempt's
        // clarify-vs-output mode (clarifyModeFlip) — the resumed session
        // never emitted the now-needed protocol, so the runner takes the
        // FULL renderUserPrompt path instead.
        ...(followupDecision.followup && !clarifyModeFlip && effectiveResumeSessionId !== undefined
          ? {
              promptMode: {
                kind: 'followup' as const,
                resumeSessionId: effectiveResumeSessionId,
                reason: followupDecision.reason,
                ...(followupClarifyDirective !== undefined
                  ? { clarifyDirective: followupClarifyDirective }
                  : {}),
                // RFC-049: thread the structured failures through so the
                // runner renders the per-kind repair block. Empty array
                // (degraded mode) is fine — the followup still fires.
                ...(followupDecision.reason === 'port-validation'
                  ? { portValidations: followupDecision.failures }
                  : {}),
              },
            }
          : {}),
        // RFC-313: 本次 attempt 是主动会话升级后的第一次运行 ⇒ 让渲染器在完整
        // prompt 的协议块之后追加一段简短告知。与 promptMode.followup 天然互斥
        // （升级时 followupDecision 已被 decideFollowupForRetry 收回成 false），
        // 所以短提示与告知永远不会同时出现。
        ...(pendingRestartReason !== undefined
          ? { priorSessionAbandonedReason: pendingRestartReason }
          : {}),
        // RFC-148: the clarify quartet is ONE ClarifyChannel value now —
        // wiring family (parser cap) × this-run directive (enforcement)
        // × stop-notice injection.
        clarifyChannel: !hasClarifyChannel
          ? { kind: 'none' as const }
          : {
              kind: channelKind,
              directive: clarifyStopped
                ? ('stopped' as const)
                : clarifyOptional
                  ? ('optional' as const)
                  : effectiveHasClarifyChannel
                    ? ('mandatory' as const)
                    : ('suppressed' as const),
              injectStopNotice: clarifyStopNotice,
            },
        skills: resolvedSkills,
        dependents,
        mcps,
        plugins,
        appHome: opts.appHome,
        ...(opts.binaryOverride ? { binaryOverride: opts.binaryOverride } : {}),
        db,
        log: log.child('run'),
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.subagentLiveCapture !== undefined
          ? { subagentLiveCapture: opts.subagentLiveCapture }
          : {}),
      })

      // RFC-026: persist opencode session id captured from the JSON event
      // stream so the NEXT clarify-driven rerun on this lineage can pass
      // it back via `--session`. NULL on failed / canceled runs is fine.
      if (lastResult.sessionId !== undefined && lastResult.sessionId !== '') {
        const persistedSessionId = lastResult.sessionId
        withTaskExecutionMutation({
          db,
          taskId,
          run: (tx) =>
            tx
              .update(nodeRuns)
              .set({ opencodeSessionId: persistedSessionId })
              .where(eq(nodeRuns.id, nodeRunId))
              .run(),
        })
      }
      // RFC-026: post-spawn fallback — opencode rejected the resume id we
      // passed. Treat the run as a fail-soft signal: leave the failure to
      // surface naturally (status will be 'failed' or have empty outputs),
      // but log a warning so operators can see WHY. The next retry within
      // this attempt loop will not carry resumeSessionId (we only set it
      // on the first attempt of a clarify rerun).
      if (resumeDecision.inlineMode && lastResult.status !== 'done') {
        const stderrText = await readStderrText(db, nodeRunId)
        // RFC-284 T15（D10）：判据下沉 driver 能力面——措辞属各 CLI 私有。
        // 无该能力的 driver 视为「无法判定」（告警可能缺失但绝不误报）。
        if (getRuntimeDriver(frozenRuntime.protocol).detectSessionNotFound?.(stderrText) === true) {
          await recordClarifyInlineEvent(db, nodeRunId, {
            level: 'warning',
            reason: 'session-not-found',
            extra: { clarifyGeneration },
          })
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const errorMessage = `node ${node.id} threw: ${msg}`
      // runNode normally owns pending→running→terminal. Exceptions thrown
      // before it can enter that lifecycle (for example prompt-template
      // rendering) used to leave the attempt row pending. Retry minting then
      // abandoned each predecessor, while the final pending/isolating row was
      // redispatched and crashed on begin-isolation from an abandoned state.
      // Close the row before the retry policy observes the synthetic failure.
      await transitionNodeRunStatus({
        db,
        nodeRunId,
        event: { kind: 'mark-failed', reason: 'scheduler-node-threw' },
        extra: { finishedAt: Date.now(), errorMessage, exitCode: null },
      })
      lastResult = {
        status: 'failed',
        exitCode: null,
        outputs: {},
        tokenUsage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0 },
        prompt: '',
        errorMessage,
      }
      lastError = msg
    }

    broadcastNodeStatus(taskId, nodeRunId, node.id, lastResult.status)
    return lastResult
  }

  const windowOut = await runAssembly<Record<string, never>, RunResult | null, AgentWindowOut>(
    {},
    {
      // RFC-208：许可由骨架自取自放（全五条线同一口径）。
      pools: [agentSem],
      iso: {
        create: async () => {
          isoHandle = await createIsoUnderLock({
            writeSem,
            appHome: opts.appHome,
            taskId,
            db,
            isoKeyRunId,
            canonRepos: state.repos,
            log,
          })
          return isoHandle
        },
        // RFC-208: persisting the iso base must happen INSIDE the region whose
        // finally releases the permit. It used to sit between the acquire and the
        // window, and `transitionMergeState` throwing there (a documented,
        // test-locked behavior — NotFoundError / IllegalMergeStateTransition /
        // ConcurrentMergeStateTransition, plus any SQLite error) leaked one
        // daemon-wide permit per occurrence with no way back short of a restart.
        persistBase: 'in-window',
        persist: async () => {
          await persistIsoBase(db, nodeRunId, task.repoCount, isoHandle)
        },
      },
      onIsoSetupFailure: (err) => {
        log.warn('iso worktree setup failed', {
          nodeId: node.id,
          error: err instanceof Error ? err.message : String(err),
        })
        return {
          kind: 'settled',
          out: {
            kind: 'failed',
            summary: 'isolated worktree setup failed',
            message: 'iso-setup-failed',
          },
        }
      },
      // 机身不需要 attempt 序号：行已由 prepareRetryAttempt 按正确 retryIndex 铸好，
      // 机身一律读 nodeRunId（迁移前的 `attempt` 局部也只服务于重试前奏，机身里只在
      // 注释中出现过）。
      spawn: async () => await runOneAttempt(),
      retryPolicy: {
        // 迁移前的循环是 `for (attempt = retryIndex; attempt <= retryIndex + maxRetries)`
        // 配两处 break；三条判据逐字搬来，取值范围一一对应（k 为骨架轮次，0 起）。
        shouldRetry: (r, k) =>
          k < maxRetries &&
          r !== null &&
          r.status !== 'done' &&
          r.status !== 'canceled' &&
          shouldRetryNodeFailure(r.failureCode, r.processUnreaped === true),
        // D17：同会话续跑留用同一棵树，换新会话丢弃重建——判据即 RFC-042 决策本身。
        isoOnRetry: { keepIf: async (r) => await decideFollowupForRetry(r) },
        onIsoRecreateFailure: (err) => {
          log.warn('retry iso recreate failed', {
            nodeId: node.id,
            error: err instanceof Error ? err.message : String(err),
          })
          lastError = 'iso-recreate-failed'
          lastResult = {
            status: 'failed',
            exitCode: null,
            outputs: {},
            tokenUsage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0 },
            prompt: '',
            errorMessage: 'iso-recreate-failed',
          }
          // 迁移前这里是 `break` 落到窗口外收尾；判别式回 'ran' 等价。
          return { kind: 'ran', result: lastResult }
        },
        onNextAttempt: async (k) => {
          await prepareRetryAttempt(retryIndex + k)
        },
      },
      // 第五维：旧 child 可能还活着，树不能收（正交于合并处置）。
      keepFromOutcome: (r) => r?.processUnreaped === true,
      // RFC-130 §段③: on success, merge the iso delta back into the canonical
      // worktree under a brief writeSem window. The runner already wrote
      // status='done'; downstream readiness ALSO gates on merge_state (D15,
      // deriveFrontier), so nothing dispatches off this node until 'merged'.
      // D19: a <workflow-clarify> reply is status='done' with result.clarify set but
      // has NOT produced final output — skip merge-back and KEEP the iso so the
      // answered inline resume (same opencode session) sees the files it wrote.
      mergePhase: (_c, r) => {
        if (r !== null && r.status === 'done' && r.clarify !== undefined) {
          return { skip: 'park', keep: true, then: 'settle' }
        }
        if (r === null || r.status !== 'done')
          return { skip: 'not-done', keep: false, then: 'settle' }
        if (isoHandle.passthrough) return { skip: 'passthrough', keep: false, then: 'settle' }
        return 'merge'
      },
      mergeBack: {
        // RFC-188: the ONE merge-back assembly (mergeBackAndSettle) — the §6.2
        // writeSem hold, conflict resolution and merge_state settling now live
        // in isolatedAgentRun.ts; this site keeps only its own dispositions
        // (keepIso + awaiting_human on conflict-human; merge-failed stamp on
        // throw — RFC-130 D15 keeps downstream gated, RFC-144 §5 try-variant).
        run: async (_c, r) =>
          await mergeBackAndSettle({
            db,
            writeSem,
            handle: isoHandle,
            nodeRunId,
            repoCount: task.repoCount,
            via: 'live',
            // RFC-193 K1: this run's own just-emitted port files (not yet in the
            // handle's DB-aggregated roster) join the final-snapshot force list.
            extraForcedContainerPaths: (r?.portFilePaths ?? []).map((p) =>
              toContainerRelative(state.repos[0]?.worktreeDirName ?? '', p),
            ),
            conflictResolver: (conflicts, containerPath) =>
              resolveMergeConflicts(state, {
                conflicts,
                containerPath,
                conflictNodeRunId: nodeRunId,
                nodeId: node.id,
                iteration,
              }),
            log,
          }),
        disposition: {
          // §6.3 — merge agent could not resolve → park human. Conflict is NEVER
          // silently lost; canonical stays clean for siblings; the resolve-iso(s)
          // are kept so the human finishes there and resume re-merges (#4).
          onConflictHuman: (detail) => ({
            keep: true,
            produce: async () => {
              log.warn('merge-back conflict unresolved by merge agent → awaiting_human', {
                nodeId: node.id,
                detail,
              })
              return {
                kind: 'settled',
                out: {
                  kind: 'awaiting_human',
                  summary: `merge conflict unresolved: ${detail}`,
                  message: 'merge-conflict',
                },
              }
            },
          }),
          // 抛出走骨架默认处置（keep + markMergeFailed + settle），故不覆写 onThrow。
        },
      },
      // RFC-130 robustness: a merge-back that THROWS (iso corrupted, .git gone,
      // a git op error) must fail the node loudly — never leave a 'done' row
      // whose delta never reached canonical.
      //
      // RFC-210 impl-gate A1-fix: KEEP the iso on a merge-back throw. The iso
      // worktree can be the ONLY copy of the node's product — most acutely
      // when the snapshot phase itself failed (submodule auto-commit rejected
      // by a hook, object publish failed): nothing has reached canonical or
      // the pool yet, and the old discard-in-finally deleted the sole copy.
      // A later fresh-session retry builds its own iso under a new run id;
      // this one stays for manual salvage until the container GC sweeps it.
      // ——keep 由骨架默认处置负责；这里只做本线私有的 warn + 结局改写。
      markMergeFailed: async (msg) => {
        log.warn('merge-back failed', { nodeId: node.id, error: msg })
        await markMergeFailed(db, nodeRunId, msg, log)
        if (lastResult !== null) {
          lastResult = {
            ...lastResult,
            status: 'failed',
            errorMessage: `merge-back-failed: ${msg}`,
          }
        }
      },
      discardIso: async (h) => {
        // Discard the iso worktree on a terminal exit; keep it when the node is
        // parked (awaiting_human / merge conflict) so the resume path (D19) + the
        // future merge agent (PR-B) can reuse the exact same worktree state.
        await discardNodeIso(h as IsoHandle, log, writeSem)
      },
      settle: async () => ({ kind: 'ran', result: lastResult }),
      log,
    },
  )
  if (windowOut.kind === 'settled') return windowOut.out
  // 直线回填：让 TS 的控制流重新看到 `RunResult | null`（闭包内的赋值它看不见）。
  lastResult = windowOut.result

  if (lastResult === null) {
    return {
      kind: 'failed',
      summary: 'node produced no result',
      message: lastError ?? 'unknown',
    }
  }
  if (lastResult.status === 'canceled') {
    return {
      kind: 'canceled',
      summary: 'node canceled',
      message: lastResult.errorMessage ?? 'canceled',
    }
  }
  if (lastResult.status !== 'done') {
    return {
      kind: 'failed',
      summary: lastResult.errorMessage ?? `node ${node.id} ${lastResult.status}`,
      message: lastResult.errorMessage ?? lastResult.status,
      ...(lastResult.processUnreaped === true ? { processUnreaped: true as const } : {}),
    }
  }
  // RFC-023: when the agent reply was a <workflow-clarify> envelope, runner
  // returns status='done' AND populates result.clarify. The scheduler is the
  // only piece with access to the workflow definition, so it owns mapping
  // the asking agent → clarify node id and parking the clarify node_run
  // awaiting_human. After this returns 'awaiting_human', the scope loop
  // bubbles up and the task transitions to status='awaiting_human' until the
  // user POSTs answers via /api/clarify.
  if (lastResult.clarify !== undefined) {
    // RFC-056: prefer the cross-clarify route if the questioner's
    // __clarify__ port is wired to a clarify-cross-agent node. The
    // shared helper short-circuits when no cross-clarify target exists,
    // falling through to the RFC-023 self-clarify path below.
    const crossClarifyNodeId = findCrossClarifyNodeForQuestioner(definition, node.id)
    if (crossClarifyNodeId !== undefined) {
      const currentRunRowXc = (
        await db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)).limit(1)
      )[0]
      const designerNodeId = findDesignerNodeForCrossClarify(definition, crossClarifyNodeId)
      // Defensive: persistent stop would have been short-circuited at
      // dispatch already. If the questioner still emitted clarify, treat
      // as protocol violation. Caller's retries (RFC-042) kick in.
      const persistentRow = await db
        .select({ id: nodeRuns.id })
        .from(nodeRuns)
        .where(eq(nodeRuns.taskId, taskId))
        .limit(1)
      void persistentRow
      await collaboration.openAgentClarify({
        kind: 'cross',
        taskId,
        intermediaryNodeId: crossClarifyNodeId,
        askingNodeId: node.id,
        askingNodeRunId: nodeRunId,
        targetConsumerNodeId: designerNodeId ?? null,
        loopIter: currentRunRowXc?.iteration ?? 0,
        questions: lastResult.clarify.questions,
        ...(lastResult.clarify.truncationWarnings.length > 0
          ? { truncationWarnings: lastResult.clarify.truncationWarnings }
          : {}),
      })
      return {
        kind: 'awaiting_human',
        summary: `questioner ${node.id} asked back via cross-clarify node ${crossClarifyNodeId}`,
        message: 'cross-clarify-awaiting-human',
      }
    }

    const clarifyNodeId = findClarifyNodeForAgent(definition, node.id)
    if (clarifyNodeId === undefined) {
      // Agent emitted clarify but has no clarify channel — protocol abuse.
      return {
        kind: 'failed',
        summary: `agent ${agent.name} emitted <workflow-clarify> but node ${node.id} has no clarify channel`,
        message: 'clarify-no-channel',
      }
    }
    const currentRunRow = (
      await db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)).limit(1)
    )[0]
    // RFC-074 PR-C: the clarify round index is the asking run's generation —
    // the count of its prior completed generations (id-order) — not the retired
    // clarifyIteration counter. First clarify round → generation 0.
    const askingGeneration = currentRunRow
      ? (
          await priorDoneGenerationsForRun(db, {
            taskId,
            nodeId: node.id,
            iteration: currentRunRow.iteration,
            shardKey: currentRunRow.shardKey ?? null,
            id: currentRunRow.id,
          })
        ).length
      : 0
    await collaboration.openAgentClarify({
      kind: 'self',
      taskId,
      askingNodeId: node.id,
      askingNodeRunId: nodeRunId,
      askingShardKey: currentRunRow?.shardKey ?? null,
      intermediaryNodeId: clarifyNodeId,
      iteration: askingGeneration,
      questions: lastResult.clarify.questions,
      ...(lastResult.clarify.truncationWarnings.length > 0
        ? { truncationWarnings: lastResult.clarify.truncationWarnings }
        : {}),
    })
    return {
      kind: 'awaiting_human',
      summary: `agent ${node.id} asked back via clarify node ${clarifyNodeId}`,
      message: 'clarify-awaiting-human',
    }
  }
  return { kind: 'ok', summary: '', message: '' }
}

export function broadcastNodeStatus(
  taskId: string,
  nodeRunId: string,
  nodeId: string,
  status: NodeStatus,
): void {
  taskBroadcaster.broadcast(TASK_CHANNEL(taskId), {
    id: -1,
    type: 'node.status',
    nodeRunId,
    nodeId,
    status,
  })
}

/**
 * Resolve upstream port values for one node at a given iteration.
 *
 * For each incoming edge: pick the upstream node's latest run whose iteration
 * is ≤ current iteration (prefer the highest matching iteration, then highest
 * retry_index). This lets inner-scope nodes see top-level node outputs
 * (iteration=0) and same-iteration upstream outputs from earlier ready batches.
 */
// RFC-074: exported (was module-private) for the picker baseline test. PR-B
// unified the source-run picker with the freshness picker (done-only,
// highest-iteration-then-isFresherNodeRun) and now returns `consumed`
// provenance alongside the resolved inputs — see body + design §5.1 / D10.
export async function resolveUpstreamInputs(
  db: DbClient,
  taskId: string,
  edges: WorkflowEdge[],
  nodeId: string,
  iteration: number,
  log: Logger,
  definition?: WorkflowDefinition,
  parents?: ReadonlyMap<string, string>,
): Promise<{ inputs: Record<string, string>; consumed: Record<string, string> }> {
  const grouped = new Map<string, string[]>()
  // Fanout boundary edges are structural mirrors, and clarify/cross-clarify
  // response edges are prompt-injected system channels — neither is ordinary
  // row-to-row dataflow. Reading them here would either observe a still-running
  // wrapper/channel row (and emit a false "missing upstream" warning) or, when
  // an older channel output exists, inject it into a reserved agent input and
  // record false consumed provenance. Keep agent.__clarify__ → cross-clarify:
  // channelEdgeDataflowSkip deliberately treats that direction as a real
  // dependency when the target kind is clarify-cross-agent.
  //
  // RFC-306: the projection now lives in task-execution/domain/inboundEdges so
  // the branch-activation judgment reads EXACTLY the same edge set — see that
  // module's header for why a second hand-rolled copy would be a bug factory.
  const kindById = nodeKindIndex(definition)
  const incoming = collectDataflowInboundEdges(edges, nodeId, kindById)
  // RFC-074 provenance: which upstream node_run each source edge actually read.
  // Keyed by source nodeId — all edges from the same source resolve to the same
  // picked run, so this stays consistent across multi-port fan-in.
  const consumed: Record<string, string> = {}

  for (const edge of incoming) {
    const resolved =
      definition === undefined
        ? { ok: true as const, source: edge.source, exitedWrapperIds: [] }
        : resolveWorkflowSourceRef(definition, edge.source, nodeId, parents)
    if (!resolved.ok) {
      throw new Error(
        `wrapper-output-boundary-missing: source '${edge.source.nodeId}.${edge.source.portName}' is not exposed by ${describeWrapperKind(resolved.wrapperKind)} '${resolved.wrapperId}'`,
      )
    }
    const source = resolved.source
    const rows = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, source.nodeId)))
    // RFC-074 (decision D10 / design §5.1): unify the source-run picker with
    // the freshness picker. Previously this sorted by (iteration desc,
    // retryIndex desc) with NO cci term and NO status filter — so it could read
    // a STALE pre-clarify row (higher retryIndex, lower cci) or even a pending
    // row's empty output while a done row carried the real content (the
    // three-picker drift the RFC indicts; baseline PB1/PB2). Now: among
    // top-level DONE rows within the iteration window, pick the highest
    // iteration (cross-boundary "latest visible", e.g. git-wrapper / loop
    // carry) and, within that iteration, the freshest by isFresherNodeRun.
    // RFC-098 B3 (audit S-7): the two-phase picker body now lives in
    // freshness.ts (pickUpstreamSourceRun) so computeWrapperConsumed shares
    // the exact same口径 — behavior here is unchanged.
    const run = pickUpstreamSourceRun(rows, iteration)
    if (!run) {
      log.warn('upstream node_run not found', { taskId, sourceNodeId: source.nodeId })
      continue
    }
    consumed[source.nodeId] = run.id
    const outRows = await db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, run.id))
    const port = outRows.find((o) => o.portName === source.portName)
    // RFC-306: a closed branch contributes NOTHING to a downstream prompt.
    //
    //   * source row `skipped` ⇒ it produced no ports at all;
    //   * port row `active === false` ⇒ its content is the author's REASON for
    //     closing the branch. That text must never reach another agent: it is
    //     one model's private justification, and injecting it as if it were data
    //     invents an input the author never wired.
    //
    // Reaching this line at all means the node was judged ACTIVE — i.e. some
    // OTHER inbound edge is live (joinMode 'any'), or the operator forced the
    // node to run. Empty string is exactly the right value for the dead legs.
    const inactive = run.status === 'skipped' || port?.active === false
    const content = inactive ? '' : (port?.content ?? '')
    const list = grouped.get(edge.target.portName) ?? []
    list.push(content)
    grouped.set(edge.target.portName, list)
  }

  const inputs: Record<string, string> = {}
  for (const [name, values] of grouped) {
    inputs[name] = values.length === 1 ? (values[0] ?? '') : values.join('\n\n---\n\n')
  }
  return { inputs, consumed }
}

// RFC-060 PR-E: pickLatestSourceRun + sumChildTokens were used only by the
// agent-multi runFanOutNode path (now removed). Deleted alongside the fan-out
// implementation.

/**
 * RFC-193 D16 — row-returning variant: derived-output projections (output
 * virtual nodes, wrapper outlet promotion) must copy `kind` + `archive_json`
 * alongside `content`, or the projected row 404s on the port-artifacts API
 * and goes dark after worktree GC (Codex design-gate P1).
 */
export async function readPortRowAtIteration(
  db: DbClient,
  taskId: string,
  nodeId: string,
  portName: string,
  iteration: number,
): Promise<{
  runId: string | null
  content: string
  kind: string | null
  archiveJson: string | null
  /**
   * RFC-306: false when this port is NOT carrying a value this round — either
   * the producer marked it `active="false"`, or the producing run was itself
   * skipped. Every projection built on this read (output nodes, wrapper outlet
   * promotion, loop exit conditions) has to propagate it, or a closed branch
   * silently re-opens one layer up.
   */
  active: boolean
}> {
  const rows = await db
    .select()
    .from(nodeRuns)
    .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, nodeId)))
  // Pick the freshest DONE top-level run visible at this iteration. For a
  // normal in-loop source, the current iteration wins. For a historical
  // snapshot that references an outer source, iteration 0 remains visible in
  // later loop rounds instead of turning into a synthetic empty value.
  // RFC-096 (audit 附录 C #5): the done-only filter aligns this read with
  // buildFreshestSettledPerNode / the RFC-074 freshness口径 — without it, a
  // freshly minted non-done row (e.g. a concurrent designer-rerun pending
  // row) was picked as freshest, had no outputs, and the port read returned
  // '': a loop `port-empty` exit condition false-fired and the wrapper
  // persisted '' outputs. Non-done rows never have outputs (the runner only
  // persists ports on done), so skipping them can only surface the newest
  // REAL content. (The RFC-040 shadowing fix — pure id over retryIndex — is
  // inherited from isFresherNodeRun; the old comment describing the retired
  // (clarifyIteration, retryIndex, id) triple was stale and is gone.)
  const chosen = pickUpstreamSourceRun(rows, iteration)
  if (chosen === undefined) {
    // No settled run at all. `active: true` (not false) on purpose: "nothing has
    // run yet" is not a branch decision, and reporting it as inactive would let
    // a bookkeeping gap masquerade as a deliberate skip.
    return { runId: null, content: '', kind: null, archiveJson: null, active: true }
  }
  const out = await db
    .select()
    .from(nodeRunOutputs)
    .where(and(eq(nodeRunOutputs.nodeRunId, chosen.id), eq(nodeRunOutputs.portName, portName)))
  // A skipped producing run has no port rows at all, so the port-row check alone
  // would read it as "absent ⇒ active" (the compatibility default). The run
  // status has to be consulted too.
  const active = chosen.status !== 'skipped' && out[0]?.active !== false
  return {
    runId: chosen.id,
    content: active ? (out[0]?.content ?? '') : '',
    kind: out[0]?.kind ?? null,
    archiveJson: out[0]?.archiveJson ?? null,
    active,
  }
}

export function pickString(node: WorkflowNode, key: string): string | null {
  const v = (node as Record<string, unknown>)[key]
  return typeof v === 'string' && v.length > 0 ? v : null
}

export interface Binding {
  name: string
  bind: { nodeId: string; portName: string }
}

export function readBindings(node: WorkflowNode, key: string): Binding[] {
  const arr = (node as Record<string, unknown>)[key]
  if (!Array.isArray(arr)) return []
  const out: Binding[] = []
  for (const item of arr) {
    if (typeof item !== 'object' || item === null) continue
    const rec = item as Record<string, unknown>
    if (typeof rec.name !== 'string') continue
    const bind = rec.bind
    if (typeof bind !== 'object' || bind === null) continue
    const br = bind as Record<string, unknown>
    if (typeof br.nodeId !== 'string' || typeof br.portName !== 'string') continue
    out.push({ name: rec.name, bind: { nodeId: br.nodeId, portName: br.portName } })
  }
  return out
}

// RFC-092 T2: `readSnapshotForLatestRun` was deleted (its `orderBy(desc(retryIndex))`
// was one of the audit S-13 freshest-row forks, ruled out in favor of id-order).
// RFC-130: the retry-rollback machinery it fed is itself GONE — a fresh-session
// retry now DISCARDS the failed iso and re-branches from the current canonical
// state (runOneNode); the canonical worktree is never dirtied, so there is nothing
// to roll back.

/**
 * RFC-119 / RFC-056: read a prior run's captured port outputs and render them in
 * the agent's declared-output order via the shared `buildPriorOutputBlock`.
 * Shared by the cross-clarify update-mode path AND the generalized rerun path.
 * `onlyPorts` (RFC-119 D10) restricts which declared ports render — review-iterate
 * passes the single iterate-target port so it doesn't duplicate RFC-014's
 * `## Sibling Outputs`; everything else passes undefined (all ports).
 */
export async function composePriorOutputBlock(
  db: DbClient,
  priorRunId: string,
  agentOutputs: readonly string[],
  onlyPorts?: ReadonlySet<string>,
  envelopeNonce = '',
): Promise<string> {
  const captured = await db
    .select()
    .from(nodeRunOutputs)
    .where(eq(nodeRunOutputs.nodeRunId, priorRunId))
  const byPort = new Map(captured.map((r) => [r.portName, r.content]))
  const ordered = (agentOutputs ?? [])
    .filter((p) => onlyPorts === undefined || onlyPorts.has(p))
    .map((p) => ({ portName: p, content: byPort.get(p) ?? '' }))
    .filter((o) => o.content.length > 0)
  return buildPriorOutputBlock(ordered, envelopeNonce)
}

/**
 * RFC-119: the freshest prior run of this node at the SAME (iteration, shardKey),
 * minted before this run (id < current), that captured at least one output row —
 * REGARDLESS of final status. Unlike `priorDoneGenerationsForRun` (deliberately
 * `done`-only, for the clarify generation count) this MUST also see
 * review-supersede `canceled` rows: review reject/iterate flips the prior `done`
 * row to `canceled` but keeps its node_run_outputs. node_run_outputs are written
 * only on a run that reached `done`, so "has an output row" == "this run produced
 * output at some point".
 *
 * RFC-119 multi-process (D9 revision): **parent-agnostic** — it deliberately does
 * NOT filter `parentNodeRunId === null`, so it ALSO matches fan-out children
 * across wrapper generations. The (nodeId, shardKey) tuple is what scopes the
 * lookup, and no node has both top-level AND child runs at the same
 * (nodeId, iteration, shardKey): a single-process agent node has only top-level
 * runs (so the dropped filter is a no-op there); a fan-out inner node has only
 * shard children (keyed by shardKey); a fan-out aggregator node has only
 * aggregator children (shardKey null). So id-order within (nodeId, iteration,
 * shardKey) uniquely identifies the freshest prior run for all three dispatch
 * sites (single-process / fan-out shard / fan-out aggregator).
 *
 * Candidate set is tiny (one node's attempts this iteration), so the per-row
 * existence probe is cheap; the freshest candidate normally hits on the first.
 */
export async function freshestPriorRunWithOutput(
  db: DbClient,
  run: { taskId: string; nodeId: string; iteration: number; shardKey: string | null; id: string },
): Promise<typeof nodeRuns.$inferSelect | undefined> {
  const rows = await db
    .select()
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.taskId, run.taskId),
        eq(nodeRuns.nodeId, run.nodeId),
        eq(nodeRuns.iteration, run.iteration),
      ),
    )
  // shardKey filtered in memory (drizzle IS NULL handling varies; see
  // readPriorAgentSessionId). Walk freshest-first (largest id) and return the
  // first prior run (any parent — see doc) that captured output.
  const candidates = rows
    .filter((r) => (r.shardKey ?? null) === (run.shardKey ?? null) && r.id < run.id)
    .sort((a, b) => (a.id > b.id ? -1 : a.id < b.id ? 1 : 0))
  for (const c of candidates) {
    const has = await db
      .select({ p: nodeRunOutputs.portName })
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, c.id))
      .limit(1)
    if (has.length > 0) return c
  }
  return undefined
}

/**
 * RFC-183 (Codex design-gate P2#1/P2#4): the cause chain of this run's
 * lineage, newest-first, INCLUDING the current row — the input to
 * `continuesClarifyLineage` (nodeRunMint.ts). Top-level rows only, same
 * (taskId, nodeId, iteration, shardKey), id <= current. Persisted-row
 * derivation on purpose: the verdict must survive the attempt loop
 * (process-retry mints), daemon restarts (interrupted → 'revival' mints) and
 * resumes alike — an in-memory boolean carried across attempts cannot
 * (RFC-183 design §2.5).
 */
async function lineageCausesNewestFirst(
  db: DbClient,
  run: { taskId: string; nodeId: string; iteration: number; shardKey: string | null; id: string },
): Promise<Array<string | null>> {
  const rows = await db
    .select()
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.taskId, run.taskId),
        eq(nodeRuns.nodeId, run.nodeId),
        eq(nodeRuns.iteration, run.iteration),
      ),
    )
  return rows
    .filter(
      (r) =>
        (r.shardKey ?? null) === (run.shardKey ?? null) &&
        r.parentNodeRunId === null &&
        r.id <= run.id,
    )
    .sort((a, b) => (a.id > b.id ? -1 : a.id < b.id ? 1 : 0))
    .map((r) => r.rerunCause)
}

/**
 * RFC-074 PR-C: derive a node_run's clarify "generation" from id-order instead
 * of the retired `clarifyIteration` counter. The generation is the number of
 * earlier completed generations: top-level (`parentNodeRunId === null`) `done`
 * rows for the same (taskId, nodeId, iteration, shardKey) minted before this
 * run (id < beforeId). 0 = first generation. `done` (not canceled) so
 * review-iterate supersede markers don't inflate it; parent-null so fan-out
 * shard children don't either. Returns the prior rows too — the freshest is the
 * clarify-rerun's working draft (priorDoneDesigner) and the session-resume
 * source.
 */
async function priorDoneGenerationsForRun(
  db: DbClient,
  run: { taskId: string; nodeId: string; iteration: number; shardKey: string | null; id: string },
): Promise<Array<typeof nodeRuns.$inferSelect>> {
  const rows = await db
    .select()
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.taskId, run.taskId),
        eq(nodeRuns.nodeId, run.nodeId),
        eq(nodeRuns.iteration, run.iteration),
        eq(nodeRuns.status, 'done'),
      ),
    )
  return rows.filter(
    (r) =>
      (r.shardKey ?? null) === (run.shardKey ?? null) &&
      r.parentNodeRunId === null &&
      r.id < run.id,
  )
}

/**
 * RFC-026: look up the opencode session id captured on the agent's PRIOR
 * clarify round. RFC-074 PR-C: the retired `clarifyIteration` counter is
 * replaced by id-order — the prior generation is simply the freshest top-level
 * `done` row for this node minted BEFORE the current run (id < beforeId),
 * scoped to the same (taskId, nodeId, iteration, shardKey). That row emitted
 * the `<workflow-clarify>` envelope the user just answered. Returns null when
 * nothing matches (will then degrade to isolated via `decideResumeSessionId`).
 */
async function readPriorAgentSessionId(
  db: DbClient,
  args: {
    taskId: string
    agentNodeId: string
    shardKey: string | null
    iteration: number
    beforeId: string
  },
): Promise<string | null> {
  const rows = await db
    .select()
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.taskId, args.taskId),
        eq(nodeRuns.nodeId, args.agentNodeId),
        eq(nodeRuns.iteration, args.iteration),
        eq(nodeRuns.status, 'done'),
      ),
    )
    .orderBy(desc(nodeRuns.id))
  // shardKey is filtered in memory because drizzle's IS NULL handling
  // varies; the result set is tiny (one row per prior attempt). Walk newest
  // first (largest id) and return the first prior generation that captured a
  // session id.
  const filtered = rows.filter(
    (r) =>
      (r.shardKey ?? null) === args.shardKey && r.parentNodeRunId === null && r.id < args.beforeId,
  )
  for (const r of filtered) {
    if (r.opencodeSessionId !== null && r.opencodeSessionId !== '') {
      return r.opencodeSessionId
    }
  }
  return null
}

/**
 * RFC-026: read concatenated stderr text recorded for a node_run via the
 * runner's stderr pump. Used post-spawn to sniff for `session not found`
 * style messages so the inline-mode fallback can degrade gracefully.
 */
async function readStderrText(db: DbClient, nodeRunId: string): Promise<string> {
  const rows = await db
    .select()
    .from(nodeRunEvents)
    .where(and(eq(nodeRunEvents.nodeRunId, nodeRunId), eq(nodeRunEvents.kind, 'stderr')))
    .orderBy(asc(nodeRunEvents.id))
  return rows.map((r) => r.payload).join('\n')
}

/**
 * RFC-026: record an info/warning row about inline-mode session resume.
 *
 * Both flavors are written as `kind: 'text'` (the closest enum value that
 * doesn't collide with stderr / step-finish / etc.) with a structured JSON
 * payload + a stable `[rfc026/...]` prefix. PR-B's frontend reads the
 * prefix to render the row with an info or warning style; until then the
 * payload is plain-readable in the events tab.
 */
async function recordClarifyInlineEvent(
  db: DbClient,
  nodeRunId: string,
  args:
    | {
        level: 'info'
        sessionIdPrefix: string
        extra?: Record<string, unknown>
      }
    | {
        level: 'warning'
        reason: ClarifyInlineFallbackReason
        extra?: Record<string, unknown>
      },
): Promise<void> {
  const tag = args.level === 'info' ? '[rfc026/inline-session-resumed]' : '[rfc026/inline-fallback]'
  const payload =
    args.level === 'info'
      ? JSON.stringify({
          rfc: 'rfc026',
          code: 'clarify-session-resumed',
          sessionIdPrefix: args.sessionIdPrefix,
          ...args.extra,
        })
      : JSON.stringify({
          rfc: 'rfc026',
          code: 'inline-clarify-fallback-to-isolated',
          reason: args.reason,
          ...args.extra,
        })
  withCurrentTaskExecutionMutation({
    db,
    run: (tx) =>
      tx
        .insert(nodeRunEvents)
        .values({
          nodeRunId,
          ts: Date.now(),
          kind: 'text',
          payload: `${tag} ${payload}`,
        })
        .run(),
  })
}

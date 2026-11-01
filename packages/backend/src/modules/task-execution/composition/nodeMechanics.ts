import { pickString } from '../domain/nodeFields'
import { resolveUpstreamInputs } from '../application/nodeInputs'
import { broadcastNodeStatus, type NodeStatus } from '../infrastructure/nodeStatusEvents'
import { describeIsoFailure } from '../infrastructure/executionDiagnostics'
import { resolveMergeConflicts } from '../engine/node/shared/resolveMergeConflicts'
import { bindMergeConflictPorts } from './mergeConflictResolution'
import { isolatedRunBinding, nodeRunLedger } from './executionMechanismBindings'

import { bindIsolationCleanup } from '../infrastructure/executionKernelBinding'
// RFC-334 W2-C — production node and workgroup-host mechanics.
// Per-kind selection lives in the closed registry; wrapper bodies are owned by
// the RFC-339 WrapperRuntime and consume this file only through typed ports.

import { prepareConsumedInputs } from '../infrastructure/consumedInputsParticipant'
import { nodeRunAttemptIndex } from '../domain/nodeRunAttempt'
import { nodeRunMintIdentityForSlot } from '../application/nodeRunMintIdentity'
import { portFallbackMount } from '@/platform/content/locations/portArchive'
import type { CollaborationRuntimeMechanics } from '@/modules/collaboration/public/participants'
import type {
  NodeExecutionPersistence,
  NodeExecutionSnapshot,
} from '@/modules/task-execution/application/ports/nodeExecutionPersistence'
import { NOOP_AGENT_RUN_SETTLED_OBSERVER } from '@/modules/task-execution/application/ports/agentRunSettledObserver'
import { resolveSchedulerRunRow } from '@/modules/task-execution/application/resolveSchedulerRunRow'
import {
  decideRetryShape,
  DEFAULT_SESSION_RESTART_BUDGET,
  type EnvelopeFollowupOutcome,
  type RetryShapeState,
} from '@/modules/task-execution/domain/envelopeRetryPolicy'
import { retryAttemptCap } from '@/platform/contracts/retryAttemptCap'
import { findClarifyNode } from '@/services/clarify/service'
import {
  computeRemaining,
  resolveEffectiveClarifyChannel,
  shouldInjectStopNotice,
} from '@/services/clarifyRounds'
import { CLARIFY_FORBIDDEN_PREFIX, parsePortValidationFailuresJson } from '@/services/envelope'
import { resolveSyntheticTaskAgentInjection } from '@/services/execution/taskExecutionResources'
import type {
  NodeMechanicsResult,
  TaskMechanicsState,
} from '@/services/execution/taskMechanicsState'
import {
  createIsoUnderLock,
  persistIsoBase,
} from '@/modules/task-execution/engine/kernel/isolation'
import {
  markMergeFailed,
  mergeBackAndSettle,
  type MergeSettleOutcome,
} from '@/modules/task-execution/engine/kernel/merge'

import { discardNodeIso } from '@/modules/task-execution/engine/kernel/isolationCleanup'

import { type IsoHandle } from '@/platform/contracts/isolationWorkspace'
import { ORCHESTRATOR_AGENT_ID } from '@/services/orchestratorAgent'
import { continuesClarifyLineage, isClarifyRerunCause } from '@/services/nodeRunMint'
import { toContainerRelative } from '@/modules/task-execution/public/queries'
import { agentRefOfNode } from '@/services/ref/runtimeRef'
import { runTaskAgentWithFamily as runNode } from './taskAgentRunFamily'
import type { RunResult } from '../application/ports/taskAgentRun'
import { getRuntimeDriver } from '@/services/runtime'
import { runAssembly, type IsoLike } from '@/modules/task-execution/engine/kernel/assembly'

import {
  decideResumeSessionId,
  type ClarifyInlineFallbackReason,
} from '@/services/sessionModeFallback'
import type {
  WorkgroupTurnHostOperations,
  WorkgroupTurnHostRequest,
  WorkgroupTurnHostResult,
} from '../application/ports/workgroupTurnsOperations'
import { ConflictError } from '@/util/errors'
import { worktreeFilesChanged } from '@/util/git'

import { describeEffectError } from '../domain/effectErrorDescription'
import { type Logger } from '@/util/log'

import type {
  ClarifyCrossAgentNode,
  ClarifyNode,
  EnvelopeFollowupReason,
  FailureCode,
  WorkflowNode,
} from '@agent-workflow/shared'
import {
  type NodeRunOrderKey,
  agentHasClarifyChannel,
  buildPriorOutputBlock,
  DEFAULT_PROTOCOL_RETRY_BUDGET,
  findClarifyNodeForAgent,
  findCrossClarifyNodeForQuestioner,
  findDesignerNodeForCrossClarify,
  followupPolicyForFailure,
  resolveClarifySessionMode,
  resolveCrossClarifySessionMode,
} from '@agent-workflow/shared'

/**
 * RFC-284 T20（§4）—— 子任务继承面的唯一登记：buildChildDeps 按本清单整体透传，
 * 新增 RunTaskOptions 字段时**必须**在测试的处置表里表态（inherit / per-task /
 * dropped-独立供给），编译期穷尽（satisfies Record<keyof RunTaskOptions,…>）
 * 防「看起来像可继承」的字段被顺手漏配或顺手多配。
 *
 * 实施偏差（相对 design 草稿的「拆 inheritable 嵌套子对象」）：字面嵌套会让
 * RunTaskOptions/TaskContinuationDependencies 的全部构造点与测试夹具连坐改形，而两型 15 个
 * 同名字段的注释各自承载调度语义/路由接线两套契约、不宜合并——注册表 + Pick
 * 派生型给出同等单源与更强的双向锁，类型面零搬迁。
 */

export type SchedulerState = TaskMechanicsState

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
  req: WorkgroupTurnHostRequest,
  collaboration: CollaborationRuntimeMechanics,
): Promise<WorkgroupTurnHostResult> {
  const { taskId, task, opts, log, definition } = state
  const injection =
    req.agent.id === ORCHESTRATOR_AGENT_ID
      ? resolveSyntheticTaskAgentInjection(req.agent, opts.taskAgentRuns.materialReferences)
      : await state.taskExecutionResources.injection(req.agent.id)
  if (injection.kind === 'failed') {
    await nodeRunLedger(state).setNodeRunStatus({
      nodeRunId: req.nodeRunId,
      to: 'failed',
      allowedFrom: ['pending'],
      reason: 'wg-injection-failed',
      extra: {
        identity: {
          finishedAt: Date.now(),
          errorMessage: injection.message,
        },
      },
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
    | { kind: 'early'; out: WorkgroupTurnHostResult }
    | { kind: 'ran'; result: RunResult; projected: Record<string, string> }
  return await runAssembly<Record<string, never>, HostSpawn, WorkgroupTurnHostResult>(
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
            binding: isolatedRunBinding(state),
            isoKeyRunId: req.nodeRunId,
            canonRepos: state.repos,
            log,
          })
          iso = hookIso
          return hookIso
        },
        persistBase: 'in-setup',
        persist: async (h: IsoLike) => {
          if (!h.passthrough) await persistIsoBase(isolatedRunBinding(state), req.nodeRunId, iso)
        },
      },
      onIsoSetupFailure: (err) => {
        const message = describeEffectError(err)
        log.warn('workgroup host-node iso setup failed', { nodeRunId: req.nodeRunId, message })
        return { status: 'failed', outputs: {}, errorMessage: `iso-setup-failed: ${message}` }
      },
      spawn: async (): Promise<HostSpawn> => {
        const frozen = await opts.taskAgentRuns.runtimeBindings.resolve(
          req.nodeRunId,
          injection.spec.agent.runtime,
          opts.defaultRuntime,
          null,
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
        const runRow = await state.opts.persistence.nodeExecution.read(req.nodeRunId)
        const runShardKey = runRow?.shardKey ?? null
        const clarifyQueue = await collaboration.buildClarifyQueueContext({
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
        // output kinds (F42SE root cause). The per-task resource session above
        // already resolved the ORIGINAL req.agent (skills/mcp/deps are
        // unaffected by this projection). Dynamic orchestrator runs leave hostOutputPorts unset →
        // no projection (design.md §2.2/§2.4).
        const hostAgent =
          req.hostOutputPorts !== undefined
            ? { ...injection.spec.agent, outputs: [...req.hostOutputPorts], outputKinds: undefined }
            : injection.spec.agent
        const result = await runNode(
          opts.taskAgentRuns,
          {
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

            runtimeParams: frozen.params,
            runtimeConfigDir: frozen.configDir,
            runtimeObservationIdentity: frozen.observationIdentity,
            observationInvocations: state.opts.observationInvocations,
            inputs: {},

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
                // RFC-248: 同上——`{{__repo_names__}}` 要渲染挂载路径。
                mountPath: state.repos[i]?.mountPath ?? r.mountPath,
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
                      : collaboration.isTaskClarifySuppressed({
                          taskId,
                          nodeId: req.nodeId,
                          shardKey: runShardKey,
                        }),
                }
              : {}),
            ...(clarifyQueue !== undefined
              ? { clarifyContext: { flatBlock: clarifyQueue.block } }
              : {}),

            dependents: injection.spec.dependents,
            mcps: injection.spec.mcps,

            memorySnapshots: opts.memorySnapshots,

            memoryInjectionQueries: opts.memoryInjectionQueries,
            runtimeSessionLeases: opts.runtimeSessionLeases,
            runtimeRegistry: opts.runtimeRegistry,
            persistence: opts.persistence,

            log,
            ...(opts.signal ? { signal: opts.signal } : {}),
            ...(opts.subagentLiveCapture !== undefined
              ? { subagentLiveCapture: opts.subagentLiveCapture }
              : {}),
          },
          {
            workspaceRef: iso.repos[0]?.isoWorktreePath ?? task.worktreePath,
            material: injection.spec.material,
            runtimeBinding: frozen.runtimeBinding,
          },
        )
        const early = await (async (): Promise<WorkgroupTurnHostResult | null> => {
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
            const lateSuppress = async (): Promise<WorkgroupTurnHostResult> => {
              const dropped = result.clarify?.questions.length ?? 0
              const suppressedMsg = `${CLARIFY_FORBIDDEN_PREFIX}: ask-back disabled mid-run (autonomous); dropped ${dropped} question(s)`
              await nodeRunLedger(state).setNodeRunStatus({
                nodeRunId: req.nodeRunId,
                to: 'failed',
                allowedFrom: ['done'],
                allowTerminal: true,
                reason: 'wg-clarify-suppressed-late',
                extra: {
                  identity: {
                    finishedAt: Date.now(),
                    errorMessage: suppressedMsg,
                    failureCode: 'clarify-forbidden',
                  },
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
              (await collaboration.isTaskClarifySuppressed({
                taskId,
                nodeId: req.nodeId,
                shardKey: runShardKey,
              }))
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
            const currentRunRow = await state.opts.persistence.nodeExecution.read(req.nodeRunId)
            // RFC-172 (route 2, R2-T6): host clarify GENERATION — count this (node, iteration, shard)'s
            // prior DONE clarify generations (shardKey-aware; mirrors the normal-node path ~scheduler.ts
            // 3540) instead of the old hardcoded 0. A host run (leader OR member) asking a SECOND round
            // otherwise shares the first round's clarify node_run (findClarifyNodeRunForShard is
            // idempotent on iterationIndex → its questions overwrite the first's and selectAgentQueue's
            // per-origin resolve turns ambiguous). shardKey-scoped so concurrent members count only
            // their OWN prior generations.
            const askingGeneration = currentRunRow
              ? (
                  await priorDoneGenerationsForRun(state.opts.persistence.nodeExecution, {
                    taskId,
                    nodeId: req.nodeId,
                    iteration: currentRunRow.iteration,
                    shardKey: currentRunRow.shardKey ?? null,
                    id: currentRunRow.id,
                    seq: currentRunRow.seq,
                  })
                ).length
              : 0
            await collaboration.openAgentClarify({
              kind: 'self',
              taskId,
              askingNodeId: req.nodeId,
              askingNodeRunId: req.nodeRunId,
              askingShardKey: currentRunRow?.shardKey ?? null,
              // RFC-354: the park row lives in the asking run's frame — the
              // generation row AND the round inside it.
              frame: {
                containerRunId: currentRunRow?.containerRunId ?? null,
                iteration: currentRunRow?.iteration ?? 0,
              },
              intermediaryNodeId: clarifyNodeId,
              iteration: askingGeneration,
              questions: result.clarify.questions,
              ...(opts.executionContext === undefined
                ? {}
                : { executionContext: opts.executionContext }),
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
              (await collaboration.isTaskClarifySuppressed({
                taskId,
                nodeId: req.nodeId,
                shardKey: runShardKey,
              }))
            ) {
              const dismissed = await collaboration.dismissOpenClarifyParksForAutonomous({
                taskId,
              })
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
                await state.opts.persistence.mergeStates.tryTransition({
                  nodeRunId: req.nodeRunId,
                  event: { kind: 'abandon', reason: 'discard-writes' },
                  ...nodeRunLedger(state).executionContextInput(),
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
              binding: isolatedRunBinding(state),
              writeSem: state.writeSem,
              handle: iso as IsoHandle,
              nodeRunId: req.nodeRunId,
              via: 'live',
              conflictResolver: (conflicts, containerPath) =>
                resolveMergeConflicts(bindMergeConflictPorts(state), {
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
              await state.opts.persistence.mergeStates.tryTransition({
                nodeRunId: req.nodeRunId,
                event: { kind: 'abandon', reason: 'wg-merge-conflict-unresolved' },
                ...nodeRunLedger(state).executionContextInput(),
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
        const msg = describeEffectError(err)
        log.error('workgroup host-node run failed', { nodeRunId: req.nodeRunId, error: msg })
        return { status: 'failed', outputs: {}, errorMessage: msg }
      },
      discardIso: async (h: IsoLike) => {
        await discardNodeIso(bindIsolationCleanup(), h as IsoHandle, log, state.writeSem)
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
): Omit<WorkgroupTurnHostOperations, 'runHost'> {
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
export async function countAgentTextEvents(
  persistence: NodeExecutionPersistence,
  nodeRunId: string,
): Promise<number> {
  return await persistence.countAgentTextEvents(nodeRunId, FRAMEWORK_AUDIT_EVENT_PREFIX)
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

export type OneNodeResult = NodeMechanicsResult

export interface OneNodeArgs {
  node: WorkflowNode
  /** RFC-354 — the frame (wrapper generation row) the node is dispatched in; null at the top scope. */
  containerRunId: string | null
  iteration: number
  log: Logger
}

// RFC-188: persistIsoBase / persistIsoNodeTree moved to isolatedAgentRun.ts
// (shared by all five assembly sites + replay) — imported above.

/**
 * RFC-356 G3 —— 把 iso 建树/重建失败渲染成能自证的一段话。
 *
 * 改动前这两条路只给一个 `iso-setup-failed` / `iso-recreate-failed`，排障的人看不出
 * 「是哪个目录清不掉、谁可能锁着、本机有没有 Job Object」。**失败分类字符串不变**
 * （后端内部串，不在 FAILURE_CODES 里、前端也无分支消费），只是消息更详细。
 */

export async function runAgentSingleNode(
  state: SchedulerState,
  args: OneNodeArgs,
  collaboration: CollaborationRuntimeMechanics,
): Promise<OneNodeResult> {
  const { task, taskId, definition, opts, agentSem, writeSem, log } = state
  const { node, iteration } = args

  // RFC-271 T6d：解析走统一 resolver（services/ref/runtimeRef.ts），但**两个错误码
  // 与归属逐字不变**——主派发是节点级失败，与 fanout hydration 的静默跳过不同。
  const agentIdRef = pickString(node, 'agentId')
  const agentName = pickString(node, 'agentName') ?? agentIdRef ?? node.id
  const agentRef = agentRefOfNode(node)
  if (agentRef === null) {
    return {
      kind: 'failed',
      summary: `node ${node.id} missing canonical agentId`,
      message: 'agent-identity-missing',
    }
  }
  if (agentRef.k !== 'id') {
    return { kind: 'failed', summary: `agent '${agentName}' not found`, message: 'agent-not-found' }
  }
  const injection = await state.taskExecutionResources.injection(agentRef.id)
  if (injection.kind === 'failed') {
    return injection.message === 'agent-not-found'
      ? { kind: 'failed', summary: `agent '${agentName}' not found`, message: 'agent-not-found' }
      : injection
  }
  // RFC-132 ③ (借壳收官): the borrow ledgers are move-semantics (RFC-131 T4) and the immediate
  // ledger is deleted, so resolveBorrowForNode never returns an agent anymore — its remaining
  // job is the multi-ledger duplicate-execution REJECT (designer + dispatched self/q both open
  // on this home). Keep the call for that reject; the node always runs its OWN agent.
  // ConflictError surfaces as a node-level failure (don't reject the scope tick — runTask would
  // fail the WHOLE task).
  try {
    await collaboration.resolveBorrowForNode({ taskId, nodeId: node.id, iteration, definition })
  } catch (err) {
    if (err instanceof ConflictError) {
      return { kind: 'failed', summary: err.message, message: err.code }
    }
    throw err
  }
  const agent = injection.spec.agent

  // RFC-060 PR-E: agent-multi NodeKind was removed in favor of wrapper-fanout.
  // The agent-single path below is now the sole agent dispatch path.
  // RFC-074: resolveUpstreamInputs now also returns the provenance map of which
  // upstream run each input was read from; recorded on every row this dispatch
  // mints/reuses so read-time freshness can later tell if an upstream advanced.
  const { inputs: upstreamInputs, consumed: consumedUpstream } = await resolveUpstreamInputs(
    state.opts.persistence.nodeExecution,
    taskId,
    definition.edges,
    node.id,
    { containerRunId: args.containerRunId, iteration },
    log,
    definition,
    state.containerOf,
  )
  const consumedUpstreamJson = prepareConsumedInputs({
    record: consumedUpstream,
  }).consumedUpstreamRunsJson!
  // RFC-022: expand the agent.dependsOn closure before resolving skills so
  // closure-member skills get unioned into the same OPENCODE_CONFIG_DIR
  // staging dir. A cycle / missing-dep here is fatal — the agent.ts save
  // guard normally prevents it; hitting one at runtime implies an external
  // SQL edit or a race against another writer. Fail loudly instead of
  // silently spawning with a broken closure.
  const { dependents, material: resourceMaterial, mcps } = injection.spec
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
  const reviewContext = await collaboration.buildReviewPromptContext({
    appHome: opts.appHome,
    upstreamNodeId: node.id,
    taskId,
    iteration,
  })
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
  const sameNodeIterRuns = await opts.persistence.nodeExecution.list({
    taskId,
    nodeId: node.id,
    iteration,
  })
  // RFC-287 T8：取行前奏收编到 `resolveSchedulerRunRow`（四线单一实现）。
  // RFC-074 PR-C: no clarifyIteration inheritance — freshness is pure id-order
  // and the clarify generation is derived from prior-done id-order at dispatch
  // time. A process retry's External Feedback / Prior Output / questioner Q&A
  // context all key off id-order / the RFC-070 consumed-by stamps, so nothing
  // needs to be carried forward on the row.
  const resolvedRow = await resolveSchedulerRunRow({
    lifecycle: opts.persistence.nodeRuns,
    projections: opts.persistence.nodeExecution,
    ...(opts.executionContext === undefined ? {} : { executionContext: opts.executionContext }),
    taskId,
    nodeId: node.id,
    containerRunId: args.containerRunId,
    iteration,
    consumedUpstreamJson,
    rows: sameNodeIterRuns,
    selection: state.opts.persistence.selection,
    inheritReviewIteration: true,
    clearAgentOverride: true,
    trackRetryIndex: true,
    broadcastPending: (id) => broadcastNodeStatus(taskId, id, node.id, 'pending'),
    broadcastCanceled: (id) => broadcastNodeStatus(taskId, id, node.id, 'canceled'),
  })
  let nodeRunId = resolvedRow.nodeRunId
  const retryIndex = resolvedRow.retryIndex
  const latestExisting = resolvedRow.latestExisting
  const inheritedReviewIteration = latestExisting?.reviewIteration ?? 0
  const inheritedShardKey = latestExisting?.shardKey ?? null
  const inheritedParentNodeRunId = latestExisting?.parentNodeRunId ?? null
  let envelopeNonce = await nodeRunLedger(state).loadEnvelopeNonce(nodeRunId)

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
      const agentTextCount = await countAgentTextEvents(
        state.opts.persistence.nodeExecution,
        nodeRunId,
      )
      // RFC-049: read the structured port-validation failures the prior
      // attempt's runner persisted (NULL → undefined; malformed JSON →
      // null via parsePortValidationFailuresJson, then coerced to
      // undefined for the decision input). decideEnvelopeFollowup uses
      // the failures array to populate the per-port repair prompt; absent
      // / empty arrays degrade gracefully (followup still fires on the
      // outer prefix, but the prompt skips per-kind specifics).
      const priorRunRow = await opts.persistence.nodeExecution.read(nodeRunId)
      const priorFailures = parsePortValidationFailuresJson(
        priorRunRow?.portValidationFailuresJson ?? null,
      )
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
        ? (await collaboration.getNodeClarifyDirective({ taskId, nodeId: node.id })) === 'stop'
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
        nodeRunId = await nodeRunLedger(state).mintNodeRun({
          ...nodeRunMintIdentityForSlot(
            (await opts.persistence.nodeExecution.read(nodeRunId))!.slot,
            { kind: 'current' },
            followupDecision.followup && envelopeNonce.length > 0 ? envelopeNonce : undefined,
          ),
          taskId,
          nodeId: node.id,
          status: 'pending',
          cause: 'process-retry',
          retryIndex: nodeRunAttemptIndex({ kind: 'explicit', attempt }),
          containerRunId: args.containerRunId,
          iteration,
          overrides: {
            identity: {
              reviewIteration: inheritedReviewIteration,
              shardKey: inheritedShardKey,
              parentNodeRunId: inheritedParentNodeRunId,
            },
            inputs: {
              consumedUpstreamRunsJson: consumedUpstreamJson,
            },
          },
        })
        envelopeNonce = await nodeRunLedger(state).loadEnvelopeNonce(nodeRunId)
        broadcastNodeStatus(taskId, nodeRunId, node.id, 'pending')
        // RFC-130: carry the iso columns onto the freshly-minted retry row so a
        // crash mid-retry can still find the iso worktree (the physical iso is
        // keyed by isoKeyRunId and shared across the invocation's attempts).
        await persistIsoBase(isolatedRunBinding(state), nodeRunId, isoHandle)

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
              await opts.persistence.nodeExecution.appendEvent({
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
                ...nodeRunLedger(state).executionContextInput(),
              })
            }
          } else {
            const followupReason = followupDecision.reason
            await opts.persistence.nodeExecution.appendEvent({
              nodeRunId,
              ts: Date.now(),
              kind: 'text',
              payload: `[rfc042/envelope-followup] ${JSON.stringify({
                rfc: 'RFC-042',
                reason: followupReason,
                retryAttempt: attempt,
              })}`,
              ...nodeRunLedger(state).executionContextInput(),
            })
          }
        }

        // RFC-313: 主动会话升级的审计行。写在**新铸的那一行**上（与 rfc042 的续跑
        // 事件同址同形），于是任务详情页的事件流里，「接续」与「换脑重来」是两条可
        // 区分的痕迹——用户拍板不新增 rerun cause，事件流就是唯一的区分面。
        // 与上面的 followup 分支互斥：升级时 followupDecision 已被收回成 false。
        if (pendingRestartReason !== undefined) {
          await opts.persistence.nodeExecution.appendEvent({
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
            ...nodeRunLedger(state).executionContextInput(),
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
      const currentRunRow = await opts.persistence.nodeExecution.read(nodeRunId)
      const currentShardKey = currentRunRow?.shardKey ?? null

      // RFC-074 PR-C: the clarify "generation" is derived from id-order, NOT
      // the retired `clarifyIteration` counter. The prior top-level `done`
      // rows for this node at the same (iteration, shardKey), minted before
      // this run (earlier mint seq), each represent an earlier completed clarify
      // generation; their count is the generation index the counter used to
      // hold. `done` (not canceled) so review-iterate supersede markers don't
      // inflate it, and parentNodeRunId === null so fan-out shard children
      // don't either.
      const priorDoneGenerations = currentRunRow
        ? await priorDoneGenerationsForRun(state.opts.persistence.nodeExecution, {
            taskId,
            nodeId: node.id,
            iteration: currentRunRow.iteration,
            shardKey: currentShardKey,
            id: currentRunRow.id,
            seq: currentRunRow.seq,
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
      const mindmapGate = crossQuestionerNode ?? clarifyNodeObjForGate
      const sessionMode = crossQuestionerNode
        ? resolveCrossClarifySessionMode(crossQuestionerNode)
        : clarifyNodeObjForGate
          ? resolveClarifySessionMode(clarifyNodeObjForGate)
          : 'isolated'
      const isClarifyRerun = isClarifyRerunCause(currentRunRow?.rerunCause)
      const priorSessionId =
        isClarifyRerun && currentRunRow
          ? await readPriorAgentSessionId(state.opts.persistence.nodeExecution, {
              taskId,
              agentNodeId: node.id,
              shardKey: currentShardKey,
              iteration: currentRunRow.iteration,
              before: currentRunRow,
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
        await recordClarifyInlineEvent(state.opts.persistence.nodeExecution, nodeRunId, {
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
        ? await collaboration.getNodeClarifyDirective({ taskId, nodeId: node.id })
        : undefined
      const nodeDirective = nodeDirectiveRow
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
      const clarifyQueue = await collaboration.buildClarifyQueueContext({
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
        ? await lineageCausesNewestFirst(state.opts.persistence.nodeExecution, {
            taskId,
            nodeId: node.id,
            iteration: currentRunRow.iteration,
            shardKey: currentShardKey,
            id: currentRunRow.id,
            seq: currentRunRow.seq,
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
      if (currentRunRow !== null && !resumeDecision.inlineMode) {
        const priorRun = await freshestPriorRunWithOutput(state.opts.persistence.nodeExecution, {
          taskId,
          nodeId: node.id,
          iteration: currentRunRow.iteration,
          shardKey: currentShardKey,
          id: currentRunRow.id,
          seq: currentRunRow.seq,
        })
        if (priorRun !== undefined) {
          const onlyPorts =
            reviewContext?.iterateTargetPort !== undefined
              ? new Set([reviewContext.iterateTargetPort])
              : undefined
          const block = await composePriorOutputBlock(
            state.opts.persistence.nodeExecution,
            priorRun.id,
            agent.outputs ?? [],
            onlyPorts,
          )
          if (block.length > 0) priorOutputUpdate = { block }
        }
      }
      if (resumeDecision.inlineMode && resumeDecision.resumeSessionId !== undefined) {
        await recordClarifyInlineEvent(state.opts.persistence.nodeExecution, nodeRunId, {
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
          ? await state.opts.taskAgentRuns.runtimeBindings.ofSession(effectiveResumeSessionId)
          : null
      const frozenRuntime = await state.opts.taskAgentRuns.runtimeBindings.resolve(
        nodeRunId,
        agent.runtime,
        state.opts.defaultRuntime,
        inheritedRuntime,
      )
      lastResult = await runNode(
        opts.taskAgentRuns,
        {
          taskId,
          nodeRunId,
          nodeId: node.id,
          agent,
          triggerContext: state.triggerContext,
          runtime: frozenRuntime.protocol,

          runtimeParams: frozenRuntime.params,
          runtimeConfigDir: frozenRuntime.configDir, // RFC-154: frozen config-dir profile
          runtimeObservationIdentity: frozenRuntime.observationIdentity,
          observationInvocations: state.opts.observationInvocations,
          inputs: upstreamInputs,
          // RFC-130 D16: the opencode cwd + ALL path-bearing template tokens point
          // at the ISOLATED worktree, not the canonical one — otherwise the agent
          // would be told (via {{__repo_path__}} / {{__repos__}}) to edit a path
          // outside its isolation. repos[].repoPath stays the source repo (an origin
          // reference, not a cwd); repos[].worktreePath becomes the per-repo iso.

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
              mountPath: r.mountPath,
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
          ...(followupDecision.followup &&
          !clarifyModeFlip &&
          effectiveResumeSessionId !== undefined
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
          ...(mindmapGate?.interactionMode === 'mindmap' && mindmapGate.mindmap
            ? { clarifyMindmap: mindmapGate.mindmap }
            : {}),
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

          dependents,
          mcps,

          memorySnapshots: opts.memorySnapshots,

          memoryInjectionQueries: opts.memoryInjectionQueries,
          runtimeSessionLeases: opts.runtimeSessionLeases,
          runtimeRegistry: opts.runtimeRegistry,
          persistence: opts.persistence,

          log: log.child('run'),
          ...(opts.signal ? { signal: opts.signal } : {}),
          ...(opts.subagentLiveCapture !== undefined
            ? { subagentLiveCapture: opts.subagentLiveCapture }
            : {}),
        },
        {
          workspaceRef: isoHandle.repos[0]?.isoWorktreePath ?? task.worktreePath,
          material: resourceMaterial,
          runtimeBinding: frozenRuntime.runtimeBinding,
        },
      )

      // RFC-026: persist opencode session id captured from the JSON event
      // stream so the NEXT clarify-driven rerun on this lineage can pass
      // it back via `--session`. NULL on failed / canceled runs is fine.
      if (lastResult.sessionId !== undefined && lastResult.sessionId !== '') {
        const persistedSessionId = lastResult.sessionId
        await opts.persistence.nodeExecution.patch({
          nodeRunId,
          values: {
            runtime: {
              opencodeSessionId: persistedSessionId,
            },
          },
          ...nodeRunLedger(state).executionContextInput(),
        })
      }
      // RFC-026: post-spawn fallback — opencode rejected the resume id we
      // passed. Treat the run as a fail-soft signal: leave the failure to
      // surface naturally (status will be 'failed' or have empty outputs),
      // but log a warning so operators can see WHY. The next retry within
      // this attempt loop will not carry resumeSessionId (we only set it
      // on the first attempt of a clarify rerun).
      if (resumeDecision.inlineMode && lastResult.status !== 'done') {
        const stderrText = await readStderrText(state.opts.persistence.nodeExecution, nodeRunId)
        // RFC-284 T15（D10）：判据下沉 driver 能力面——措辞属各 CLI 私有。
        // 无该能力的 driver 视为「无法判定」（告警可能缺失但绝不误报）。
        if (getRuntimeDriver(frozenRuntime.protocol).detectSessionNotFound?.(stderrText) === true) {
          await recordClarifyInlineEvent(state.opts.persistence.nodeExecution, nodeRunId, {
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
      await nodeRunLedger(state).transitionNodeRunStatus({
        nodeRunId,
        event: { kind: 'mark-failed', reason: 'scheduler-node-threw' },
        extra: {
          identity: {
            finishedAt: Date.now(),
            errorMessage,
            exitCode: null,
          },
        },
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
    // RFC-366 —— agent 运行结束的记忆提炼信号。
    //
    // 位置：每次 attempt 结算之后（本函数在重试循环体内），所以 loop 每轮、fanout
    // 每分片、每次重试各通知一次 —— 就是 D1 的粒度。
    //
    // 终态过滤留在这里（而不是下游）：哪些状态算「一次跑完的执行」是执行语义。
    // canceled / interrupted / exhausted / skipped 都不算（D4）。
    //
    // best-effort（D13）：通知失败绝不能影响节点结算本身，否则一个蒸馏队列的
    // 写入错误就能把一次已经成功的 agent 运行改判成失败。
    if (lastResult.status === 'done' || lastResult.status === 'failed') {
      await (state.opts.agentRunSettled ?? NOOP_AGENT_RUN_SETTLED_OBSERVER)
        .onAgentRunSettled({
          taskId,
          nodeRunId,
          nodeId: node.id,
          status: lastResult.status,
        })
        .catch((err: unknown) => {
          log.warn('agent-run settled observer failed', {
            nodeRunId,
            error: err instanceof Error ? err.message : String(err),
          })
        })
    }
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
            binding: isolatedRunBinding(state),
            isoKeyRunId,
            canonRepos: state.repos,
            log,
          })
          return isoHandle
        },
        // RFC-208: persisting the iso base must happen INSIDE the region whose
        // finally releases the permit. It used to sit between the acquire and the
        // window, and the merge_state CAS throwing there (a documented,
        // test-locked behavior — node-run-not-found / IllegalMergeStateTransition /
        // concurrent-merge-state-transition, plus any database error) leaked one
        // daemon-wide permit per occurrence with no way back short of a restart.
        persistBase: 'in-window',
        persist: async () => {
          await persistIsoBase(isolatedRunBinding(state), nodeRunId, isoHandle)
        },
      },
      onIsoSetupFailure: (err) => {
        log.warn('iso worktree setup failed', {
          nodeId: node.id,
          error: describeEffectError(err),
        })
        return {
          kind: 'settled',
          out: {
            // RFC-356 G3：分类字符串不变，summary 换成能自证的结构化诊断。
            kind: 'failed',
            summary: describeIsoFailure('isolated worktree setup failed', err),
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
            error: describeEffectError(err),
          })
          lastError = 'iso-recreate-failed'
          lastResult = {
            status: 'failed',
            exitCode: null,
            outputs: {},
            tokenUsage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0 },
            prompt: '',
            // RFC-356 G3：分类前缀不变，后面接结构化诊断（残留路径 / 最后错误 /
            // 本机进程树归属可用性）。
            errorMessage: describeIsoFailure('iso-recreate-failed', err),
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
            binding: isolatedRunBinding(state),
            writeSem,
            handle: isoHandle,
            nodeRunId,
            via: 'live',
            // RFC-193 K1: this run's own just-emitted port files (not yet in the
            // handle's DB-aggregated roster) join the final-snapshot force list.
            extraForcedContainerPaths: (r?.portFilePaths ?? []).map((p) =>
              toContainerRelative(portFallbackMount(state.repos.map((repo) => repo.mountPath)), p),
            ),
            conflictResolver: (conflicts, containerPath) =>
              resolveMergeConflicts(bindMergeConflictPorts(state), {
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
        await markMergeFailed(isolatedRunBinding(state), nodeRunId, msg, log)
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
        await discardNodeIso(bindIsolationCleanup(), h as IsoHandle, log, writeSem)
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
      const currentRunRowXc = await opts.persistence.nodeExecution.read(nodeRunId)
      const designerNodeId = findDesignerNodeForCrossClarify(definition, crossClarifyNodeId)
      // Defensive: persistent stop would have been short-circuited at
      // dispatch already. If the questioner still emitted clarify, treat
      // as protocol violation. Caller's retries (RFC-042) kick in.
      await collaboration.openAgentClarify({
        kind: 'cross',
        taskId,
        intermediaryNodeId: crossClarifyNodeId,
        askingNodeId: node.id,
        askingNodeRunId: nodeRunId,
        targetConsumerNodeId: designerNodeId ?? null,
        // RFC-354: the park row lives in the asking run's frame; loopIter is
        // the round INSIDE that frame (the cross round's `loop_iter` column).
        frame: {
          containerRunId: currentRunRowXc?.containerRunId ?? null,
          iteration: currentRunRowXc?.iteration ?? 0,
        },
        loopIter: currentRunRowXc?.iteration ?? 0,
        questions: lastResult.clarify.questions,
        ...(opts.executionContext === undefined ? {} : { executionContext: opts.executionContext }),
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
    const currentRunRow = await opts.persistence.nodeExecution.read(nodeRunId)
    // RFC-074 PR-C: the clarify round index is the asking run's generation —
    // the count of its prior completed generations (id-order) — not the retired
    // clarifyIteration counter. First clarify round → generation 0.
    const askingGeneration = currentRunRow
      ? (
          await priorDoneGenerationsForRun(state.opts.persistence.nodeExecution, {
            taskId,
            nodeId: node.id,
            iteration: currentRunRow.iteration,
            shardKey: currentRunRow.shardKey ?? null,
            id: currentRunRow.id,
            seq: currentRunRow.seq,
          })
        ).length
      : 0
    await collaboration.openAgentClarify({
      kind: 'self',
      taskId,
      askingNodeId: node.id,
      askingNodeRunId: nodeRunId,
      askingShardKey: currentRunRow?.shardKey ?? null,
      // RFC-354 (PR-3 gate P1): the park row lives in the asking run's frame —
      // generation row + round. Minted at the top frame, a gate inside a loop /
      // git wrapper was invisible to the frame-scoped frontier after the answer,
      // which then visited the "empty" gate and settled it idle (`skipped`).
      frame: {
        containerRunId: currentRunRow?.containerRunId ?? null,
        iteration: currentRunRow?.iteration ?? 0,
      },
      intermediaryNodeId: clarifyNodeId,
      iteration: askingGeneration,
      questions: lastResult.clarify.questions,
      ...(opts.executionContext === undefined ? {} : { executionContext: opts.executionContext }),
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

// RFC-060 PR-E: pickLatestSourceRun + sumChildTokens were used only by the
// agent-multi runFanOutNode path (now removed). Deleted alongside the fan-out
// implementation.

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
  persistence: NodeExecutionPersistence,
  priorRunId: string,
  agentOutputs: readonly string[],
  onlyPorts?: ReadonlySet<string>,
  envelopeNonce = '',
): Promise<string> {
  const captured = await persistence.listOutputs(priorRunId)
  const byPort = new Map(captured.map((r) => [r.portName, r.content]))
  const ordered = (agentOutputs ?? [])
    .filter((p) => onlyPorts === undefined || onlyPorts.has(p))
    .map((p) => ({ portName: p, content: byPort.get(p) ?? '' }))
    .filter((o) => o.content.length > 0)
  return buildPriorOutputBlock(ordered, envelopeNonce)
}

/**
 * RFC-119: the freshest prior run of this node at the SAME (iteration, shardKey),
 * minted before this run (earlier mint seq), that captured at least one output row —
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
 * aggregator children (shardKey null). So mint order within (nodeId, iteration,
 * shardKey) uniquely identifies the freshest prior run for all three dispatch
 * sites (single-process / fan-out shard / fan-out aggregator).
 *
 * Candidate set is tiny (one node's attempts this iteration), so the per-row
 * existence probe is cheap; the freshest candidate normally hits on the first.
 */
export async function freshestPriorRunWithOutput(
  persistence: NodeExecutionPersistence,
  run: {
    taskId: string
    nodeId: string
    iteration: number
    shardKey: string | null
    id: string
    seq: number
  },
): Promise<NodeExecutionSnapshot | undefined> {
  return persistence.snapshotRead(async (snapshot) => {
    const rows = await snapshot.list({
      taskId: run.taskId,
      nodeId: run.nodeId,
      iteration: run.iteration,
    })
    // shardKey filtered in memory (drizzle IS NULL handling varies; see
    // readPriorAgentSessionId). Walk freshest-first (largest seq) and return the
    // first prior run (any parent — see doc) that captured output.
    const history = await snapshot.selection.familyHistory(
      run.taskId,
      {
        nodeId: run.nodeId,
        iteration: run.iteration,
        shardKey: run.shardKey ?? null,
        runIds: rows.map((row) => row.id),
      },
      { before: run, direction: 'desc' },
    )
    const byId = new Map(rows.map((row) => [row.id, row]))
    const candidates = history.map((ref) => byId.get(ref.id)!)
    for (const c of candidates) {
      const has = await snapshot.listOutputs(c.id)
      if (has.length > 0) return c
    }
    return undefined
  })
}

/**
 * RFC-183 (Codex design-gate P2#1/P2#4): the cause chain of this run's
 * lineage, newest-first, INCLUDING the current row — the input to
 * `continuesClarifyLineage` (nodeRunMint.ts). Top-level rows only, same
 * (taskId, nodeId, iteration, shardKey), minted no later than current. Persisted-row
 * derivation on purpose: the verdict must survive the attempt loop
 * (process-retry mints), daemon restarts (interrupted → 'revival' mints) and
 * resumes alike — an in-memory boolean carried across attempts cannot
 * (RFC-183 design §2.5).
 */
async function lineageCausesNewestFirst(
  persistence: NodeExecutionPersistence,
  run: {
    taskId: string
    nodeId: string
    iteration: number
    shardKey: string | null
    id: string
    seq: number
  },
): Promise<Array<string | null>> {
  return persistence.snapshotRead(async (snapshot) => {
    const rows = await snapshot.list({
      taskId: run.taskId,
      nodeId: run.nodeId,
      iteration: run.iteration,
    })
    return (
      await snapshot.selection.familyHistory(
        run.taskId,
        {
          nodeId: run.nodeId,
          iteration: run.iteration,
          shardKey: run.shardKey ?? null,
          runIds: rows.map((row) => row.id),
        },
        { topLevelOnly: true, through: run, direction: 'desc' },
      )
    ).map((ref) => ref.rerunCause)
  })
}

/**
 * RFC-074 PR-C: derive a node_run's clarify "generation" from mint order instead
 * of the retired `clarifyIteration` counter. The generation is the number of
 * earlier completed generations: top-level (`parentNodeRunId === null`) `done`
 * rows for the same (taskId, nodeId, iteration, shardKey) minted before this
 * run (earlier mint seq). 0 = first generation. `done` (not canceled) so
 * review-iterate supersede markers don't inflate it; parent-null so fan-out
 * shard children don't either. Returns the prior rows too — the freshest is the
 * clarify-rerun's working draft (priorDoneDesigner) and the session-resume
 * source.
 */
async function priorDoneGenerationsForRun(
  persistence: NodeExecutionPersistence,
  run: {
    taskId: string
    nodeId: string
    iteration: number
    shardKey: string | null
    id: string
    seq: number
  },
): Promise<readonly NodeExecutionSnapshot[]> {
  return persistence.snapshotRead(async (snapshot) => {
    const rows = await snapshot.list({
      taskId: run.taskId,
      nodeId: run.nodeId,
      iteration: run.iteration,
      status: 'done',
    })
    const history = await snapshot.selection.familyHistory(
      run.taskId,
      {
        nodeId: run.nodeId,
        iteration: run.iteration,
        shardKey: run.shardKey ?? null,
        runIds: rows.map((row) => row.id),
      },
      { topLevelOnly: true, statusIn: ['done'], before: run },
    )
    const byId = new Map(rows.map((row) => [row.id, row]))
    return history.map((ref) => byId.get(ref.id)!)
  })
}

/**
 * RFC-026: look up the opencode session id captured on the agent's PRIOR
 * clarify round. RFC-074 PR-C: the retired `clarifyIteration` counter is
 * replaced by mint order — the prior generation is simply the freshest top-level
 * `done` row for this node minted BEFORE the current run (earlier mint seq),
 * scoped to the same (taskId, nodeId, iteration, shardKey). That row emitted
 * the `<workflow-clarify>` envelope the user just answered. Returns null when
 * nothing matches (will then degrade to isolated via `decideResumeSessionId`).
 */
async function readPriorAgentSessionId(
  persistence: NodeExecutionPersistence,
  args: {
    taskId: string
    agentNodeId: string
    shardKey: string | null
    iteration: number
    before: NodeRunOrderKey
  },
): Promise<string | null> {
  return persistence.snapshotRead(async (snapshot) => {
    const rows = await snapshot.list({
      taskId: args.taskId,
      nodeId: args.agentNodeId,
      iteration: args.iteration,
      status: 'done',
    })
    const history = await snapshot.selection.familyHistory(
      args.taskId,
      {
        nodeId: args.agentNodeId,
        iteration: args.iteration,
        shardKey: args.shardKey,
        runIds: rows.map((row) => row.id),
      },
      { topLevelOnly: true, statusIn: ['done'], before: args.before, direction: 'desc' },
    )
    const byId = new Map(rows.map((row) => [row.id, row]))
    const filtered = history.map((ref) => byId.get(ref.id)!)
    for (const r of filtered) {
      if (r.opencodeSessionId !== null && r.opencodeSessionId !== '') {
        return r.opencodeSessionId
      }
    }
    return null
  })
}

/**
 * RFC-026: read concatenated stderr text recorded for a node_run via the
 * runner's stderr pump. Used post-spawn to sniff for `session not found`
 * style messages so the inline-mode fallback can degrade gracefully.
 */
async function readStderrText(
  persistence: NodeExecutionPersistence,
  nodeRunId: string,
): Promise<string> {
  return await persistence.readStderr(nodeRunId)
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
  persistence: NodeExecutionPersistence,
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
  await persistence.appendEvent({
    nodeRunId,
    ts: Date.now(),
    kind: 'text',
    payload: `${tag} ${payload}`,
  })
}

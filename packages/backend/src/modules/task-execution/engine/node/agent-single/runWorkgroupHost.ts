import { findClarifyNodeForAgent } from '@agent-workflow/shared'
import type { IsoHandle } from '@/platform/contracts/isolationWorkspace'
import type { AgentNodeExecutionPorts } from '../../../application/ports/agentNodeExecution'
import type { RunResult } from '../../../application/ports/taskAgentRun'
import type {
  WorkgroupHostExecutionRequest,
  WorkgroupHostExecutionResult,
} from '../../../application/ports/workgroupHostExecution'
import { describeEffectError } from '../../../domain/effectErrorDescription'
import { runAssembly, type IsoLike } from '../../kernel/assembly'
import type { MergeSettleOutcome } from '../../kernel/merge'

// RFC-406 — the workgroup host lane of the agent-single executor, moved from composition/nodeMechanics.ts
// onto the executor's ports. The closure state (`keepHookIso`, `hookIso`, `iso`) stays exactly as RFC-287 T6
// wrote it; only the receivers changed (state / opts → ports).
// -----------------------------------------------------------------------------
// RFC-164 — workgroup engine integration. The engine (workgroupRunner.ts) owns
// orchestration; this hook owns the MECHANICS of one host-node run, copied
// from the fanout-shard dispatch path (iso worktree + frozen runtime +
// runNode + merge-back + clarify session).
// -----------------------------------------------------------------------------

export async function runWorkgroupHost(
  ports: AgentNodeExecutionPorts,
  request: WorkgroupHostExecutionRequest,
): Promise<WorkgroupHostExecutionResult> {
  const { task, policy: opts, collaboration, rules, ledger, history, workspace, log } = ports
  const { taskId, definition } = task
  const req = request.host
  const injection = await ports.resources.hostInjection(req.agent)
  if (injection.kind === 'failed') {
    await ledger.setNodeRunStatus({
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
    ports.status.broadcastNodeStatus(taskId, req.nodeRunId, req.nodeId, 'failed')
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
    | { kind: 'early'; out: WorkgroupHostExecutionResult }
    | { kind: 'ran'; result: RunResult; projected: Record<string, string> }
  return await runAssembly<Record<string, never>, HostSpawn, WorkgroupHostExecutionResult>(
    {},
    {
      // RFC-208：许可由骨架自己取自己放——外面先抢再传进来会留出「抢到许可 ~
      // 进 runAssembly」这段无人兜底的窗口。全五条线同一口径。
      pools: [ports.agentSem],
      iso: {
        create: async () => {
          hookIso = await workspace.createIsoUnderLock(req.nodeRunId)
          iso = hookIso
          return hookIso
        },
        persistBase: 'in-setup',
        persist: async (h: IsoLike) => {
          if (!h.passthrough) await workspace.persistIsoBase(req.nodeRunId, iso)
        },
      },
      onIsoSetupFailure: (err) => {
        const message = describeEffectError(err)
        log.warn('workgroup host-node iso setup failed', { nodeRunId: req.nodeRunId, message })
        return { status: 'failed', outputs: {}, errorMessage: `iso-setup-failed: ${message}` }
      },
      spawn: async (): Promise<HostSpawn> => {
        const frozen = await ports.runtime.resolve(
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
        const runRow = await ledger.read(req.nodeRunId)
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
        const result = await ports.runtime.runAgent(
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
                mountPath: task.repoMounts[i] ?? r.mountPath,
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

            log,
          },
          {
            workspaceRef: iso.repos[0]?.isoWorktreePath ?? task.worktreePath,
            material: injection.spec.material,
            runtimeBinding: frozen.runtimeBinding,
          },
        )
        const early = await (async (): Promise<WorkgroupHostExecutionResult | null> => {
          if (result.processUnreaped === true) keepHookIso = true
          ports.status.broadcastNodeStatus(taskId, req.nodeRunId, req.nodeId, result.status)
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
            const lateSuppress = async (): Promise<WorkgroupHostExecutionResult> => {
              const dropped = result.clarify?.questions.length ?? 0
              const suppressedMsg = `${rules.clarifyForbiddenPrefix}: ask-back disabled mid-run (autonomous); dropped ${dropped} question(s)`
              await ledger.setNodeRunStatus({
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
              ports.status.broadcastNodeStatus(taskId, req.nodeRunId, req.nodeId, 'failed')
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
            const currentRunRow = await ledger.read(req.nodeRunId)
            // RFC-172 (route 2, R2-T6): host clarify GENERATION — count this (node, iteration, shard)'s
            // prior DONE clarify generations (shardKey-aware; mirrors the normal-node path ~scheduler.ts
            // 3540) instead of the old hardcoded 0. A host run (leader OR member) asking a SECOND round
            // otherwise shares the first round's clarify node_run (findClarifyNodeRunForShard is
            // idempotent on iterationIndex → its questions overwrite the first's and selectAgentQueue's
            // per-origin resolve turns ambiguous). shardKey-scoped so concurrent members count only
            // their OWN prior generations.
            const askingGeneration = currentRunRow
              ? (
                  await history.priorDoneGenerationsForRun({
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
                await workspace.abandonMerge(req.nodeRunId, 'discard-writes')
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
            return await workspace.mergeBackAndSettle({
              handle: iso as IsoHandle,
              nodeRunId: req.nodeRunId,
              via: 'live',
              conflictResolver: (conflicts, containerPath) =>
                ports.conflicts.resolveMergeConflicts({
                  conflicts,
                  containerPath,
                  conflictNodeRunId: req.nodeRunId,
                  nodeId: req.nodeId,
                  iteration: 0,
                }),
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
              await workspace.abandonMerge(req.nodeRunId, 'wg-merge-conflict-unresolved')
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
        await workspace.discardNodeIso(h as IsoHandle)
      },
      settle: async (_c, s) =>
        s.kind === 'ran'
          ? { status: 'done', outputs: s.projected }
          : { status: 'failed', outputs: {}, errorMessage: 'unreachable' },
      log,
    },
  )
}

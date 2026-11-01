// RFC-412 — the automatic commit&push tail (RFC-075 / W5), moved from services/scheduler.ts: after a top-level
// node completes, each writable repository with changes gets a synthesized commit node run whose message and push
// repair are driven by the built-in commit agent. Runs on task-execution ports; the source-control commit runner and
// commit-agent helpers arrive through composition/commitPushBinding.ts.
import {
  DEFAULT_COMMIT_PUSH_DIFF_MAX_BYTES,
  DEFAULT_COMMIT_PUSH_MAX_REPAIR_RETRIES,
  type WorkflowNode,
} from '@agent-workflow/shared'
import type { AutoCommitPushPorts } from '../../../application/ports/commitPush'
import type { Logger } from '../../../application/ports/executionKernel'
import { nodeRunMintIdentityForSlot } from '../../../application/nodeRunMintIdentity'
import { createRunHistorySnapshot } from '../../../application/runHistory'

/**
 * RFC-075: auto commit&push after a top-level node completed. Diff-driven —
 * for each repo whose worktree has changes since the last commit, the
 * framework stages + commits (LLM message) + pushes via `runCommitPush`, with
 * the commit message + push repair driven by an opencode session (the built-in
 * commit agent) captured under the synthesized commit node_run. Read-only
 * nodes and no-op writers leave a clean worktree and are skipped for free.
 *
 * Only ever invoked when `task.autoCommitPush === true` (the caller
 * gates it), so this is a pure addition for opt-in tasks. Each repo's commit
 * runs sequentially in the scope's result loop, so commits never interleave.
 */
export async function runAutoCommitPush(
  ports: AutoCommitPushPorts,
  node: WorkflowNode,
  iteration: number,
  log: Logger,
): Promise<{ processUnreaped?: true }> {
  const { task } = ports
  // The triggering node's latest done run at this iteration → parent of the
  // commit row, so the detail page can group it under the agent.
  // RFC-096: freshest-by-id pick (was desc(startedAt) — a S-13 ordering fork;
  // attribution semantics unchanged, the rows are done-only).
  const parentRows = await ports.history.listDoneNodeRuns({
    taskId: task.id,
    nodeId: node.id,
    iteration,
  })
  const parentHistory = await createRunHistorySnapshot(
    task.id,
    parentRows.map((row) => ({
      ...row,
      nodeId: node.id,
      status: 'done' as const,
      iteration,
    })),
  ).familyHistory(task.id, { nodeId: node.id, iteration }, { topLevelOnly: true })
  const parentNodeRunId = parentHistory.at(-1)?.id ?? null
  const agentLabel: string =
    node.kind === 'agent-single' && typeof node.agentName === 'string' ? node.agentName : node.id
  const branch = task.branch
  // RFC-117: resolve the commit agent's runtime once for this task (profile name →
  // defaultRuntime → deprecated commitPushModel fallback); frozen per session below.
  const rt = await ports.runtime.internal({
    runtimeName: ports.config.commitPushRuntime,
    deprecatedModel: ports.config.commitPushModel,
    defaultRuntime: ports.config.defaultRuntime,
  })

  for (const repo of ports.repos) {
    // RFC-098 B1: a cancel that lands mid-commit&push stops at the next repo
    // boundary (the in-repo opencode session already holds the shared signal).
    if (ports.signal?.aborted === true) return {}
    const status = await ports.repository.statusPorcelain(repo)
    // RFC-248 D11: 只读成员不参与自动提交推送。它被改动了不是「无事发生」——
    // 框架不在文件系统层面阻止写入，所以 agent 确实可能改了它。静默丢弃最难
    // 排查，故落一条任务级告警（不改任务状态：一个误建的临时文件不该搞垮整任务）。
    // RFC-248 D11: 只读成员不参与自动提交推送。脏检查本身**不在这里**做——
    // 它挂在任务终态收尾（`inspectReadonlyRepos`），否则默认关闭自动推送的
    // 任务永远不会被检查（实现门 P1）。
    if (repo.readonly) continue
    if (status.stdout.trim() === '') continue // nothing changed in this repo
    const publicationTransport = ports.config.repositoryPublicationTransport
    if (publicationTransport === undefined) {
      throw new Error('repository-publication-transport-not-composed')
    }
    const repoSlug = repo.mountPath
    const nodeId = ports.commitAgent.nodeId(node.id, repoSlug || undefined)
    const baseRef = repo.baseBranch || task.baseBranch
    const repoName = repoSlug || repo.repoPath.split('/').pop() || 'repo'

    // Drive a commit-agent opencode session under the commit node_run id so the
    // detail-page "view session" button shows the message/repair conversation.
    const genViaOpencode = async (
      buildPrompt: (envelopeNonce: string) => string,
      ctx: { nodeRunId: string },
    ): Promise<{ message: string | null; sessionId: string | null }> => {
      // Each opencode session (message gen, each repair) runs on its OWN child
      // node_run so runNode's lifecycle state machine (pending→running→done)
      // owns it cleanly — reusing the commit container row would collide with
      // its mark-running transition. The child's parent is the container, so
      // the detail page groups the captured session(s) under the commit row.
      try {
        const sessionRunId = await ports.nodeRuns.mint({
          ...nodeRunMintIdentityForSlot(
            {
              kind: 'synthetic',
              syntheticKind: 'commit-session',
              owner: { kind: 'attempt', id: ctx.nodeRunId },
              discriminator: nodeId,
            },
            { kind: 'current' },
          ),
          taskId: task.id,
          nodeId,
          status: 'pending',
          cause: 'commit-push-session',
          iteration,
          overrides: {
            identity: {
              parentNodeRunId: ctx.nodeRunId,
            },
          },
        })
        // RFC-117: freeze the resolved commit runtime onto the session row via
        // inheritFrom — its source is config.commitPushRuntime / deprecated model
        // (not an agent.runtime row), so we pre-resolved `rt` above and freeze it
        // here, getting the same node_runs snapshot the other 3 dispatch points do.
        const frozen = await ports.runtime.resolve(
          sessionRunId,
          null,
          null,
          rt,
          // Codex impl-gate P1-2: profile binaryPath NULL + config head set used
          // to reach this spawn via opts.opencodeCmd; fold it into the freeze.
        )
        const envelopeNonce = await ports.nodeRuns.loadEnvelopeNonce(sessionRunId)
        const prepared = ports.commitAgent.prepare()
        const commitAgent = prepared.agent
        // RFC-282 B2 — the 6th/5th entries also go through the ONE resolver.
        // writeSem is held here: thread the scope signal (design §9-5).
        const commitInjection = prepared.injection
        if (commitInjection.kind === 'failed') {
          throw new Error(`commit-push injection resolve failed: ${commitInjection.message}`)
        }
        const result = await ports.runtime.runAgent(
          {
            taskId: task.id,
            nodeRunId: sessionRunId,
            nodeId,
            agent: commitAgent,
            triggerContext: null,
            expandPromptTemplate: false,
            runtime: frozen.protocol,

            runtimeParams: frozen.params,
            runtimeConfigDir: frozen.configDir, // RFC-154: frozen config-dir profile
            runtimeObservationIdentity: frozen.observationIdentity,
            observationSystemKind: 'commit-push',
            inputs: {},

            promptTemplate: buildPrompt(envelopeNonce),
            templateMeta: {
              repoPath: repo.repoPath,
              baseBranch: baseRef,
              taskId: task.id,
              nodeId,
              iteration,
              repos: ports.repos,
              // RFC-248: `{{__repo_group__}}`；非组启动时不传 ⇒ 渲染空串。
              ...(ports.repoGroupName !== null ? { repoGroupName: ports.repoGroupName } : {}),
            },
            // RFC-282 B2 / RFC-345 T4a — code-owned synthetic agents are resolved
            // explicitly without a catalog read. Any future managed reference
            // fails closed instead of being hidden behind hand-written empties.

            dependents: commitInjection.spec.dependents,
            mcps: commitInjection.spec.mcps,

            log: log.child('commit'),
            gitUserName: task.gitUserName,
            gitUserEmail: task.gitUserEmail,
          },
          {
            workspaceRef: repo.worktreePath,
            material: commitInjection.spec.material,
            runtimeBinding: frozen.runtimeBinding,
          },
        )
        const msg = result.outputs[ports.commitAgent.messagePort]
        return {
          message: msg !== undefined && msg.trim() !== '' ? msg : null,
          sessionId: result.sessionId ?? null,
          ...(result.processUnreaped === true ? { processUnreaped: true as const } : {}),
        }
      } catch (err) {
        log.warn('commit-agent opencode run failed; will fall back', {
          nodeId,
          error: err instanceof Error ? err.message : String(err),
        })
        return { message: null, sessionId: null }
      }
    }

    const commitResult = await ports.effects.runCommitPush(
      {
        taskId: task.id,
        agentNodeId: node.id,
        agentName: agentLabel,
        parentNodeRunId,
        worktreePath: repo.worktreePath,
        repositoryIdentity: repo.repoPath,
        repoBranch: branch,
        baseRef,
        ...(repoSlug ? { repoSlug } : {}),
        ownerUserId: task.ownerUserId,
        gitUserName: task.gitUserName,
        gitUserEmail: task.gitUserEmail,
        maxRepairRetries:
          ports.config.commitPushMaxRepairRetries ?? DEFAULT_COMMIT_PUSH_MAX_REPAIR_RETRIES,
        diffMaxBytes: ports.config.commitPushDiffMaxBytes ?? DEFAULT_COMMIT_PUSH_DIFF_MAX_BYTES,
        excludePatterns: await ports.config.excludePatterns(),
        // RFC-076 C4: capture the staged snapshot only when no writer node is
        // mid-write. Writers hold this same Semaphore(1) for their whole run, so
        // under the race loop this serializes the commit's `git add` against
        // them — restoring the worktree quiescence the old batch barrier gave.
        acquireWrite: () => ports.effects.acquireWrite(),
        generateMessage: (mctx) =>
          genViaOpencode(
            (envelopeNonce) =>
              ports.commitAgent.messagePrompt(
                {
                  repoName,
                  branch,
                  baseRef,
                  stat: mctx.stat,
                  diffTruncated: mctx.diffTruncated,
                  // RFC-157: undefined ≡ en-US. Initial + repair share one language.
                  lang: ports.config.commitPushLang ?? 'en-US',
                },
                envelopeNonce,
              ),
            mctx,
          ),
        generateRepair: (rctx) =>
          genViaOpencode(
            (envelopeNonce) =>
              ports.commitAgent.repairPrompt(
                {
                  branch,
                  pushStderr: rctx.pushStderr,
                  currentMessage: rctx.currentMessage,
                  stat: rctx.stat,
                  priorAttempts: rctx.priorAttempts,
                  lang: ports.config.commitPushLang ?? 'en-US',
                },
                envelopeNonce,
              ),
            rctx,
          ),
      },
      {
        log: log.child('commit'),
        publicationTransport,
      },
    )
    if (commitResult.processUnreaped === true) return { processUnreaped: true }
  }
  return {}
}

import type {
  MergeConflictPorts,
  MergeConflictRequest,
  MergeConflictManifest,
} from '../../../application/ports/mergeConflictResolution'

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
 * the runtime selection port keeps the same commit/push configuration fallback order.
 */
export async function resolveMergeConflicts(
  ports: MergeConflictPorts,
  opts: MergeConflictRequest,
): Promise<{ allResolved: boolean; detail: string }> {
  const { facts: task, log } = ports
  const rt = await ports.runtime.internal(ports.runtimeSelection)
  const mergeNodeId = ports.template.mergeResolveNodeId(opts.nodeId, opts.iteration)
  const runAgent = async (
    _legacyPrompt: string,
    cwd: string,
    manifest: MergeConflictManifest,
  ): Promise<void> => {
    const sessionRunId = await ports.ledger.mintNodeRun({
      ...ports.ledger.nodeRunMintIdentityForSlot(
        {
          kind: 'synthetic',
          syntheticKind: 'merge-resolve',
          owner: { kind: 'attempt', id: opts.conflictNodeRunId },
          discriminator: mergeNodeId,
        },
        { kind: 'current' },
      ),
      taskId: task.taskId,
      nodeId: mergeNodeId,
      status: 'pending',
      cause: 'merge-resolve',
      iteration: opts.iteration,
      overrides: {
        identity: {
          parentNodeRunId: opts.conflictNodeRunId,
        },
      },
    })
    const frozen = await ports.runtime.resolve(
      sessionRunId,
      null,
      null,
      rt,
      // Codex impl-gate P1-2: same config-head fold as the commit-session site.
    )
    const envelopeNonce = await ports.ledger.loadEnvelopeNonce(sessionRunId)
    const mergeAgent = ports.template.buildMergeAgent()
    // RFC-282 B2 — single-resolver derivation (writeSem held: signal threaded).
    const mergeInjection = ports.agent.resolveSyntheticTaskAgentInjection(mergeAgent)
    if (mergeInjection.kind === 'failed') {
      throw new Error(`merge injection resolve failed: ${mergeInjection.message}`)
    }
    // DIRECT runNode — bypasses the node pool on purpose (§7 deadlock avoidance).
    const mergeAgentResult = await ports.agent.runNode(
      {
        taskId: task.taskId,
        nodeRunId: sessionRunId,
        nodeId: mergeNodeId,
        agent: mergeAgent,
        triggerContext: null,
        expandPromptTemplate: false,
        runtime: frozen.protocol,

        runtimeParams: frozen.params,
        runtimeConfigDir: frozen.configDir, // RFC-154: frozen config-dir profile
        runtimeObservationIdentity: frozen.observationIdentity,
        observationSystemKind: 'merge-resolve',
        inputs: {},

        promptTemplate: ports.template.buildMergeResolvePrompt({ manifest, envelopeNonce }),
        templateMeta: {
          repoPath: cwd,
          baseBranch: task.baseBranch,
          taskId: task.taskId,
          nodeId: mergeNodeId,
          iteration: opts.iteration,
          repos: task.repositories,
          ...(task.repoGroupName !== null ? { repoGroupName: task.repoGroupName } : {}),
        },
        // RFC-282 B2 — same single-resolver derivation as commit-push above.

        dependents: mergeInjection.spec.dependents,
        mcps: mergeInjection.spec.mcps,

        log: log.child('merge'),
        gitUserName: task.gitUserName,
        gitUserEmail: task.gitUserEmail,

        ...(ports.signal ? { signal: ports.signal } : {}),
        // RFC-208: this was the ONLY runNode call site without a timeout, and it
        // runs inside the per-task writeSem — so a merge agent that hangs blocks
        // every other writer for that task (review decisions, clarify dispatch)
        // with no SIGTERM→SIGKILL escalation ever armed. Same budget as every
        // other node.
        ...(ports.timeoutMs !== undefined ? { timeoutMs: ports.timeoutMs } : {}),
      },
      {
        workspaceRef: cwd,
        material: mergeInjection.spec.material,
        runtimeBinding: frozen.runtimeBinding,
      },
    )
    if (mergeAgentResult.processUnreaped === true) {
      throw ports.diagnostics.mergeAgentChildUnreapedError()
    }
  }
  let allResolved = true
  const parts: string[] = []
  for (const conflict of opts.conflicts) {
    const outcome = await ports.workspace.resolveIsolatedConflict(conflict, {
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
        `${conflict.mountPath || '(repo)'}: ${outcome.unresolved.map((e) => e.path).join(', ')}${salvageNote}`,
      )
    }
  }
  return { allResolved, detail: parts.join('; ') }
}

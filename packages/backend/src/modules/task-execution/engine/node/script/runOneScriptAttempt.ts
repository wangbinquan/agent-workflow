import {
  isDaemonInterruptionAbortReason,
  maskScriptEnvValues,
  readScriptDependencies,
  readScriptEnv,
  scriptOutputMode,
} from '@agent-workflow/shared'
import {
  ScriptDepsInstallError,
  type TaskScriptDependencyEnvironment,
} from '../../../application/ports/taskScriptRunFamily'
import type {
  ScriptNodeExecutionPorts,
  ScriptProcessEffect,
} from '../../../application/ports/scriptNodeExecution'
import type { ScriptAttemptArgs, ScriptAttemptOutcome } from './types'

/** One attempt: dependencies -> spawn -> ports -> terminal row. */
export async function runOneScriptAttempt(
  ports: ScriptNodeExecutionPorts,
  a: ScriptAttemptArgs,
): Promise<ScriptAttemptOutcome> {
  const { task, policy: opts, log } = ports
  const { taskId } = task
  const signal = a.signal
  const runContent = ports.process.prepareRunContent(taskId, a.nodeRunId)

  // The iso handle is created before every attempt, including readonly. The
  // scope-root fallback exists only for defensive compatibility with a
  // passthrough handle implementation.
  const worktreePath = a.isoHandle?.repos[0]?.isoWorktreePath ?? task.scopeRoot
  // Every repo this attempt may touch — the boundary must match the paths
  // `AW_REPOS_JSON` hands the script, not just the primary one.
  //
  // `name` is the RFC-248 canonical repo key (the mount path), not the legacy
  // `worktreeDirName` — the latter loses the nesting for a repo-group member
  // mounted at `a/b`.
  const repoProjection =
    a.isoHandle === null
      ? task.repos.map((r) => ({ name: r.mountPath, path: r.worktreePath }))
      : a.isoHandle.repos.map((r, i) => ({
          name: task.repos[i]?.mountPath ?? r.mountPath,
          path: r.isoWorktreePath,
        }))
  // Dependencies are deterministic and prebuilt-only, but otherwise run with
  // the daemon's natural toolchain and network access.
  let depsEnv: TaskScriptDependencyEnvironment | null = null
  const specs = readScriptDependencies(a.node)
  if (specs.length > 0) {
    try {
      depsEnv = await ports.process.ensureDependencies({
        contentHomeRef: opts.appHome,
        language: a.language,
        interpreter: ports.process.dependencyInterpreter(a.interpreter),
        specs,
        timeoutMs: opts.scriptDepsInstallTimeoutMs ?? 10 * 60 * 1000,
        ...(signal === undefined ? {} : { signal: signal }),
        onLine: async (stream: 'stdout' | 'stderr', line: string) =>
          await ports.ledger.appendEvent({
            nodeRunId: a.nodeRunId,
            ts: Date.now(),
            kind: stream === 'stderr' ? 'stderr' : 'text',
            payload: JSON.stringify({ phase: 'deps-install', line }),
          }),
        log,
      })
    } catch (err) {
      const detail = err instanceof ScriptDepsInstallError ? err.detail : String(err)
      const message = err instanceof Error ? err.message : String(err)
      await ports.ledger.setNodeRunStatus({
        nodeRunId: a.nodeRunId,
        to: 'failed',
        allowedFrom: ['pending', 'running'],
        reason: 'script-deps-install-failed',
        extra: {
          identity: {
            finishedAt: Date.now(),
            errorMessage: `${message}\n${detail}`.slice(0, 4000),
            failureCode: 'script-deps-install-failed',
          },
        },
      })
      ports.status.broadcastNodeStatus(taskId, a.nodeRunId, a.node.id, 'failed')
      return { kind: 'failed', summary: message, message: 'script-deps-install-failed' }
    }
  }

  const envelopeNonce = await ports.ledger.loadEnvelopeNonce(a.nodeRunId)

  // RFC-253 T28 — resolved once and shared by every diagnostic sink below, so
  // no sink can drift into persisting what another one masks.
  const scriptEnv = readScriptEnv(a.node)

  // DB first, then broadcast — a client must never observe `running` for a row
  // the database still calls `pending`.
  await ports.ledger.setNodeRunStatus({
    nodeRunId: a.nodeRunId,
    to: 'running',
    allowedFrom: ['pending'],
    reason: 'script-dispatch',
    extra: {
      identity: {
        startedAt: Date.now(),
      },
    },
  })
  ports.status.broadcastNodeStatus(taskId, a.nodeRunId, a.node.id, 'running')

  let processEffect: ScriptProcessEffect | undefined
  const outcome = await ports.process.runScriptProcess({
    node: a.node,
    inputs: a.inputs,
    runContent,
    workspaceRef: worktreePath,
    // 2026-08-04 audit: hand the script the paths it is actually allowed to
    // touch. This used to be the CANONICAL worktree while a non-readonly node
    // runs in its iso copy — so a script that followed the documented
    // `AW_REPOS_JSON` contract wrote outside its isolation: EPERM on macOS,
    // and on Linux a silent write into the appHome tmpfs that evaporated at
    // exit. The agent path next door already resolves iso paths for the same
    // reason (`{{__repos__}}` below).
    repositories: repoProjection.map((r) => ({ name: r.name, reference: r.path })),
    taskId,
    nodeId: a.node.id,
    nodeRunId: a.nodeRunId,
    iteration: a.iteration,
    retryIndex: a.retryIndex,
    shardKey: null,
    envelopeNonce,
    interpreter: a.interpreter,
    dependencies: depsEnv,
    ...(opts.defaultPerNodeTimeoutMs === undefined
      ? {}
      : { timeoutMs: opts.defaultPerNodeTimeoutMs }),
    ...(signal === undefined ? {} : { signal: signal }),
    beforeStart: async (start) => {
      processEffect = ports.effect.createProcessEffectAttemptObserver({
        taskId,
        nodeRunId: a.nodeRunId,
        start,
        resources: a.isReadonly ? [] : { writerWorkspace: worktreePath },
      })
      await processEffect?.beforeSpawn()
    },
    gitUserName: task.gitUserName,
    gitUserEmail: task.gitUserEmail,
    onStarted: async (receipt) => {
      // Persist before reading a single byte of output: a daemon crash after
      // this point leaves the boot reaper something to match (design-gate P0-3).
      const runtimeParamsJson = ports.process.runtimeParameters({
        interpreter: a.interpreter,
        dependencies: depsEnv,
      })
      if (processEffect === undefined) {
        await ports.process.recordUnownedStart({
          nodeRunId: a.nodeRunId,
          receipt,
          runtimeParamsJson,
        })
      } else {
        await processEffect.recordSpawnReceipt(receipt, runtimeParamsJson)
      }
    },
    requireStartReceipt: true,
    onStdoutLine: async (line, sourceKey) => {
      // NOT masked, deliberately: stdout is the DATA channel. Its bytes become
      // the port value verbatim (AC-27), so masking this mirror would show the
      // operator something the downstream node never sees. A script that prints
      // its own credential to stdout has published it as data.
      await ports.ledger.appendEvent({
        ...(sourceKey === undefined ? {} : { sourceKey }),
        nodeRunId: a.nodeRunId,
        ts: Date.now(),
        kind: 'text',
        payload: JSON.stringify({ line }),
      })
    },
    onStderrLine: async (line, sourceKey) => {
      // RFC-253 T28 — stderr is the DIAGNOSTIC channel and these rows are a
      // read surface (node-run events route, /session reconstruction, WS
      // replay). Masking only the failure detail below was not enough: that
      // value is `stderrTail`, a strict SUFFIX of the very bytes this sink
      // stores, so the same secret stayed in the clear one table over.
      await ports.ledger.appendEvent({
        ...(sourceKey === undefined ? {} : { sourceKey }),
        nodeRunId: a.nodeRunId,
        ts: Date.now(),
        kind: 'stderr',
        payload: JSON.stringify({ line: maskScriptEnvValues(line, scriptEnv) }),
      })
    },
    log,
  })

  if (outcome.result.outcome === 'aborted') {
    const daemonShutdown = isDaemonInterruptionAbortReason(signal?.reason)
    await ports.ledger.setNodeRunStatus({
      nodeRunId: a.nodeRunId,
      to: daemonShutdown ? 'interrupted' : 'canceled',
      allowedFrom: ['running'],
      reason: 'script-aborted',
      extra: {
        identity: {
          finishedAt: Date.now(),
          exitCode: outcome.result.exitCode,
        },
      },
    })
    await processEffect?.settle(outcome.result)
    ports.status.broadcastNodeStatus(
      taskId,
      a.nodeRunId,
      a.node.id,
      daemonShutdown ? 'interrupted' : 'canceled',
    )
    return { kind: 'canceled', message: daemonShutdown ? 'daemon-shutdown' : 'canceled' }
  }

  if (outcome.result.truncated.stdout) {
    await ports.ledger.appendEvent({
      nodeRunId: a.nodeRunId,
      ts: Date.now(),
      kind: 'error',
      payload: JSON.stringify({ truncated: 'stdout' }),
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
  const outputPorts: Record<string, string> = {}
  /** RFC-306: ports this script closed with `active="false"`. */
  const inactivePorts = new Set<string>()

  if (failureCode === null) {
    const extraction = ports.output.extractScriptPorts({
      node: a.node,
      rawStdout: outcome.result.rawStdout,
      nonce: envelopeNonce,
    })
    if (extraction.kind === 'ok') {
      Object.assign(outputPorts, extraction.ports)
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
    await ports.ledger.setNodeRunStatus({
      nodeRunId: a.nodeRunId,
      to: 'failed',
      allowedFrom: ['running'],
      reason: failureCode,
      extra: {
        identity: {
          finishedAt: Date.now(),
          exitCode: outcome.result.exitCode,
          errorMessage,
          failureCode,
        },
      },
    })
    await processEffect?.settle(outcome.result)
    ports.status.broadcastNodeStatus(taskId, a.nodeRunId, a.node.id, 'failed')
    return {
      kind: 'failed',
      summary: errorMessage ?? `script exited ${String(outcome.result.exitCode)}`,
      message: failureCode,
    }
  }

  await ports.ledger.upsertOutputs({
    nodeRunId: a.nodeRunId,
    outputs: Object.entries(outputPorts).map(([portName, content]) => ({
      portName,
      content,
      // RFC-306: a script closes a branch the same way an agent does.
      active: !inactivePorts.has(portName),
    })),
  })
  // RFC-276 regression fix: a readonly script's iso is discarded without a
  // merge-back, but its 'isolating' stamp must still SETTLE — deriveFrontier's
  // D15 gate only completes done rows whose merge_state is settled, so a
  // done+isolating row wedges the scope forever ("scheduler stalled / no ready
  // nodes in scope"; pre-RFC-276 readonly scripts ran in place and stayed NULL).
  // Settled BEFORE the done write so no done+unsettled state is ever observable.
  if (a.isReadonly && a.isoHandle !== null && !a.isoHandle.passthrough) {
    await ports.workspace.transitionMergeState({
      nodeRunId: a.nodeRunId,
      event: { kind: 'discard-readonly' },
    })
  }
  await ports.ledger.setNodeRunStatus({
    nodeRunId: a.nodeRunId,
    to: 'done',
    allowedFrom: ['running'],
    reason: 'script-done',
    extra: {
      identity: {
        finishedAt: Date.now(),
        exitCode: outcome.result.exitCode,
      },
    },
  })
  await processEffect?.settle(outcome.result)
  ports.status.broadcastNodeStatus(taskId, a.nodeRunId, a.node.id, 'done')
  return { kind: 'done' }
}

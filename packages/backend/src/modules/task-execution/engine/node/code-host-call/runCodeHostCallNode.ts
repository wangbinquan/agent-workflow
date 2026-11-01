import type { CodeHostNodeExecutionPorts } from '../../../application/ports/codeHostNodeExecution'
import type { NodeStepRequest, NodeStepOutcome } from '../../../domain/nodeExecution'
import { isCodeHostAction, type CodeHostCustomRequest } from '@agent-workflow/shared'
import { pickString } from '../../../domain/nodeFields'
import { sha256Hex } from '../../../domain/digest'
import {
  decodeLineageSlotPath,
  encodeLineageSlotPath,
  type LineageSlot,
} from '../../../domain/executionIntent'
import {
  requestHash as executionEffectRequestHash,
  operationFamilyKey,
} from '../../../domain/executionEffect'

/** HTTP retries and send/probe recovery only; code-host has no node-level retry or assembly. */
export async function runCodeHostCallNode(
  ports: CodeHostNodeExecutionPorts,
  args: NodeStepRequest<'code-host-call'>,
): Promise<NodeStepOutcome> {
  const { task, policy: opts, codeHostSem } = ports
  const { taskId } = task
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

  const { inputs: upstreamInputs, consumed } = await ports.input.resolveUpstreamInputs(node.id, {
    containerRunId: args.containerRunId,
    iteration,
  })

  // Row selection mirrors the script/agent branches exactly: adopt the pending
  // row if one exists (that is what `retryNode` mints for a user-requested
  // retry and what the cascade mints downstream), otherwise take the next
  // retry index. Minting unconditionally would leave the placeholder pending
  // forever and make `isFresherNodeRun` pick between two rows for the same
  // attempt.
  const consumedUpstreamJson = ports.input.prepareConsumedInputs(consumed)
  const sameNodeIterRuns = await ports.ledger.listNodeRuns({
    taskId,
    nodeId: node.id,
    iteration,
  })
  // RFC-287 T8：取行前奏收编。本线两处与其余三线不同，**都不能统一掉**：
  //   · 不追 retryIndex —— 代码平台调用没有节点级重试（只有 HTTP 幂等重试）；
  //   · 不广播 pending —— 它铸完立刻转 running（下方），多播一条 WS 事件会让
  //     前台看到一个根本不存在的 pending 态。
  const { nodeRunId } = await ports.ledger.resolveSchedulerRunRow({
    taskId,
    nodeId: node.id,
    containerRunId: args.containerRunId,
    iteration,
    consumedUpstreamJson,
    rows: sameNodeIterRuns,
    inheritReviewIteration: false,
    clearAgentOverride: false,
    trackRetryIndex: false,
    broadcastPending: null,
    // RFC-369 实现门 P3-1：canceled 是真实终态（不像 pending 马上转 running），照常广播。
    broadcastCanceled: (id) => ports.status.broadcastNodeStatus(taskId, id, node.id, 'canceled'),
  })
  await ports.ledger.setNodeRunStatus({
    nodeRunId,
    to: 'running',
    allowedFrom: ['pending'],
    reason: 'code-host-call-start',
    extra: {},
  })
  ports.status.broadcastNodeStatus(taskId, nodeRunId, node.id, 'running')

  const settle = async (
    to: 'done' | 'failed',
    reason: string,
    extra: { readonly errorMessage?: string | null; readonly failureCode?: string | null },
  ): Promise<void> => {
    await ports.ledger.setNodeRunStatus({
      nodeRunId,
      to,
      allowedFrom: ['running'],
      reason,
      extra: {
        identity: {
          finishedAt: Date.now(),
          ...extra,
        },
      },
    })
    ports.status.broadcastNodeStatus(taskId, nodeRunId, node.id, to)
  }

  // RFC-349: provider bootstrap owns credential persistence. The execution
  // plane consumes only the async connection participant and never reopens a
  // SQLite key-file adapter as an implicit fallback.
  const connections = opts.codeHostConnections
  const connection = connections === undefined ? null : await connections.resolve(provider)
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

  const attemptObserver = await (async () => {
    if (!ports.effects.enabled) return undefined
    const run = await ports.ledger.read(nodeRunId)
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
    const attemptPlan = await ports.effects.planCodeHostAttempt({
      executionLineageId,
      operationFamilyKey: familyKey,
    })
    const objectCoordinates = Object.fromEntries(
      ['project', 'mr', 'issue', 'thread', 'comment', 'draft', 'pipeline', 'job', 'sha', 'workflow']
        .filter((key) => params[key] !== undefined)
        .map((key) => [key, params[key]]),
    )
    return ports.effects.createCodeHostEffectAttemptObserver({
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
  let outcome: Awaited<ReturnType<CodeHostNodeExecutionPorts['requests']['executeCodeHostCall']>>
  try {
    let recoveryCycle = 0
    for (;;) {
      outcome = await ports.requests.executeCodeHostCall(
        {
          provider,
          action,
          params,
          ...(rawRequest !== undefined ? { request: rawRequest as CodeHostCustomRequest } : {}),
          allowDestructive:
            (node as unknown as { allowDestructive?: unknown }).allowDestructive === true,
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        },
        {
          connection,
          ctx: { ports: upstreamInputs, triggerContext: task.triggerContext },
          projectFallback: ports.requests.resolveProjectFallback({
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
      const probe = await ports.requests.probeCodeHostMutation({
        descriptor,
        resolveConnection: async (targetProvider) =>
          targetProvider === provider
            ? connection
            : connections === undefined
              ? null
              : await connections.resolve(targetProvider),
        ...(opts.codeHostFetch !== undefined ? { fetchImpl: opts.codeHostFetch } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      })
      if (probe.kind === 'definitely-not-applied' && recoveryCycle > 0) break
      const resolution = await attemptObserver.resolveTerminalProbe(probe)
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
      (await attemptObserver?.settleTerminal({
        nodeRunId,
        status: 'failed',
        reason: failureCode,
        finishedAt,
        errorMessage,
        failureCode,
      })) === true
    if (settledWithEffect) ports.status.broadcastNodeStatus(taskId, nodeRunId, node.id, 'failed')
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

  const outputs = [
    { portName: 'response', content: outcome.body },
    { portName: 'status', content: String(outcome.status) },
  ] as const
  const finishedAt = Date.now()
  const settledWithEffect =
    (await attemptObserver?.settleTerminal({
      nodeRunId,
      status: 'done',
      reason: 'code-host-call-done',
      finishedAt,
      outputs,
    })) === true
  if (settledWithEffect) ports.status.broadcastNodeStatus(taskId, nodeRunId, node.id, 'done')
  else {
    await ports.ledger.upsertOutputs({
      nodeRunId,
      outputs,
    })
    await settle('done', 'code-host-call-done', {})
  }
  return {
    kind: 'ok',
    summary: `${outcome.method} ${outcome.pathname} → ${outcome.status}`,
    message: '',
  }
}

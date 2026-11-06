import { buildPriorOutputBlock, type NodeRunOrderKey } from '@agent-workflow/shared'
import { FRAMEWORK_AUDIT_EVENT_PREFIX } from '../domain/envelopeRetryPolicy'
import type {
  NodeExecutionPersistence,
  NodeExecutionSnapshot,
} from './ports/nodeExecutionPersistence'

// RFC-405 — run-history reads shared by the agent-single body and the wrapper fan-out shards /
// aggregator. Moved verbatim from composition/nodeMechanics.ts; each reads the persistence it is given.

/**
 * RFC-026: why an inline clarify rerun fell back to an isolated session — `decideResumeSessionId`'s
 * two pre-spawn exits plus the post-spawn `session-not-found`. Task-execution's own copy of the union
 * in `domain/sessionModeFallback.ts`: the agent binding passes that decision through the rules port,
 * so the compiler rejects any reason this record does not accept.
 */
export type ClarifyInlineFallbackReason =
  | 'missing-session-id'
  | 'session-not-found'
  | 'session-resume-unsupported'

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
export async function lineageCausesNewestFirst(
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
export async function priorDoneGenerationsForRun(
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
export async function readPriorAgentSessionId(
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
export async function readStderrText(
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
export async function recordClarifyInlineEvent(
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

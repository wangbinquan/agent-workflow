// RFC-098 WP-10 T-a (audit S-16) — the single node_runs INSERT factory.
//
// Before this module, 13 call sites across 6 files each hand-rolled their own
// `db.insert(nodeRuns).values({...})` with a hand-copied subset of the
// inheritance fields — the exact substrate on which the proxy-signal gating
// bugs (audit S-25) grew. Every node_run row in the system is now minted HERE
// and nowhere else (locked by rfc098-node-run-mint-grep-guard.test.ts, same
// mechanism as lifecycle-grep-guard.test.ts; escape hatch:
// `// rfc098-allow-direct-node-run-insert` on the line above the insert).
//
// Placement: this module sits BELOW scheduler / review / clarify /
// crossClarify / task (they all import it, it imports none of them) so the
// factory does not re-grow the scheduler↔review module cycle RFC-096 broke.
//
// Lifecycle note (RFC-098 design 对抗检视修订 #10): the RFC-053 state machine
// (`lifecycle.ts`) governs UPDATES, not INSERTS — minting a row directly at
// 'running' is legal here and is exactly what the commit&push container row
// does (commitPushRunner.ts). The factory enforces the one invariant that
// direct-running minting must keep: a 'running' row MUST be a child row
// (parentNodeRunId non-null), because a top-level running row would enter
// deriveFrontier's in-flight set and freeze the frontier. Violation throws
// (pinned by node-run-mint.test.ts).

import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { NodeRunStatus, RerunCause } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { nodeRuns } from '@/db/schema'
import { dbTxSync } from '@/db/txSync'
import { abandonSupersededMergeStates } from '@/services/lifecycle'
import type { RuntimeKind } from '@/services/runtime'
import { isKnownRuntimeKind } from '@/services/runtime'
import { resolveAgentRuntime, type RuntimeProfile } from '@/services/runtimeRegistry'
import { createLogger } from '@/util/log'

/**
 * Statuses a row may be BORN with. Everything else (canceled / interrupted /
 * skipped / exhausted) is only reachable via lifecycle transitions on an
 * existing row.
 *
 *   - 'pending'         — the common case (scheduler / rerun mints)
 *   - 'running'         — commit&push container row ONLY (child row; see
 *                         module header)
 *   - 'done'            — virtual IO rows (input / output nodes)
 *   - 'failed'          — retryNode 'queued for retry' placeholder rows
 *   - 'awaiting_review' — review park (review.ts)
 *   - 'awaiting_human'  — clarify / cross-clarify park
 */
export type MintableNodeRunStatus = Extract<
  NodeRunStatus,
  'pending' | 'running' | 'done' | 'failed' | 'awaiting_review' | 'awaiting_human'
>

/**
 * THE single inheritance list (RFC-098 survey §wp10-三): when a mint is a
 * re-incarnation of a prior row, exactly these four fields carry over. Any
 * caller that needs a different subset passes `overrides` (which always win
 * over `inheritFrom`).
 */
export interface MintInheritSource {
  reviewIteration: number
  shardKey: string | null
  parentNodeRunId: string | null
  preSnapshot: string | null
}

/**
 * Explicit per-site deviations — the union of what the 13 historical call
 * sites actually set. `undefined` = "not overridden" (inherit / default);
 * explicit `null` is a real value (e.g. review-rerun rows force
 * parentNodeRunId null, the legacy rerun mints force startedAt null).
 */
export interface MintNodeRunOverrides {
  parentNodeRunId?: string | null
  shardKey?: string | null
  reviewIteration?: number
  preSnapshot?: string | null
  /** RFC-098 B3: fanout shard child rows only. */
  shardValueHash?: string | null
  /** RFC-074 provenance map `{upstreamNodeId: nodeRunId}` (JSON). */
  consumedUpstreamRunsJson?: string | null
  errorMessage?: string | null
  /**
   * Default is `Date.now()`. The clarify / cross-clarify / review rerun
   * mints historically wrote NO startedAt (NULL) — they pass `null`
   * explicitly to preserve that (the runner stamps real timing when the row
   * actually runs).
   */
  startedAt?: number | null
  /** Default: now for status 'done', NULL otherwise. */
  finishedAt?: number | null
  /**
   * RFC-127 借壳: name of the borrowed agent X this row runs under, while
   * node_id stays the original node P. NULL/undefined = the node's default
   * agent (normal path). Orthogonal to `inheritFrom` (the inheritance list has
   * no agent — borrowing is a new dimension).
   */
  agentOverrideName?: string | null
}

export interface MintNodeRunArgs {
  taskId: string
  nodeId: string
  status: MintableNodeRunStatus
  /**
   * WHY this row exists (RFC-098 WP-10 / audit S-25). Persisted on
   * `node_runs.rerun_cause` (migration 0044) and read back by the
   * scheduler's injection gates instead of proxy signals.
   */
  cause: RerunCause
  /** Default 0. */
  retryIndex?: number
  /** Default 0. */
  iteration?: number
  /** Single-list inheritance (see {@link MintInheritSource}); null/undefined = defaults. */
  inheritFrom?: MintInheritSource | null
  overrides?: MintNodeRunOverrides
}

/**
 * Mint one node_runs row. Returns the new ULID id.
 *
 * Resolution order per field: `overrides` ≻ `inheritFrom` ≻ default.
 */
/**
 * Build the node_runs INSERT row WITHOUT touching the DB (the pure field-
 * resolution half of {@link mintNodeRun}). Lets a caller that needs the row id
 * BEFORE the insert (RFC-120 T9 dispatchTaskQuestions — atomic claim+mint inside
 * one `dbTxSync`) preallocate `id` and run the insert synchronously
 * (`tx.insert(nodeRuns).values(buildMintNodeRunValues({ id, … })).run()`). The
 * async {@link mintNodeRun} delegates here, so both paths share one inheritance /
 * default / guard implementation (no drift).
 *
 * Resolution order per field: `overrides` ≻ `inheritFrom` ≻ default.
 */
export function buildMintNodeRunValues(
  args: MintNodeRunArgs & { id?: string },
): typeof nodeRuns.$inferInsert {
  const id = args.id ?? ulid()
  const now = Date.now()
  const inherit = args.inheritFrom ?? null
  const o = args.overrides ?? {}

  const parentNodeRunId =
    o.parentNodeRunId !== undefined ? o.parentNodeRunId : (inherit?.parentNodeRunId ?? null)
  const shardKey = o.shardKey !== undefined ? o.shardKey : (inherit?.shardKey ?? null)
  const reviewIteration =
    o.reviewIteration !== undefined ? o.reviewIteration : (inherit?.reviewIteration ?? 0)
  const preSnapshot = o.preSnapshot !== undefined ? o.preSnapshot : (inherit?.preSnapshot ?? null)

  // RFC-098 对抗检视修订 #10 — frontier invisibility invariant: a row born
  // 'running' must be a CHILD row. deriveFrontier treats top-level running
  // rows as in-flight, so a parentless running mint would freeze every
  // downstream node until something else flips it. The only legal direct-
  // running mint (commit&push container) is always parented to the
  // triggering agent run.
  if (args.status === 'running' && parentNodeRunId === null) {
    throw new Error(
      `mintNodeRun: refusing to mint a top-level 'running' row for node '${args.nodeId}' ` +
        `(task ${args.taskId}) — born-running rows must carry parentNodeRunId ` +
        `(frontier invisibility, RFC-098 revision #10)`,
    )
  }

  return {
    id,
    taskId: args.taskId,
    nodeId: args.nodeId,
    status: args.status,
    // RFC-098 WP-10 T-b: the cause column (migration 0044) — the single
    // write point in the codebase.
    rerunCause: args.cause,
    retryIndex: args.retryIndex ?? 0,
    iteration: args.iteration ?? 0,
    reviewIteration,
    shardKey,
    parentNodeRunId,
    preSnapshot,
    shardValueHash: o.shardValueHash ?? null,
    consumedUpstreamRunsJson: o.consumedUpstreamRunsJson ?? null,
    errorMessage: o.errorMessage ?? null,
    startedAt: o.startedAt !== undefined ? o.startedAt : now,
    finishedAt: o.finishedAt !== undefined ? o.finishedAt : args.status === 'done' ? now : null,
    agentOverrideName: o.agentOverrideName ?? null,
  }
}

export async function mintNodeRun(db: DbClient, args: MintNodeRunArgs): Promise<string> {
  const values = buildMintNodeRunValues(args)
  // RFC-144 D12 (stale-replay fix): abandoning the superseded generations'
  // in-flight merge_state and inserting the successor MUST commit atomically —
  // a crash between two separate statements would leave the old pending-merge
  // row replayable at the next runTask entry (the exact bug this closes), or
  // conversely a successor row whose predecessors were never retired.
  dbTxSync(db, (tx) => {
    abandonSupersededMergeStates({
      db: tx,
      taskId: values.taskId,
      nodeId: values.nodeId,
      iteration: values.iteration ?? 0,
      supersededByRunId: values.id,
    })
    tx.insert(nodeRuns).values(values).run()
  })
  return values.id
}

/**
 * RFC-098 对抗检视修订 #11 — the scheduler main-mint cause merge rule.
 * Maps the freshest existing top-level row's status to the cause recorded on
 * the fresh row the scheduler is about to mint. Pinned branch-by-branch by
 * rfc098-rerun-cause-gates.test.ts; see RERUN_CAUSES doc (shared/schemas/
 * task.ts) for the rationale per branch.
 */
export function schedulerMintCause(
  latestExisting: { status: string } | undefined,
): Extract<RerunCause, 'initial' | 'stale-redispatch' | 'revival'> {
  if (latestExisting === undefined) return 'initial'
  switch (latestExisting.status) {
    case 'failed':
    case 'interrupted':
    case 'canceled':
    case 'exhausted':
      return 'revival'
    // 'done' = upstream advanced → stale re-dispatch; awaiting_* = stale
    // PARKED row re-dispatched (the park row keeps its own *-park cause);
    // pending / running / skipped are defensive (see RERUN_CAUSES doc).
    default:
      return 'stale-redispatch'
  }
}

/**
 * RFC-098 WP-10 T-c — gate-2 (`isClarifyRerun`) cause set. TRUE only for the
 * two rerun kinds whose prompt/session semantics are "the SAME logical round
 * continues after a human answered":
 *   - 'clarify-answer'                  — RFC-023 self-clarify answer rerun
 *   - 'cross-clarify-questioner-rerun'  — questioner stop / reject / continue
 *     rerun (deliberately minted at retryIndex 0 pre-WP-10 to ride the same
 *     gate; the cause column now states it outright)
 *
 * Deliberately NOT in the set (RFC-098 对抗检视修订 #11):
 *   - 'cross-clarify-answer' (designer update rerun) — it uses the separate
 *     retry-agnostic `isCrossClarifyTriggeredRerun` update-mode path, which
 *     stays generation-derived (in-attempt process retries must see the same
 *     working draft).
 *   - 'process-retry' — design.md §7 forbids inline resume on technical
 *     retries; a retry within a clarify round re-derives its Q&A from
 *     generation order, not from this gate.
 *
 * `null` (pre-0044 legacy rows dispatched across a daemon upgrade) gates
 * FALSE: the rerun still runs and still sees its Q&A context (that path is
 * generation-derived, not gated here) — it only loses inline-session resume
 * and latest-directive application for that one boundary dispatch.
 */
export function isClarifyRerunCause(cause: string | null | undefined): boolean {
  return cause === 'clarify-answer' || cause === 'cross-clarify-questioner-rerun'
}

/** RFC-112/113: the frozen runtime snapshot a node_run dispatches/resumes on. */
export interface FrozenRuntime {
  /** RuntimeDriver kind — decides the driver + session-id format. */
  protocol: RuntimeKind
  /** The custom binary head snapshot, or null = the protocol's default binary. */
  binary: string | null
  /** RFC-113 (Codex P1-2): the execution params (model/variant/...) frozen too. */
  params: RuntimeProfile
}

/** Parse the frozen `runtime_params_json`, tolerating legacy NULL / bad JSON. */
function parseFrozenParams(json: string | null | undefined): RuntimeProfile {
  if (json != null && json.length > 0) {
    try {
      const p = JSON.parse(json) as Partial<RuntimeProfile>
      return {
        model: p.model ?? null,
        variant: p.variant ?? null,
        temperature: p.temperature ?? null,
        steps: p.steps ?? null,
        maxSteps: p.maxSteps ?? null,
      }
    } catch {
      /* fall through to empty */
    }
  }
  return { model: null, variant: null, temperature: null, steps: null, maxSteps: null }
}

/**
 * RFC-111 D15 + RFC-112 (Codex P1) — read the (protocol, binary) frozen onto a
 * node_run, or on the FIRST dispatch (runtime still NULL) resolve the agent's
 * runtime NAME via the registry to a (protocol, binary) and freeze BOTH onto the
 * row. resume/retry read the frozen SNAPSHOT — never the mutable registry — so
 * deleting / renaming / re-pointing a runtime can't re-route a captured session
 * to the wrong driver or binary (session id + runtime are a pair, D11). An
 * unrecognized stored protocol re-resolves (forward-compatible recovery, logged).
 */
export async function resolveFrozenRuntime(
  db: DbClient,
  nodeRunId: string,
  agentRuntime: string | null | undefined,
  defaultRuntime: string | null | undefined,
  /**
   * RFC-112 (Codex impl-gate P1): when this dispatch RESUMES a captured session,
   * the runtime must be INHERITED from the row that owns that session — NOT
   * re-resolved from the (mutable) registry — or a changed / deleted runtime
   * could resume the session under the wrong driver/binary. The caller passes the
   * source row's frozen `{protocol, binary}` here; it is used only when THIS row
   * isn't frozen yet (the first dispatch of a fresh retry / clarify-rerun row).
   */
  inheritFrom?: FrozenRuntime | null,
): Promise<FrozenRuntime> {
  const row = (
    await db
      .select({
        runtime: nodeRuns.runtime,
        runtimeBinary: nodeRuns.runtimeBinary,
        runtimeParamsJson: nodeRuns.runtimeParamsJson,
      })
      .from(nodeRuns)
      .where(eq(nodeRuns.id, nodeRunId))
      .limit(1)
  )[0]
  if (row != null && isKnownRuntimeKind(row.runtime)) {
    // already frozen — return the self-contained snapshot, registry-independent.
    return {
      protocol: row.runtime,
      binary: row.runtimeBinary ?? null,
      params: parseFrozenParams(row.runtimeParamsJson),
    }
  }
  // Codex impl-gate P2-2: a NON-null stored value that isn't a known protocol
  // means corruption or a future runtime downgraded away. Re-resolve (a recovery
  // that keeps the run alive) but log loudly so it is never silent.
  if (row?.runtime != null && row.runtime !== '') {
    createLogger('nodeRunMint').warn('frozen-runtime-invalid-reresolved', {
      nodeRunId,
      stored: row.runtime,
    })
  }
  // RFC-112 P1: a resuming row inherits the session-owner's frozen snapshot so the
  // session id + (protocol, binary, params) stay consumed together across the new
  // row. RFC-113: params are part of the snapshot.
  const frozen: FrozenRuntime =
    inheritFrom != null
      ? inheritFrom
      : await resolveAgentRuntime(db, agentRuntime, defaultRuntime).then((r) => ({
          protocol: r.protocol,
          binary: r.binaryPath,
          params: {
            model: r.model,
            variant: r.variant,
            temperature: r.temperature,
            steps: r.steps,
            maxSteps: r.maxSteps,
          },
        }))
  await db
    .update(nodeRuns)
    .set({
      runtime: frozen.protocol,
      runtimeBinary: frozen.binary,
      runtimeParamsJson: JSON.stringify(frozen.params),
    })
    .where(eq(nodeRuns.id, nodeRunId))
  return frozen
}

/**
 * RFC-112 (Codex impl-gate P1): the frozen runtime of the node_run that CAPTURED
 * a given session id — used to inherit (protocol, binary) when a retry /
 * clarify-rerun resumes that session under a fresh row. Returns null if no frozen
 * row owns the session (then the caller resolves fresh).
 */
export async function frozenRuntimeOfSession(
  db: DbClient,
  sessionId: string,
): Promise<FrozenRuntime | null> {
  const row = (
    await db
      .select({
        runtime: nodeRuns.runtime,
        runtimeBinary: nodeRuns.runtimeBinary,
        runtimeParamsJson: nodeRuns.runtimeParamsJson,
      })
      .from(nodeRuns)
      .where(eq(nodeRuns.opencodeSessionId, sessionId))
      .limit(1)
  )[0]
  if (row != null && isKnownRuntimeKind(row.runtime)) {
    return {
      protocol: row.runtime,
      binary: row.runtimeBinary ?? null,
      params: parseFrozenParams(row.runtimeParamsJson),
    }
  }
  return null
}

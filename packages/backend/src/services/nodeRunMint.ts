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

import type { NodeRunStatus, RerunCause } from '@agent-workflow/shared'
import type { RuntimeKind } from '@/services/runtime'
import { tryGetRuntimeDriver, isKnownRuntimeKind } from '@/services/runtime'
import { defaultConfigDirProfile } from '@/services/runtimeRegistry'
import type {
  RuntimeProfile,
  RuntimeRegistryOperations,
} from '@/platform/runtime-registry/application/runtimeRegistryOperations'
import type { RuntimeConfigDirProfile } from '@agent-workflow/shared'
import { createLogger } from '@/util/log'
import { nextRetryIndex } from '@/modules/task-execution/application/nextRetryIndex'
import {
  buildNodeRunMintRecord,
  generateNodeRunEnvelopeNonce,
} from '@/modules/task-execution/application/buildNodeRunMintRecord'
import type {
  NodeRunLifecyclePersistence,
  NodeRunMintInput,
  NodeRunMintRecord,
} from '@/modules/task-execution/application/ports/nodeRunLifecyclePersistence'
import type { NodeRunRuntimePersistence } from '@/modules/task-execution/application/ports/nodeRunRuntimePersistence'
import {
  resolveSchedulerRunRow as resolveSchedulerRunRowWithPorts,
  type SchedulerRunRowCandidate as ApplicationSchedulerRunRowCandidate,
} from '@/modules/task-execution/application/resolveSchedulerRunRow'
import {
  createLegacySqliteNodeRunOperations,
  mintLegacySqliteNodeRunInTx,
  type LegacySqliteNodeRunDatabase,
  type LegacySqliteNodeRunTransaction,
} from '@/modules/task-execution/infrastructure/legacySqliteNodeRunOperations'
export { nextRetryIndex }

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
  /** RFC-354 — a rerun / placeholder stays in the frame of the row it is minted from. */
  containerRunId?: string | null
  preSnapshot: string | null
  /** RFC-328 causal slot/generation inheritance; optional for legacy fixtures. */
  continuationSlotKey?: string | null
  lineageSlotPathJson?: string | null
  operationGeneration?: number
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
   * RFC-306 §10 — one-shot "run anyway" marker. Set only on the retry
   * placeholder the user's click produced; the run that follows mints its own
   * row WITHOUT it, which is what makes the override apply to exactly one
   * dispatch instead of becoming a permanent property of the node.
   */
  forceActivated?: boolean
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
  /**
   * RFC-223 (PR-3a): the CANONICAL id of the borrowed / workgroup-member agent
   * (sibling of `agentOverrideName`). Producers stamp BOTH; consumers resolve
   * by this id first. NULL/undefined = the node's default agent.
   */
  agentOverrideId?: string | null
  /** RFC-189 — leader_worker workgroup round ordinal（1-based）. Workgroup
   *  turn mints stamp it; everything else leaves NULL. */
  wgRound?: number | null
  /**
   * RFC-200 (T1b) — per-run envelope nonce. Normally left unset, so the factory
   * generates a fresh unpredictable one (default). The runner passes an explicit
   * value on the inline-followup path so the follow-up dispatch REUSES the
   * anchor round's nonce (the resumed opencode session already told the agent
   * that nonce; a fresh one would make the parser reject the agent's output) —
   * mirrors how the runner inherits the memory snapshot from the first attempt.
   */
  envelopeNonce?: string
  /** RFC-328 internal causal identity overrides. */
  continuationSlotKey?: string | null
  lineageSlotPathJson?: string | null
  operationGeneration?: number
}

export interface MintNodeRunArgs {
  /** Preallocated identity for a transaction manifest (RFC-333 review-open). */
  id?: string
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
  /** RFC-354 — the frame this row hangs off; undefined = inherit, else top scope (null). */
  containerRunId?: string | null
  /** RFC-354 — explicit breadcrumb; omitted = derived from the container row. */
  scopePath?: string
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
/**
 * RFC-200 — a fresh, unpredictable per-run envelope nonce (16 hex chars = 64
 * bits of `crypto` randomness). Unpredictable is load-bearing: the whole point
 * is that untrusted upstream content — authored BEFORE this run existed — cannot
 * guess it to forge a `<workflow-output nonce="…">` the parser would accept. A
 * time-ordered id (ULID) would be guessable, so this must stay `randomBytes`.
 */
export function generateEnvelopeNonce(): string {
  return generateNodeRunEnvelopeNonce()
}

/**
 * RFC-200 read seam shared by every prompt producer and the runner parser.
 * NULL means the row was dispatched before migration 0097 (or is a legacy
 * direct-construction test), so callers deliberately fall back to bare tags.
 */
export async function loadRunEnvelopeNonce(
  db: LegacySqliteNodeRunDatabase,
  nodeRunId: string,
): Promise<string> {
  return await createLegacySqliteNodeRunOperations(db).lifecycle.loadEnvelopeNonce(nodeRunId)
}

export function buildMintNodeRunValues(args: MintNodeRunArgs): NodeRunMintRecord {
  return buildNodeRunMintRecord(args)
}

export async function mintNodeRun(
  db: LegacySqliteNodeRunDatabase,
  args: MintNodeRunArgs,
): Promise<string> {
  return await createLegacySqliteNodeRunOperations(db).lifecycle.mint(args)
}

/**
 * RFC-326 — the transactional body of `mintNodeRun`, for callers that already
 * hold a `dbTxSync` (the review decision mints its re-run rows together with the
 * rows it archives and retires). Same retire-then-insert pair, same values.
 */
export function mintNodeRunTx(tx: LegacySqliteNodeRunTransaction, args: MintNodeRunArgs): string {
  return mintLegacySqliteNodeRunInTx(tx, args)
}

/** Provider-selected mint entry used by daemon/application composition. */
export async function mintNodeRunWith(
  lifecycle: NodeRunLifecyclePersistence,
  args: NodeRunMintInput,
): Promise<string> {
  return await lifecycle.mint(args)
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
/**
 * The causes {@link isClarifyRerunCause} gates TRUE, as a value list. Exported so a SQL
 * filter (RFC-187 T13's auto-resume sweep for killed clarify continuations) selects the
 * exact same set the predicate does, instead of re-listing the literals and drifting.
 */
export const CLARIFY_RERUN_CAUSES = ['clarify-answer', 'cross-clarify-questioner-rerun'] as const

export function isClarifyRerunCause(cause: string | null | undefined): boolean {
  return (CLARIFY_RERUN_CAUSES as readonly string[]).includes(cause ?? '')
}

/**
 * RFC-183 (Codex design-gate P2#1 + P2#4) — does the CURRENT dispatch
 * continue a clarify-answer lineage?
 *
 * The RFC-122 oracle (`resolveEffectiveClarifyChannel`) keeps mandatory
 * ask-back alive on a review-active round only when the run "is itself a
 * clarify-answer rerun". Feeding it `isClarifyRerunCause(currentCause)`
 * alone is wrong for TECHNICAL continuations of such a round:
 *   - an in-attempt crash mints `cause:'process-retry'` (scheduler attempt
 *     loop), and
 *   - a daemon restart reaps the row to `interrupted`, whose redispatch
 *     mints `cause:'revival'` (schedulerMintCause),
 * both of which are deliberately OUTSIDE `isClarifyRerunCause` (RFC-098
 * 对抗检视修订 #11 — that gate owns inline-resume / Q&A derivation, which
 * must stay generation-derived on technical retries). Without lineage
 * awareness those rounds degrade to directive 'suppressed' — zero clarify
 * bytes in the prompt, and (post-RFC-183) a hard reject — while the user may
 * have just clicked "Keep clarifying".
 *
 * So: walk the cause chain newest-first, SKIP consecutive technical
 * continuations ('process-retry' / 'revival'), and let the first substantive
 * cause decide via {@link isClarifyRerunCause}. Substantive causes ARE
 * terminal on purpose: 'retry-node' (user chose to redo) and
 * 'stale-redispatch' (a new logical round) do NOT inherit a clarify lineage.
 * Derived from persisted rows, so the verdict survives attempt loops, daemon
 * restarts and resumes alike.
 */
export function continuesClarifyLineage(
  causesNewestFirst: ReadonlyArray<string | null | undefined>,
): boolean {
  for (const cause of causesNewestFirst) {
    if (cause === 'process-retry' || cause === 'revival') continue
    return isClarifyRerunCause(cause)
  }
  return false
}

/** RFC-112/113: the frozen runtime snapshot a node_run dispatches/resumes on. */
export interface FrozenRuntime {
  /** RuntimeDriver kind — decides the driver + session-id format. */
  protocol: RuntimeKind
  /** The custom binary head snapshot, or null = the protocol's default binary. */
  binary: string | null
  /** RFC-113 (Codex P1-2): the execution params (model/variant/...) frozen too. */
  params: RuntimeProfile
  /**
   * RFC-154: the config-dir injection profile frozen too (sibling of `params`,
   * NOT inside it — it is a per-node-run property, not per-agent; dependents
   * share the root's config dir). Serialized as the `__configDir` key inside
   * `runtime_params_json` (no extra column); resume/retry MUST read this
   * snapshot, not the mutable runtimes row — claude especially: the session
   * transcript lives under the frozen dir, re-resolving would lose it.
   */
  configDir: RuntimeConfigDirProfile
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
        isSandbox: p.isSandbox === true,
        // 2026-08-04 — frozen extraArgs (claude fork flags). Whitelist-shape
        // checked: anything but a non-empty string[] degrades to null, so a
        // tampered/legacy JSON can never smuggle argv.
        extraArgs:
          Array.isArray(p.extraArgs) &&
          p.extraArgs.length > 0 &&
          p.extraArgs.every((t): t is string => typeof t === 'string')
            ? p.extraArgs
            : null,
      }
    } catch {
      /* fall through to empty */
    }
  }
  return {
    model: null,
    variant: null,
    temperature: null,
    steps: null,
    maxSteps: null,
    isSandbox: false,
    extraArgs: null,
  }
}

/**
 * RFC-154: extract the frozen `__configDir` from `runtime_params_json`. Legacy
 * rows (pre-RFC-154, no key) and bad JSON fall back to the protocol default —
 * byte-equivalent to their pre-RFC-154 behavior. Downgrade-safe the other way:
 * old parseFrozenParams whitelists its five keys, so it ignores `__configDir`.
 */
function parseFrozenConfigDir(
  json: string | null | undefined,
  protocol: RuntimeKind,
): RuntimeConfigDirProfile {
  if (json != null && json.length > 0) {
    try {
      const p = JSON.parse(json) as { __configDir?: Partial<RuntimeConfigDirProfile> }
      const cd = p.__configDir
      if (
        cd !== undefined &&
        typeof cd.env === 'string' &&
        cd.env.length > 0 &&
        typeof cd.name === 'string' &&
        cd.name.length > 0
      ) {
        return { env: cd.env, name: cd.name }
      }
    } catch {
      /* fall through to default */
    }
  }
  return defaultConfigDirProfile(protocol)
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

/** RFC-282 C1-2 — config-level binary fallback for the freeze, expressed via
 *  the driver's own defaultBinary (no protocol literals here): the value is
 *  frozen only when the config actually contributes a head. */
function configBackedBinary(
  protocol: string,
  binaryConfig: { opencodePath?: string | null; claudeCodePath?: string | null } | undefined,
): string | null {
  if (binaryConfig === undefined) return null
  const driver = tryGetRuntimeDriver(protocol)
  if (driver === null) return null
  const withConfig = driver.defaultBinary(binaryConfig)[0] ?? null
  const bare = driver.defaultBinary({})[0] ?? null
  return withConfig !== null && withConfig !== bare ? withConfig : null
}

export async function resolveFrozenRuntime(
  db: LegacySqliteNodeRunDatabase,
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
  /**
   * RFC-282 C1-2 — config-level binary fallbacks (config.opencodePath /
   * claudeCodePath), folded into the FROZEN value at mint time. The old shape
   * read config at SPAWN time via the per-entry opencodeCmd channel, so a
   * config edit could flip the head of an already-minted run on resume —
   * against the RFC-111 D15 "resume reads the frozen snapshot" ruling. Now
   * the fallback freezes with everything else; registry binaryPath still wins.
   */
  binaryConfig?: { opencodePath?: string | null; claudeCodePath?: string | null },
): Promise<FrozenRuntime> {
  const operations = createLegacySqliteNodeRunOperations(db)
  return await resolveFrozenRuntimeWith(
    operations.runtimes,
    operations.runtimeRegistry,
    nodeRunId,
    agentRuntime,
    defaultRuntime,
    inheritFrom,
    binaryConfig,
  )
}

/** Provider-selected runtime freeze entry; no provider client crosses it. */
export async function resolveFrozenRuntimeWith(
  persistence: NodeRunRuntimePersistence,
  runtimeRegistry: RuntimeRegistryOperations,
  nodeRunId: string,
  agentRuntime: string | null | undefined,
  defaultRuntime: string | null | undefined,
  inheritFrom?: FrozenRuntime | null,
  binaryConfig?: { opencodePath?: string | null; claudeCodePath?: string | null },
): Promise<FrozenRuntime> {
  const row = await persistence.load(nodeRunId)
  if (row != null && isKnownRuntimeKind(row.runtime)) {
    // already frozen — return the self-contained snapshot, registry-independent.
    // Codex impl-gate P1-3 (RFC-282 收尾门): a NULL frozen binary means "no
    // explicit head was ever frozen" — pre-C1 rows never froze the config head
    // (it rode the per-entry opencodeCmd channel, read at spawn time), so NULL
    // must keep resolving against the CURRENT config or resuming such a row
    // regresses to the bare protocol command. D15 stays intact for non-NULL
    // frozen values; the stored column is not backfilled (compat read only).
    return {
      protocol: row.runtime,
      binary: row.runtimeBinary ?? configBackedBinary(row.runtime, binaryConfig),
      params: parseFrozenParams(row.runtimeParamsJson),
      configDir: parseFrozenConfigDir(row.runtimeParamsJson, row.runtime),
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
  // row. RFC-113: params are part of the snapshot. RFC-154: so is configDir —
  // the resumed session's transcript/skills live under the frozen dir.
  const frozen: FrozenRuntime =
    inheritFrom != null
      ? {
          ...inheritFrom,
          // Codex impl-gate P1-2 (RFC-282 收尾门): inherit-literal callers
          // (commit/merge sessions pass a pre-resolved profile) and resume
          // inherits from pre-C1 rows carry NULL when the head used to arrive
          // via the deleted opencodeCmd channel. Fold the config head here so
          // this first freeze of the new row captures it — same semantics as
          // the fresh-resolve branch below.
          binary: inheritFrom.binary ?? configBackedBinary(inheritFrom.protocol, binaryConfig),
        }
      : await runtimeRegistry.resolveAgentRuntime(agentRuntime, defaultRuntime).then((r) => ({
          protocol: r.protocol,
          // Which config key backs which protocol is DRIVER knowledge
          // (defaultBinary); freeze the config-backed head only when config
          // actually contributes one (differs from the bare default), so a
          // null stays null and custom-fork detection is untouched.
          binary: r.binaryPath ?? configBackedBinary(r.protocol, binaryConfig),
          params: {
            model: r.model,
            variant: r.variant,
            temperature: r.temperature,
            steps: r.steps,
            maxSteps: r.maxSteps,
            isSandbox: r.isSandbox,
            extraArgs: r.extraArgs ?? null,
          },
          configDir: r.configDir,
        }))
  await persistence.freeze({
    nodeRunId,
    runtime: frozen.protocol,
    runtimeBinary: frozen.binary,
    // RFC-154: __configDir rides inside the same JSON column (no new column);
    // parseFrozenParams whitelists its keys so it never leaks into params.
    runtimeParamsJson: JSON.stringify({ ...frozen.params, __configDir: frozen.configDir }),
  })
  return frozen
}

/**
 * RFC-112 (Codex impl-gate P1): the frozen runtime of the node_run that CAPTURED
 * a given session id — used to inherit (protocol, binary) when a retry /
 * clarify-rerun resumes that session under a fresh row. Returns null if no frozen
 * row owns the session (then the caller resolves fresh).
 */
export async function frozenRuntimeOfSession(
  db: LegacySqliteNodeRunDatabase,
  sessionId: string,
): Promise<FrozenRuntime | null> {
  return await frozenRuntimeOfSessionWith(
    createLegacySqliteNodeRunOperations(db).runtimes,
    sessionId,
  )
}

export async function frozenRuntimeOfSessionWith(
  persistence: NodeRunRuntimePersistence,
  sessionId: string,
): Promise<FrozenRuntime | null> {
  const row = await persistence.findBySessionId(sessionId)
  if (row != null && isKnownRuntimeKind(row.runtime)) {
    return {
      protocol: row.runtime,
      binary: row.runtimeBinary ?? null,
      params: parseFrozenParams(row.runtimeParamsJson),
      configDir: parseFrozenConfigDir(row.runtimeParamsJson, row.runtime),
    }
  }
  return null
}

/**
 * RFC-284 T21（§4）——「下一个 retry_index」五处手写口径的唯一实现。
 *
 * 纯函数吃调用方已读的行集（**不自带查询**——五个调用点各有自己的行集读法与
 * 事务性，收编读法会改热路径的读行为；实施偏差已记 plan.md §实施记录）。
 * 口径差异参数化：
 *   - topLevelOnly：只数 parentNodeRunId === null 的行（taskQuestionDispatch 口径；
 *     task.ts 的 retry-cascade 刻意含 child rows，不传）
 *   - iteration：只数该迭代的行（taskQuestionDispatch 口径；scheduler 的
 *     sameNodeIterRuns 已在查询里限定迭代，不传）
 * 空集 → 0（与历史两种写法 reduce(…,-1)+1 / length===0?0:max()+1 同值）。
 * review.ts 的「latest 单行 +1」= 单元素集特例，经此函数语义不变。
 */
// -----------------------------------------------------------------------------
// RFC-287 T8（G2）—— 取行前奏的单一实现。
//
// 迁移前四条线各手抄一份：L4 agent / L7 script / L8 call / L9 code-host。四份的
// 骨干完全一致（查同节点同迭代的行 → 取最新一行 isFresherNodeRun → 有 pending 就
// 复用并盖 provenance 戳，否则按 schedulerMintCause 铸新行），差异只落在**五个
// 维度**上（用 difflib 逐行对差实证，不是照设计文档抄的）：
//
//   ① reviewIteration 继承        —— 仅 L4/L8
//   ② agentOverrideName 显式置空  —— 仅 L4/L8（RFC-132 ③：重试/复活行不再带借用）
//   ③ 复用 pending 行时追 retryIndex —— L9 不追（它压根不追这个维度）
//   ④ 收尾广播 pending             —— L9 不广播（它铸完直接转 running，多播一条
//                                     WS 事件会让前台看到不存在的 pending 态）
//   ⑤ 领养短路                     —— 仅 L8：RFC-243-LOCK 的领养区**不进收编**
//                                     （那里可能复用一条 running/interrupted/canceled
//                                     的行并直接转 running，与「铸行」是两码事），
//                                     以 preResolve 回调在拿到 latestExisting 后短路。
//
// 三条既有测试守着这四线的差异：rfc098-rerun-cause-gates（cause 分档）、
// rfc243 系列（领养区）、rfc284-t21（nextRetryIndex 收编）。
// -----------------------------------------------------------------------------

/** 前奏读到的同节点同迭代行（只列被判据用到的列，便于四线共用）。 */
export interface SchedulerRunRowCandidate extends ApplicationSchedulerRunRowCandidate {
  id: string
  startedAt: number | null
  childTaskId?: string | null
}

export interface ResolveSchedulerRunRowArgs<R extends SchedulerRunRowCandidate> {
  db: LegacySqliteNodeRunDatabase
  taskId: string
  nodeId: string
  /** RFC-354 — the frame the node is dispatched in; null at the top scope. */
  containerRunId: string | null
  iteration: number
  /** 复用 pending 行 / 铸新行都要盖上的 provenance 戳（RFC-074）。 */
  consumedUpstreamJson: string
  /** 已查好的同节点同迭代行（调用方自己查——各线的 select 列集不同）。 */
  rows: readonly R[]
  /** ① 仅 L4/L8。 */
  inheritReviewIteration: boolean
  /** ② 仅 L4/L8。 */
  clearAgentOverride: boolean
  /** ③ L9 false。 */
  trackRetryIndex: boolean
  /** ④ L9 false（它铸完直接转 running）。 */
  broadcastPending: ((nodeRunId: string) => void) | null
  /** ⑤ 仅 L8：领养区短路，返回非 null 即整段前奏不执行。 */
  preResolve?: (latestExisting: R | undefined) => Promise<{ nodeRunId: string } | null>
}

export interface ResolvedSchedulerRunRow<R> {
  nodeRunId: string
  retryIndex: number
  latestExisting: R | undefined
  /** 领养短路命中（L8）——调用方据此跳过自己的铸行后续。 */
  adopted: boolean
}

export async function resolveSchedulerRunRow<R extends SchedulerRunRowCandidate>(
  args: ResolveSchedulerRunRowArgs<R>,
): Promise<ResolvedSchedulerRunRow<R>> {
  const operations = createLegacySqliteNodeRunOperations(args.db)
  return await resolveSchedulerRunRowWithPorts({
    lifecycle: operations.lifecycle,
    projections: operations.projections,
    taskId: args.taskId,
    nodeId: args.nodeId,
    containerRunId: args.containerRunId,
    iteration: args.iteration,
    consumedUpstreamJson: args.consumedUpstreamJson,
    rows: args.rows,
    inheritReviewIteration: args.inheritReviewIteration,
    clearAgentOverride: args.clearAgentOverride,
    trackRetryIndex: args.trackRetryIndex,
    broadcastPending: args.broadcastPending,
    ...(args.preResolve === undefined ? {} : { preResolve: args.preResolve }),
  })
}

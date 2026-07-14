// Runner: spawn ONE opencode subprocess for one node_run, stream its output
// into the DB, persist the parsed envelope, and clean up.
//
// Process isolation (design/proposal.md §6.1):
//   * cwd = task worktree
//   * OPENCODE_CONFIG_DIR -> per-run dir for framework-managed skills
//   * OPENCODE_CONFIG_CONTENT -> inline JSON of the agent definition
//     (highest precedence in opencode's merge order; beats repo and $HOME)
//   * No DISABLE flags so repo .opencode/skills + $HOME/.opencode/* still load
//
// Lifecycle:
//   pending -> running    (node_runs row updated with pid + startedAt + prompt)
//   running -> done       (envelope parsed, outputs persisted)
//   running -> failed     (non-zero exit / missing envelope / timeout)
//   running -> canceled   (AbortSignal aborted)
//
// Caller (scheduler / tests) is responsible for INSERT-ing the node_runs row
// in 'pending' state before calling runNode().

import type {
  ClarifyChannel,
  PromptMode,
  Agent,
  ClarifyPromptContext,
  ClarifyQuestion,
  ClarifyTruncationWarning,
  Mcp,
  Plugin,
  PriorOutputUpdateContext,
  ReviewPromptContext,
} from '@agent-workflow/shared'
import {
  isAgentNodeKind,
  composePerParsedKindRepairBlocks,
  normalizeKindString,
  parseClarifyEnvelopeBody,
  renderEnvelopeFollowupPrompt,
  SignalPortInPromptError,
  assertNoPromptSignalRefs,
} from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type { DbClient } from '@/db/client'
import { nodeRunEvents, nodeRunOutputs, nodeRuns } from '@/db/schema'
import { createLogger, type Logger } from '@/util/log'
import {
  CLARIFY_FORBIDDEN_PREFIX,
  CLARIFY_REQUIRED_PREFIX,
  detectEnvelopeKind,
  ENVELOPE_PORT_MALFORMED_PREFIX,
  extractClarifyEnvelopeBody,
  extractLastEnvelope,
  parseEnvelope,
  PortValidationError,
  resolvePortContent,
  serializePortValidationFailures,
  type PortValidationFailure,
} from './envelope'
import { renderUserPrompt } from './protocol'
// RFC-111 PR-A/B + RFC-143 PR-4: agent runtime behind the driver seam. The
// stdout pump uses `getRuntimeDriver(runtime).parseEvent` and the spawn goes
// through `driver.buildBusinessSpawn` — runNode is fully kind-blind (zero
// `runtime === 'xxx'` branches; the runtime-specific assembly lives in
// runtime/opencode + runtime/claudeCode). The event helpers, buildCommand and
// the inline-config surface are re-exported at the bottom so existing importers
// (tests, memoryDistiller) keep resolving from './runner'.
import { getRuntimeDriver, type RuntimeKind } from './runtime'
import {
  defaultConfigDirProfile,
  resolveAgentRuntime,
  type RuntimeProfile,
} from '@/services/runtimeRegistry'
import type { RuntimeConfigDirProfile } from '@agent-workflow/shared'
import type { ResolvedSkill, SpawnPlan } from './runtime/types'
import { EMPTY_RUNTIME_PROFILE } from './runtime/opencode/inlineConfig'
import { NOOP_HANDLE } from './subagentLiveCapture'
import { setNodeRunStatus, transitionNodeRunStatus } from './lifecycle'
import {
  injectMemoryForRun,
  loadInjectedSnapshotFromFirstAttempt,
  type ScopeBudget,
} from './memoryInject'
import type { FailureCode, InjectedMemorySnapshot } from '@agent-workflow/shared'
import { TASK_CHANNEL, taskBroadcaster } from '@/ws/broadcaster'

// RFC-143 PR-4: SkillSource / ResolvedSkill moved to runtime/types.ts (drivers
// type their skill inputs there); re-exported so scheduler/tests keep resolving.
export type { SkillSource, ResolvedSkill } from './runtime/types'

export interface RunNodeOptions {
  taskId: string
  /** ULID of a pre-existing node_runs row in 'pending' state. */
  nodeRunId: string
  /**
   * RFC-047: workflow node id (the canvas-level id, not the run id). The
   * scheduler always knows it at the call site; threading it through lets
   * the runner emit `node.status` broadcasts (e.g. after the eager
   * injected-snapshot write at runner.ts §inject) without an extra
   * `SELECT nodeId FROM node_runs WHERE id = ?` round-trip.
   */
  nodeId: string
  agent: Agent
  /** Resolved upstream port values (already concatenated by the scheduler). */
  inputs: Record<string, string>
  /** opencode subprocess cwd = task worktree. */
  worktreePath: string
  /** Template variable substitutions for {{__repo_path__}} etc. */
  templateMeta: {
    repoPath: string
    baseBranch: string
    taskId: string
    nodeId?: string
    iteration?: number
    shardKey?: string
    /**
     * RFC-066: per-repo metadata for the multi-repo placeholders. Always
     * non-empty; single-repo tasks pass a length-1 array mirroring the
     * legacy `repoPath` / `baseBranch` fields with `worktreeDirName = ''`
     * so `{{__repo_names__}}` renders empty (byte-baseline). The runner
     * just forwards this to `renderUserPrompt`; the scheduler is the
     * source of truth.
     */
    repos?: Array<{
      repoPath: string
      worktreePath: string
      worktreeDirName: string
      baseBranch: string
    }>
  }
  promptTemplate?: string
  /**
   * RFC-005 review-driven re-run context. When the scheduler is re-running an
   * upstream node after a downstream review's reject/iterate decision, this
   * carries the rendered comments / rejection reason / iterate target port
   * so {{__review_rejection__}} / {{__review_comments__}} /
   * {{__iterate_target_port__}} substitute and the auto-appended sections
   * fire. Absent on first runs and on runs that aren't downstream of a
   * decided review. Built by services/review.ts:buildReviewPromptContext.
   */
  reviewContext?: ReviewPromptContext
  /**
   * RFC-023 clarify-driven re-run context. Set by the scheduler when the
   * agent is being re-spawned after the user submitted clarify answers
   * (clarifyIteration > 0). Substitutes {{__clarify_questions__}} /
   * {{__clarify_answers__}} / {{__clarify_iteration__}} / {{__clarify_remaining__}}
   * and auto-appends the Q&A sections at the user prompt tail. Absent on
   * first runs and on runs whose agent never asked back.
   */
  clarifyContext?: ClarifyPromptContext
  /**
   * RFC-119 / RFC-141: prior-output context for a NON-cross-clarify rerun
   * (review reject/iterate, manual retry, cascade, resume, clarify-answer,
   * ask-back rounds, override handoffs). The scheduler sets it from the
   * freshest prior run that captured output; threaded straight into
   * renderUserPrompt, which picks the update vs ask-back directive variant off
   * hasClarifyChannel. Absent on first runs / followups / cross-clarify.
   */
  priorOutputUpdate?: PriorOutputUpdateContext
  /**
   * RFC-148: this dispatch's clarify-channel state as ONE discriminated
   * value (shared `ClarifyChannel`) — replaces the historical
   * hasClarifyChannel / clarifyStopped / clarifyStopNotice / clarifyMode
   * quartet. `kind` alone drives the envelope parser's question cap
   * (cross lifts the RFC-023 max — independent of enforcement, so a
   * suppressed cross rerun still parses with the lifted cap);
   * `directive` drives the RFC-100 clarify-required gate ('mandatory'),
   * the RFC-123 clarify-forbidden rejection ('stopped'), and the render
   * projections. Absent ⇒ { kind: 'none' } semantics.
   */
  clarifyChannel?: ClarifyChannel
  /**
   * RFC-181 C — envelope-time hard-suppression oracle for workgroup host
   * runs. When present and it resolves true at the moment a voluntary
   * `<workflow-clarify>` is parsed, the run closes as
   * failed:clarify-forbidden (no session, no park) BEFORE terminal
   * persistence. Injected only by the workgroup hook; absent everywhere else
   * (ordinary nodes keep their RFC-123 'stopped' directive semantics).
   */
  clarifySuppressed?: () => Promise<boolean>
  /** RFC-164: workgroup protocol block replacing the agent-outputs protocol
   *  (threaded to renderUserPrompt.workgroupProtocolBlock; design §5). */
  workgroupProtocolBlock?: string
  /** Skills used by this agent. */
  skills: ResolvedSkill[]
  /**
   * RFC-022: agents resolved from the primary agent's dependsOn closure (BFS
   * order, root excluded). Each one becomes an additional entry under
   * `agent` in OPENCODE_CONFIG_CONTENT so the primary agent can invoke them
   * via opencode's task / subagent tool. Default `[]` keeps legacy callers
   * (the runner tests pre-RFC-022) at single-agent injection behavior.
   *
   * Dependents do NOT receive the per-node `overrides` block — overrides
   * (model / variant / temperature) only ever apply to the node-selected
   * primary agent.
   */
  dependents?: Agent[]
  /**
   * RFC-028: MCP server configs to inject under `mcp.<name>` in the inline
   * OPENCODE_CONFIG_CONTENT. Scheduler pre-loads these via
   * `collectMcpNamesFromClosure` + `loadMcpsByNames` (see services/mcpClosure)
   * over the dependsOn closure. Empty / undefined → omit the `mcp` key
   * entirely; the user's repo `.opencode/config.json` + `~/.config/opencode/`
   * MCPs still load naturally (deep-merge baseline). See OPENCODE_CONFIG.md
   * §1 and §3.3 for the field-name translation rules.
   */
  mcps?: readonly Mcp[]
  /**
   * RFC-031: opencode plugin records to inject under `plugin` in the inline
   * OPENCODE_CONFIG_CONTENT. Scheduler pre-loads these via
   * `collectPluginNamesFromClosure` + `loadPluginsByNames` (see
   * services/pluginClosure) over the dependsOn closure. Each record carries
   * a `cachedPath` populated at save time by services/pluginInstaller; the
   * runner injects `file://<cachedPath>` so opencode resolves the entry
   * without touching the network. Empty / undefined → omit the `plugin` key
   * entirely.
   */
  plugins?: readonly Plugin[]
  /**
   * RFC-060 D.T7: per-input port kinds, used to enforce the
   * `signal`-port-not-in-prompt rule. Optional — when set, the runner runs
   * `assertNoPromptSignalRefs` against `promptTemplate` before render and
   * fails the run with errCode `signal-port-in-prompt` when any `{{port}}`
   * reference resolves to a `signal` kind. When unset, the check is skipped
   * (legacy callers retain current behavior). Scheduler's wrapper-fanout
   * dispatch in services/scheduler.ts populates this for inner shard dispatches.
   */
  inputPortKinds?: Record<string, string>
  /** Wall-clock timeout in ms. Undefined = no limit. */
  timeoutMs?: number
  /**
   * RFC-098 WP-8 (audit S-15): grace between the first SIGTERM (abort /
   * timeout path) and the SIGKILL escalation. Also the base of the final
   * reap deadline (grace + 5s margin) after which a child that survived
   * SIGKILL is abandoned as `child-unkillable`. Default 10s. Only tests
   * pass a small value (the stubborn-child suite must stay fast);
   * production callers leave it unset.
   */
  killEscalationGraceMs?: number
  /** App home dir (parent of runs/, snapshots/, worktrees/, ...). */
  appHome: string
  /**
   * Override the OPENCODE binary head. Production sets this from
   * `config.opencodePath` (resolveOpencodeCmd); opencode tests pass
   * `['bun','run',mock-opencode.ts]`. NOTE: opencode-specific — the claude
   * branch must NOT reuse it (Codex impl-gate P1-1), or a custom opencodePath
   * would spawn opencode with claude flags + skip the credential bridge.
   */
  opencodeCmd?: string[]
  /**
   * RFC-111: generic runtime-binary head override for TESTS only (mock-claude /
   * a future mock). Production never sets it → claude resolves to `['claude']`
   * (PATH) and the subscription credential bridge runs. Its presence is the
   * test signal that gates the bridge off so CI never touches the keychain.
   */
  runtimeCmd?: string[]
  /**
   * RFC-111 D15: the FROZEN runtime for this node_run (resolved once at dispatch
   * from `agent.runtime ?? config.defaultRuntime`, persisted to
   * `node_runs.runtime`, and read back on resume/retry so a mutated agent /
   * default can't re-route a captured session to the wrong runtime). Omitted /
   * undefined → `'opencode'` (legacy zero-change default).
   */
  runtime?: RuntimeKind
  /**
   * RFC-112: the FROZEN custom binary head for this node_run (the resolved
   * runtime's `binaryPath` snapshot, frozen onto `node_runs.runtime_binary`
   * alongside `runtime`). null / undefined = use the protocol's DEFAULT binary
   * (built-in runtimes) — which preserves RFC-111 behavior byte-for-byte
   * (opencode → opts.opencodeCmd, claude → opts.runtimeCmd). A non-empty value
   * (a custom fork) overrides the head for BOTH protocols.
   */
  runtimeBinary?: string | null
  /**
   * RFC-113 (Codex P1-2): the runtime's execution params (model/variant/...),
   * resolved + frozen at dispatch. The runner spawns the ROOT agent with these
   * (the agent itself no longer carries model/variant/steps). Omitted → no params
   * (the binary uses its own defaults). Dependents resolve their own live.
   *
   * NOTE (RFC-113 §5): the RFC-112 P2 `claudeCodePath` thread is GONE — the
   * built-in claude binary now comes from the claude runtime row's binary_path
   * (config.claudeCodePath migrated into it), surfacing as `runtimeBinary`.
   */
  runtimeParams?: RuntimeProfile
  /**
   * RFC-154: the FROZEN config-dir injection profile (env var name + leaf dir
   * name), resolved at dispatch from the runtime row and frozen inside
   * `node_runs.runtime_params_json.__configDir`. Omitted → the protocol default
   * (OPENCODE_CONFIG_DIR/.opencode, CLAUDE_CONFIG_DIR/.claude) — byte-identical
   * legacy behavior, so direct-construction tests need no change.
   */
  runtimeConfigDir?: RuntimeConfigDirProfile
  db: DbClient
  log?: Logger
  /** When aborted, runner SIGTERMs the child and returns status='canceled'. */
  signal?: AbortSignal
  /**
   * RFC-026: when set (only ever populated by the scheduler on the
   * clarify-driven rerun path where the upstream clarify node has
   * `sessionMode: 'inline'` AND the prior agent run captured an opencode
   * session id), the runner appends `--session <id>` to the opencode CLI.
   * opencode then loads the prior session's full transcript (messages,
   * thinking, tool calls), and the rendered user prompt is reduced to a
   * small incremental message (just this round's clarify answers + a short
   * reminder — see `buildClarifyInlineReminder` in shared/prompt.ts).
   *
   * Review reject / iterate / technical retry / loop cross-iteration paths
   * MUST NOT set this — they intentionally start fresh sessions. See
   * proposal §2.1 / A12 / A13 / A7.
   */
  resumeSessionId?: string
  /**
   * RFC-029: workflow node kind for the row being executed. Drives whether
   * the inventory dump plugin is wired in and whether the inventory snapshot
   * is read back after `child.exited`. Only the two agent kinds
   * (`'agent-single'` / `'agent-multi'`) produce an inventory; anything else
   * results in `node_runs.inventory_snapshot_json` staying NULL. Optional
   * (defaults to `'agent-single'` for legacy callers / tests that don't
   * exercise the inventory path).
   */
  nodeKind?: string
  /**
   * RFC-148: how to render this dispatch's user prompt, as ONE discriminated
   * value (shared `PromptMode`) — replaces the historical envelopeFollowup /
   * envelopeFollowupReason / envelopeFollowupClarifyDirective /
   * envelopeFollowupPortValidations quartet. The followup arm carries the
   * MANDATORY `resumeSessionId` (a follow-up nudge is only meaningful inside
   * the resumed session that already holds the original prompt — the
   * "followup without a session" state is unrepresentable). Absent ⇒
   * { kind: 'initial' } semantics.
   */
  promptMode?: PromptMode
  /**
   * RFC-041 PR3: per-scope token budget for memory inject. Optional —
   * scheduler/daemon reads `config.memoryInjectionBudget` and passes it
   * through; tests omit to use the design.md §3.3 defaults.
   */
  memoryInjectionBudget?: ScopeBudget
  /**
   * RFC-048: cadence + failure tolerance for the live subagent capture
   * poller. Omitted (or `pollMs === 0`) falls back to RFC-027 behavior —
   * the runner only captures child-session events in the single post-run
   * BFS. Scheduler / cli plumb `config.subagentLiveCapture` through here.
   */
  subagentLiveCapture?: { pollMs: number; consecutiveFailureLimit: number }
  /**
   * RFC-067: per-task Git commit identity. When BOTH `gitUserName` and
   * `gitUserEmail` are non-empty strings, the runner injects all four env
   * vars (`GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` / `GIT_COMMITTER_NAME` /
   * `GIT_COMMITTER_EMAIL`) at opencode spawn time so any `git commit`
   * invocation in the agent inherits the task-scoped identity. The runner
   * defensively re-checks the pair here (StartTaskSchema's superRefine
   * already rejected the half-set case at write time) — if either side is
   * empty / null / undefined the env vars are NOT injected, preserving the
   * pre-RFC-067 default of resolving identity from the daemon's git config.
   * env injected here outranks any inherited `GIT_AUTHOR_*` from the daemon
   * process (later-write wins inside the spawn env dict).
   */
  gitUserName?: string | null
  gitUserEmail?: string | null
}

export type RunFinalStatus = 'done' | 'failed' | 'canceled'

export interface RunResult {
  status: RunFinalStatus
  exitCode: number | null
  /** Resolved declared port values (missing ones present as ""). */
  outputs: Record<string, string>
  tokenUsage: {
    input: number
    output: number
    cacheCreate: number
    cacheRead: number
    total: number
  }
  errorMessage?: string
  /**
   * RFC-145: machine-readable failure taxonomy (shared FAILURE_CODES),
   * declared HERE at the stamp point that also writes errorMessage — the
   * scheduler's decideEnvelopeFollowup consumes the persisted column instead
   * of parsing errorMessage prefixes. Absent = no machine-readable shape.
   */
  failureCode?: FailureCode
  /** The exact user prompt sent to opencode (also written to node_runs.promptText). */
  prompt: string
  /** opencode sessionID first seen in stdout events, if any. */
  sessionId?: string
  /**
   * RFC-023: present when the agent reply parsed as a `<workflow-clarify>`
   * envelope (status will still be 'done' — the agent successfully expressed
   * an ask). The scheduler reads this and forwards questions/warnings into
   * `clarify.createClarifySession`, then parks the task at `awaiting_human`.
   * `outputs` is empty in this case — clarify defers all port outputs to
   * the next round per the protocol block in the user prompt.
   */
  clarify?: {
    questions: ClarifyQuestion[]
    truncationWarnings: ClarifyTruncationWarning[]
  }
}

// RFC-143 PR-4: pickRuntimeHead moved to ./runtime/head.ts (both drivers select
// their argv head there); re-exported for the runtime-spawn-head contract lock.
export { pickRuntimeHead } from './runtime/head'

export async function runNode(opts: RunNodeOptions): Promise<RunResult> {
  const log = opts.log ?? createLogger('runner')
  const runRoot = join(opts.appHome, 'runs', opts.taskId, opts.nodeRunId)

  // RFC-111 D15: the runtime is frozen by the dispatcher into node_runs.runtime
  // and threaded here. opencode is the default and its spawn/pump path is
  // byte-identical to pre-RFC-111; claude-code branches at the spawn site below.
  // The stdout pump is runtime-agnostic (driver.parseEvent normalizes events).
  const runtime: RuntimeKind = opts.runtime ?? 'opencode'
  const driver = getRuntimeDriver(runtime)

  // 1. RFC-154: resolve the config-dir injection profile (frozen at dispatch;
  // omitted → protocol default). Skill staging moved INTO each driver's
  // buildBusinessSpawn so it lands in the directory that runtime actually reads
  // — the old runtime-blind preamble staged into `.opencode` even for claude
  // runs (dead copy the claude binary never read).
  const configDir = opts.runtimeConfigDir ?? defaultConfigDirProfile(runtime)

  // 2. Resolve the per-agent runtime profiles (RFC-113): the root agent uses its
  // FROZEN profile (opts.runtimeParams); each dependent subagent uses ITS OWN
  // runtime's profile (resolved live — they aren't the session owner, so they
  // don't need freezing). The async DB resolve stays HERE (RFC-143 §4.6C:
  // drivers are DB-free); the map is raw material for driver.buildBusinessSpawn
  // (opencode folds it into the inline config; claude reads the root model).
  const resolvedParamsByAgent = new Map<string, RuntimeProfile>()
  resolvedParamsByAgent.set(opts.agent.name, opts.runtimeParams ?? EMPTY_RUNTIME_PROFILE)
  for (const dep of opts.dependents ?? []) {
    if (resolvedParamsByAgent.has(dep.name)) continue
    const r = await resolveAgentRuntime(opts.db, dep.runtime, undefined)
    resolvedParamsByAgent.set(dep.name, {
      model: r.model,
      variant: r.variant,
      temperature: r.temperature,
      steps: r.steps,
      maxSteps: r.maxSteps,
    })
  }

  // RFC-029: the inventory dump plugin is wired only for agent kinds (single /
  // multi). For wrapper / clarify / review etc. runNode is not invoked anyway,
  // but the explicit guard keeps the behavior stable even if a future caller
  // routes non-agent kinds through here.
  //
  // RFC-042: on a same-session envelope follow-up, the first attempt already
  // wrote the inventory snapshot. Re-materializing the plugin just to nudge
  // the model into emitting an envelope is pure overhead, so followups skip it.
  //
  // RFC-143 PR-4: this is a pure BUSINESS gate — whether the runtime can even
  // produce an inventory is the driver's capability (claude simply lacks it);
  // the materialization itself lives in opencode's buildBusinessSpawn.
  const inventoryNodeKind = opts.nodeKind ?? 'agent-single'
  // RFC-148 canonical projections of the two dispatch ADTs (single
  // derivation; every historical scattered-boolean guard reads these).
  const followupMode = opts.promptMode?.kind === 'followup' ? opts.promptMode : undefined
  const channel = opts.clarifyChannel ?? { kind: 'none' as const }
  const clarifyWired = channel.kind !== 'none'
  const clarifyMandatory = clarifyWired && channel.directive === 'mandatory'
  // RFC-165 (F12): optional trips NEITHER enforcement gate below; it only
  // keeps the clarify option alive in envelope-followup (error-correction)
  // rounds so the agent can still pick either envelope after a malformed
  // reply.
  const clarifyOptional = clarifyWired && channel.directive === 'optional'
  const clarifyStoppedDirective = clarifyWired && channel.directive === 'stopped'
  const wantsInventory = isAgentNodeKind(inventoryNodeKind) && followupMode === undefined

  // RFC-041 PR3: silent inject of approved memories into the primary agent's
  // inline prompt. Best-effort — a broken memory table degrades to "no
  // inject", never to a failed run. Skipped for the envelope-followup path
  // (the same-session retry is just nudging for a missing envelope; the
  // first attempt already saw the original block, and re-stringifying a
  // large prompt fragment on each retry would pointlessly invalidate the
  // session prompt cache).
  // RFC-046: capture the post-clip snapshot from inject so the final
  // node_runs UPDATE can persist it to `injected_memories_json`. Stays
  // null in every failure / non-agent / followup-with-attempt-0-null path
  // so the column distinguishes legitimate zero-inject runs from
  // "captured but empty" runs (see RFC-046 design.md §3.2).
  let injectedSnapshot: InjectedMemorySnapshot[] | null = null
  // RFC-111/143: the injected memory text — HOW it reaches the model is each
  // driver's job (opencode appends it to the inline agent prompt inside
  // buildBusinessSpawn; claude weaves it into the system-prompt-file).
  let injectedMemoryBlock: string | null = null
  if (followupMode === undefined) {
    try {
      const { block: memoryBlock, snapshot } = await injectMemoryForRun({
        db: opts.db,
        taskId: opts.taskId,
        primaryAgent: opts.agent,
        dependents: opts.dependents ?? [],
        budget: opts.memoryInjectionBudget,
      })
      injectedSnapshot = snapshot
      injectedMemoryBlock = memoryBlock
    } catch (err) {
      log.warn('memory-inject-failed', {
        nodeRunId: opts.nodeRunId,
        error: err instanceof Error ? err.message : String(err),
      })
      // injectedSnapshot stays null — fail-safe column write at the end
      // of the run mirrors the legacy "no inject" path so the UI shows
      // nothing rather than a corrupt list.
    }
  } else {
    // RFC-046: envelope-followup retries (RFC-042) skip inject entirely so
    // the resumed opencode session keeps cache-hit ratios on the original
    // prompt. The model is still seeing the first attempt's memory block
    // in its transcript, so we copy that attempt's snapshot to the current
    // retry's row — the Session-tab card stays consistent across attempts.
    try {
      const currentRunRow = (
        await opts.db
          .select({
            nodeId: nodeRuns.nodeId,
            iteration: nodeRuns.iteration,
            shardKey: nodeRuns.shardKey,
            reviewIteration: nodeRuns.reviewIteration,
          })
          .from(nodeRuns)
          .where(eq(nodeRuns.id, opts.nodeRunId))
          .limit(1)
      )[0]
      if (currentRunRow !== undefined) {
        injectedSnapshot = await loadInjectedSnapshotFromFirstAttempt(opts.db, {
          taskId: opts.taskId,
          nodeId: currentRunRow.nodeId,
          iteration: currentRunRow.iteration,
          shardKey: currentRunRow.shardKey,
          reviewIteration: currentRunRow.reviewIteration,
          runId: opts.nodeRunId,
        })
      }
    } catch (err) {
      log.warn('memory-inject-followup-inherit-failed', {
        nodeRunId: opts.nodeRunId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // RFC-047: persist the injected-memory snapshot to `injected_memories_json`
  // BEFORE spawning opencode, so the task-detail Session tab can show the
  // `Injected memories (N)` card while the agent is still running instead of
  // waiting for the run-end UPDATE (which can take many minutes for long
  // sessions / review / clarify await_human). The final UPDATE at step 11
  // still writes the same column with the same value — keeping it as a
  // fail-safe means an early-write SQL throw degrades to legacy RFC-046
  // behavior (column populated at end-of-run), not to a corrupted column.
  // A follow-up `node.status: running` broadcast lets `useTaskSync` invalidate
  // `['tasks', taskId, 'node-runs']` so the card materializes without a manual
  // refresh — RFC-098 B3 (audit S-28) moved that broadcast BELOW the
  // mark-running CAS (DB-first rule, lifecycle.ts): broadcasting 'running'
  // here, while the row is still 'pending', made a refresh-on-receipt read a
  // status the DB didn't hold yet.
  try {
    await opts.db
      .update(nodeRuns)
      .set({
        injectedMemoriesJson: injectedSnapshot === null ? null : JSON.stringify(injectedSnapshot),
      })
      .where(eq(nodeRuns.id, opts.nodeRunId))
    log.info('inject-snapshot-eager-write', {
      nodeRunId: opts.nodeRunId,
      count: injectedSnapshot?.length ?? 0,
    })
  } catch (err) {
    log.warn('inject-snapshot-eager-write-failed', {
      nodeRunId: opts.nodeRunId,
      error: err instanceof Error ? err.message : String(err),
    })
    // Non-fatal: the final UPDATE at step 11 still carries injectedMemoriesJson,
    // so behavior degrades exactly to RFC-046 (column visible only after run ends).
  }

  // 3. Render the user prompt.
  //
  // RFC-042: on a same-session envelope follow-up, swap the full
  // `renderUserPrompt` (template body + input ports + protocol blocks) for a
  // short directive that re-anchors the agent on the envelope contract. The
  // prior round's full prompt is still in opencode's session memory thanks to
  // `resumeSessionId` being set on the same call — re-emitting it would just
  // burn tokens and risk re-anchoring the agent on stale framing.
  //
  // RFC-023 + RFC-039: when the scheduler tells us this node has a clarify
  // channel wired in the workflow definition, the renderer rewrites the
  // trailing protocol block as a bi-modal preamble (RFC-039: defaults to
  // <workflow-clarify> first; <workflow-output> only when every decision is
  // already pinned down) and appends the clarify format block immediately
  // after — see `buildProtocolBlock` in shared.
  // RFC-049: when reason is 'port-validation', the scheduler attached the
  // failures payload via envelopeFollowupPortValidations. Pre-render the
  // per-kind repair segments through the registered OutputKindHandler set
  // (shared, pure JS) so the prompt assembler stays a string-splicer with
  // no per-kind branching of its own.
  const followupRepairBlocks =
    followupMode !== undefined &&
    followupMode.reason === 'port-validation' &&
    followupMode.portValidations !== undefined &&
    followupMode.portValidations.length > 0
      ? // RFC-080: route per-kind repair through the parametric registry —
        // path<ext> / list<T> / signal failures now render their repair block
        // instead of being dropped by the legacy 3-key Record. No more
        // `as 'string' | 'markdown' | 'markdown_file'` narrowing cast.
        composePerParsedKindRepairBlocks(
          followupMode.portValidations.map((f) => ({
            port: f.port,
            kind: f.kind,
            subReason: f.subReason,
            ...(f.detail !== undefined ? { detail: f.detail } : {}),
          })),
          opts.agent.outputKinds,
        )
      : undefined

  // RFC-060 D.T7: enforce signal-port-not-in-prompt at the runner edge before
  // any render / spawn. When inputPortKinds is omitted (legacy callers /
  // non-fanout dispatch paths), the check no-ops.
  if (opts.inputPortKinds !== undefined && followupMode === undefined) {
    try {
      assertNoPromptSignalRefs(opts.promptTemplate, opts.inputPortKinds)
    } catch (err) {
      if (err instanceof SignalPortInPromptError) {
        const ports = err.violations.map((v) => v.port).join(',')
        await setNodeRunStatus({
          db: opts.db,
          nodeRunId: opts.nodeRunId,
          to: 'failed',
          allowedFrom: ['pending'],
          reason: 'signal-port-in-prompt',
          extra: {
            finishedAt: Date.now(),
            errorMessage: err.message,
          },
        })
        return {
          status: 'failed',
          exitCode: null,
          outputs: {},
          tokenUsage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0 },
          errorMessage: `signal-port-in-prompt:${ports}`,
          prompt: '',
        }
      }
      throw err
    }
  }

  const prompt =
    followupMode !== undefined
      ? renderEnvelopeFollowupPrompt({
          hasClarifyChannel: clarifyMandatory || clarifyOptional,
          // RFC-165 (F12): keep the correction round dual-choice for optional
          // nodes — the mandatory-only bullets would forbid a valid
          // output-only recovery.
          clarifyOptional,
          // RFC-148: reason is mandatory on the followup arm — the historical
          // envelope-missing coalescing fallback (a patch over the unpacked
          // flag) is gone with the packing.
          reason: followupMode.reason,
          ...(followupMode.clarifyDirective !== undefined
            ? { clarifyDirective: followupMode.clarifyDirective }
            : {}),
          ...(followupRepairBlocks !== undefined
            ? { perKindRepairBlocks: followupRepairBlocks }
            : {}),
        })
      : renderUserPrompt({
          promptTemplate: opts.promptTemplate,
          inputs: opts.inputs,
          meta: opts.templateMeta,
          agentOutputs: opts.agent.outputs,
          ...(opts.workgroupProtocolBlock !== undefined
            ? { workgroupProtocolBlock: opts.workgroupProtocolBlock }
            : {}),
          // RFC-005 outputKinds: when any port is `markdown_file`, the trailing
          // protocol block surfaces the "write the file first, then emit only its
          // worktree-relative path" rule by name. Pass-through is unconditional so
          // the editor preview (which threads the same map via PromptPreview) and
          // the live runner stay in lock-step.
          ...(opts.agent.outputKinds !== undefined
            ? { agentOutputKinds: opts.agent.outputKinds }
            : {}),
          ...(opts.reviewContext !== undefined ? { reviewContext: opts.reviewContext } : {}),
          ...(opts.clarifyContext !== undefined ? { clarifyContext: opts.clarifyContext } : {}),
          // RFC-119: generalized prior-output for non-cross-clarify reruns.
          ...(opts.priorOutputUpdate !== undefined
            ? { priorOutputUpdate: opts.priorOutputUpdate }
            : {}),
          // RFC-148: the clarify-channel ADT rides through whole — the
          // renderer projects mandatory-ask-back and the RFC-122 stop notice
          // from it.
          ...(opts.clarifyChannel !== undefined ? { clarifyChannel: opts.clarifyChannel } : {}),
        })

  // Write promptText FIRST (no status change). RFC-053: the status flip
  // pending → running goes through transitionNodeRunStatus below.
  // rfc053-allow-direct-status-write -- writing non-status field
  await opts.db.update(nodeRuns).set({ promptText: prompt }).where(eq(nodeRuns.id, opts.nodeRunId))
  // RFC-053: mark-running enforces pending → running.
  await transitionNodeRunStatus({
    db: opts.db,
    nodeRunId: opts.nodeRunId,
    event: { kind: 'mark-running' },
    extra: { startedAt: Date.now() },
  })
  // RFC-098 B3 (audit S-28): the eager `node.status: running` ping (see the
  // inject-snapshot block above) fires only AFTER the row really is running —
  // a WS listener that re-reads the DB on receipt must observe the same
  // status it was told about.
  taskBroadcaster.broadcast(TASK_CHANNEL(opts.taskId), {
    id: -1,
    type: 'node.status',
    nodeRunId: opts.nodeRunId,
    nodeId: opts.nodeId,
    status: 'running',
  })

  // 4. Spawn the agent runtime — one kind-blind call (RFC-143 PR-4). The driver
  // owns its runtime's ENTIRE assembly: opencode builds + mutates + serializes
  // the inline config (incl. RFC-029 inventory plugin + RFC-041 memory append)
  // into OPENCODE_CONFIG_CONTENT; claude writes the system-prompt-file, converts
  // MCP/subagents to flags and decides the credential bridge. Everything below
  // (lifecycle / kill / pump / exit) is runtime-agnostic.
  let plan: SpawnPlan
  try {
    plan = await driver.buildBusinessSpawn({
      agent: opts.agent,
      prompt,
      injectedMemoryBlock,
      dependents: opts.dependents ?? [],
      mcps: opts.mcps ?? [],
      plugins: opts.plugins ?? [],
      resolvedParamsByAgent,
      skills: opts.skills,
      // RFC-148: a followup dispatch carries its session INSIDE the arm
      // (unrepresentable without one); inline clarify resume keeps the
      // top-level field. Exactly one is set per dispatch by the scheduler.
      resumeSessionId:
        opts.promptMode?.kind === 'followup'
          ? opts.promptMode.resumeSessionId
          : opts.resumeSessionId,
      worktreePath: opts.worktreePath,
      runRoot,
      configDir,
      gitUserName: opts.gitUserName,
      gitUserEmail: opts.gitUserEmail,
      runtimeBinary: opts.runtimeBinary,
      opencodeCmd: opts.opencodeCmd,
      runtimeCmd: opts.runtimeCmd,
      wantsInventory,
      nodeRunId: opts.nodeRunId,
      log,
    })
  } catch (err) {
    // RFC-143 §6: a driver that fails to ASSEMBLE the spawn (system-prompt-file
    // write EACCES, config-dir prep failure) lands on the same failure mode as
    // an unspawnable binary below — mark failed cleanly instead of throwing out
    // of runNode and stranding the row at 'running'.
    const errorMessage = `spawn ${runtime} failed: ${err instanceof Error ? err.message : String(err)}`
    log.warn('runtime-spawn-failed', { nodeRunId: opts.nodeRunId, runtime, errorMessage })
    await setNodeRunStatus({
      db: opts.db,
      nodeRunId: opts.nodeRunId,
      to: 'failed',
      allowedFrom: ['running', 'pending'],
      reason: 'runtime-spawn-failed',
      extra: { finishedAt: Date.now(), errorMessage },
    })
    return {
      status: 'failed',
      exitCode: null,
      outputs: {},
      tokenUsage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0 },
      prompt,
      errorMessage,
    }
  }
  const { cmd, env } = plan
  // Diagnostic: surface the model/variant/temperature/mcp/plugin facts that
  // actually landed in the driver's spawn assembly (plan.diagnostics, RFC-143
  // §4.4 — same fields the runner used to derive from the inline config). Lets
  // operators tell "scheduler dropped the override on the floor" apart from
  // "the runtime received it but ignored it" without dumping the full config.
  // Names/counts only — never config bodies (env / headers may contain user
  // tokens; OPENCODE_CONFIG.md §6).
  log.info('spawning agent runtime', {
    runtime,
    bin: cmd[0],
    agent: opts.agent.name,
    cwd: opts.worktreePath,
    nodeRunId: opts.nodeRunId,
    ...(plan.diagnostics ?? {}),
  })

  // env (PWD fix / OPENCODE_CONFIG_DIR+CONTENT / RFC-029 inventory path /
  // RFC-067 git identity) is assembled by the driver — see
  // ./runtime/opencode/spawn.ts for the byte-for-byte construction.
  const trySpawn = (): Bun.Subprocess<'ignore' | 'pipe', 'pipe', 'pipe'> =>
    Bun.spawn({
      cmd,
      cwd: opts.worktreePath,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
      // RFC-111 D12: claude receives the prompt over stdin (avoids argv E2BIG);
      // opencode passes it positionally and ignores stdin.
      stdin: plan.stdin?.mode === 'pipe' ? 'pipe' : 'ignore',
      // RFC-098 WP-8 (audit S-15): POSIX setsid() — the child becomes its own
      // process-group leader, so killTree's `process.kill(-pid, sig)` reaches
      // grandchildren (docker MCP / shell-tool descendants) that a single-pid
      // SIGTERM would orphan with the write end of our pipes still open.
      detached: true,
    })
  let child: ReturnType<typeof trySpawn>
  try {
    child = trySpawn()
  } catch (err) {
    // RFC-111 (Codex impl-gate P1-2): a missing / unspawnable runtime binary
    // (the OPTIONAL claude not installed, a bad path) throws ENOENT here. Mark
    // the node failed cleanly instead of throwing out of runNode and stranding
    // the row at 'running' (opencode is hard-required at startup, so in practice
    // this only fires for claude). The spawn driver's temp dir is cleaned up.
    const errorMessage = `spawn ${runtime} failed: ${err instanceof Error ? err.message : String(err)}`
    log.warn('runtime-spawn-failed', { nodeRunId: opts.nodeRunId, runtime, errorMessage })
    plan.cleanup?.()
    await setNodeRunStatus({
      db: opts.db,
      nodeRunId: opts.nodeRunId,
      to: 'failed',
      allowedFrom: ['running', 'pending'],
      reason: 'runtime-spawn-failed',
      extra: { finishedAt: Date.now(), errorMessage },
    })
    return {
      status: 'failed',
      exitCode: null,
      outputs: {},
      tokenUsage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0 },
      prompt,
      errorMessage,
    }
  }

  // RFC-111 D12: stream the prompt into the child's stdin then close it (claude).
  if (plan.stdin?.mode === 'pipe') {
    const sink = child.stdin as { write: (s: string) => void; end: () => void } | undefined
    if (sink !== undefined) {
      sink.write(plan.stdin.data)
      sink.end()
    }
  }

  if (typeof child.pid === 'number') {
    // RFC-108 T9 (AR-14): persist the spawned binary path (cmd[0]) alongside pid
    // so the stale-process reaper can match a live pid against THIS specific
    // binary, not a fuzzy regex — telling "our child still alive" from a recycled pid.
    await opts.db
      .update(nodeRuns)
      .set({ pid: child.pid, spawnBinaryPath: cmd[0] })
      .where(eq(nodeRuns.id, opts.nodeRunId))
  }

  // 5. Wire up cancellation + timeout.
  //
  // RFC-098 WP-8 (audit S-15): both paths now go through the SIGTERM →
  // grace → SIGKILL escalation (group-kill first, see killTree) instead of
  // a single fire-and-forget SIGTERM, and arm a final reap deadline
  // (grace + margin) so a child that ignores even SIGKILL cannot wedge the
  // runner forever (see §7 below).
  let aborted = false
  let timedOut = false
  const graceMs = opts.killEscalationGraceMs ?? KILL_ESCALATION_GRACE_MS

  let reapDeadlineTimer: ReturnType<typeof setTimeout> | null = null
  let reapDeadlineFire: (() => void) | undefined
  const reapDeadline = new Promise<'deadline'>((res) => {
    reapDeadlineFire = () => res('deadline')
  })
  const armReapDeadline = (): void => {
    if (reapDeadlineTimer !== null) return
    reapDeadlineTimer = setTimeout(() => reapDeadlineFire?.(), graceMs + FINAL_REAP_MARGIN_MS)
    reapDeadlineTimer.unref()
  }

  // Initializer cast keeps TS from flow-narrowing to `null` at the §7 read —
  // the assignment only ever happens inside the abort/timeout closures.
  let escalation = null as { cancel: () => void } | null
  const startKill = (): void => {
    if (escalation === null) escalation = armKillEscalation(child, log, graceMs)
    armReapDeadline()
  }

  const onAbort = (): void => {
    aborted = true
    startKill()
  }
  if (opts.signal) {
    if (opts.signal.aborted) onAbort()
    else opts.signal.addEventListener('abort', onAbort)
  }

  const timeoutHandle =
    opts.timeoutMs !== undefined
      ? setTimeout(() => {
          timedOut = true
          startKill()
        }, opts.timeoutMs)
      : null

  // 6. Stream stdout + stderr into node_run_events.
  //    `--format json` makes opencode emit one JSON event per line; the
  //    agent's text reply (which carries the <workflow-output> envelope)
  //    is inside the `part.text` field of `text` events. We accumulate
  //    text-event payloads here and parse the envelope from that buffer.
  const agentText: string[] = []
  const tokenUsage: RunResult['tokenUsage'] = {
    input: 0,
    output: 0,
    cacheCreate: 0,
    cacheRead: 0,
    total: 0,
  }
  let sessionId: string | undefined

  // Throttled `node.status: running` re-ping so the SessionTab's `/session`
  // query refreshes live while the parent opencode child is streaming events.
  // Without this, the only mid-run broadcast came from RFC-048's subagent
  // live poller (runner.ts §livePoller below) — but workflows whose worker
  // never spawns a subagent produced ZERO mid-run broadcasts, so the
  // conversation list in the Session tab sat stale until the user switched
  // tabs and forced a remount-refetch. Cadence is intentionally coarser
  // than per-line: opencode emits many events per agent message and React-
  // Query would coalesce anyway, but cutting WS volume to ~2/s keeps the
  // browser tab cheap. The terminal `node.status: done|failed|...` ping
  // from the scheduler handles the trailing-edge flush.
  const PARENT_BROADCAST_THROTTLE_MS = 500
  let lastParentBroadcastTs = 0
  const broadcastParentRunning = (): void => {
    const now = Date.now()
    if (now - lastParentBroadcastTs < PARENT_BROADCAST_THROTTLE_MS) return
    lastParentBroadcastTs = now
    taskBroadcaster.broadcast(TASK_CHANNEL(opts.taskId), {
      id: -1,
      type: 'node.status',
      nodeRunId: opts.nodeRunId,
      nodeId: opts.nodeId,
      status: 'running',
    })
  }

  const stdoutPump = pumpLines(child.stdout, async (line) => {
    // RFC-111 PR-A/B: normalize one stdout line through the frozen runtime's
    // driver. `parseEvent` returns null for non-JSON / falsy-JSON lines, which
    // routes them through the raw-text fallback exactly as the old inline
    // opencode `if (evt) {...} else {...}` selection did.
    const ev = driver.parseEvent(line)
    if (ev) {
      if (ev.sessionId !== undefined && sessionId === undefined) {
        sessionId = ev.sessionId
      }
      if (ev.tokens) {
        tokenUsage.input += ev.tokens.input
        tokenUsage.output += ev.tokens.output
        tokenUsage.cacheCreate += ev.tokens.cacheCreate
        tokenUsage.cacheRead += ev.tokens.cacheRead
        tokenUsage.total =
          tokenUsage.input + tokenUsage.output + tokenUsage.cacheCreate + tokenUsage.cacheRead
      }
      if (typeof ev.text === 'string') agentText.push(ev.text)
      const ts = ev.timestamp ?? Date.now()
      // RFC-027: tag every stdout-derived row with the (root) sessionID +
      // parent_session_id=null so the SessionTab parser can bucket parent
      // events against post-run captured child events without ambiguity.
      const evtSessionId = ev.sessionId ?? sessionId ?? null
      await opts.db.insert(nodeRunEvents).values({
        nodeRunId: opts.nodeRunId,
        ts,
        kind: ev.kind,
        payload: ev.rawLine,
        sessionId: evtSessionId,
        parentSessionId: null,
      })
      broadcastParentRunning()
    } else {
      // Non-JSON stdout lines shouldn't happen with --format json, but record
      // them as kind=text for debugging.
      await opts.db.insert(nodeRunEvents).values({
        nodeRunId: opts.nodeRunId,
        ts: Date.now(),
        kind: 'text',
        payload: line,
      })
      agentText.push(line)
      broadcastParentRunning()
    }
  })

  // RFC-048: spin up the subagent live capture poller alongside the child.
  // It mirrors opencode's child-session SQLite into `node_run_events` on a
  // fixed cadence (default 1500ms) so the SessionTab sees subagent output
  // accumulate during the run instead of waiting for post-run BFS. The
  // handle is stopped on child exit; the post-run captureChildSessions call
  // below still runs and uses `insertedPartIdsBySession` to skip rows the
  // poller already wrote.
  const livePollMs = opts.subagentLiveCapture?.pollMs ?? 1500
  const liveFailureLimit = opts.subagentLiveCapture?.consecutiveFailureLimit ?? 5
  const liveCtrl = new AbortController()
  // RFC-143: live subagent capture is an opencode-only capability. claude's
  // driver omits `startLiveCapture` → NOOP_HANDLE (was an UNCONDITIONAL start
  // that spun uselessly against opencode's SQLite on every claude run).
  const livePoller =
    driver.startLiveCapture?.({
      nodeRunId: opts.nodeRunId,
      taskId: opts.taskId,
      nodeId: opts.nodeId,
      getRootSessionId: () => sessionId ?? null,
      db: opts.db,
      log: log.child('subagent-live-poll'),
      pollMs: livePollMs,
      consecutiveFailureLimit: liveFailureLimit,
      signal: liveCtrl.signal,
      onInsert: (info) => {
        // Reuse the existing `node.status: running` broadcast lane so the
        // frontend `useTaskSync` invalidates `['tasks', taskId, 'node-runs']`
        // without an additional WS schema entry. The status hasn't actually
        // changed — we're piggybacking the cheap idempotent ping that already
        // triggers the right invalidation. Empty ticks don't reach this
        // callback so we never spam empty broadcasts.
        void info
        taskBroadcaster.broadcast(TASK_CHANNEL(opts.taskId), {
          id: -1,
          type: 'node.status',
          nodeRunId: opts.nodeRunId,
          nodeId: opts.nodeId,
          status: 'running',
        })
      },
    }) ?? NOOP_HANDLE

  const stderrPump = pumpLines(child.stderr, async (line) => {
    await opts.db.insert(nodeRunEvents).values({
      nodeRunId: opts.nodeRunId,
      ts: Date.now(),
      kind: 'stderr',
      payload: line,
    })
    // RFC-031: detect opencode's plugin-load error log lines and surface a
    // synthetic `text` event tagged `[rfc031/plugin-load-failed]`. opencode
    // only logs + publishes these (does NOT kill the parent process — see
    // opencode/packages/opencode/src/plugin/index.ts:170-209), so without
    // this tap the operator never sees that an injected plugin failed.
    const decoded = detectPluginLoadFailure(line, opts.plugins ?? [])
    if (decoded !== null) {
      await opts.db.insert(nodeRunEvents).values({
        nodeRunId: opts.nodeRunId,
        ts: Date.now(),
        kind: 'text',
        payload: `[rfc031/plugin-load-failed] ${JSON.stringify({
          rfc: 'RFC-031',
          code: 'plugin-load-failed',
          pluginName: decoded.pluginName,
          message: decoded.message,
        })}`,
      })
    }
  })

  // 7. Wait for exit + drain streams — bounded (RFC-098 WP-8, audit S-15).
  //    The reap deadline (grace + margin) is armed at the first kill signal:
  //    a child that survives the SIGTERM→SIGKILL escalation past it is
  //    abandoned — status='failed' / errorMessage='child-unkillable', stream
  //    readers canceled, child unref'd — so neither the daemon nor bun test
  //    can hang on an unkillable subprocess. The deadline is re-armed at
  //    normal exit too, bounding the pump drain below: a detached descendant
  //    that inherited our pipe FDs would otherwise keep the pumps from ever
  //    seeing EOF (the second wedge point S-15 called out).
  const exitedOutcome = await Promise.race([
    child.exited.then((code) => ({ kind: 'exited' as const, code })),
    reapDeadline.then(() => ({ kind: 'unkillable' as const })),
  ])
  const childUnkillable = exitedOutcome.kind === 'unkillable'
  const exitCode = exitedOutcome.kind === 'exited' ? exitedOutcome.code : null
  escalation?.cancel()
  // RFC-048: stop the live poller before the post-run BFS so no concurrent
  // SELECT races against the final captureChildSessions read. `abort()` is
  // idempotent + signal-based; `livePoller.stop()` clears the interval and
  // closes the readonly handle.
  liveCtrl.abort()
  livePoller.stop()
  if (childUnkillable) {
    log.error('child survived SIGKILL escalation past reap deadline; abandoning', {
      nodeRunId: opts.nodeRunId,
      pid: child.pid,
      deadlineMs: graceMs + FINAL_REAP_MARGIN_MS,
    })
    stdoutPump.cancel()
    stderrPump.cancel()
    child.unref()
  } else {
    armReapDeadline()
    const drained = await Promise.race([
      Promise.all([stdoutPump.done, stderrPump.done]).then(() => true),
      reapDeadline.then(() => false),
    ])
    if (!drained) {
      log.warn('stdout/stderr never hit EOF after exit (descendant holding pipe?); canceling', {
        nodeRunId: opts.nodeRunId,
        pid: child.pid,
      })
      stdoutPump.cancel()
      stderrPump.cancel()
    }
  }
  await Promise.all([stdoutPump.done, stderrPump.done])
  if (opts.signal) opts.signal.removeEventListener('abort', onAbort)
  if (timeoutHandle !== null) clearTimeout(timeoutHandle)
  if (reapDeadlineTimer !== null) clearTimeout(reapDeadlineTimer)

  // 8. Resolve final status.
  let status: RunFinalStatus
  let errorMessage: string | undefined
  // RFC-145: set in lock-step with every machine-relevant errorMessage stamp
  // below; persisted alongside it in the runner-exit extra.
  let failureCode: FailureCode | undefined
  // RFC-049: structured port-validation failures captured eagerly after
  // parseEnvelope (see section below). Persisted to
  // node_runs.port_validation_failures_json so the scheduler can route the
  // followup attempt to the right OutputKindHandler's repair block without
  // re-parsing errorMessage.
  const portValidationFailures: PortValidationFailure[] = []
  if (childUnkillable) {
    // RFC-098 WP-8: overrides aborted/timedOut — the operator needs the pid
    // to clean up by hand, and a 'canceled' status would read as a clean stop.
    status = 'failed'
    errorMessage = `child-unkillable: pid ${child.pid} survived SIGTERM→SIGKILL escalation past ${graceMs + FINAL_REAP_MARGIN_MS}ms; abandoned (detached process group left running)`
  } else if (aborted) {
    status = 'canceled'
    errorMessage = 'aborted by signal'
  } else if (timedOut) {
    status = 'failed'
    errorMessage = `node-timeout: exceeded ${opts.timeoutMs ?? 0}ms`
  } else if (exitCode !== 0) {
    status = 'failed'
    errorMessage = `${runtime} exited with code ${exitCode}` // RFC-111 P3: name the actual runtime
  } else {
    status = 'done'
  }

  // 9. Parse envelope on clean exit. RFC-023 splits this into a kind probe
  //    first so we can branch between the legacy <workflow-output> path,
  //    the new <workflow-clarify> path, and the exclusive-or hard rejects
  //    (both / neither). detectEnvelopeKind is the single source of truth
  //    for which form the reply took.
  let outputs: Record<string, string> = {}
  let clarifyResult:
    | { questions: ClarifyQuestion[]; truncationWarnings: ClarifyTruncationWarning[] }
    | undefined
  if (status === 'done') {
    const accumulatedText = agentText.join('\n')
    const kind = detectEnvelopeKind(accumulatedText)
    // RFC-100: while mandatory ask-back is ACTIVE (channel wired AND the user
    // has not clicked "Stop clarifying" — RFC-148: directive === 'mandatory'
    // on the clarify-channel ADT), the ONLY valid reply is a
    // `<workflow-clarify>` envelope. Any `<workflow-output>` / both / neither
    // is a violation: fail with a `clarify-required-*` errorMessage so
    // `decideEnvelopeFollowup` drives a same-session follow-up that re-demands
    // the clarify envelope (and the node hard-fails after retries — there is no
    // output escape hatch). On the stop / suppressed rounds this guard is
    // skipped and the agent finalizes through the normal `<workflow-output>`
    // path below.
    const clarifyActive = clarifyMandatory
    if (clarifyActive && kind !== 'clarify') {
      status = 'failed'
      failureCode = 'clarify-required'
      errorMessage =
        kind === 'output'
          ? `${CLARIFY_REQUIRED_PREFIX}-output-emitted: node is in mandatory ask-back mode; emit <workflow-clarify>, not <workflow-output>`
          : kind === 'both'
            ? `${CLARIFY_REQUIRED_PREFIX}-both-present: node is in mandatory ask-back mode; emit only <workflow-clarify>, no <workflow-output>`
            : `${CLARIFY_REQUIRED_PREFIX}-missing: node is in mandatory ask-back mode; reply must be a <workflow-clarify> envelope`
    } else if (clarifyStoppedDirective && kind === 'clarify') {
      // RFC-123 follow-up (user「强制停止」): the node is EXPLICITLY stopped (canvas
      // toggle='stop' OR a latest answered 'stop' directive — NOT review-rerun ask-back
      // suppression) so it was told STOP CLARIFYING. The agent disobeyed and emitted a
      // <workflow-clarify> anyway. REJECT it — symmetric to the clarify-required output
      // rejection above — so a stopped node can NEVER re-open a clarify session despite
      // agent disobedience. No clarifyResult is set (no session); decideEnvelopeFollowup
      // matches this prefix → same-session follow-up re-demands <workflow-output> (the
      // renderer coerces the reason to 'envelope-missing' while hasClarify=false). Hard
      // fails after retries (the stop is enforced; the agent must produce output).
      status = 'failed'
      failureCode = 'clarify-forbidden'
      errorMessage = `${CLARIFY_FORBIDDEN_PREFIX}: node is in STOP CLARIFYING mode; emit <workflow-output>, not <workflow-clarify>`
    } else if (kind === 'clarify' && (await opts.clarifySuppressed?.()) === true) {
      // RFC-181 C — workgroup autonomous hard suppression, resolved at
      // ENVELOPE time against the LATEST task config (the per-task PATCH can
      // flip `autonomous` mid-run in EITHER direction, so a dispatch-frozen
      // directive would race the toggle both ways — impl-gate P1/P2).
      // Classified HERE, before terminal persistence, so the row closes as
      // failed + failure_code='clarify-forbidden' (the RFC-182 note source)
      // without any illegal done→failed correction. No clarifyResult ⇒ no
      // session ⇒ no park; the workgroup runner re-prompts and then
      // drop-and-continues on this prefix.
      status = 'failed'
      failureCode = 'clarify-forbidden'
      errorMessage = `${CLARIFY_FORBIDDEN_PREFIX}: ask-back is OFF in this autonomous group; proceed with your best judgment and emit <workflow-output>`
    } else if (kind === 'both') {
      status = 'failed'
      failureCode = 'clarify-and-output-both'
      errorMessage =
        'clarify-and-output-both-present: agent reply contained BOTH <workflow-output> and <workflow-clarify>; the framework requires exactly one'
    } else if (kind === 'clarify') {
      const body = extractClarifyEnvelopeBody(accumulatedText)
      // RFC-056: cross-clarify path disables the RFC-023 5-question cap.
      // RFC-148 (设计门 high 采纳): the cap follows the WIRING family alone —
      // a suppressed cross rerun (review reject/iterate) that voluntarily
      // emits <workflow-clarify> still parses with the lifted cap.
      const parseOpts = channel.kind === 'cross' ? { maxQuestions: Number.POSITIVE_INFINITY } : {}
      const parsed = body !== null ? parseClarifyEnvelopeBody(body, parseOpts) : null
      if (parsed === null || parsed.body === null) {
        const firstErr = parsed?.errors[0]
        status = 'failed'
        // RFC-145 D8: only the clarify-questions-* validator-code family is a
        // follow-up-able failure (matches the old router's startsWith); other
        // codes (clarify-options-* …) stay unstructured — no follow-up.
        if (firstErr === undefined || firstErr.code.startsWith('clarify-questions-')) {
          failureCode = 'clarify-questions-malformed'
        }
        errorMessage =
          firstErr !== undefined
            ? `${firstErr.code}: ${firstErr.detail}`
            : 'clarify-questions-malformed: empty body'
      } else {
        // Agent successfully expressed a clarify ask. Keep status=done — the
        // agent's subprocess exited cleanly with a valid envelope; the next
        // round will be a fresh node_run minted post-answer.
        clarifyResult = {
          questions: parsed.body.questions,
          truncationWarnings: parsed.warnings,
        }
        if (parsed.warnings.length > 0) {
          log.warn('clarify envelope truncated to limits', {
            nodeRunId: opts.nodeRunId,
            warnings: parsed.warnings.map((w) => w.code),
          })
        }
      }
    } else if (kind === 'none') {
      status = 'failed'
      failureCode = 'envelope-missing'
      errorMessage = 'no <workflow-output> envelope found in stdout'
    } else {
      // kind === 'output' — legacy happy path.
      const envelope = extractLastEnvelope(accumulatedText)
      // envelope is non-null here because detectEnvelopeKind matched, but
      // guard defensively for type narrowing.
      if (envelope === null) {
        status = 'failed'
        failureCode = 'envelope-missing'
        errorMessage = 'no <workflow-output> envelope found in stdout'
      } else {
        const parsed = parseEnvelope(envelope, opts.agent.outputs)
        outputs = Object.fromEntries(parsed.ports)
        if (parsed.missingDeclared.length > 0) {
          log.warn('agent omitted declared ports', {
            missing: parsed.missingDeclared,
            nodeRunId: opts.nodeRunId,
          })
        }
        if (parsed.undeclared.length > 0) {
          log.warn('agent emitted undeclared ports', {
            undeclared: parsed.undeclared.map((u) => u.name),
            nodeRunId: opts.nodeRunId,
          })
        }

        // A `<port name="...">` was opened but never closed with a parseable
        // `</port>` (corrupted / truncated close tag — e.g. a leaked special
        // token produced `</|DSML|port>`). The tolerant scanner can't extract
        // such a port, so without this guard it would degrade to an empty
        // string and the node would complete `done` with a blank port — a
        // downstream doc-review node then silently produces nothing, and the
        // failure-only retry path (decideEnvelopeFollowup) never fires. Fail
        // BEFORE RFC-049 validation + the node_run_outputs INSERT so the
        // scheduler drives a same-session retry (and a hard fail after retries)
        // instead of swallowing the corruption. Runs for ALL ports regardless
        // of outputKind — this is more fundamental than per-kind validation and
        // also catches string / markdown / undeclared-kind ports that RFC-049
        // skips.
        if (parsed.malformedPorts.length > 0) {
          log.warn('agent emitted malformed (unclosed) ports', {
            malformed: parsed.malformedPorts,
            nodeRunId: opts.nodeRunId,
          })
          status = 'failed'
          failureCode = 'envelope-port-malformed'
          errorMessage = `${ENVELOPE_PORT_MALFORMED_PREFIX}: agent opened <port name="..."> tag(s) without a parseable </port> close (corrupted or truncated close tag): ${parsed.malformedPorts.join(', ')}`
        }

        // RFC-049: eagerly validate port content against the declared
        // OutputKindHandler BEFORE persisting to node_run_outputs. Failures
        // here surface the producer's session immediately so the scheduler
        // can drive a same-session followup (consumer-side validation would
        // only see the failure after the producer's session is already
        // gone). Fail-fast — first failure wins, see RFC-049 design.md §7.
        //
        // Validation runs BEFORE the node_run_outputs INSERT below so that
        // the table only ever contains rows that passed validation. This
        // makes "node_run_outputs has rows for this node_run" a clean
        // ground-truth signal for "agent successfully produced output"
        // (consumed by the clarify-history cutoff in scheduler.ts), and
        // prevents a markdown_file port with a missing on-disk file from
        // leaving a ghost row that downstream readers might misuse.
        const outputKinds = opts.agent.outputKinds
        // status may already be 'failed' from the malformed-port guard above —
        // skip per-kind validation in that case (the node is failing regardless
        // and we must not overwrite the malformed errorMessage).
        if (status === 'done' && outputKinds !== undefined) {
          for (const [name, content] of parsed.ports) {
            const kind = outputKinds[name]
            if (kind === undefined) continue
            try {
              resolvePortContent({
                rawContent: content,
                kind,
                worktreePath: opts.worktreePath,
                port: name,
              })
            } catch (err) {
              if (err instanceof PortValidationError) {
                portValidationFailures.push(err.failure)
                status = 'failed'
                failureCode = 'port-validation-failed'
                errorMessage = err.message
                break
              }
              // Unknown errors fall through to the standard catch path.
              throw err
            }
          }
        }

        // Persist ports only on successful validation. The fail-fast loop
        // above bails on the first invalid port without setting status back
        // to 'done', so this branch runs iff every declared port passed
        // (status still 'done').
        if (status === 'done') {
          for (const [name, content] of parsed.ports) {
            // RFC-072: persist the resolved output kind so the Outputs tab can
            // tell file-path ports from text. NULL when the agent declared no
            // kind for this port. flag-audit §8 决策：入库前 canonical 化——
            // agent frontmatter 仍可声明 legacy 别名 'markdown_file'，但持久列
            // 统一存 'path<md>'（migration 0075 清洗了存量，别再倒灌）。
            const rawKind = outputKinds?.[name]
            const kind = rawKind !== undefined ? normalizeKindString(rawKind) : null
            await opts.db
              .insert(nodeRunOutputs)
              .values({ nodeRunId: opts.nodeRunId, portName: name, content, kind })
              .onConflictDoUpdate({
                target: [nodeRunOutputs.nodeRunId, nodeRunOutputs.portName],
                set: { content, kind },
              })
          }
        }
      }
    }
  }

  // 10. RFC-027: post-run capture of child (subagent) session events
  //     from opencode's persisted SQLite. Non-fatal; any failure writes
  //     a `subagent_capture_failed` marker and lets the SessionTab tab
  //     fall back to AC-10 rendering.
  //
  // RFC-048: forward the live poller's partId dedupe state so post-run BFS
  // only inserts the tail rows opencode flushed after the last tick. With
  // pollMs=0 the poller returned a no-op handle whose Map is empty, so the
  // call falls back to RFC-027 byte-for-byte behavior.
  if (sessionId !== undefined) {
    try {
      // RFC-143: each driver captures its own subagent transcripts (opencode:
      // SQLite BFS + the live poller's partId dedupe; claude: JSONL files under
      // <runRoot>/.claude/projects). The union ctx carries both runtimes' inputs.
      await driver.captureSessions({
        rootSessionId: sessionId,
        nodeRunId: opts.nodeRunId,
        taskId: opts.taskId,
        db: opts.db,
        log,
        worktreePath: opts.worktreePath,
        runRoot,
        configDirName: configDir.name, // RFC-154: claude's transcript lives under it
        alreadyInsertedPartIds: livePoller.stats().insertedPartIdsBySession,
      })
    } catch (err) {
      log.warn('subagent-capture-unhandled', {
        nodeRunId: opts.nodeRunId,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // 10b. RFC-029: read the runtime inventory snapshot the dump plugin wrote
  //      into runRoot. Total: any failure path resolves to a `captured:false`
  //      stub with a precise reason code rather than leaving the column
  //      NULL, so the UI's reason-pinpointed messaging works on the first
  //      load. Skipped (column stays NULL) for non-agent kinds.
  //
  // RFC-042: same-session envelope follow-up runs skipped plugin
  // materialization above; reading the (intentionally absent) snapshot file
  // would just record a `file-missing` stub on top of the previous attempt's
  // legitimate snapshot. Leave the column at its prior value by skipping the
  // read entirely.
  let inventoryJson: string | null = null
  // RFC-143: inventory read is an opencode-only capability. The agent-kind +
  // non-followup gates are business conditions (`wantsInventory`, same value the
  // spawn-side injection used); the runtime gate is expressed by `readInventory`
  // being present — claude's driver omits it → `?.` short-circuits and the
  // column stays null.
  if (wantsInventory) {
    try {
      const snapshot = await driver.readInventory?.({
        runRoot,
        nodeKind: inventoryNodeKind,
      })
      if (snapshot !== undefined && snapshot !== null) {
        inventoryJson = JSON.stringify(snapshot)
      }
    } catch (err) {
      log.warn('inventory-read-unhandled', {
        nodeRunId: opts.nodeRunId,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // 11. Update node_runs final state.
  // RFC-053: setNodeRunStatus enforces the runtime-determined transition
  // running → {done, failed, canceled}. Non-status fields are batched in
  // `extra`. Two writes: status via CAS helper, then the columns lifecycle
  // doesn't know about (inventory / token usage / portValidation / etc.).
  await setNodeRunStatus({
    db: opts.db,
    nodeRunId: opts.nodeRunId,
    to: status,
    allowedFrom: ['running'],
    reason: 'runner-exit',
    extra: {
      finishedAt: Date.now(),
      exitCode: exitCode ?? null,
      errorMessage: errorMessage ?? null,
      failureCode: failureCode ?? null,
      tokInput: tokenUsage.input,
      tokOutput: tokenUsage.output,
      tokCacheCreate: tokenUsage.cacheCreate,
      tokCacheRead: tokenUsage.cacheRead,
      tokTotal: tokenUsage.total,
    },
  })
  // RFC-132 PR-D 步骤2 (T4): RFC-070 消费戳废弃——派生老化 isTargetNodeConsumed
  // (clarifyRerunLedger) 已是唯一老化判据（读 run 状态，零持久戳）。此处不再落戳。
  // Runner-specific JSON fields not in NodeRunStatusUpdateExtra — write
  // them as a follow-up non-status update.
  // rfc053-allow-direct-status-write -- writing non-status fields
  await opts.db
    .update(nodeRuns)
    .set({
      inventorySnapshotJson: inventoryJson,
      // RFC-046: persist the post-budget-clip snapshot captured at inject
      // time (or copied from attempt 0 on the envelope-followup path).
      injectedMemoriesJson: injectedSnapshot === null ? null : JSON.stringify(injectedSnapshot),
      // RFC-049: structured port-validation failure payload.
      portValidationFailuresJson:
        portValidationFailures.length > 0
          ? serializePortValidationFailures(portValidationFailures)
          : null,
    })
    .where(eq(nodeRuns.id, opts.nodeRunId))

  // 12. Clean up run dir (best-effort).
  try {
    rmSync(runRoot, { recursive: true, force: true })
  } catch {
    // Logged but non-fatal.
  }

  const result: RunResult = { status, exitCode, outputs, tokenUsage, prompt }
  if (errorMessage !== undefined) result.errorMessage = errorMessage
  if (failureCode !== undefined) result.failureCode = failureCode
  if (sessionId !== undefined) result.sessionId = sessionId
  if (clarifyResult !== undefined) result.clarify = clarifyResult
  return result
}

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

// RFC-154: `prepareSkills` (the opencode-blind skill-staging preamble) moved to
// ./runtime/stageSkills.ts — each driver now stages into ITS OWN config dir
// inside buildBusinessSpawn (opencode strict, claude best-effort).

/**
 * RFC-031 — substring-scan a stderr line for opencode plugin-load error
 * patterns (see opencode/packages/opencode/src/plugin/index.ts:170-209 for
 * the producer side). Returns `{ pluginName, message }` when matched and
 * `null` otherwise.
 *
 * `pluginName` is best-effort: we try to map back from the file://<cached>
 * path embedded in the spec to the plugin record's `name`. When the line
 * mentions a different path or the lookup fails, we return an empty string
 * so the UI still renders the message (truncated stderr) with a generic
 * "unknown plugin" label.
 */
export function detectPluginLoadFailure(
  line: string,
  plugins: readonly Plugin[],
): { pluginName: string; message: string } | null {
  // opencode log lines pass through a structured logger; the human-readable
  // tail of the line (after `INFO`/`ERROR`/etc.) starts with the message we
  // emitted via `publishPluginError`. Match against the publish strings.
  const PATTERNS = [
    /Failed to load plugin (\S+):\s*(.*)$/,
    /Failed to install plugin (\S+):\s*(.*)$/,
    /Plugin (\S+) skipped:\s*(.*)$/,
  ]
  let spec: string | null = null
  let message = ''
  for (const re of PATTERNS) {
    const m = re.exec(line)
    if (m !== null) {
      spec = m[1] ?? null
      message = (m[2] ?? '').trim()
      break
    }
  }
  if (spec === null) return null
  // Try to map a file:// spec back to a plugin record by suffix.
  let pluginName = ''
  if (spec.startsWith('file://')) {
    const path = spec.replace(/^file:\/\//, '')
    for (const p of plugins) {
      const cached = p.cachedPath.replace(/^file:\/\//, '')
      if (path === cached || path.endsWith(cached) || cached.endsWith(path)) {
        pluginName = p.name
        break
      }
    }
  } else {
    // npm/git spec form — try direct name match.
    for (const p of plugins) {
      if (p.spec === spec || p.name === spec) {
        pluginName = p.name
        break
      }
    }
  }
  return { pluginName, message: message.length > 0 ? message : spec }
}

// RFC-111 PR-A: buildCommand moved to ./runtime/opencode/spawn.ts (re-exported
// at the bottom of this file); buildOpencodeSpawn there assembles argv + env.

function safeKill(child: Bun.Subprocess, signal: 'SIGTERM' | 'SIGKILL'): void {
  try {
    child.kill(signal)
  } catch {
    // already exited
  }
}

/** RFC-098 WP-8: SIGTERM → SIGKILL escalation grace. */
const KILL_ESCALATION_GRACE_MS = 10_000
/** RFC-098 WP-8: margin on top of the grace for the final reap deadline. */
const FINAL_REAP_MARGIN_MS = 5_000

/**
 * RFC-098 WP-8 (audit S-15): kill the child's WHOLE process group — spawn
 * uses `detached: true`, making the child its own group leader, so `-pid`
 * reaches grandchildren too (verified on bun 1.3.13 / darwin: group SIGTERM
 * kills a bash child's forked sleep). Falls back to the single-process
 * safeKill when the group signal fails (ESRCH after exit / EPERM).
 */
function killTree(child: Bun.Subprocess, signal: 'SIGTERM' | 'SIGKILL'): void {
  const pid = child.pid
  if (typeof pid === 'number' && pid > 0) {
    try {
      process.kill(-pid, signal)
      return
    } catch {
      // fall back to the single-process kill below
    }
  }
  safeKill(child, signal)
}

/**
 * RFC-098 WP-8: fire SIGTERM at the child's process group now, then escalate
 * to SIGKILL after `graceMs` unless the child exits first. The timer is
 * unref'd so a wedged child can't keep the daemon (or bun test) alive, and
 * auto-cancels on `child.exited`.
 */
function armKillEscalation(
  child: Bun.Subprocess,
  log: Logger,
  graceMs: number,
): { cancel: () => void } {
  killTree(child, 'SIGTERM')
  const timer = setTimeout(() => {
    log.warn('child ignored SIGTERM past grace; escalating to SIGKILL', {
      pid: child.pid,
      graceMs,
    })
    killTree(child, 'SIGKILL')
  }, graceMs)
  timer.unref()
  const cancel = (): void => clearTimeout(timer)
  void child.exited.then(cancel, cancel)
  return { cancel }
}

interface LinePump {
  /** Resolves once the stream EOFs (or is canceled) and every onLine settled. */
  done: Promise<void>
  /**
   * RFC-098 WP-8: abandon the stream — cancels the underlying reader so a
   * pipe FD held open by a surviving (grand)child can't wedge `done`.
   * The partial tail line is dropped on cancel.
   */
  cancel: () => void
}

/**
 * Drain a ReadableStream of UTF-8 bytes, calling `onLine` for each complete
 * line. Awaits each callback so the caller's DB writes serialize naturally.
 */
function pumpLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => Promise<void> | void,
): LinePump {
  const reader = stream.getReader()
  let canceled = false
  const done = (async (): Promise<void> => {
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const { value, done: eof } = await reader.read()
        if (eof) break
        buffer += decoder.decode(value, { stream: true })
        let idx: number
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 1)
          if (line.length > 0) await onLine(line)
        }
      }
      // Flush remaining tail (process emitted a line without trailing newline).
      if (buffer.length > 0 && !canceled) await onLine(buffer)
    } finally {
      reader.releaseLock()
    }
  })()
  return {
    done,
    cancel: () => {
      canceled = true
      // Resolves any in-flight read() with done:true; the loop above then
      // exits and releases the lock.
      void reader.cancel().catch(() => {})
    },
  }
}

// RFC-111 PR-A: opencode runtime helpers moved to ./runtime/opencode/* (leaf
// modules, no runner.ts import → no module-init cycle). Re-export the public
// surface so existing import sites (tests, memoryDistiller) keep resolving from
// './runner'.
export { accumulateTokens, extractTextFromEvent, inferEventKind } from './runtime/opencode/events'
export { buildCommand } from './runtime/opencode/spawn'
// RFC-143 PR-4: the OPENCODE_CONFIG_CONTENT assembly moved to
// ./runtime/opencode/inlineConfig.ts so the opencode driver's buildBusinessSpawn
// can import it cycle-free. Same re-export contract as above.
export {
  AW_GLOBAL_PERMISSION,
  buildInlineAgentEntry,
  buildInlineConfig,
} from './runtime/opencode/inlineConfig'

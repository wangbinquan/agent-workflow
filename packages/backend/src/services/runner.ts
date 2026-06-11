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
  Agent,
  ClarifyPromptContext,
  ClarifyQuestion,
  ClarifyTruncationWarning,
  CrossClarifyPromptContext,
  Mcp,
  Plugin,
  ReviewPromptContext,
} from '@agent-workflow/shared'
import {
  composePerParsedKindRepairBlocks,
  parseClarifyEnvelopeBody,
  renderEnvelopeFollowupPrompt,
  SignalPortInPromptError,
  assertNoPromptSignalRefs,
} from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import { cpSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { DbClient } from '@/db/client'
import { nodeRunEvents, nodeRunOutputs, nodeRuns } from '@/db/schema'
import { createLogger, type Logger } from '@/util/log'
import {
  detectEnvelopeKind,
  extractClarifyEnvelopeBody,
  extractLastEnvelope,
  parseEnvelope,
  PortValidationError,
  resolvePortContent,
  serializePortValidationFailures,
  type PortValidationFailure,
} from './envelope'
import { renderUserPrompt } from './protocol'
import { captureChildSessions } from './sessionCapture'
import { startLiveSubagentCapture } from './subagentLiveCapture'
import { setNodeRunStatus, transitionNodeRunStatus } from './lifecycle'
import { markClarifyRoundsConsumedBy } from './clarifyRounds'
import { isAgentRunKind, readSnapshotFromRunDir } from './inventory'
import {
  injectMemoryForRun,
  loadInjectedSnapshotFromFirstAttempt,
  type ScopeBudget,
} from './memoryInject'
import type { InjectedMemorySnapshot } from '@agent-workflow/shared'
import { materializeInventoryPlugin } from '@/opencode-plugin'
import { TASK_CHANNEL, taskBroadcaster } from '@/ws/broadcaster'

export type SkillSource = 'managed' | 'external' | 'project'

export interface ResolvedSkill {
  name: string
  sourceKind: SkillSource
  /** Absolute path for managed/external. Unused for project. */
  sourcePath?: string
}

export interface AgentOverrides {
  model?: string
  variant?: string
  temperature?: number
}

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
  overrides?: AgentOverrides
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
   * RFC-056: External Feedback context for designers being rerun by a
   * cross-clarify node. Built by services/crossClarify.buildExternalFeedbackContext.
   * Substitutes {{__external_feedback__}} / {{__external_feedback_iteration__}} /
   * {{__external_feedback_sources__}} and auto-appends the
   * `## External Feedback` section at the user prompt tail (between the
   * RFC-023 `## Self Clarify Q&A` section and the RFC-039 protocol block).
   * Absent on first runs and on runs whose designer never received
   * cross-agent feedback.
   */
  crossClarifyContext?: CrossClarifyPromptContext
  /**
   * RFC-023 + RFC-039: when true (scheduler computed
   * `agentHasClarifyChannel(definition, agentNodeId)` from the workflow
   * definition), the renderer emits a bi-modal trailing block. RFC-039
   * sharpened the basetone so `<workflow-clarify>` is the default reply and
   * `<workflow-output>` is only allowed when every decision has been pinned
   * down — agents biased toward output even when the user wired a clarify
   * channel. Off by default keeps the non-clarify wire format identical to
   * pre-RFC-023.
   */
  hasClarifyChannel?: boolean
  /**
   * RFC-056: when this agent's `__clarify__` source port is wired to a
   * `clarify-cross-agent` node (rather than the RFC-023 self-clarify node),
   * the runner's envelope parser must NOT truncate at the RFC-023 default
   * (`CLARIFY_MAX_QUESTIONS=5`) — cross-clarify deliberately lifts that cap
   * (questions can be 1..N). The scheduler computes this by looking at the
   * workflow definition (`findCrossClarifyNodeForQuestioner`) and threads it
   * here so the runner doesn't need the definition. Default `'self'` keeps
   * RFC-023 byte-for-byte semantics.
   */
  clarifyMode?: 'self' | 'cross'
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
  /** Default true. */
  dangerouslySkipPermissions?: boolean
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
   * Command to spawn instead of `['opencode']`. Tests pass
   * `['bun', 'run', /path/to/mock-opencode.ts]`.
   */
  opencodeCmd?: string[]
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
   * RFC-042: same-session envelope follow-up. When the scheduler's
   * `decideEnvelopeFollowup` determined the previous attempt failed for a
   * recognized envelope-format reason AND opencode itself exited cleanly
   * with a captured session id, the next retry attempt is run with this set
   * to `true`. The runner then:
   *   - Renders the user prompt via `renderEnvelopeFollowupPrompt` (a short
   *     directive — no inputs, no template body, no auto-appended port
   *     sections, no full RFC-039 / RFC-023 protocol blocks). The original
   *     prompt is still in opencode's session memory thanks to
   *     `resumeSessionId` being set alongside this flag.
   *   - Skips materializing the RFC-029 inventory plugin (the first attempt
   *     already wrote a snapshot; followup is only nudging for an envelope).
   *
   * Always passed together with `resumeSessionId`. `envelopeFollowupReason`
   * drives the opening line and `envelopeFollowupClarifyDirective` controls
   * whether the RFC-039 "Keep clarifying" trailer is appended. Defaults
   * `false` / `undefined` preserve legacy callers.
   */
  envelopeFollowup?: boolean
  envelopeFollowupReason?:
    | 'envelope-missing'
    | 'both-present'
    | 'clarify-malformed'
    | 'port-validation'
  envelopeFollowupClarifyDirective?: 'continue' | 'stop'
  /**
   * RFC-049: structured failures persisted into the previous attempt's
   * `port_validation_failures_json` column. Scheduler reads + zod-parses the
   * column, threads the array through here when scheduling a
   * `reason='port-validation'` followup; runner forwards it to the shared
   * renderer (via composePerKindRepairBlocks) so the agent gets per-port
   * repair instructions in this session.
   */
  envelopeFollowupPortValidations?: ReadonlyArray<{
    port: string
    kind: string
    subReason: string
    detail?: string
  }>
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

export async function runNode(opts: RunNodeOptions): Promise<RunResult> {
  const log = opts.log ?? createLogger('runner')
  const runRoot = join(opts.appHome, 'runs', opts.taskId, opts.nodeRunId)
  const runDir = join(runRoot, '.opencode')

  // 1. Prepare per-run config dir and inject skills.
  prepareSkills(runDir, opts.skills, log)

  // 2. Build OPENCODE_CONFIG_CONTENT inline agent + mcp JSON. RFC-022:
  // primary agent plus every closure dependent gets a `agent.<name>` entry.
  // RFC-028: every Mcp the scheduler pre-loaded becomes an `mcp.<name>` entry
  // (field names translated env→environment / timeoutMs→timeout to match
  // opencode's `McpLocalConfig` / `McpRemoteConfig` wire format — see
  // OPENCODE_CONFIG.md §3.3). opencode merges this AFTER all directory scans
  // so platform definitions win at field level.
  const inlineConfig: {
    agent: Record<string, Record<string, unknown>>
    mcp?: Record<string, Record<string, unknown>>
    plugin?: Array<string | [string, Record<string, unknown>]>
  } = buildInlineConfig(
    opts.agent,
    opts.overrides,
    opts.dependents ?? [],
    opts.mcps ?? [],
    opts.plugins ?? [],
  )

  // RFC-029: only wire the dump plugin for agent kinds (single / multi). For
  // wrapper / clarify / review etc. runNode is not invoked anyway, but the
  // explicit guard keeps the behavior stable even if a future caller routes
  // non-agent kinds through here.
  //
  // RFC-042: on a same-session envelope follow-up, the first attempt already
  // wrote the inventory snapshot. Re-materializing the plugin just to nudge
  // the model into emitting an envelope is pure overhead (extra plugin-load
  // failure surface for no gain), so the followup path skips this entire
  // block.
  const inventoryNodeKind = opts.nodeKind ?? 'agent-single'
  let inventoryOutPath: string | undefined
  if (isAgentRunKind(inventoryNodeKind) && opts.envelopeFollowup !== true) {
    try {
      mkdirSync(runRoot, { recursive: true })
      // materializeInventoryPlugin handles both dev (source tree) and
      // single-binary (embed table) layouts — see opencode-plugin/index.ts.
      // Async because the binary-mode branch reads bytes via Bun.file(); the
      // surrounding `runNode` is already async so awaiting here doesn't
      // change the call-graph.
      const pluginPath = await materializeInventoryPlugin(runRoot)
      const fileSpec: string | [string, Record<string, unknown>] = `file://${pluginPath}`
      inlineConfig.plugin = [...(inlineConfig.plugin ?? []), fileSpec]
      inventoryOutPath = join(runRoot, 'inventory.json')
    } catch (err) {
      // Non-fatal: if we can't materialize the plugin (disk full / permission
      // denied / asset missing in binary mode), the run continues without
      // inventory capture and the post-exit read lands on `plugin-load-failed`.
      log.warn('inventory-plugin-materialize-failed', {
        nodeRunId: opts.nodeRunId,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

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
  if (opts.envelopeFollowup !== true) {
    try {
      const { block: memoryBlock, snapshot } = await injectMemoryForRun({
        db: opts.db,
        taskId: opts.taskId,
        primaryAgent: opts.agent,
        dependents: opts.dependents ?? [],
        budget: opts.memoryInjectionBudget,
      })
      injectedSnapshot = snapshot
      if (memoryBlock !== null) {
        const primary = inlineConfig.agent[opts.agent.name]
        if (primary !== undefined && typeof primary.prompt === 'string') {
          primary.prompt = `${primary.prompt}\n\n${memoryBlock}`
        }
      }
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

  // RFC-022 §design B6: warn (don't fail) when the serialized config crosses
  // the soft cap. Real OS env-var ceilings are well above this; the warning
  // helps catch authors stuffing massive bodies into every dependent agent
  // OR cramming many MCP servers' env / headers maps.
  const serializedInline = JSON.stringify(inlineConfig)
  if (serializedInline.length > 32 * 1024) {
    log.warn('inline-config-large', {
      bytes: serializedInline.length,
      agents: Object.keys(inlineConfig.agent),
      mcpCount: inlineConfig.mcp ? Object.keys(inlineConfig.mcp).length : 0,
    })
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
    opts.envelopeFollowup === true &&
    opts.envelopeFollowupReason === 'port-validation' &&
    opts.envelopeFollowupPortValidations &&
    opts.envelopeFollowupPortValidations.length > 0
      ? // RFC-080: route per-kind repair through the parametric registry —
        // path<ext> / list<T> / signal failures now render their repair block
        // instead of being dropped by the legacy 3-key Record. No more
        // `as 'string' | 'markdown' | 'markdown_file'` narrowing cast.
        composePerParsedKindRepairBlocks(
          opts.envelopeFollowupPortValidations.map((f) => ({
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
  if (opts.inputPortKinds !== undefined && opts.envelopeFollowup !== true) {
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
    opts.envelopeFollowup === true
      ? renderEnvelopeFollowupPrompt({
          hasClarifyChannel: opts.hasClarifyChannel === true,
          reason: opts.envelopeFollowupReason ?? 'envelope-missing',
          ...(opts.envelopeFollowupClarifyDirective !== undefined
            ? { clarifyDirective: opts.envelopeFollowupClarifyDirective }
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
          ...(opts.crossClarifyContext !== undefined
            ? { crossClarifyContext: opts.crossClarifyContext }
            : {}),
          ...(opts.hasClarifyChannel === true ? { hasClarifyChannel: true } : {}),
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

  // 4. Spawn opencode.
  const cmd = buildCommand(opts, prompt)
  // Diagnostic: surface the model/variant/temperature that actually landed in
  // the inline-agent JSON. Lets operators tell "scheduler dropped the override
  // on the floor" apart from "opencode received it but ignored it" without
  // having to dump the full OPENCODE_CONFIG_CONTENT.
  const primaryInline = inlineConfig.agent[opts.agent.name] as Record<string, unknown> | undefined
  // RFC-028: log only the count + names of injected MCPs — never the config
  // bodies. env / headers may contain user tokens; OPENCODE_CONFIG.md §6 calls
  // this out explicitly. If the count seems wrong (e.g. user expected 3 but
  // log shows 1) the operator can grep `mcpKeys` to see which names actually
  // landed without redacting the inline JSON.
  log.info('spawning opencode', {
    bin: cmd[0],
    agent: opts.agent.name,
    cwd: opts.worktreePath,
    nodeRunId: opts.nodeRunId,
    inlineModel: primaryInline?.model ?? null,
    inlineVariant: primaryInline?.variant ?? null,
    inlineTemperature: primaryInline?.temperature ?? null,
    overrides: opts.overrides ?? null,
    mcpCount: inlineConfig.mcp ? Object.keys(inlineConfig.mcp).length : 0,
    mcpKeys: inlineConfig.mcp ? Object.keys(inlineConfig.mcp) : [],
    // RFC-031: log only the count + names of injected plugins — never the
    // options bodies (may contain API keys / tokens). pluginNames lets the
    // operator spot "expected dd-trace, got nothing" without dumping the full
    // OPENCODE_CONFIG_CONTENT to logs.
    pluginCount: (opts.plugins ?? []).filter((p) => p.enabled !== false).length,
    pluginNames: (opts.plugins ?? []).filter((p) => p.enabled !== false).map((p) => p.name),
  })

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    // opencode 1.14.51+ (upstream commit 7f2b5ee8c, the Effect-TS run.ts rewrite)
    // resolves its root via `process.env.PWD ?? process.cwd()`, NOT just
    // `process.cwd()`. Bun.spawn's `cwd:` updates the child's
    // `process.cwd()` but leaves `PWD` inherited from the daemon's parent
    // shell. When daemon's PWD (e.g. the repo source root) differs from the
    // spawn cwd (the worktree), opencode loads TWO Instances (one for cwd via
    // effectCmd's directory preload, one for PWD as the SDK default), the
    // session lands in the wrong one, and `--format json` events stop reaching
    // our stdout pump entirely — the run exits 0 with zero parseable lines and
    // every node fails "no <workflow-output> envelope found in stdout".
    // Reproduced 2026-05-20 against opencode-ai 1.14.51 on this machine.
    // Forcing PWD = cwd is no-op for pre-1.14.30 versions (they used
    // `process.cwd()` only) and restores the legacy behavior for 1.14.30+.
    PWD: opts.worktreePath,
    OPENCODE_CONFIG_DIR: runDir,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(inlineConfig),
  }
  // RFC-029: tell the dump plugin where to write the snapshot file. Set only
  // when the plugin was actually injected — otherwise leaving it unset keeps
  // any externally-set value (e.g. a developer running mock-opencode) from
  // accidentally hijacking the path.
  if (inventoryOutPath !== undefined) {
    env.OPENCODE_AW_INVENTORY_OUT = inventoryOutPath
  }

  // RFC-067: inject the per-task Git commit identity into the spawn env so
  // any `git commit` invocation by the agent (opencode shell tool transmits
  // process.env wholesale per opencode src/tool/shell.ts:419) inherits the
  // task-scoped author + committer. Author + committer are set together —
  // if either side is empty/null the entire block is skipped so the daemon's
  // existing identity resolution (inherited `GIT_AUTHOR_*` from parent shell
  // or `git config user.*`) keeps working unchanged. This defensive `&&`
  // guard is the second line of defense after StartTaskSchema's XOR
  // superRefine — both must be true before we mint a half-identity env.
  const gitName = typeof opts.gitUserName === 'string' ? opts.gitUserName : ''
  const gitEmail = typeof opts.gitUserEmail === 'string' ? opts.gitUserEmail : ''
  if (gitName.length > 0 && gitEmail.length > 0) {
    env.GIT_AUTHOR_NAME = gitName
    env.GIT_AUTHOR_EMAIL = gitEmail
    env.GIT_COMMITTER_NAME = gitName
    env.GIT_COMMITTER_EMAIL = gitEmail
  }

  const child = Bun.spawn({
    cmd,
    cwd: opts.worktreePath,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
    // RFC-098 WP-8 (audit S-15): POSIX setsid() — the child becomes its own
    // process-group leader, so killTree's `process.kill(-pid, sig)` reaches
    // grandchildren (docker MCP / shell-tool descendants) that a single-pid
    // SIGTERM would orphan with the write end of our pipes still open.
    detached: true,
  })

  if (typeof child.pid === 'number') {
    await opts.db.update(nodeRuns).set({ pid: child.pid }).where(eq(nodeRuns.id, opts.nodeRunId))
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
    let evt: Record<string, unknown> | null = null
    try {
      evt = JSON.parse(line) as Record<string, unknown>
    } catch {
      // non-JSON line — store as text and ignore
    }
    if (evt) {
      if (typeof evt.sessionID === 'string' && sessionId === undefined) {
        sessionId = evt.sessionID
      }
      accumulateTokens(evt, tokenUsage)
      const text = extractTextFromEvent(evt)
      if (text !== null) agentText.push(text)
      const kind = inferEventKind(evt)
      const ts = typeof evt.timestamp === 'number' ? evt.timestamp : Date.now()
      // RFC-027: tag every stdout-derived row with the (root) sessionID +
      // parent_session_id=null so the SessionTab parser can bucket parent
      // events against post-run captured child events without ambiguity.
      const evtSessionId =
        typeof evt.sessionID === 'string' ? (evt.sessionID as string) : (sessionId ?? null)
      await opts.db.insert(nodeRunEvents).values({
        nodeRunId: opts.nodeRunId,
        ts,
        kind,
        payload: line,
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
  const livePoller = startLiveSubagentCapture({
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
  })

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
    errorMessage = `opencode exited with code ${exitCode}`
  } else {
    status = 'done'
  }

  // 9. Parse envelope on clean exit. RFC-023 splits this into a kind probe
  //    first so we can branch between the legacy <workflow-output> path,
  //    the new <workflow-clarify> path, and the exclusive-or hard rejects
  //    (both / neither). detectEnvelopeKind is the single source of truth
  //    for which form the reply took.
  let outputs: Record<string, string> = {}
  // RFC-070: tracks the number of `<workflow-output>` ports actually persisted
  // to `node_run_outputs`. Drives the mark-consumed gate at runner tail so
  // clarify-only / no-output completions don't age out unconsumed Q&A rounds.
  let outputsPersistedCount = 0
  let clarifyResult:
    | { questions: ClarifyQuestion[]; truncationWarnings: ClarifyTruncationWarning[] }
    | undefined
  if (status === 'done') {
    const accumulatedText = agentText.join('\n')
    const kind = detectEnvelopeKind(accumulatedText)
    if (kind === 'both') {
      status = 'failed'
      errorMessage =
        'clarify-and-output-both-present: agent reply contained BOTH <workflow-output> and <workflow-clarify>; the framework requires exactly one'
    } else if (kind === 'clarify') {
      const body = extractClarifyEnvelopeBody(accumulatedText)
      // RFC-056: cross-clarify path disables the RFC-023 5-question cap.
      const parseOpts =
        opts.clarifyMode === 'cross' ? { maxQuestions: Number.POSITIVE_INFINITY } : {}
      const parsed = body !== null ? parseClarifyEnvelopeBody(body, parseOpts) : null
      if (parsed === null || parsed.body === null) {
        const firstErr = parsed?.errors[0]
        status = 'failed'
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
      errorMessage = 'no <workflow-output> envelope found in stdout'
    } else {
      // kind === 'output' — legacy happy path.
      const envelope = extractLastEnvelope(accumulatedText)
      // envelope is non-null here because detectEnvelopeKind matched, but
      // guard defensively for type narrowing.
      if (envelope === null) {
        status = 'failed'
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
        if (outputKinds !== undefined) {
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
            // kind for this port.
            const kind = outputKinds?.[name] ?? null
            await opts.db
              .insert(nodeRunOutputs)
              .values({ nodeRunId: opts.nodeRunId, portName: name, content, kind })
              .onConflictDoUpdate({
                target: [nodeRunOutputs.nodeRunId, nodeRunOutputs.portName],
                set: { content, kind },
              })
            outputsPersistedCount += 1
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
      await captureChildSessions({
        rootSessionId: sessionId,
        nodeRunId: opts.nodeRunId,
        taskId: opts.taskId,
        db: opts.db,
        log,
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
  if (isAgentRunKind(inventoryNodeKind) && opts.envelopeFollowup !== true) {
    try {
      const snapshot = await readSnapshotFromRunDir({
        runDir: runRoot,
        nodeKind: inventoryNodeKind,
        pureMode: process.env.OPENCODE_PURE === '1' || process.env.OPENCODE_PURE === 'true',
      })
      inventoryJson = JSON.stringify(snapshot)
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
      tokInput: tokenUsage.input,
      tokOutput: tokenUsage.output,
      tokCacheCreate: tokenUsage.cacheCreate,
      tokCacheRead: tokenUsage.cacheRead,
      tokTotal: tokenUsage.total,
    },
  })
  // RFC-070: stamp every clarify Q&A row this consumer just baked into a
  // captured `<workflow-output>`. Gated on outputs presence so clarify-only
  // (no-output) completions don't age out unconsumed rounds. Single mark
  // entry point — keeps the aging contract verifiable by grep.
  if (status === 'done' && outputsPersistedCount > 0) {
    await markClarifyRoundsConsumedBy(opts.db, {
      id: opts.nodeRunId,
      taskId: opts.taskId,
      nodeId: opts.nodeId,
      shardKey: opts.templateMeta.shardKey ?? null,
    })
  }
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
  if (sessionId !== undefined) result.sessionId = sessionId
  if (clarifyResult !== undefined) result.clarify = clarifyResult
  return result
}

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

function prepareSkills(runDir: string, skills: ResolvedSkill[], log: Logger): void {
  const skillsDir = join(runDir, 'skills')
  mkdirSync(skillsDir, { recursive: true })
  for (const skill of skills) {
    if (skill.sourceKind === 'project') continue
    if (skill.sourcePath === undefined) {
      log.warn('skill missing sourcePath; skipping injection', { name: skill.name })
      continue
    }
    const dst = join(skillsDir, skill.name)
    // Ensure parent exists (skillsDir already does, but defensive).
    mkdirSync(dirname(dst), { recursive: true })
    if (skill.sourceKind === 'managed') {
      cpSync(skill.sourcePath, dst, { recursive: true })
    } else {
      // external -> symlink for IO economy
      symlinkSync(skill.sourcePath, dst, 'dir')
    }
  }
}

/**
 * RFC-073: global permission injected at the TOP LEVEL of OPENCODE_CONFIG_CONTENT
 * (not under any agent). opencode folds a top-level `permission` into
 * `config.permission` (config/config.ts), which `agent/agent.ts:124` reads as
 * `user` and merges into EVERY agent's ruleset (`:290` `merge(defaults, user)`).
 * Because `session/prompt.ts`'s `ctx.ask` and `session/llm.ts:resolveTools`
 * recompute the ruleset per-session from the CURRENT session's agent.permission,
 * this reaches the root AND every nested subagent — without relying on
 * opencode's subagent permission forwarding (subagent-permissions.ts only
 * forwards external_directory/deny, never allow).
 *
 *   "*": "allow"       — evaluate() (permission/evaluate.ts) returns allow for
 *                        every permission on every session, so `ask()` never
 *                        publishes `permission.asked`. Kills the subagent
 *                        deadlock: `opencode run`'s loop only replies to the
 *                        ROOT session's permission (cli/cmd/run.ts:708 skips
 *                        child sessions) and we have no reverse channel in CLI
 *                        mode, so a child's `permission.asked` would otherwise
 *                        block forever.
 *   "question": "deny" — Permission.disabled (permission/index.ts:293-302,
 *                        called from llm.ts:resolveTools) drops the `question`
 *                        tool from the model's tool list on every session, so
 *                        the agent can't invoke it → no `question.asked`
 *                        deadlock (run.ts has no question.asked handler at all).
 *                        Orthogonal to our own clarify flow, which travels via
 *                        the `<workflow-clarify>` envelope (shared/clarify.ts),
 *                        not opencode's question tool.
 *
 * ORDER IS LOAD-BEARING: `Permission.disabled` resolves a tool via `findLast`.
 * For `question` BOTH `{*,allow}` and `{question,deny}` match; the LAST wins.
 * `question` MUST stay AFTER `*` or it is not disabled. Locked by
 * runner-permission-inject.test.ts (serialization-order assertion).
 */
export const AW_GLOBAL_PERMISSION: Record<string, string> = {
  '*': 'allow',
  question: 'deny',
}

/**
 * RFC-073: strip any `question` key from an agent's own permission overrides
 * before injecting it under `agent.<name>.permission`. opencode merges the
 * per-agent permission LAST (agent.ts:306), so a `question: "allow"` there
 * would override the global `question: "deny"` from AW_GLOBAL_PERMISSION and
 * revive the deadlock-prone question tool. No product surface sets this today;
 * the guard is defensive + future-proof. Other keys pass through verbatim.
 */
function sanitizeInjectedAgentPermission(
  permission: Record<string, unknown>,
): Record<string, unknown> {
  if (!('question' in permission)) return permission
  const { question: _dropped, ...rest } = permission
  return rest
}

/**
 * RFC-022: build the inline-agent JSON for one agent. Pulled out so the
 * primary agent and every closure dependent share one definition formula;
 * the only difference is that dependents pass `overrides = {}` so per-node
 * model/variant/temperature tweaks only apply to the selected primary.
 */
export function buildInlineAgentEntry(
  agent: Agent,
  overrides: AgentOverrides = {},
): Record<string, unknown> {
  const inlineAgent: Record<string, unknown> = {
    prompt: agent.bodyMd,
    description: agent.description,
    // RFC-073: drop any `question:"allow"` so it can't override the global
    // `question:"deny"` (AW_GLOBAL_PERMISSION) and revive the question tool.
    permission: sanitizeInjectedAgentPermission(agent.permission),
    // Platform-only fields live under `options` so opencode passes them through
    // without trying to parse. The runner doesn't read these back; they exist
    // for observability when an operator dumps `opencode debug agent`.
    options: { outputs: agent.outputs, readonly: agent.readonly },
  }
  const model = overrides.model ?? agent.model
  if (model !== undefined) inlineAgent.model = model
  const variant = overrides.variant ?? agent.variant
  if (variant !== undefined) inlineAgent.variant = variant
  const temperature = overrides.temperature ?? agent.temperature
  if (temperature !== undefined) inlineAgent.temperature = temperature
  if (agent.steps !== undefined) inlineAgent.steps = agent.steps
  return inlineAgent
}

export function buildInlineConfig(
  agent: Agent,
  overrides: AgentOverrides | undefined,
  dependents: readonly Agent[],
  mcps: readonly Mcp[] = [],
  plugins: readonly Plugin[] = [],
): {
  agent: Record<string, Record<string, unknown>>
  mcp?: Record<string, Record<string, unknown>>
  /**
   * RFC-031: opencode `config.plugin` is an array of `Spec` values. Each
   * element is either a bare `file://<path>` string or a `[file://..., options]`
   * tuple when the plugin record carries non-empty options. We NEVER inject
   * the raw user-supplied spec — opencode would re-resolve it through npm,
   * defeating the eager-install + cache contract.
   */
  plugin?: Array<string | [string, Record<string, unknown>]>
  /** RFC-073: global permission injected at the top level — see AW_GLOBAL_PERMISSION. */
  permission?: Record<string, string>
} {
  const map: Record<string, Record<string, unknown>> = {
    [agent.name]: buildInlineAgentEntry(agent, overrides),
  }
  for (const dep of dependents) {
    if (dep.name === agent.name) continue // root would shadow itself; defensive
    if (map[dep.name] !== undefined) continue // closure already deduped, but guard anyway
    map[dep.name] = buildInlineAgentEntry(dep)
  }
  const out: {
    agent: Record<string, Record<string, unknown>>
    mcp?: Record<string, Record<string, unknown>>
    plugin?: Array<string | [string, Record<string, unknown>]>
    permission?: Record<string, string>
  } = { agent: map }
  // RFC-073: inject global permission at the TOP LEVEL of the inline config
  // (= OPENCODE_CONFIG_CONTENT) so opencode folds it into `config.permission`
  // → every agent + every nested subagent. Roots out the subagent
  // permission.asked / question.asked deadlock at the source. See
  // AW_GLOBAL_PERMISSION for the full mechanism + the load-bearing key order.
  out.permission = AW_GLOBAL_PERMISSION
  // RFC-028: emit the mcp record only when at least one ENABLED entry exists.
  // Disabled entries are skipped entirely to keep the env-var compact AND to
  // avoid masking a same-name inherited entry from repo .opencode/config.json
  // — leaving inherited config alone is the v1 stance (OPENCODE_CONFIG.md §6).
  const mcpMap: Record<string, Record<string, unknown>> = {}
  for (const m of mcps) {
    if (m.enabled === false) continue
    if (mcpMap[m.name] !== undefined) continue // closure dedupe
    mcpMap[m.name] = buildInlineMcpEntry(m)
  }
  if (Object.keys(mcpMap).length > 0) out.mcp = mcpMap
  // RFC-031: emit the plugin array only when at least one ENABLED entry
  // resolves. Dedupe by plugin.name (closure may visit the same plugin via
  // multiple agents). Each element is `file://<cachedPath>` so opencode's
  // `resolvePathPluginTarget` handles it without npm.
  const pluginArr: Array<string | [string, Record<string, unknown>]> = []
  const pluginSeen = new Set<string>()
  for (const p of plugins) {
    if (p.enabled === false) continue
    if (pluginSeen.has(p.name)) continue
    pluginSeen.add(p.name)
    const pathSpec = p.cachedPath.startsWith('file://') ? p.cachedPath : `file://${p.cachedPath}`
    const opts = p.options && Object.keys(p.options).length > 0 ? p.options : undefined
    pluginArr.push(opts === undefined ? pathSpec : [pathSpec, opts])
  }
  if (pluginArr.length > 0) out.plugin = pluginArr
  return out
}

/**
 * Translate one DB-shape Mcp into the opencode-wire shape consumed by
 * `OPENCODE_CONFIG_CONTENT.mcp.<name>`:
 *   - Local : `command` array kept verbatim; `env` → `environment`;
 *             `timeoutMs` → `timeout`. **No `cwd` field** (opencode lacks it
 *             — stdio child cwd is taken from the opencode process directory
 *             = our worktree). See OPENCODE_CONFIG.md §3.3.
 *   - Remote: `url` / `headers` / `oauth` kept verbatim; `timeoutMs` → `timeout`.
 *
 * Undefined fields are stripped so the resulting JSON does not include `null`
 * values that opencode's Effect Schema would reject.
 */
function buildInlineMcpEntry(m: Mcp): Record<string, unknown> {
  const entry: Record<string, unknown> = { type: m.type, enabled: m.enabled }
  if (m.type === 'local') {
    entry.command = m.config.command
    if (m.config.env !== undefined) entry.environment = m.config.env
    if (m.config.timeoutMs !== undefined) entry.timeout = m.config.timeoutMs
  } else {
    entry.url = m.config.url
    if (m.config.headers !== undefined) entry.headers = m.config.headers
    if (m.config.oauth !== undefined) entry.oauth = m.config.oauth
    if (m.config.timeoutMs !== undefined) entry.timeout = m.config.timeoutMs
  }
  return entry
}

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

export function buildCommand(opts: RunNodeOptions, prompt: string): string[] {
  const head = opts.opencodeCmd ?? ['opencode']
  // `--thinking` makes opencode emit `reasoning` events to stdout in
  // `--format json` mode; without it `cli/cmd/run.ts:671` filters them
  // out and the SessionTab can never show the model's thinking blocks.
  const cmd = [...head, 'run', prompt, '--agent', opts.agent.name, '--format', 'json', '--thinking']
  if (opts.dangerouslySkipPermissions ?? true) cmd.push('--dangerously-skip-permissions')
  // RFC-026: clarify-inline rerun — resume the prior opencode session so the
  // agent has its full prior transcript + state. Only ever populated by the
  // scheduler on the clarify-driven path (review / retry / loop paths leave
  // it undefined). Empty string is treated the same as undefined.
  if (opts.resumeSessionId !== undefined && opts.resumeSessionId.length > 0) {
    cmd.push('--session', opts.resumeSessionId)
  }
  return cmd
}

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

/**
 * Pull out the agent's text contribution from one opencode event, if any.
 * Different opencode versions / part kinds put it in different shapes; we
 * tolerate the common ones.
 */
export function extractTextFromEvent(evt: Record<string, unknown>): string | null {
  const part = evt.part as Record<string, unknown> | undefined
  // shape: { type: 'text', part: { type: 'text', text: '...' } }
  if (part && typeof part === 'object') {
    const ptype = part.type
    const ptext = part.text
    if (ptype === 'text' && typeof ptext === 'string') return ptext
  }
  // shape: { type: 'text', text: '...' }  (older / synthetic)
  if (evt.type === 'text' && typeof evt.text === 'string') return evt.text
  return null
}

/** Map an opencode JSON event to one of our enum kinds. */
export function inferEventKind(
  evt: Record<string, unknown>,
): 'tool_use' | 'text' | 'reasoning' | 'permission_asked' | 'error' | 'step_start' | 'step_finish' {
  const t = evt.type
  if (typeof t === 'string') {
    if (t === 'tool_use') return 'tool_use'
    if (t === 'text') return 'text'
    if (t === 'reasoning') return 'reasoning'
    if (t === 'permission.asked' || t === 'permission_asked') return 'permission_asked'
    if (t === 'error') return 'error'
    if (t === 'step_start') return 'step_start'
    if (t === 'step_finish') return 'step_finish'
  }
  return 'text'
}

/**
 * P-4-05: token accumulation across opencode `--format json` events.
 *
 * opencode emits step-finish events with token usage at several possible
 * paths. We probe in priority order:
 *   evt.tokens              top-level (test fixtures, some old shapes)
 *   evt.part.tokens         inside a text/step event part
 *   evt.usage               inside a step-finish summary
 *   evt.step.tokens         inside a step event
 *   evt.message.usage       message-style assistant turn
 * and within each, accept both snake_case (`input/output/cache_creation/
 * cache_read`) and camelCase. The first event with token fields wins per
 * field — we don't double-count if multiple shapes appear in one event.
 */
export function accumulateTokens(evt: Record<string, unknown>, acc: RunResult['tokenUsage']): void {
  const tokens = pickTokens([
    evt,
    evt.part as Record<string, unknown> | undefined,
    evt.usage as Record<string, unknown> | undefined,
    evt.step as Record<string, unknown> | undefined,
    evt.message as Record<string, unknown> | undefined,
  ])
  if (!tokens) return
  const input = numOrZero(tokens.input ?? tokens.input_tokens ?? tokens.prompt_tokens)
  const output = numOrZero(tokens.output ?? tokens.output_tokens ?? tokens.completion_tokens)
  const cacheCreate = numOrZero(tokens.cache_creation ?? tokens.cacheCreation)
  const cacheRead = numOrZero(tokens.cache_read ?? tokens.cacheRead)
  acc.input += input
  acc.output += output
  acc.cacheCreate += cacheCreate
  acc.cacheRead += cacheRead
  acc.total = acc.input + acc.output + acc.cacheCreate + acc.cacheRead
}

function pickTokens(
  candidates: Array<Record<string, unknown> | undefined>,
): Record<string, unknown> | null {
  for (const c of candidates) {
    if (!c || typeof c !== 'object') continue
    // Direct token-bearing object.
    const t = c.tokens
    if (t && typeof t === 'object') return t as Record<string, unknown>
    // Some shapes inline input/output at the object level.
    if (
      typeof c.input_tokens === 'number' ||
      typeof c.output_tokens === 'number' ||
      typeof c.prompt_tokens === 'number' ||
      typeof c.completion_tokens === 'number'
    ) {
      return c
    }
    // Some shapes inline usage directly.
    const usage = c.usage
    if (usage && typeof usage === 'object') {
      const u = usage as Record<string, unknown>
      if (
        typeof u.input === 'number' ||
        typeof u.output === 'number' ||
        typeof u.input_tokens === 'number' ||
        typeof u.output_tokens === 'number'
      ) {
        return u
      }
    }
  }
  return null
}

function numOrZero(v: unknown): number {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

// Runner: spawn ONE opencode subprocess for one node_run, stream its output
// into the DB, persist the parsed envelope, and clean up.
//
// Runtime assembly:
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
  EnvelopeFollowupReason,
  Agent,
  ClarifyPromptContext,
  ClarifyQuestion,
  ClarifyTruncationWarning,
  InventorySnapshot,
  Mcp,
  Plugin,
  PriorOutputUpdateContext,
  ReviewPromptContext,
  TriggerContext,
} from '@agent-workflow/shared'
import {
  DAEMON_SHUTDOWN_ABORT_REASON,
  isAgentNodeKind,
  clarifyDispositionFor,
  composePerParsedKindRepairBlocks,
  normalizeKindString,
  parseClarifyEnvelopeBody,
  renderEnvelopeFollowupPrompt,
  SignalPortInPromptError,
  assertNoPromptSignalRefs,
} from '@agent-workflow/shared'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { randomBytes } from 'node:crypto'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

import { storeNodeRunPrompt } from '@/services/nodeRunPrompt'
import type { DbClient } from '@/db/client'
import { nodeRunEvents, nodeRunOutputs, nodeRuns } from '@/db/schema'
import type { DbTxSync } from '@/db/txSync'
import {
  withTaskExecutionMutation,
  withTaskExecutionTransaction,
} from '@/services/taskExecutionParticipants'
import {
  createProcessEffectAttemptObserver,
  type ProcessEffectAttemptObserver,
  type ProcessSettlement,
} from '@/services/taskExecutionParticipants'
import { retrySqliteWrite, sqliteWriteDiagnostic } from '@/db/sqliteWriteRetry'
import { createLogger, type Logger } from '@/util/log'
import {
  BRANCH_MARKER_MALFORMED_PREFIX,
  BRANCH_PORT_NOT_DECLARED_PREFIX,
  CLARIFY_FORBIDDEN_PREFIX,
  CLARIFY_REQUIRED_PREFIX,
  detectEnvelopeKind,
  ENVELOPE_PORT_MALFORMED_PREFIX,
  extractClarifyEnvelopeBody,
  extractLastEnvelope,
  parseEnvelope,
  PortValidationError,
  resolvePortContentDetailed,
  serializePortValidationFailures,
  type PortValidationFailure,
} from './envelope'
import { archivePortArtifacts, isPathishKindString } from './portArtifacts'
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
import type {
  AgentSpawnPlan,
  NormalizedEvent,
  PersistedEventKind,
  ResolvedSkill,
  StartupInventory,
} from './runtime/types'
import { EMPTY_RUNTIME_PROFILE } from './execution/agentInjection'
import {
  declaredHasContent,
  observationForVerification,
  verifyStartup,
  type StartupVerificationRecord,
} from './execution/startupVerification'
// RFC-297 T18 —— 结算时构造统一清单观测（与 verifyStartup 共用同一套对账语义）。
import { buildRuntimeInventoryObservation } from './execution/inventoryObservation'
import { runAgentProcess } from './execution/agentProcess'
import { FINAL_REAP_MARGIN_MS, MANAGED_PROCESS_MAX_LINE_CHARS } from './execution/managedProcess'

/** SIGTERM → SIGKILL grace for a node's process group. */
const KILL_ESCALATION_GRACE_MS = 10_000
import { NOOP_HANDLE } from './runtime'
import { setNodeRunStatus, transitionNodeRunStatus } from './lifecycle'
import {
  formatMemoryBlockFromSnapshot,
  memoryFencingForNonce,
  injectMemoryForRun,
  loadInjectedSnapshotFromFirstAttempt,
  type ScopeBudget,
} from './memoryInject'
import type { FailureCode, InjectedMemorySnapshot } from '@agent-workflow/shared'
import { TASK_CHANNEL, taskBroadcaster } from '@/ws/broadcaster'
import { loadRunEnvelopeNonce } from '@/services/nodeRunMint'
import { resolveBoundaryMounts } from '@/services/execution/workspaceBoundary'
import { maskDiagnosticsText } from '@agent-workflow/shared'
import {
  claimNewRuntimeSession,
  confirmRuntimeSessionResume,
  discardRuntimeSessionLease,
  getRuntimeSessionLease,
  markRuntimeSessionResetPending,
  preclaimRuntimeSessionResume,
  releaseRuntimeSessionLease,
  rotateRuntimeSessionLease,
  type RuntimeSessionLeaseToken,
} from '@/services/runtimeSessionLease'
import { sha256Hex } from '@/util/hash'
import { runGit, type GitRunResult } from '@/util/git'

// RFC-143 PR-4: SkillSource / ResolvedSkill moved to runtime/types.ts (drivers
// type their skill inputs there); re-exported so scheduler/tests keep resolving.
export type { SkillSource, ResolvedSkill } from './runtime/types'

interface GitControlSnapshot {
  readonly head: string
  readonly symbolicHead: string
  readonly index: string
  readonly refs: string
  readonly localConfig: string
  readonly worktreeConfig: string
}

function digestGitObservation(result: GitRunResult, stdout = result.stdout): string {
  return sha256Hex(`${result.exitCode}\0${stdout}\0${result.stderr}`)
}

/**
 * Capture semantic Git control state around the exact Agent child window.
 * Read-only commands such as `git status` may refresh index stat data, so the
 * index observation deliberately hashes `ls-files --stage`, not `.git/index`
 * bytes. Platform-private refs are excluded; TaskEngine owns that namespace.
 */
async function captureGitControlSnapshot(cwd: string): Promise<GitControlSnapshot> {
  const [head, symbolicHead, index, refs, localConfig, worktreeConfig] = await Promise.all([
    runGit(cwd, ['rev-parse', '--verify', 'HEAD']),
    runGit(cwd, ['symbolic-ref', '--quiet', 'HEAD']),
    runGit(cwd, ['ls-files', '--stage', '-z']),
    runGit(cwd, ['for-each-ref', '--format=%(refname) %(objectname)']),
    runGit(cwd, ['config', '--local', '--null', '--list']),
    runGit(cwd, ['config', '--worktree', '--null', '--list']),
  ])
  const publicRefs = refs.stdout
    .split('\n')
    .filter((line) => !line.startsWith('refs/agent-workflow/'))
    .join('\n')
  return {
    head: digestGitObservation(head),
    symbolicHead: digestGitObservation(symbolicHead),
    index: digestGitObservation(index),
    refs: digestGitObservation(refs, publicRefs),
    localConfig: digestGitObservation(localConfig),
    worktreeConfig: digestGitObservation(worktreeConfig),
  }
}

function changedGitControlFields(before: GitControlSnapshot, after: GitControlSnapshot): string[] {
  return (Object.keys(before) as Array<keyof GitControlSnapshot>).filter(
    (field) => before[field] !== after[field],
  )
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
  /** opencode subprocess cwd = task worktree. */
  worktreePath: string
  /** Enforce that the Agent subprocess cannot mutate Git control state. */
  gitMutationPolicy?: 'read-only'
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
   * Defaults to true. Framework-composed host prompts set false so fenced
   * workgroup/dynamic-workflow data containing literal `{{...}}` is not
   * reinterpreted as workflow-template variables.
   */
  expandPromptTemplate?: boolean
  /** RFC-292 frozen launch context; null is an explicit non-webhook task. */
  triggerContext?: TriggerContext | null
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
  /** RFC-184: when `false`, skip persisting parsed ports into node_run_outputs
   *  (default/undefined ⇒ persist as before). Workgroup host runs pass `false`
   *  so their projected wg_* protocol ports — consumed live from result.outputs
   *  and re-materialized into workgroup_assignments/messages, never read back
   *  from node_run_outputs — do NOT leave rows that would trip the clarify-aging
   *  `runIdsWithOutput` signal (design.md §2.4). Preserves the pre-RFC-184
   *  invariant that host runs write zero node_run_outputs rows. */
  persistDeclaredOutputs?: boolean
  /**
   * Defaults to true. Workgroup host turns set false because their projected
   * wg_* list contains both required and optional protocol ports; the
   * role-specific parser immediately after runNode is the authority that
   * rejects a missing required port. The generic runner otherwise cannot tell
   * an optional omitted wg_messages from a broken output and emits a false
   * warning on every valid quiet worker turn.
   */
  warnMissingDeclaredPorts?: boolean
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
   * MCPs still load naturally (deep-merge baseline). See docs/OPENCODE_CONFIG.md
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
   * RFC-282 C1 — TEST-ONLY runtime-neutral command-head override (mock
   * binaries). Each driver maps it onto its own seam; its PRESENCE keeps real
   * credential bridges off (the old opencodeCmd/runtimeCmd pair collapsed —
   * production never sets it; config.opencodePath now freezes at mint,
   * RFC-111 D15).
   */
  binaryOverride?: readonly string[]
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
   * RFC-313: 本次运行是**主动会话升级**后的第一次 attempt——上一个 runtime 会话的
   * 同会话追问链触顶、被整体放弃，这是在全新会话里从头重来。仅作用于完整 prompt
   * 路径（`promptMode` 非 followup 时），让渲染器在协议块后追加一段简短告知。
   * 与 followup 分支互斥：调度器在判定升级时已把 RFC-042 的续跑决策收回。
   */
  priorSessionAbandonedReason?: EnvelopeFollowupReason
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
  /**
   * The executor exhausted TERM/KILL/reap and the child may still be alive.
   * Callers must not start another process for the same node/worktree until a
   * recovery barrier proves this child gone.
   */
  processUnreaped?: true
  /** Resolved declared port values (missing ones present as ""). */
  outputs: Record<string, string>
  /**
   * RFC-306: which of `outputs` the agent marked `active="false"`. Carried on
   * the result — not left to a DB re-read — because the in-process consumers
   * (fanout shard/aggregator dispatch, wrapper outlet promotion) read
   * `RunResult.outputs` directly; without this they would treat a closed
   * branch's REASON text as ordinary port data.
   */
  inactiveOutputs?: string[]
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
  /** The exact user prompt sent to opencode. RFC-311 T21: 正文落在
   *  `runs/{taskId}/prompts/{nodeRunId}.md`,行里只留路径(读点走
   *  services/nodeRunPrompt.ts 的双读)。 */
  prompt: string
  /**
   * RFC-193: repo0-relative source paths of the validated path-shaped port
   * files this run emitted. The scheduler unions these into the node's final
   * snapshot force-include roster (gitignored port files must still reach the
   * scope canonical — K1 必达, design §4.5). Absent when no path ports.
   */
  portFilePaths?: string[]
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
  // RFC-200: this persisted value is the single source for BOTH prompt emit
  // and stdout parse. Empty means a pre-upgrade in-flight row and preserves
  // the historical bare-envelope protocol byte-for-byte.
  const envelopeNonce = await loadRunEnvelopeNonce(opts.db, opts.nodeRunId)

  // RFC-111 D15: the runtime is frozen by the dispatcher into node_runs.runtime
  // and threaded here. opencode is the default and its spawn/pump path is
  // byte-identical to pre-RFC-111; claude-code branches at the spawn site below.
  // The stdout pump is runtime-agnostic (driver.parseEvent normalizes events).
  const runtime: RuntimeKind = opts.runtime ?? 'opencode'
  const driver = getRuntimeDriver(runtime)
  const persistRunnerWrite = async <T>(
    operation: string,
    write: () => T | Promise<T>,
  ): Promise<T> => {
    try {
      return await retrySqliteWrite(write, {
        onRetry: (retry) => {
          log.warn('sqlite-write-retry', {
            nodeRunId: opts.nodeRunId,
            runtime,
            operation,
            ...retry,
          })
        },
      })
    } catch (error) {
      // managedProcess retains Error.message only. Put the operation and SQLite
      // code into that bounded hand-off; runner masks/caps it before logging or
      // persisting, and the original stays attached for direct callers.
      throw new Error(`${operation}: ${sqliteWriteDiagnostic(error)}`, { cause: error })
    }
  }

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
      isSandbox: r.isSandbox,
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
  // RFC-183: the clarify projections come from the SAME exhaustive
  // disposition classifier the prompt renderer consumes, so what the prompt
  // invites and what this parse layer accepts can never drift apart.
  const followupMode = opts.promptMode?.kind === 'followup' ? opts.promptMode : undefined
  const channel = opts.clarifyChannel ?? { kind: 'none' as const }
  const clarifyWired = channel.kind !== 'none'
  const clarifyDisposition = clarifyWired ? clarifyDispositionFor(channel.directive) : undefined
  const clarifyMandatory = clarifyDisposition === 'invite-mandatory'
  // RFC-165 (F12): optional trips NEITHER enforcement gate below; it only
  // keeps the clarify option alive in envelope-followup (error-correction)
  // rounds so the agent can still pick either envelope after a malformed
  // reply.
  const clarifyOptional = clarifyDisposition === 'invite-optional'
  // RFC-123 (stopped) + RFC-183 (suppressed re-production rounds): both
  // reject a disobedient <workflow-clarify>; only the message flavor differs.
  const clarifyRejectDirective = clarifyDisposition === 'reject'
  // RFC-297 T13：这是一条业务事实（agent 类节点 + 未复用会话），不是「谁想要清单」。
  const freshAgentRun = isAgentNodeKind(inventoryNodeKind) && followupMode === undefined

  // RFC-041 PR3: silent inject of approved memories into the primary agent's
  // inline prompt. Best-effort — a broken memory table degrades to "no
  // inject", never to a failed run. The envelope-followup path does not read
  // LIVE memories; it reconstructs the original block from the first
  // attempt's snapshot. That block stays in the AGENT config while the USER
  // prompt remains the short RFC-042 nudge.
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
        envelopeNonce,
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
        // RFC-317 T39（CC-13）—— 这一支重建的是**历史 node_run** 的 persona 片段，
        // pre-RFC-200 的行没有 nonce，必须逐字复刻当年的拼法；用具名转换器把
        // 「空 nonce ⇒ 不加围栏」这个判断显式化，而不是靠公共函数的默认参数继承。
        injectedMemoryBlock = formatMemoryBlockFromSnapshot(
          injectedSnapshot,
          memoryFencingForNonce(envelopeNonce),
        )
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
    withTaskExecutionMutation({
      db: opts.db,
      taskId: opts.taskId,
      run: (tx) =>
        tx
          .update(nodeRuns)
          .set({
            injectedMemoriesJson:
              injectedSnapshot === null ? null : JSON.stringify(injectedSnapshot),
          })
          .where(eq(nodeRuns.id, opts.nodeRunId))
          .run(),
    })
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
          envelopeNonce,
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
          // RFC-306: on a branch-marker rejection, tell the agent which ports
          // ARE branch ports. That is the actionable half — the offending name
          // it already knows (it just wrote it), the legal set it evidently did
          // not. Derived here from the agent's own declaration rather than from
          // the prior attempt's errorMessage: machine reads of errorMessage are
          // forbidden (RFC-145 source guard), and this is available for free.
          ...(followupMode.reason === 'branch-marker'
            ? {
                branchMarkerDetail:
                  (opts.agent.branchPorts ?? []).length > 0
                    ? `Declared branch ports on this agent: ${(opts.agent.branchPorts ?? [])
                        .map((p) => `\`${p}\``)
                        .join(', ')}.`
                    : 'This agent declares NO branch ports, so no port of it may be marked inactive.',
              }
            : {}),
        })
      : renderUserPrompt({
          promptTemplate: opts.promptTemplate,
          triggerContext: opts.triggerContext ?? null,
          ...(opts.expandPromptTemplate !== undefined
            ? { expandPromptTemplate: opts.expandPromptTemplate }
            : {}),
          inputs: opts.inputs,
          meta: opts.templateMeta,
          agentOutputs: opts.agent.outputs,
          envelopeNonce,
          hasExternalUntrustedInput:
            envelopeNonce.length > 0 && injectedMemoryBlock?.includes('<aw-input ') === true,
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
          // RFC-306: the branch-port paragraph. Same unconditional pass-through
          // as outputKinds above — the runner and the editor's PromptPreview must
          // show the agent the same contract, or authors debug a prompt that
          // isn't the one being sent.
          ...(opts.agent.branchPorts !== undefined
            ? { agentBranchPorts: opts.agent.branchPorts }
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
          // RFC-313: 会话升级后的告知。只可能出现在这条完整 prompt 路径上——
          // followup 分支在上面的三元里，两者天然互斥。
          ...(opts.priorSessionAbandonedReason !== undefined
            ? { priorSessionAbandoned: { reason: opts.priorSessionAbandonedReason } }
            : {}),
        })

  // Write the prompt FIRST (no status change). RFC-053: the status flip
  // pending → running goes through transitionNodeRunStatus below.
  // RFC-311 T21:正文外置到 `runs/{taskId}/{nodeRunId}/prompt.md`,行里只留路径
  // (prompt_text 平均 ~6KB、占 node_runs 表 57%,而它只在详情页/会话视图被读)。
  // 落盘失败会回落成写列——prompt 是执行事实,宁可行胖也不能丢。
  // rfc053-allow-direct-status-write -- writing non-status field
  withTaskExecutionMutation({
    db: opts.db,
    taskId: opts.taskId,
    run: (tx) =>
      tx
        .update(nodeRuns)
        .set(storeNodeRunPrompt(opts.taskId, opts.nodeRunId, prompt, join(opts.appHome, 'runs')))
        .where(eq(nodeRuns.id, opts.nodeRunId))
        .run(),
  })
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

  let effectiveResumeSessionId =
    opts.promptMode?.kind === 'followup' ? opts.promptMode.resumeSessionId : opts.resumeSessionId
  const runtimeLeaseNonceDigest = sha256Hex(randomBytes(32))
  let runtimeLeaseToken: RuntimeSessionLeaseToken | undefined
  let runtimeLeaseInvalidatedByReset = false
  const releaseHeldRuntimeLease = (): void => {
    if (runtimeLeaseToken === undefined) return
    const released = runtimeLeaseInvalidatedByReset
      ? discardRuntimeSessionLease(opts.db, runtimeLeaseToken)
      : releaseRuntimeSessionLease(opts.db, runtimeLeaseToken)
    if (!released) {
      log.warn('runtime-session-lease-release-cas-missed', {
        nodeRunId: opts.nodeRunId,
        sessionId: runtimeLeaseToken.sessionId,
      })
    }
    runtimeLeaseToken = undefined
    runtimeLeaseInvalidatedByReset = false
  }

  if (effectiveResumeSessionId !== undefined && effectiveResumeSessionId !== '') {
    const requestedResumeSessionId = effectiveResumeSessionId
    const owner = getRuntimeSessionLease(opts.db, runtime, requestedResumeSessionId)
    if (owner === undefined) {
      // Rows from before the natural-runtime cutover deliberately have no
      // neutral owner. Start a fresh native session and leave a durable,
      // human-readable reset event instead of pretending resume succeeded.
      try {
        await persistRunnerWrite('node-run-event/session-reset', () =>
          withTaskExecutionMutation({
            db: opts.db,
            taskId: opts.taskId,
            run: (tx) =>
              tx
                .insert(nodeRunEvents)
                .values({
                  nodeRunId: opts.nodeRunId,
                  ts: Date.now(),
                  kind: 'text',
                  payload: JSON.stringify({
                    code: 'runtime-session-reset',
                    previousSessionUnavailable: true,
                  }),
                })
                .run(),
          }),
        )
      } catch (error) {
        const detail = maskDiagnosticsText(
          error instanceof Error ? error.message : sqliteWriteDiagnostic(error),
        ).slice(0, 2000)
        const errorMessage = `runtime-session-reset-persistence-failed: ${detail}`
        log.warn('runtime-session-reset-persistence-failed', {
          nodeRunId: opts.nodeRunId,
          runtime,
          err: detail,
        })
        try {
          await setNodeRunStatus({
            db: opts.db,
            nodeRunId: opts.nodeRunId,
            to: 'failed',
            allowedFrom: ['running'],
            reason: 'runtime-session-reset-persistence-failed',
            extra: { finishedAt: Date.now(), errorMessage },
          })
        } catch (statusError) {
          log.warn('runtime-session-reset-failure-status-persist-failed', {
            nodeRunId: opts.nodeRunId,
            err: maskDiagnosticsText(sqliteWriteDiagnostic(statusError)).slice(0, 2000),
          })
        }
        return {
          status: 'failed',
          exitCode: null,
          outputs: {},
          tokenUsage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0 },
          prompt,
          errorMessage,
        }
      }
      effectiveResumeSessionId = undefined
    } else {
      try {
        const claimedToken = await persistRunnerWrite('runtime-session-lease/preclaim', () =>
          preclaimRuntimeSessionResume(opts.db, {
            protocol: runtime,
            sessionId: requestedResumeSessionId,
            taskId: opts.taskId,
            nodeId: opts.nodeId,
            currentNodeRunId: opts.nodeRunId,
            leaseNonceDigest: runtimeLeaseNonceDigest,
          }),
        )
        runtimeLeaseToken = claimedToken
        if (
          !(await persistRunnerWrite('runtime-session-lease/confirm', () =>
            confirmRuntimeSessionResume(opts.db, claimedToken),
          ))
        ) {
          throw new Error('runtime session could not be linked to the current run')
        }
      } catch (error) {
        releaseHeldRuntimeLease()
        const errorMessage =
          error instanceof Error ? error.message : 'runtime session is already in use'
        await setNodeRunStatus({
          db: opts.db,
          nodeRunId: opts.nodeRunId,
          to: 'failed',
          allowedFrom: ['running'],
          reason: 'runtime-session-conflict',
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
    }
  }

  // 4. Spawn the agent runtime — one kind-blind call (RFC-143 PR-4). The driver
  // owns its runtime's ENTIRE assembly: opencode builds + mutates + serializes
  // the inline config (incl. RFC-029 inventory plugin + RFC-041 memory append)
  // into OPENCODE_CONFIG_CONTENT; claude writes the system-prompt-file, converts
  // MCP/subagents to flags and decides the credential bridge. Everything below
  // (lifecycle / kill / pump / exit) is runtime-agnostic.
  // RFC-281 T1: workspace-boundary mounts = this task's per-repo worktrees
  // (scheduler is source of truth via templateMeta.repos; the runner already
  // forwards them for {{__repos__}}). Single-repo tasks carry a length-1 array
  // whose worktreePath mirrors opts.worktreePath. Empty → fall back to the cwd
  // so the boundary always re-allows at least the working tree.
  // RFC-281: mounts for the workspace boundary (see resolveBoundaryMounts —
  // cwd is always included, whatever the per-repo metadata says).
  const boundaryMounts = resolveBoundaryMounts(
    opts.worktreePath,
    (opts.templateMeta.repos ?? []).map((r) => r.worktreePath),
  )
  const rootProfile = resolvedParamsByAgent.get(opts.agent.name)
  let plan: AgentSpawnPlan
  try {
    // RFC-282 B1b — the unified assembly call: ONE driver invocation returns
    // argv/env/stdin AND the declared manifest (declaration is a by-product of
    // assembly; the old shape computed them twice — runner.ts:946 pre-B1b).
    plan = await driver.buildSpawn({
      injection: {
        mcps: opts.mcps ?? [],
        agent: opts.agent,
        dependents: opts.dependents ?? [],
        plugins: opts.plugins ?? [],
        skills: opts.skills,
        ...(rootProfile !== undefined ? { profile: rootProfile } : {}),
      },
      prompt,
      agentName: opts.agent.name,
      systemPrompt: opts.agent.bodyMd,
      injectedMemoryBlock,
      resolvedParamsByAgent,
      cwd: opts.worktreePath,
      runRoot,
      configDir,
      taskMounts: boundaryMounts,
      freshAgentRun,
      // RFC-148: a followup dispatch carries its session INSIDE the arm
      // (unrepresentable without one); inline clarify resume keeps the
      // top-level field. Exactly one is set per dispatch by the scheduler.
      resumeSessionId: effectiveResumeSessionId,
      runtimeBinary: opts.runtimeBinary,
      ...(opts.binaryOverride !== undefined ? { binaryOverride: opts.binaryOverride } : {}),
      gitUserName: opts.gitUserName,
      gitUserEmail: opts.gitUserEmail,
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
    releaseHeldRuntimeLease()
    await setNodeRunStatus({
      db: opts.db,
      nodeRunId: opts.nodeRunId,
      to: 'failed',
      allowedFrom: ['running', 'pending'],
      reason: 'runtime-spawn-failed',
      extra: {
        finishedAt: Date.now(),
        errorMessage,
      },
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
  // RFC-282 B1b — the declared manifest is a FIELD of the assembly result now
  // (same computation, not a second render). §7-9: a defensive render failure
  // inside the driver degrades it to an empty manifest + warn, never fails
  // the node — matching the old independent try/catch's semantics.
  const injectionDeclared = plan.declared
  // 落差③/④ — referencing a disabled MCP or passing params this runtime
  // drops was fully silent before RFC-280; say it at spawn time too (the
  // persisted record lands at settle).
  if (injectionDeclared.skippedDisabledMcps.length > 0) {
    log.warn('mcp-disabled-skipped', {
      nodeRunId: opts.nodeRunId,
      mcps: injectionDeclared.skippedDisabledMcps,
      detail: 'agent references disabled MCP(s); they are not injected into this run',
    })
  }
  if (injectionDeclared.droppedParams.length > 0) {
    log.warn('runtime-params-dropped', {
      nodeRunId: opts.nodeRunId,
      runtime,
      params: injectionDeclared.droppedParams,
      detail: 'this runtime has no surface for these profile params; they are not applied',
    })
  }
  let planArtifactsCleaned = false
  const finalizePlan = async (): Promise<void> => {
    if (!planArtifactsCleaned) {
      planArtifactsCleaned = true
      try {
        await plan.cleanup?.()
      } catch {
        log.warn('runtime-plan-cleanup-failed', { nodeRunId: opts.nodeRunId, runtime })
      }
      try {
        rmSync(runRoot, { recursive: true, force: true })
      } catch {
        // Best-effort cleanup preserves the historical runner contract.
      }
    }
  }
  // Diagnostic: surface the model/variant/temperature/mcp/plugin facts that
  // actually landed in the driver's spawn assembly (plan.diagnostics, RFC-143
  // §4.4 — same fields the runner used to derive from the inline config). Lets
  // operators tell "scheduler dropped the override on the floor" apart from
  // "the runtime received it but ignored it" without dumping the full config.
  // Names/counts only — never config bodies (env / headers may contain user
  // tokens; docs/OPENCODE_CONFIG.md §6).
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
  //
  // RFC-280 T7: the child's ENTIRE lifecycle (spawn / stdin / pid receipt /
  // timeout+cancel / TERM→KILL→reap / bounded drain) is the unified agent
  // executor's job now (services/execution/agentProcess.ts → managedProcess,
  // the one process-reliability authority). This function keeps only the
  // business layer: event persistence, runtime-lease claiming, envelope
  // parsing, live subagent capture, and final status resolution.
  let preserveLiveRuntimeState = false
  let postSpawnFailed = false
  let processEffect: ProcessEffectAttemptObserver | undefined
  let processSettlement: ProcessSettlement | null = null
  // Survives the outer catch so even a second DB failure while stamping the
  // terminal row cannot erase the durable breadcrumb boot repair uses to
  // discard (rather than neutralize) a contradicted native resume id.
  let nativeSessionIdentityInvalidObserved = false
  // Process-orthogonal cleanup only (live poller / signal listener); the child
  // kill/reap lifecycle is owned by runAgentProcess, not these hooks.
  const spawnedCleanupHooks: Array<() => void> = []
  let aborted = false
  let timedOut = false
  const graceMs = opts.killEscalationGraceMs ?? KILL_ESCALATION_GRACE_MS
  try {
    // 6. Stream stdout + stderr into node_run_events.

    //    `--format json` makes opencode emit one JSON event per line; the
    //    agent's text reply (which carries the <workflow-output> envelope)
    //    is inside the `part.text` field of `text` events. We accumulate
    //    text-event payloads here and parse the envelope from that buffer.
    // RFC — bounded accumulator for the agent's text (the envelope is parsed from
    // this at the end). A runaway/hostile child emitting millions of lines would
    // grow an unbounded `string[]` and OOM the shared daemon. Keep a ROLLING TAIL:
    // the winning <workflow-output> envelope is always the LAST one in the output,
    // so the tail preserves it. Slicing only when the buffer reaches 2× the cap
    // amortizes the copy cost. See design/test-guard-audit-2026-07-21 gap
    // B4-runtime-6 / Top-14.
    let agentTextBuf = ''
    // RFC-310 T132 实撞：子进程非零退出时 errorMessage 只有「<runtime> exited with
    // code N」，stderr 虽然逐行落进 node_run_events，却**不在任何失败回执里**。
    // 于是 windows 那格的 Agent 动作红了整整一天，能拿到的信息只有一个退出码——
    // 没有 stderr 就没有归因，只能靠猜或靠本机复现。这里留一份有界尾巴，只在
    // 退出码非零时拼进 errorMessage（成功路径一个字节都不多带）。
    let stderrTailBuf = ''
    const appendAgentText = (s: string): void => {
      agentTextBuf = appendBoundedTail(agentTextBuf, s, MAX_AGENT_TEXT_CHARS)
    }
    const tokenUsage: RunResult['tokenUsage'] = {
      input: 0,
      output: 0,
      cacheCreate: 0,
      cacheRead: 0,
      total: 0,
    }
    let sessionId: string | undefined
    // Native ids are lookup keys for Claude's per-epoch transcript folders.
    // The logical SessionTree still has one final root, but capture must scan
    // every epoch or a reset can hide subagents that finished before it.
    const nativeSessionEpochIds: string[] = []
    let pendingConversationReset:
      | { outgoingSessionId: string; newConversationId: string }
      | undefined
    let nativeSessionProtocolFailure:
      | {
          reason: string
          eventType: string | null
          eventSubtype: string | null
          hasParentToolUseId: boolean
        }
      | undefined
    // Runtime-reported MCP availability remains useful operator telemetry, but
    // it is not an execution admission oracle.
    const declaredMcpServers = new Set(plan.declaredMcpServers ?? [])
    /** claude's terminal `{type:'result', is_error:true}` message, if any. */
    let terminalResultError: string | undefined
    /** The inventory arrives once, in the runtime's first event. */
    let mcpInventorySeen = false
    /** RFC-280 T3 — the runtime's own startup report (claude init), one-shot. */
    let capturedStartupInventory: StartupInventory | null = null
    /**
     * RFC-297 live parity: init-event runtimes report their inventory while the
     * child is still running. Persist the first report immediately so the
     * runtime-agnostic GET /inventory read end can serve it before settle, just
     * as opencode's RFC-062 live-file fallback already does. A failed eager
     * write stays retryable on a repeated init frame and is non-fatal; step 11
     * remains the authoritative final-write fallback.
     */
    let startupInventoryPersistedLive = false
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
    // RFC-314 D3 —— 事件按 chunk 合并落库。
    //
    // 此前每一行 stdout/stderr 都是一条 autocommit INSERT + 一次重试包装；20 个 agent
    // 并发猛吐时语句数与 -wal 帧数按**行数**线性增长。缓冲的冲刷点是 pump 的 chunk 边界
    // （`managedProcess.pump` 的 `onChunkEnd`）：它在同一个 await 内写完才让出事件循环，
    // pump 的下一次 read 之前一定已落库，所以读点（countAgentTextEvents / 会话租约 retag /
    // WS 回放 / 详情页）**不需要任何 flush 屏障**，也不引入额外的崩溃丢失窗口。
    /** 单条多行 INSERT 的行数上限：6 列 × 100 行 = 600 个绑定参数，低于仓内 900 护栏线
     *  （SQLite 硬上限 32766；归档器曾因无界 IN 撞上它而每小时失败）。 */
    type NodeRunEventInsert = typeof nodeRunEvents.$inferInsert
    const EVENT_INSERT_MAX_ROWS = 100
    const makeEventBuffer = (
      operation: string,
    ): { push: (row: NodeRunEventInsert) => void; flush: () => Promise<void> } => {
      const rows: NodeRunEventInsert[] = []
      return {
        push: (row) => {
          rows.push(row)
        },
        flush: async () => {
          if (rows.length === 0) return
          // splice 之前没有 await：两条流各有自己的缓冲，且这一步对并发的另一条泵是原子的。
          const batch = rows.splice(0, rows.length)
          for (let i = 0; i < batch.length; i += EVENT_INSERT_MAX_ROWS) {
            const slice = batch.slice(i, i + EVENT_INSERT_MAX_ROWS)
            await persistRunnerWrite(operation, () =>
              withTaskExecutionMutation({
                db: opts.db,
                taskId: opts.taskId,
                run: (tx) => tx.insert(nodeRunEvents).values(slice).run(),
              }),
            )
          }
        },
      }
    }
    const stdoutEvents = makeEventBuffer('node-run-event/stdout')
    const stderrEvents = makeEventBuffer('node-run-event/stderr')
    /** 抛错前把已缓冲的取证事件写下去——它们恰恰在失败时最重要。冲刷本身再失败也不能
     *  盖住原始错误（那才是这次运行失败的原因）。 */
    const flushEventsBeforeThrow = async (): Promise<void> => {
      try {
        await stdoutEvents.flush()
        await stderrEvents.flush()
      } catch (flushError) {
        log.warn('node-run-event-flush-failed', {
          nodeRunId: opts.nodeRunId,
          err: flushError instanceof Error ? flushError.message : String(flushError),
        })
      }
    }

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

    /**
     * RFC-297 T11/T12 —— 观测消费收敛到**事件载荷**这一个来源。
     *
     * 此前这里是两块各自再解析一遍原始行的 if：`parseUnusableMcpServers` 与
     * `parseStartupInventory`，加上下面的 `parseEvent`，同一行 init 被
     * `JSON.parse` 三次、被判 `type==='system' && subtype==='init'` 三次。现在
     * driver 在那一次解析里就把四个面挂进 `data.inventory`，这里只消费。
     *
     * 一次性语义保持不变：清单只认第一份（运行时在 init 处冻结 MCP 可用性，
     * RFC-242 §4.4）。
     */
    const consumeInventoryPayload = async (event: NormalizedEvent): Promise<void> => {
      const faces = event.data?.inventory?.faces
      if (faces === undefined) return
      if (capturedStartupInventory === null) {
        capturedStartupInventory = {
          ...(faces.tools === undefined ? {} : { tools: faces.tools.map((t) => t.key) }),
          ...(faces.agents === undefined ? {} : { agents: faces.agents.map((a) => a.key) }),
          ...(faces.skills === undefined ? {} : { skills: faces.skills.map((s) => s.key) }),
          ...(faces.mcps === undefined
            ? {}
            : { mcpServers: faces.mcps.map((m) => ({ name: m.key, status: m.status ?? '' })) }),
        }
      }
      // The capability, not a runtime-name branch, identifies observations that
      // arrive during stdout streaming. Persist only after the first complete
      // capture; duplicate Claude init frames are common around async agents.
      if (
        !startupInventoryPersistedLive &&
        driver.capabilities.startupObservation === 'init-event'
      ) {
        const runtimeInventoryJson = JSON.stringify(
          buildRuntimeInventoryObservation({
            capabilities: driver.capabilities,
            freshRun: freshAgentRun,
            declared: injectionDeclared,
            claudeInit: capturedStartupInventory,
            snapshot: null,
            now: event.timestamp ?? Date.now(),
          }),
        )
        try {
          await persistRunnerWrite('runtime-inventory/eager', () =>
            withTaskExecutionMutation({
              db: opts.db,
              taskId: opts.taskId,
              run: (tx) =>
                tx
                  .update(nodeRuns)
                  .set({ runtimeInventoryJson })
                  .where(eq(nodeRuns.id, opts.nodeRunId))
                  .run(),
            }),
          )
          startupInventoryPersistedLive = true
        } catch (err) {
          log.warn('runtime-inventory-eager-write-failed', {
            nodeRunId: opts.nodeRunId,
            runtime,
            err: maskDiagnosticsText(err instanceof Error ? err.message : String(err)).slice(
              0,
              2000,
            ),
          })
        }
      }
      if (declaredMcpServers.size === 0 || mcpInventorySeen || faces.mcps === undefined) return
      mcpInventorySeen = true
      // 运行时报告的 MCP 可用性仍是运维遥测，不是执行准入判据（RFC-242 原语义）。
      const declaredUnusable = faces.mcps
        .filter((m) => m.status !== 'connected' && declaredMcpServers.has(m.key))
        .map((m) => m.key)
        .sort()
      if (declaredUnusable.length > 0) {
        log.warn('runtime-declared-mcp-unusable', {
          nodeRunId: opts.nodeRunId,
          servers: declaredUnusable,
          detail: 'injected MCP server(s) did not come up; the node runs without their tools',
        })
      }
    }

    const onStdoutLine = async (line: string): Promise<void> => {
      // RFC-314 D3：任一行的解析/租约写入抛错时，先把本 chunk 已缓冲的取证事件落库
      // 再抛——它们恰恰在失败时最重要（去掉这层，「第 k 行抛错时前 k-1 行已落库」
      // 那条用例立刻转红）。
      try {
        await onStdoutLineInner(line)
      } catch (error) {
        await flushEventsBeforeThrow()
        throw error
      }
    }
    const onStdoutLineInner = async (line: string): Promise<void> => {
      // RFC-111 PR-A/B: normalize one stdout line through the frozen runtime's
      // driver. `parseEvent` returns null for non-JSON / falsy-JSON lines, which
      // routes them through the raw-text fallback exactly as the old inline
      // opencode `if (evt) {...} else {...}` selection did.
      // 2026-08-04 audit: claude's TERMINAL result carries `is_error: true` on a
      // clean exit 0 — auth failure, subscription/usage limit, a gateway error
      // from a fork. The driver has parsed that since RFC-242, but only
      // `systemAgentRun` ever called it, so on the BUSINESS path those runs
      // surfaced as `envelope-missing` ("the agent produced no output
      // envelope") AFTER burning the node's whole retry budget. Same disease as
      // the 2026-08-04 incident's "swallowed into a bare nonce missing", which
      // was fixed on the smoke path only.
      const resultError = driver.parseTerminalResultError?.(line)
      if (resultError !== undefined && resultError !== null && terminalResultError === undefined) {
        terminalResultError = resultError
      }
      const ev = driver.parseEvent(line)
      if (ev) {
        await consumeInventoryPayload(ev)
        try {
          if (ev.sessionId !== undefined) {
            if (sessionId === undefined) {
              const nativeSessionId = ev.sessionId
              sessionId = nativeSessionId
              if (runtimeLeaseToken === undefined) {
                runtimeLeaseToken = await persistRunnerWrite('runtime-session-lease/claim', () =>
                  claimNewRuntimeSession(opts.db, {
                    protocol: runtime,
                    sessionId: nativeSessionId,
                    taskId: opts.taskId,
                    nodeId: opts.nodeId,
                    currentNodeRunId: opts.nodeRunId,
                    leaseNonceDigest: runtimeLeaseNonceDigest,
                  }),
                )
              } else if (runtimeLeaseToken.sessionId !== sessionId) {
                throw new Error('runtime returned a different native session id')
              }
              nativeSessionEpochIds.push(nativeSessionId)
            } else if (sessionId !== ev.sessionId) {
              if (pendingConversationReset === undefined) {
                throw new Error('runtime changed native session id without a conversation reset')
              }
              if (
                pendingConversationReset.outgoingSessionId !== sessionId ||
                runtimeLeaseToken === undefined ||
                runtimeLeaseToken.sessionId !== sessionId
              ) {
                throw new Error('runtime conversation reset did not match the held native session')
              }
              const heldLease = runtimeLeaseToken
              const nextSessionId = ev.sessionId
              // RFC-314 D3 —— **顺序屏障**：`rotateRuntimeSessionLease` 会把该 run 已落库
              // 的旧 epoch 事件回标到新 sessionId（`runtimeSessionLease.ts` 的两条 UPDATE）。
              // 本 chunk 里还躺在缓冲区的行如果晚于它落库，就会带着旧 sessionId 落在一个
              // 孤儿桶里——正是那条回标要消灭的形态。所以先冲刷再轮换。
              await stdoutEvents.flush()
              runtimeLeaseToken = await persistRunnerWrite('runtime-session-lease/rotate', () =>
                rotateRuntimeSessionLease(opts.db, heldLease, nextSessionId),
              )
              runtimeLeaseInvalidatedByReset = false
              sessionId = nextSessionId
              nativeSessionEpochIds.push(nextSessionId)
              pendingConversationReset = undefined
            }
          }
          if (ev.conversationReset !== undefined) {
            if (
              sessionId === undefined ||
              ev.conversationReset.outgoingSessionId !== sessionId ||
              pendingConversationReset !== undefined
            ) {
              throw new Error('runtime reported an invalid conversation reset boundary')
            }
            pendingConversationReset = ev.conversationReset
            const heldLease = runtimeLeaseToken
            if (
              heldLease === undefined ||
              !(await persistRunnerWrite('runtime-session-lease/reset-pending', () =>
                markRuntimeSessionResetPending(opts.db, heldLease),
              ))
            ) {
              throw new Error('runtime conversation reset could not invalidate the old resume id')
            }
            runtimeLeaseInvalidatedByReset = true
          }
        } catch (error) {
          let eventType: string | null = null
          let eventSubtype: string | null = null
          let hasParentToolUseId = false
          try {
            const frame = JSON.parse(ev.rawLine) as Record<string, unknown>
            eventType = typeof frame.type === 'string' ? frame.type : null
            eventSubtype = typeof frame.subtype === 'string' ? frame.subtype : null
            hasParentToolUseId =
              typeof frame.parent_tool_use_id === 'string' && frame.parent_tool_use_id.length > 0
          } catch {
            // parseEvent already recognized the frame; metadata is best effort.
          }
          nativeSessionProtocolFailure = {
            reason: error instanceof Error ? error.message : String(error),
            eventType,
            eventSubtype,
            hasParentToolUseId,
          }
          nativeSessionIdentityInvalidObserved = true
          // Once a root identity contradiction is observed, the previously
          // held native id is no longer safe to advertise for resume. Fence it
          // durably before the pump aborts; normal reaping then discards it.
          const heldLease = runtimeLeaseToken
          if (heldLease !== undefined && !runtimeLeaseInvalidatedByReset) {
            // The in-memory verdict must not depend on the first fencing write:
            // after the child is reaped, discard performs a second transactional
            // clear+delete even if this best-effort early fence failed.
            runtimeLeaseInvalidatedByReset = true
            try {
              await persistRunnerWrite('runtime-session-lease/protocol-invalid', () =>
                markRuntimeSessionResetPending(opts.db, heldLease),
              )
            } catch (fenceError) {
              log.warn('runtime-session-protocol-fence-failed', {
                nodeRunId: opts.nodeRunId,
                err: maskDiagnosticsText(
                  fenceError instanceof Error ? fenceError.message : String(fenceError),
                ).slice(0, 2000),
              })
            }
          }
          throw error
        }
        if (ev.tokens) {
          tokenUsage.input += ev.tokens.input
          tokenUsage.output += ev.tokens.output
          tokenUsage.cacheCreate += ev.tokens.cacheCreate
          tokenUsage.cacheRead += ev.tokens.cacheRead
          tokenUsage.total =
            tokenUsage.input + tokenUsage.output + tokenUsage.cacheCreate + tokenUsage.cacheRead
        }
        if (typeof ev.text === 'string') appendAgentText(ev.text)
        const ts = ev.timestamp ?? Date.now()
        // RFC-027: tag every stdout-derived row with the (root) sessionID +
        // parent_session_id=null so the SessionTab parser can bucket parent
        // events against post-run captured child events without ambiguity.
        const evtSessionId = ev.sessionId ?? sessionId ?? null
        // RFC-297 T5: `startup_inventory` 只由 `drainFinalEvents()` 铸造，任何
        // stdout 行都解析不出它，而 `node_run_events.kind` 的 enum 里也没有它。
        // 读进局部常量是必要的：`kind` 是可变属性，窄化跨不进下面的延迟回调。
        const persistedKind: PersistedEventKind = ev.kind === 'startup_inventory' ? 'text' : ev.kind
        stdoutEvents.push({
          nodeRunId: opts.nodeRunId,
          ts,
          kind: persistedKind,
          payload: ev.rawLine,
          sessionId: evtSessionId,
          parentSessionId: null,
        })
        broadcastParentRunning()
      } else {
        // Non-JSON stdout lines shouldn't happen with --format json, but record
        // them as kind=text for debugging.
        stdoutEvents.push({
          nodeRunId: opts.nodeRunId,
          ts: Date.now(),
          kind: 'text',
          payload: line,
        })
        appendAgentText(line)
        broadcastParentRunning()
      }
    }

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
    spawnedCleanupHooks.push(() => liveCtrl.abort())
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
    spawnedCleanupHooks.push(() => livePoller.stop())
    // A one-shot binding so onStderrLine can reference it before its decl below.

    const persistStderrLine = async (line: string): Promise<void> => {
      stderrTailBuf = appendBoundedTail(stderrTailBuf, clampTailLine(line), MAX_STDERR_TAIL_CHARS)
      stderrEvents.push({
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
        await persistRunnerWrite('node-run-event/plugin-load-failed', () =>
          withTaskExecutionMutation({
            db: opts.db,
            taskId: opts.taskId,
            run: (tx) =>
              tx
                .insert(nodeRunEvents)
                .values({
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
                .run(),
          }),
        )
      }
    }

    // 7. Run the child through the unified executor (RFC-280 T7). It owns
    //    spawn / stdin / pid receipt / timeout+cancel / TERM→KILL→reap / bounded
    //    drain — the rfc098 process-governance invariants live in managedProcess
    //    now. Two post-exit outcomes matter here: a descendant holding our pipe
    //    past the DRAIN deadline degrades to evidence loss on a finished run
    //    (real exitCode kept, `drainTimedOut`); a child that survives SIGKILL
    //    past the REAP deadline comes back `unreaped` (→ childUnkillable below).
    const gitControlBefore =
      opts.gitMutationPolicy === 'read-only'
        ? await captureGitControlSnapshot(opts.worktreePath)
        : undefined
    processEffect = createProcessEffectAttemptObserver({
      db: opts.db,
      taskId: opts.taskId,
      nodeRunId: opts.nodeRunId,
      processKind: 'agent',
      argv: cmd,
      cwd: opts.worktreePath,
      // Read-only executions keep their existing concurrency. Writer agents
      // additionally fence the exact isolation/workspace path, never the task.
      resourceKeys:
        opts.gitMutationPolicy === 'read-only' ? [] : [`workspace:${sha256Hex(opts.worktreePath)}`],
    })
    const activeProcessEffect = processEffect
    const runResult = await runAgentProcess({
      cmd,
      cwd: opts.worktreePath,
      env,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      termGraceMs: graceMs,
      ...(opts.signal !== undefined ? { abortSignal: opts.signal } : {}),
      ...(plan.stdin?.mode === 'pipe' ? { stdin: plan.stdin } : {}),
      ...(activeProcessEffect === undefined
        ? {}
        : { beforeSpawn: () => activeProcessEffect.beforeSpawn() }),
      requireSpawnReceipt: true,
      onSpawned: async (receipt: {
        pid: number
        spawnedAt: number
        spawnBinaryPath: string
        launchNonce?: string
      }) => {
        // RFC-108 T9 (AR-14): persist the spawned binary path (cmd[0]) alongside
        // pid so the stale-process reaper can match a live pid against THIS
        // specific binary, not a fuzzy regex.
        //
        const persist = (tx: DbTxSync | DbClient) =>
          tx
            .update(nodeRuns)
            .set({
              pid: receipt.pid,
              spawnBinaryPath: receipt.spawnBinaryPath,
              spawnLaunchNonce: receipt.launchNonce ?? null,
            })
            .where(eq(nodeRuns.id, opts.nodeRunId))
            .run()
        if (activeProcessEffect === undefined) {
          withTaskExecutionMutation({
            db: opts.db,
            taskId: opts.taskId,
            run: persist,
          })
        } else {
          activeProcessEffect.recordSpawnReceipt(receipt, persist)
        }
      },
      capture: {
        onStdoutLine: async (line: string) => {
          await onStdoutLine(line)
        },
        // RFC-314 D3：一个 chunk 的行投递完 ⇒ 合并成一条多行 INSERT 落库。
        onStdoutChunkEnd: () => stdoutEvents.flush(),
        onStderrChunkEnd: () => stderrEvents.flush(),
        // impl-gate P2-B: the OLD runner applied settlePump to BOTH streams —
        // a stderr-persist failure was also a stream failure. persistStderrLine
        // can throw (the synthetic plugin-load-failed row insert); the executor
        // records it as `pumpError` (consulted below), restoring symmetry.
        onStderrLine: persistStderrLine,
      },
      log,
    })
    processSettlement = runResult
    // RFC-314 D3：取消 / kill 时 pump 走的是 `cancel()` 而不是 EOF，最后一批缓冲拿不到
    // chunk-end。这里兜底冲刷，且必须在任何读事件的下游逻辑（信封解析 / 计数 / 广播）
    // 之前。
    await stdoutEvents.flush()
    await stderrEvents.flush()
    let gitMutationViolation: string | undefined
    if (gitControlBefore !== undefined && runResult.outcome !== 'unreaped') {
      const gitControlAfter = await captureGitControlSnapshot(opts.worktreePath)
      const changedFields = changedGitControlFields(gitControlBefore, gitControlAfter)
      if (changedFields.length > 0) {
        gitMutationViolation = `changed Git control fields: ${changedFields.join(', ')}`
        log.warn('agent-git-mutation-forbidden', {
          nodeRunId: opts.nodeRunId,
          taskId: opts.taskId,
          changedFields,
        })
      }
    }
    const spawnedPid = runResult.pid
    const childUnkillable = runResult.outcome === 'unreaped'
    const spawnFailed = runResult.outcome === 'spawn-failed'
    aborted = runResult.outcome === 'aborted'
    timedOut = runResult.outcome === 'timeout'
    const exitCode = runResult.exitCode
    // RFC-284 T14（D9）：有界 post-exit drain 超时 = 完成 run 上的证据丢失
    // （exitCode 本身可信）。结构化告警 + 随 startup_verification_json 附加
    // 观测字段（下方 record 组装处），envelope 解析失败文案加前缀提示根因。
    const outputTailTruncated = runResult.drainTimedOut === true
    if (outputTailTruncated) {
      log.warn('runtime-output-tail-truncated', {
        nodeRunId: opts.nodeRunId,
        taskId: opts.taskId,
        exitCode,
      })
    }
    preserveLiveRuntimeState = childUnkillable
    // A line callback can fail while parsing runtime output, claiming a native
    // session, or persisting stdout/stderr. managedProcess deliberately catches
    // that rejection so it can TERM→KILL→reap the child instead of throwing out
    // of the drain race. Preserve that lifecycle, but do not repeat the old
    // settlePump bug of reducing the exception to a boolean: retain a masked,
    // bounded reason in both daemon logs and the durable node error.
    let streamPumpError =
      runResult.pumpError === undefined
        ? undefined
        : maskDiagnosticsText(runResult.pumpError).slice(0, 2000)
    if (streamPumpError === undefined && pendingConversationReset !== undefined) {
      streamPumpError =
        'runtime ended before reporting the replacement native session id after conversation reset'
    }
    if (streamPumpError !== undefined) {
      log.warn('runtime-stream-pump-failed', {
        nodeRunId: opts.nodeRunId,
        runtime,
        err: streamPumpError,
        ...(nativeSessionProtocolFailure === undefined ? {} : { nativeSessionProtocolFailure }),
      })
    }
    // RFC-048: stop the live poller before the post-run BFS so no concurrent
    // SELECT races against the final captureChildSessions read.
    liveCtrl.abort()
    livePoller.stop()
    if (spawnFailed) {
      // RFC-111 (Codex impl-gate P1-2): a missing / unspawnable runtime binary.
      // Mark the node failed cleanly; the executor already reaped nothing (no
      // child) and the plan temp dir is cleaned by the finally.
      const errorMessage = `spawn ${runtime} failed: ${runResult.spawnError ?? 'unknown spawn failure'}`
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
    if (childUnkillable) {
      log.error('child survived SIGKILL escalation past reap deadline; abandoning', {
        nodeRunId: opts.nodeRunId,
        pid: spawnedPid,
        deadlineMs: graceMs + FINAL_REAP_MARGIN_MS,
      })
    }

    if (!childUnkillable && sessionId !== undefined) {
      for (const epochSessionId of [...new Set(nativeSessionEpochIds)]) {
        try {
          await driver.captureSessions({
            rootSessionId: epochSessionId,
            logicalRootSessionId: sessionId,
            nodeRunId: opts.nodeRunId,
            taskId: opts.taskId,
            db: opts.db,
            log,
            worktreePath: opts.worktreePath,
            configDirEnv: configDir.env,
            configDirName: configDir.name,
            alreadyInsertedPartIds: livePoller.stats().insertedPartIdsBySession,
          })
        } catch (err) {
          log.warn('subagent-capture-unhandled', {
            nodeRunId: opts.nodeRunId,
            rootSessionId: epochSessionId,
            err: err instanceof Error ? err.message : String(err),
          })
        }
      }
      const supersededEpochIds = nativeSessionEpochIds.filter((id) => id !== sessionId)
      if (supersededEpochIds.length > 0) {
        await persistRunnerWrite('node-run-event/session-epoch-retag', () =>
          withTaskExecutionMutation({
            db: opts.db,
            taskId: opts.taskId,
            run: (tx) => {
              tx.update(nodeRunEvents)
                .set({ sessionId })
                .where(
                  and(
                    eq(nodeRunEvents.nodeRunId, opts.nodeRunId),
                    inArray(nodeRunEvents.sessionId, supersededEpochIds),
                    isNull(nodeRunEvents.parentSessionId),
                  ),
                )
                .run()
              tx.update(nodeRunEvents)
                .set({ parentSessionId: sessionId })
                .where(
                  and(
                    eq(nodeRunEvents.nodeRunId, opts.nodeRunId),
                    inArray(nodeRunEvents.parentSessionId, supersededEpochIds),
                  ),
                )
                .run()
            },
          }),
        )
      }
    }

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
    // RFC-193: repo0-relative source paths of every validated path-shaped port
    // file — the force-include roster the scheduler feeds into merge-back
    // snapshots (K1 必达).
    const portFilePaths: string[] = []
    if (childUnkillable) {
      // RFC-098 WP-8: overrides aborted/timedOut — the operator needs the pid
      // to clean up by hand, and a 'canceled' status would read as a clean stop.
      status = 'failed'
      if (nativeSessionProtocolFailure !== undefined) {
        failureCode = 'runtime-session-identity-invalid'
      }
      errorMessage = `child-unkillable: pid ${spawnedPid} survived SIGTERM→SIGKILL escalation past ${graceMs + FINAL_REAP_MARGIN_MS}ms; abandoned (detached process group left running)`
    } else if (gitMutationViolation !== undefined) {
      status = 'failed'
      errorMessage = `agent-git-mutation-forbidden: ${gitMutationViolation}`
    } else if (terminalResultError !== undefined) {
      // The runtime told us WHY it stopped. Report that instead of the generic
      // "no envelope", and treat it as permanent: auth / quota / gateway
      // rejections do not become true by retrying, and the old path burned the
      // full retry budget on every one of them.
      status = 'failed'
      failureCode = 'runtime-result-error'
      errorMessage = `runtime-result-error: ${maskDiagnosticsText(terminalResultError).slice(0, 2000)}`
    } else if (streamPumpError !== undefined) {
      status = 'failed'
      failureCode =
        nativeSessionProtocolFailure === undefined
          ? 'runtime-stream-interrupted'
          : 'runtime-session-identity-invalid'
      errorMessage = `${runtime} stream handling failed: ${streamPumpError}`
    } else if (aborted) {
      // RFC-202 T4: a daemon-shutdown abort must NOT read as a user cancel.
      // RunResult keeps status='canceled' (control flow: loop break / runScope
      // canceled propagation stay untouched); the PERSISTED row branches below
      // to 'interrupted' so resume's rollback-target selection (failed /
      // interrupted only) rolls this node back before re-running it.
      status = 'canceled'
      errorMessage =
        opts.signal?.reason === DAEMON_SHUTDOWN_ABORT_REASON
          ? 'daemon-shutdown: node interrupted mid-run; resume re-runs it from its pre-run snapshot'
          : 'aborted by signal'
    } else if (timedOut) {
      status = 'failed'
      errorMessage = `node-timeout: exceeded ${opts.timeoutMs ?? 0}ms`
    } else if (exitCode !== 0) {
      status = 'failed'
      // RFC-111 P3: name the actual runtime. RFC-310 T132: 附上 stderr 尾巴——
      // 一个裸退出码是不可归因的，而这条消息往往是操作者与上层（如
      // development-automation 的 blockDetail）唯一能看到的东西。
      const stderrTail = stderrTailBuf.trim()
      errorMessage =
        stderrTail.length === 0
          ? `${runtime} exited with code ${exitCode}`
          : `${runtime} exited with code ${exitCode}; stderr tail: ${stderrTail}`
    } else {
      status = 'done'
    }

    // 9. Parse envelope on clean exit. RFC-023 splits this into a kind probe
    //    first so we can branch between the legacy <workflow-output> path,
    //    the new <workflow-clarify> path, and the exclusive-or hard rejects
    //    (both / neither). detectEnvelopeKind is the single source of truth
    //    for which form the reply took.
    let outputs: Record<string, string> = {}
    // RFC-306: names of ports the agent closed this round (see RunResult).
    let inactiveOutputs: string[] = []
    let clarifyResult:
      | { questions: ClarifyQuestion[]; truncationWarnings: ClarifyTruncationWarning[] }
      | undefined
    if (status === 'done') {
      const accumulatedText = agentTextBuf
      const kind = detectEnvelopeKind(accumulatedText, envelopeNonce)
      // RFC-100: while mandatory ask-back is ACTIVE (channel wired AND the user
      // has not clicked "Stop clarifying" — RFC-148: directive === 'mandatory'
      // on the clarify-channel ADT), the ONLY valid reply is a
      // `<workflow-clarify>` envelope. Any `<workflow-output>` / both / neither
      // is a violation: fail with a `clarify-required-*` errorMessage so
      // `decideEnvelopeFollowup` drives a same-session follow-up that re-demands
      // the clarify envelope (and the node hard-fails after retries — there is no
      // output escape hatch). On the stop / suppressed rounds this guard is
      // skipped and the agent finalizes through the normal `<workflow-output>`
      // path below (RFC-183: on those rounds a disobedient <workflow-clarify>
      // is rejected further down — output is the only accepted reply).
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
      } else if (kind === 'clarify' && !clarifyWired) {
        // RFC-183 (Codex design-gate P2#3): a voluntary <workflow-clarify> on a
        // run with NO clarify channel used to parse into a clarifyResult with
        // status='done' and EMPTY outputs. The main dispatch path caught that
        // afterwards in the scheduler (clarify-no-channel), but direct callers
        // that only check result.status — fanout shard children
        // (scheduler.ts dispatchFanoutShard) and aggregators — treated the
        // empty envelope as success and merged worktrees. Front-stop it here.
        // No failureCode on purpose: parity with the scheduler-level rejection
        // (not a followup-able failure); the attempt loop retries, then the
        // node hard-fails.
        status = 'failed'
        errorMessage =
          'clarify-no-channel: agent emitted <workflow-clarify> but this run has no clarify channel; emit <workflow-output>'
      } else if (kind === 'clarify' && channel.kind !== 'none' && clarifyRejectDirective) {
        // RFC-123 (directive 'stopped' — user「强制停止」: canvas toggle='stop' OR a
        // latest answered 'stop' directive) + RFC-183 (directive 'suppressed' —
        // a review reject / iterate re-production round that never invited
        // ask-back): the disposition classifier says this dispatch injected
        // ZERO clarify bytes into the prompt, so a <workflow-clarify> reply is
        // REJECTED — symmetric to the clarify-required output rejection above,
        // and the invite⟺accept symmetry the classifier exists to enforce. No
        // clarifyResult is set (no session), so a stopped/suppressed node can
        // NEVER (re-)open a clarify round through agent disobedience.
        // decideEnvelopeFollowup matches this prefix → same-session follow-up
        // re-demands <workflow-output> (the renderer coerces the reason to
        // 'envelope-missing' while hasClarify=false). Hard fails after retries.
        status = 'failed'
        failureCode = 'clarify-forbidden'
        errorMessage =
          channel.directive === 'stopped'
            ? `${CLARIFY_FORBIDDEN_PREFIX}: node is in STOP CLARIFYING mode; emit <workflow-output>, not <workflow-clarify>`
            : `${CLARIFY_FORBIDDEN_PREFIX}: this re-production round does not accept ask-back; apply the review feedback and emit <workflow-output>, not <workflow-clarify>`
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
        const body = extractClarifyEnvelopeBody(accumulatedText, envelopeNonce)
        // RFC-056: cross-clarify path disables the RFC-023 5-question cap.
        // RFC-148: the cap follows the WIRING family alone. RFC-183 narrows the
        // rounds that reach this parse to the invited dispositions (mandatory /
        // optional) — a suppressed cross rerun is now rejected above before
        // parsing — but the anchor stays the kind: an optional cross round
        // still parses with the lifted cap.
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
        errorMessage = `${outputTailTruncated ? 'output tail truncated; ' : ''}no <workflow-output> envelope found in stdout`
      } else {
        // kind === 'output' — legacy happy path.
        const envelope = extractLastEnvelope(accumulatedText, envelopeNonce)
        // envelope is non-null here because detectEnvelopeKind matched, but
        // guard defensively for type narrowing.
        if (envelope === null) {
          status = 'failed'
          failureCode = 'envelope-missing'
          errorMessage = `${outputTailTruncated ? 'output tail truncated; ' : ''}no <workflow-output> envelope found in stdout`
        } else {
          const parsed = parseEnvelope(envelope, opts.agent.outputs, envelopeNonce)
          outputs = Object.fromEntries(parsed.ports)
          if (parsed.missingDeclared.length > 0 && opts.warnMissingDeclaredPorts !== false) {
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

          // RFC-306 — branch marker admission, BEFORE per-kind validation and
          // before anything is persisted.
          //
          // Two rejections, both deliberately loud:
          //   * an `active` value that is neither true nor false — we refuse to
          //     guess which way the author meant it;
          //   * `active="false"` on a port the agent never declared as a branch
          //     port — the agent believes it closed a branch; treating the port
          //     as active would run that branch anyway, which is the single
          //     worst outcome this feature can produce. Both re-ask in-session
          //     (FOLLOWUP_POLICY) and hard-fail after the retry budget.
          //
          // Ordered AFTER the malformed-port guard on purpose: a corrupted frame
          // makes every marker inside it untrustworthy, so framing wins.
          if (status !== 'failed') {
            const declaredBranch = new Set(opts.agent.branchPorts ?? [])
            const illegal = parsed.inactivePorts.filter((p) => !declaredBranch.has(p))
            if (parsed.badActiveAttr.length > 0) {
              status = 'failed'
              failureCode = 'branch-marker-malformed'
              errorMessage = `${BRANCH_MARKER_MALFORMED_PREFIX}: port(s) ${parsed.badActiveAttr.join(', ')} carry an \`active\` attribute whose value is neither "true" nor "false"`
            } else if (illegal.length > 0) {
              status = 'failed'
              failureCode = 'branch-port-not-declared'
              const declaredList =
                declaredBranch.size > 0
                  ? [...declaredBranch].join(', ')
                  : '(this agent declares no branch ports)'
              errorMessage = `${BRANCH_PORT_NOT_DECLARED_PREFIX}: port(s) ${illegal.join(', ')} marked active="false" but are not declared branch ports; declared branch ports: ${declaredList}`
            }
          }
          inactiveOutputs = parsed.inactivePorts

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
          //
          // RFC-193 D15 两阶段：阶段一纯校验（fail-fast，零磁盘写入——首端口过、
          // 次端口挂时不得留下孤儿归档），顺带收集 path 形端口的 items（handler
          // 校验已读过文件，sourcePath 即 worktree 相对规范路径）；全部通过后
          // 阶段二统一归档 + content 规范化 + INSERT。
          const pathishArchives = new Map<
            string,
            { items: Array<{ sourceAbs: string; sourcePath: string }> }
          >()
          // Registered handlers own the downstream content shape as well as
          // validation. Scalars are normally byte-preserving, list<T>
          // canonicalizes its wire form, and signal deliberately discards any
          // accidental body. Path kinds are normalized after archival below:
          // their persisted value is a relative path, not the file body.
          const normalizedContent = new Map<string, string>()
          if (status === 'done' && outputKinds !== undefined) {
            const inactiveSet = new Set(parsed.inactivePorts)
            for (const [name, content] of parsed.ports) {
              const kind = outputKinds[name]
              if (kind === undefined) continue
              // RFC-306: an inactive port's body is the author's REASON for
              // closing the branch, not a value of the declared kind. Validating
              // it would fail every `path<…>` / `list<…>` branch port for the
              // wrong reason ("no such file"), and archiving it would copy a
              // sentence as if it were an artifact. Skipping both is what makes
              // a branch port free to carry a normal kind while it is open.
              if (inactiveSet.has(name)) continue
              try {
                const resolved = resolvePortContentDetailed({
                  rawContent: content,
                  kind,
                  worktreePath: opts.worktreePath,
                  port: name,
                })
                if (isPathishKindString(kind)) {
                  // 单值 path：detailed 给 sourcePath；list<path<*>>：items 给逐项。
                  const its =
                    resolved.items !== undefined
                      ? resolved.items
                      : resolved.sourcePath !== undefined
                        ? [{ body: resolved.body, sourcePath: resolved.sourcePath }]
                        : []
                  pathishArchives.set(name, {
                    items: its
                      .filter((it) => it.sourcePath !== undefined)
                      .map((it) => ({
                        sourceAbs: join(opts.worktreePath, it.sourcePath!),
                        sourcePath: it.sourcePath!,
                      })),
                  })
                } else {
                  normalizedContent.set(name, resolved.body)
                }
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

          // 阶段二（RFC-193 D1）：全部端口校验通过后归档 path 形端口（字节级
          // copy，节点 iso 仍存活——全生命周期唯一可靠读取窗口），并把 content
          // 规范化为 repo0 相对路径（D6：绝对路径 / './' 前缀不再泄漏下游；容器
          // 相对形态只进 archive_json）。归档写失败 = 环境级故障，fail loud。
          const worktreeDirName = opts.templateMeta.repos?.[0]?.worktreeDirName ?? ''
          const archiveJsonByPort = new Map<string, string>()
          if (
            status === 'done' &&
            pathishArchives.size > 0 &&
            // D14: workgroup host runs persist no node_run_outputs rows, so an
            // archive would have no reference mount point (orphan). Their wg_*
            // protocol ports are text-kinded anyway — this is defensive.
            opts.persistDeclaredOutputs !== false
          ) {
            try {
              for (const [name, arch] of pathishArchives) {
                const res = archivePortArtifacts({
                  appHome: opts.appHome,
                  taskId: opts.taskId,
                  nodeRunId: opts.nodeRunId,
                  portName: name,
                  items: arch.items,
                  worktreeDirName,
                  worktreeRootAbs: opts.worktreePath,
                })
                archiveJsonByPort.set(name, res.archiveJson)
                normalizedContent.set(name, arch.items.map((it) => it.sourcePath).join('\n'))
                portFilePaths.push(...res.portFilePaths)
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              log.warn('port artifact archival failed', { nodeRunId: opts.nodeRunId, error: msg })
              // Environment-level failure (appHome full / permissions), NOT an
              // agent output defect — deliberately no failureCode, so
              // decideEnvelopeFollowup stays out (a same-session "re-emit your
              // envelope" would mislead the agent); the ordinary node retry
              // re-runs validation + archival wholesale (RFC-145 "not
              // follow-up-able" default).
              status = 'failed'
              errorMessage = `port-artifact-archive-failed: ${msg}`
            }
          }
          // D17：RunResult.outputs 与入库 content 同步规范化——fanout/wrapper 直接
          // 消费该 map（不读 DB），不同步会让 wrapper 继续提升原始（可能绝对）路径。
          if (status === 'done') {
            for (const [name, norm] of normalizedContent) outputs[name] = norm
          }

          // Persist ports only on successful validation. The fail-fast loop
          // above bails on the first invalid port without setting status back
          // to 'done', so this branch runs iff every declared port passed
          // (status still 'done').
          // RFC-184: workgroup host runs pass persistDeclaredOutputs=false so their
          // projected wg_* protocol ports never land in node_run_outputs (design.md
          // §2.4) — result.outputs below still carries them for live consumption.
          // RFC-193 D14：host run 不归档（无 node_run_outputs 行 = 归档引用无挂载
          // 点）——上面的归档段不看 persistDeclaredOutputs 是因为 workgroup hook
          // 的 agent 没有 path 形声明端口（wg_* 协议端口皆文本）；防御性地，此处
          // persist=false 时归档引用同样不落库。
          if (status === 'done' && opts.persistDeclaredOutputs !== false) {
            try {
              await persistRunnerWrite('node-run-output/batch', () =>
                withTaskExecutionTransaction({
                  db: opts.db,
                  taskId: opts.taskId,
                  run: (tx) => {
                    const inactiveSet = new Set(parsed.inactivePorts)
                    for (const [name, content] of parsed.ports) {
                      // RFC-072: persist the resolved output kind so the Outputs
                      // tab can tell file-path ports from text. Keep every port in
                      // one synchronous transaction: a later failure must roll
                      // earlier upserts back instead of exposing partial outputs.
                      const rawKind = outputKinds?.[name]
                      const kind = rawKind !== undefined ? normalizeKindString(rawKind) : null
                      const persisted = normalizedContent.get(name) ?? content
                      const archiveJson = archiveJsonByPort.get(name) ?? null
                      // RFC-306: `active` must be part of the UPSERT's `set` too —
                      // a re-run of the same node_run (inline followup) may flip a
                      // branch open again, and a set-list that omitted the column
                      // would leave the previous round's closure in place.
                      const active = !inactiveSet.has(name)
                      tx.insert(nodeRunOutputs)
                        .values({
                          nodeRunId: opts.nodeRunId,
                          portName: name,
                          content: persisted,
                          kind,
                          archiveJson,
                          active,
                        })
                        .onConflictDoUpdate({
                          target: [nodeRunOutputs.nodeRunId, nodeRunOutputs.portName],
                          set: { content: persisted, kind, archiveJson, active },
                        })
                        .run()
                    }
                  },
                }),
              )
            } catch (error) {
              const detail = maskDiagnosticsText(
                error instanceof Error ? error.message : sqliteWriteDiagnostic(error),
              ).slice(0, 2000)
              log.warn('runtime-output-persistence-failed', {
                nodeRunId: opts.nodeRunId,
                runtime,
                err: detail,
              })
              status = 'failed'
              errorMessage = `runtime-output-persistence-failed: ${detail}`
              outputs = {}
              portFilePaths.length = 0
            }
          }
        }
      }
    }

    // 10. RFC-029: read the runtime inventory snapshot the dump plugin wrote
    //      into runRoot.
    //
    // RFC-297 T22 —— 读**仍在**（它是本轮观测的来源之一，喂给统一清单与启动
    // 验证），但**不再写 `inventory_snapshot_json`**：跨运行时统一后，观测的唯一
    // 落库目标是 `runtime_inventory_json`，旧列继续写就是同一份数据的第三份拷贝
    // （而且是只有 opencode 才有的那一份形状）。旧列保留只为读存量行。
    //
    // RFC-042: same-session envelope follow-up runs skipped plugin
    // materialization above; reading the (intentionally absent) snapshot file
    // would just record a `file-missing` stub, so the read is skipped entirely.
    // RFC-280 T3 — the parsed snapshot doubles as the opencode observation
    // source for the startup-verification record below.
    let capturedInventorySnapshot: InventorySnapshot | null = null
    // RFC-143: inventory read is an opencode-only capability. The agent-kind +
    // non-followup gates are business conditions (`freshAgentRun`, same value the
    // spawn-side injection used); the runtime gate is expressed by `readInventory`
    // being present — claude's driver omits it → `?.` short-circuits and the
    // column stays null.
    if (freshAgentRun) {
      try {
        const snapshot = await driver.readInventory?.({
          runRoot,
          nodeKind: inventoryNodeKind,
        })
        if (snapshot !== undefined && snapshot !== null) {
          capturedInventorySnapshot = snapshot
        }
      } catch (err) {
        log.warn('inventory-read-unhandled', {
          nodeRunId: opts.nodeRunId,
          err: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // RFC-297 T12 —— 退出后补发的合成事件走**同一条**消费路径。opencode 的清单
    // 在 dump 文件里而不在流里，driver 把它读成一个普通事件；下游因此无从分辨
    // 某份观测来自流内一行还是一个文件（design §3.2「event 来源统一」）。
    // 补发失败只丢观测，绝不改节点成败——清单是呈现面。
    try {
      const finalEvents =
        (await driver.drainFinalEvents?.({
          runRoot,
          nodeKind: inventoryNodeKind,
          freshRun: freshAgentRun,
        })) ?? []
      for (const event of finalEvents) await consumeInventoryPayload(event)
    } catch (err) {
      log.warn('final-events-drain-failed', {
        nodeRunId: opts.nodeRunId,
        err: err instanceof Error ? err.message : String(err),
      })
    }

    // RFC-280 T3 — startup verification: declared manifest × runtime startup
    // report. Persisted for the node-detail warning face; NEVER changes the
    // run's own status (user ruling: business nodes warn, don't fail).
    //
    // impl-gate P2-E: opencode's observation source is the RFC-029 inventory,
    // which is only produced for agent-kind non-followup runs (`freshAgentRun`).
    // On a followup the MCPs/skills ARE injected but no inventory is read — so
    // an "unavailable" record would flag every followup as "cannot verify"
    // (systematic noise). Skip recording when opencode has no observation
    // opportunity by design; claude captures its init inline every time.
    // RFC-282 C2 — the driver's STATIC capabilities replace the
    // readInventory-presence proxy (a third runtime silently fell into
    // the claude branch). P1-7: the fresh-run guard stays FIRST — flipping the
    // order re-creates the followup "cannot verify" noise (RFC-280 P2-E).
    const caps = driver.capabilities
    const observationSkippedByDesign = caps.observationRequiresFreshRun && !freshAgentRun

    // RFC-297 T18 —— 清单观测**无条件**落库，与下面的验证判定分开。
    //
    // 二者受不同的门：验证回答「我注入的东西生效了吗」，没注入就无从谈起，故仍受
    // `declaredHasContent` 门控；清单回答「这一轮到底加载了什么」，零注入节点同样
    // 想知道（AC-5）——此前 claude 侧这类节点的观测随作用域直接丢弃。
    //
    // 「没观测到」的三种归因不可混为一谈，否则会复活 RFC-280 P2-E 治过的噪音：
    // 运行时压根不产清单 / 本轮按设计不产（followup 复用会话）/ 本该有却没有。
    const runtimeInventoryJson = JSON.stringify(
      buildRuntimeInventoryObservation({
        capabilities: caps,
        freshRun: freshAgentRun,
        declared: injectionDeclared,
        claudeInit: capturedStartupInventory,
        snapshot: capturedInventorySnapshot,
        now: Date.now(),
      }),
    )

    let startupVerificationJson: string | null = null
    if (declaredHasContent(injectionDeclared) && !observationSkippedByDesign) {
      // RFC-297 T12：按 driver 表态取观测的判据收进 execution 层单点
      // （`observationForVerification`），runner 不再自己 switch 运行时——
      // 该判据此前在这里与 MCP 测试台各写一遍，第三个运行时接入要记得改两处。
      const observation = await observationForVerification(caps, {
        claudeInit: capturedStartupInventory,
        loadSnapshot: () => capturedInventorySnapshot,
      })
      const verification = verifyStartup(injectionDeclared, observation)
      const record: StartupVerificationRecord = {
        declared: injectionDeclared,
        observation,
        verification,
        // T14：证据丢失仅在既有 record 上附加（NULL 列 run 只打 warn，不合成
        // 三段必填的占位结构——设计门 P2/P3 裁决）。
        ...(outputTailTruncated ? { outputTailTruncated: true } : {}),
      }
      startupVerificationJson = JSON.stringify(record)
      const gaps =
        verification.mcpUnusable.length +
        verification.skillsMissing.length +
        verification.subagentsMissing.length +
        verification.toolsMissing.length
      if (gaps > 0 || verification.observation !== 'verified') {
        log.warn('startup-verification-gaps', {
          nodeRunId: opts.nodeRunId,
          runtime,
          observation: verification.observation,
          ...(verification.observationReason !== undefined
            ? { observationReason: verification.observationReason }
            : {}),
          mcpUnusable: verification.mcpUnusable.map((s) => `${s.name}:${s.status}`),
          skillsMissing: verification.skillsMissing,
          subagentsMissing: verification.subagentsMissing,
          toolsMissing: verification.toolsMissing,
        })
      }
    }

    // 11. Update node_runs final state.
    // RFC-053: setNodeRunStatus enforces the runtime-determined transition
    // running → {done, failed, canceled}. Non-status fields are batched in
    // `extra`. Two writes: status via CAS helper, then the columns lifecycle
    // doesn't know about (inventory / token usage / portValidation / etc.).
    const persistedStatus =
      status === 'canceled' && opts.signal?.reason === DAEMON_SHUTDOWN_ABORT_REASON
        ? 'interrupted'
        : status
    await setNodeRunStatus({
      db: opts.db,
      nodeRunId: opts.nodeRunId,
      to: persistedStatus,
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
    withTaskExecutionMutation({
      db: opts.db,
      taskId: opts.taskId,
      run: (tx) =>
        tx
          .update(nodeRuns)
          .set({
            runtimeInventoryJson,
            // RFC-280 T3: declared × observed × diff — the node-detail warning face.
            startupVerificationJson,
            // RFC-046: persist the post-budget-clip snapshot captured at inject
            // time (or copied from attempt 0 on the envelope-followup path).
            injectedMemoriesJson:
              injectedSnapshot === null ? null : JSON.stringify(injectedSnapshot),
            // RFC-049: structured port-validation failure payload.
            portValidationFailuresJson:
              portValidationFailures.length > 0
                ? serializePortValidationFailures(portValidationFailures)
                : null,
          })
          .where(eq(nodeRuns.id, opts.nodeRunId))
          .run(),
    })

    const result: RunResult = { status, exitCode, outputs, tokenUsage, prompt }
    // RFC-306: only attach when non-empty so every existing result object stays
    // byte-identical (several tests compare whole RunResults).
    if (inactiveOutputs.length > 0) result.inactiveOutputs = inactiveOutputs
    if (childUnkillable) result.processUnreaped = true
    if (portFilePaths.length > 0) result.portFilePaths = portFilePaths
    if (errorMessage !== undefined) result.errorMessage = errorMessage
    if (failureCode !== undefined) result.failureCode = failureCode
    // A reset boundary invalidates the outgoing resume id immediately. Until
    // a later bookend reveals and rotates to the replacement, never return the
    // stale id to callers that persist RunResult.sessionId again.
    if (
      sessionId !== undefined &&
      pendingConversationReset === undefined &&
      nativeSessionProtocolFailure === undefined
    ) {
      result.sessionId = sessionId
    }
    if (clarifyResult !== undefined) result.clarify = clarifyResult
    return result
  } catch (error) {
    // Defer the durable failure stamp until after `finally` has reaped the
    // runtime and completed all plan cleanup.
    postSpawnFailed = true
    void error
  } finally {
    // RFC-280 T7: process reaping is owned by the unified executor (it returns
    // only after reap, or after determining the child is unkillable). These
    // hooks are process-orthogonal (live poller stop / signal listener); the
    // child object no longer exists at this layer.
    for (const cleanup of spawnedCleanupHooks.reverse()) {
      try {
        cleanup()
      } catch {
        // Every hook is best-effort and idempotent.
      }
    }
    // `preserveLiveRuntimeState` (executor outcome 'unreaped') means the child
    // may still hold its native session — keep the lease + scratch for
    // recovery. Otherwise the child is reaped (or never spawned): release the
    // lease and run plan cleanup.
    if (!preserveLiveRuntimeState) {
      try {
        releaseHeldRuntimeLease()
      } catch (error) {
        log.warn('runtime-session-lease-release-failed', {
          nodeRunId: opts.nodeRunId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
      await finalizePlan()
    } else {
      log.warn('runtime-process-left-live-after-reap-deadline', {
        nodeRunId: opts.nodeRunId,
      })
    }
    // The process effect becomes terminal only after the node/output/session
    // projection above has committed. A crash before this line leaves an
    // unresolved attempt for proof-backed recovery instead of a duplicate
    // automatic runtime launch.
    if (!postSpawnFailed && processSettlement !== null) {
      processEffect?.settle(processSettlement)
    }
  }

  // The only fallthrough from the try/catch/finally above is an unexpected
  // post-spawn exception. Convert it into a normal failed RunResult after the
  // process/resource finalizer has completed; otherwise the scheduler's catch
  // path can leave this durable row stuck at `running`.
  if (!postSpawnFailed) {
    throw new Error('unreachable runner post-spawn state')
  }
  const postSpawnFailureCode: FailureCode | undefined = nativeSessionIdentityInvalidObserved
    ? 'runtime-session-identity-invalid'
    : undefined
  const postSpawnErrorMessage = postSpawnFailureCode ?? 'runtime-spawn-failed'
  try {
    await setNodeRunStatus({
      db: opts.db,
      nodeRunId: opts.nodeRunId,
      to: 'failed',
      allowedFrom: ['running'],
      reason: 'runner-post-spawn-exception',
      extra: {
        finishedAt: Date.now(),
        exitCode: null,
        errorMessage: postSpawnErrorMessage,
        failureCode: postSpawnFailureCode ?? null,
      },
    })
  } catch {
    // A concurrent terminal transition wins. In particular, never overwrite a
    // cancellation/review result merely because the runner was also unwinding.
    log.warn('runner-post-spawn-failure-status-cas-rejected', {
      nodeRunId: opts.nodeRunId,
    })
  }
  if (processSettlement !== null) processEffect?.settle(processSettlement)
  return {
    status: 'failed',
    exitCode: null,
    ...(preserveLiveRuntimeState ? { processUnreaped: true as const } : {}),
    outputs: {},
    tokenUsage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0 },
    prompt,
    errorMessage: postSpawnErrorMessage,
    ...(postSpawnFailureCode === undefined ? {} : { failureCode: postSpawnFailureCode }),
  }
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

/** RFC-098 WP-8: SIGTERM → SIGKILL escalation grace. */

/**
 * Per-line cap (code units) for a child's stdout/stderr. A runaway or hostile
 * child that emits data with NO newline would otherwise grow `buffer`
 * without bound and OOM the daemon (which is shared by every concurrent task).
 * A single >1 MiB "line" is never a valid `--format json` event, so truncate it
 * with a marker and discard the rest of that monster line until the next
 * newline resumes normal parsing.
 * See design/test-guard-audit-2026-07-21 gap B4-runtime-6 / Top-14.
 */
// RFC-284 §3.5 尾项：数值单点在 managedProcess（RFC-280 起真正的 pump 实现），
// 本名保留 re-export——历史消费方（含测试锁）零改动，两处漂移不再可能。
export const MAX_STREAM_LINE_CHARS = MANAGED_PROCESS_MAX_LINE_CHARS

/**
 * Rolling-tail cap (code units) for the accumulated agent text the envelope is
 * parsed from. 8 MiB comfortably holds any realistic `<workflow-output>`
 * envelope (which is the LAST thing in the output), while bounding the daemon's
 * RSS against a runaway loop that emits millions of small lines. See
 * appendAgentText in runNode / gap B4-runtime-6.
 */
export const MAX_AGENT_TEXT_CHARS = 8 * 1024 * 1024
/**
 * 非零退出时拼进 errorMessage 的 stderr 尾巴上限。取 2KB 是因为它要进 DB 的
 * `tasks.error_message` 并一路上浮到 UI / blockDetail：够看清一条崩溃栈或一句
 * 「找不到 X」，又不至于让一个刷屏的子进程把失败回执撑成日志转储。
 */
export const MAX_STDERR_TAIL_CHARS = 2 * 1024

/**
 * 单行进入 stderr 尾巴前的裁剪长度。**这不是美观问题，是归因问题**：runtime 崩溃时
 * stderr 的形状是「第一行是错因，随后是被打印的源码行」，而 bundle 里的源码行是压缩过
 * 的**单行几十 KB**。只按总长度取尾巴的话，那一行会把错因整个挤出窗口——2026-08-20 的
 * windows CI 实撞：拿到手的 tail 全是 minified 源码片段，真正的 error 消息一个字都没留下。
 * 逐行先裁头，再拼尾巴，窗口里就能同时容下错因与其后若干行栈。
 */
export const MAX_STDERR_TAIL_LINE_CHARS = 320

/** 长行裁到 `maxChars` 并标注被丢弃的字符数（保留**行首**：错因写在前面）。 */
export function clampTailLine(line: string, maxChars = MAX_STDERR_TAIL_LINE_CHARS): string {
  if (line.length <= maxChars) return line
  return `${line.slice(0, maxChars)}…(+${line.length - maxChars} chars)`
}

/**
 * Append `addition` (newline-joined) to `current`, keeping only the last
 * `maxChars` code units. Slices only when the buffer reaches 2× the cap, so the
 * O(cap) copy is amortized across many appends rather than paid on every one.
 * Pure — extracted so the rolling-tail bound can be tested without a live child.
 */
export function appendBoundedTail(current: string, addition: string, maxChars: number): string {
  const joined = current.length > 0 ? current + '\n' + addition : addition
  if (joined.length > 2 * maxChars) {
    return joined.slice(joined.length - maxChars)
  }
  return joined
}

// RFC-111 PR-A moved opencode runtime helpers to ./runtime/opencode/*; the
// compatibility re-exports that used to live here were DELETED by RFC-282 C0
// (import sites go through @/services/runtime now, and
// rfc282-c0c2-runtime-fence.test.ts locks that this file re-exports nothing
// from the runtime directory). (2026-08-12 审计对账：原注释仍描述已删除的
// re-export 契约，已修正——不要按旧注释在这里恢复任何 runtime re-export。)

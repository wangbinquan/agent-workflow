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
  Mcp,
  PriorOutputUpdateContext,
  ReviewPromptContext,
  TriggerContext,
} from '@agent-workflow/shared'

import type { ObservationInvocationParticipant } from '@/modules/run-observability/public/participants'

import { type Logger } from '@/util/log'

// RFC-111 PR-A/B + RFC-143 PR-4: agent runtime behind the driver seam. The
// stdout pump uses `getRuntimeDriver(runtime).parseEvent` and the spawn goes
// through `driver.buildBusinessSpawn` — runNode is fully kind-blind (zero
// `runtime === 'xxx'` branches; the runtime-specific assembly lives in
// runtime/opencode + runtime/claudeCode). The event helpers, buildCommand and
// the inline-config surface are re-exported at the bottom so existing importers
// (tests, memoryDistiller) keep resolving from '@/services/runner'.
// RFC-111 PR-A/B + RFC-143 PR-4: agent runtime behind the driver seam. The
// stdout pump uses `getRuntimeDriver(runtime).parseEvent` and the spawn goes
// through `driver.buildBusinessSpawn` — runNode is fully kind-blind (zero
// `runtime === 'xxx'` branches; the runtime-specific assembly lives in
// runtime/opencode + runtime/claudeCode). The event helpers, buildCommand and
// the inline-config surface are re-exported at the bottom so existing importers
// (tests, memoryDistiller) keep resolving from '@/services/runner'.
import type { RuntimeKind } from '@/modules/runtime-management/public/types'
import type {
  RuntimeProfile,
  RuntimeObservationIdentity,
} from '@/modules/runtime-management/public/types'
import type { RuntimeExecutionQueries } from '@/modules/runtime-management/public/queries'

import type { RuntimeConfigDirProfile } from '@agent-workflow/shared'

// RFC-297 T18 —— 结算时构造统一清单观测（与 verifyStartup 共用同一套对账语义）。

import { type ScopeBudget } from '@/modules/memory/public/types'
import type { MemoryInjectionQueries } from '@/modules/memory/public/queries'
import type { FailureCode } from '@agent-workflow/shared'

import type { TaskExecutionPersistence } from '@/modules/task-execution/application/ports/taskExecutionPersistence'

import { type RuntimeSessionLeaseOperations } from '@/services/runtimeSessionLease'

// RFC-143 PR-4: SkillSource / ResolvedSkill moved to runtime/types.ts (drivers
// type their skill inputs there); re-exported so scheduler/tests keep resolving.

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
// RFC-143 PR-4: SkillSource / ResolvedSkill moved to runtime/types.ts (drivers
// type their skill inputs there); re-exported so scheduler/tests keep resolving.
export interface TaskAgentRunPolicy {
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
  dependents?: readonly Agent[]
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
   * RFC-060 D.T7: per-input port kinds, used to enforce the
   * `signal`-port-not-in-prompt rule. Optional — when set, the runner runs
   * `assertNoPromptSignalRefs` against `promptTemplate` before render and
   * fails the run with errCode `signal-port-in-prompt` when any `{{port}}`
   * reference resolves to a `signal` kind. When unset, the check is skipped
   * (legacy callers retain current behavior). Task-execution's fanout attempt
   * adapter populates this for inner shard dispatches.
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
  /**
   * RFC-111 D15: the FROZEN runtime for this node_run (resolved once at dispatch
   * from `agent.runtime ?? config.defaultRuntime`, persisted to
   * `node_runs.runtime`, and read back on resume/retry so a mutated agent /
   * default can't re-route a captured session to the wrong runtime). Omitted /
   * undefined → `'opencode'` (legacy zero-change default).
   */
  runtime?: RuntimeKind
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
  /** Bootstrap-selected task execution persistence. No provider client crosses
   * the runner boundary. */
  persistence: TaskExecutionPersistence
  /** Bootstrap-selected durable accounting; no deployment inference in the runner. */
  observationInvocations: ObservationInvocationParticipant
  runtimeObservationIdentity?: RuntimeObservationIdentity
  observationPurpose?: 'task' | 'system' | 'playground' | 'memory'
  /** Bootstrap-selected runtime registry operations. */
  runtimeRegistry: Pick<RuntimeExecutionQueries, 'resolveAgentRuntime'>
  /** Bootstrap-selected durable ownership for native runtime conversations. */
  runtimeSessionLeases: RuntimeSessionLeaseOperations
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
  /** Provider-neutral memory read participant selected by daemon composition. */
  memoryInjectionQueries: MemoryInjectionQueries
  /**
   * RFC-048: cadence + failure tolerance for the live subagent capture
   * poller. Omitted (or `pollMs === 0`) falls back to RFC-027 behavior —
   * the runner only captures child-session events in the single post-run
   * BFS. Scheduler / cli plumb `config.subagentLiveCapture` through here.
   */
  subagentLiveCapture?: {
    pollMs: number
    consecutiveFailureLimit: number
  }
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

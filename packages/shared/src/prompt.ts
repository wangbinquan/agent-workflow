// Prompt assembly logic shared between the backend runner and the frontend
// preview pane (NodeInspector). Pure functions — no Bun / Node / DB
// imports. Mirrors design.md §7.2.

import type { AgentOutputKindsMap } from './schemas/agent'
import { PROMPT_INJECTED_PORT_NAMES } from './systemChannelPorts'
import type { FailureCode } from './schemas/task'
import {
  ASKBACK_PRIOR_OUTPUT_BLOCK_TITLE,
  ASKBACK_PRIOR_OUTPUT_DIRECTIVE_BLOCK_TITLE,
  ASKBACK_PRIOR_OUTPUT_DIRECTIVE_TEXT,
  PRIOR_OUTPUT_BLOCK_TITLE,
  UPDATE_DIRECTIVE_BLOCK_TITLE,
  UPDATE_DIRECTIVE_TEXT,
  renderClarifyDirectiveTrailer,
} from './clarify'
import { groupPortsByParsedKind, parsePortKind, getHandlerForParsedKind } from './outputKinds'

/**
 * Review-driven re-run context (RFC-005 + RFC-014).
 *
 * Filled only when a node is being re-run because a downstream review decision
 * (`reject` or `iterate`) fired. All fields are pre-rendered strings — the
 * structured-to-markdown serialization lives in `services/review.ts` so this
 * module stays a pure substitution engine.
 *
 * Builtin tokens populated from this context:
 *   {{__review_rejection__}}     ← rejection (set on reject path)
 *   {{__review_comments__}}      ← comments  (set on iterate path; markdown list)
 *   {{__iterate_target_port__}}  ← iterateTargetPort (set on iterate path)
 *   {{__sibling_outputs__}}      ← siblingOutputs (set on iterate path when the
 *                                  upstream agent declares ≥ 2 markdown[_file]
 *                                  outputs AND opted into `syncOutputsOnIterate`;
 *                                  carries the other documents' current bodies
 *                                  prefixed with a stable English consistency
 *                                  instruction — RFC-014 §3.1)
 *
 * Templates that don't reference these tokens get framework-auto-appended
 * sections at the tail of the user prompt (just like unreferenced ports).
 */
export interface ReviewPromptContext {
  /** Reject reason text, when set. */
  rejection?: string
  /** Comments list, already rendered as a markdown string. */
  comments?: string
  /**
   * On iterate path, the source port name being iterated on. Lets agents
   * branch their generation logic on "regen this port only, leave others".
   */
  iterateTargetPort?: string
  /**
   * RFC-014: pre-rendered markdown listing the other markdown[_file] outputs
   * of the same upstream node. Only set on iterate path when the upstream
   * declares ≥ 2 markdown[_file] outputs AND has `syncOutputsOnIterate: true`.
   * Includes the leading English consistency instruction line — see
   * `buildSiblingOutputsBlock` in services/review.ts.
   */
  siblingOutputs?: string
}

/**
 * RFC-023 clarify-driven re-run context.
 *
 * Filled when an agent is being re-spawned because its previous reply was a
 * `<workflow-clarify>` envelope and the user has now answered. All fields are
 * pre-rendered strings — the structured-to-markdown serialization lives in
 * shared/clarify.ts so this module stays a pure substitution engine.
 *
 * Builtin tokens populated from this context:
 *   {{__clarify_iteration__}}  ← iteration      (string form of the clarify generation)
 *   {{__clarify_remaining__}}  ← remaining      (string; "max - current" when inside a
 *                                                wrapper-loop with a cap, "" otherwise)
 *
 * RFC-148 (RFC-132 收尾): the legacy round-grouped fields
 * (questionsBlock / answersBlock / directive / currentRoundOnly) are GONE —
 * the flat `## Clarify Q&A` block is the only injection surface, exactly what
 * the scheduler has produced since RFC-132 PR-C.
 */
export interface ClarifyPromptContext {
  /**
   * RFC-132 (PR-C): the single flat `## Clarify Q&A` block (built by
   * `renderFlatClarifyQueue` via `buildClarifyQueueContext`). Emitted
   * VERBATIM — the block already carries its own heading. The designer's
   * cross-clarify Q&A rides this same block (§5 ②b).
   */
  flatBlock?: string
  /** Current clarifyIteration as string. '0' means first asking-back; '1' means
   *  first answers-received run; '2' means second ask-then-answer, etc. */
  iteration?: string
  /** Empty string when not inside a wrapper-loop with a cap; otherwise
   *  String(max_iterations - current iteration). Agent reads this to know how
   *  many ask-back rounds it has left before the framework exhausts the loop. */
  remaining?: string
  /**
   * RFC-026: which clarify session mode emitted this context. Defaults to
   * `'isolated'` (treats missing / undefined the same as RFC-023 behavior).
   *
   * When `'inline'`, the runner has spawned opencode with `--session <id>`
   * and the prior rounds' Q&A + protocol blocks already live in opencode's
   * session memory. `renderUserPrompt` then skips port-content substitution
   * and auto-append sections and swaps the trailing protocol block for a
   * short inline reminder (`buildClarifyInlineReminder()`).
   */
  mode?: 'isolated' | 'inline'
}

/**
 * RFC-119 / RFC-141: generalized prior-output context for NON-cross-clarify
 * reruns (review reject/iterate, manual retry, cascade, resume, clarify-answer,
 * ask-back rounds, override handoffs). The scheduler populates `block` (via
 * `composePriorOutputBlock` → the shared `buildPriorOutputBlock`) from the
 * freshest prior run that captured output; `renderUserPrompt` then emits the
 * `## Prior Output` + directive section pair — the update variant on an output
 * round, the ask-back variant (RFC-141) when mandatory ask-back is active.
 *
 * Empty / undefined `block` ⇒ no sections. (RFC-148: the historical mutual
 * exclusion with the dead RFC-056 designer-context prior output is gone —
 * this is the only prior-output surface.)
 */
export interface PriorOutputUpdateContext {
  block?: string
}

/**
 * RFC-148 — clarify-channel state for one dispatch, as ONE discriminated
 * value instead of four scattered booleans (hasClarifyChannel /
 * clarifyStopped / clarifyStopNotice / clarifyMode). The axes are
 * deliberately orthogonal:
 *   - `kind` is the WIRING family — it alone drives the envelope parser's
 *     question cap (cross lifts the RFC-023 max), independent of whether
 *     ask-back is mandatory this run (a review rerun keeps `kind:'cross'`
 *     with `directive:'suppressed'`).
 *   - `directive` is this run's enforcement:
 *       'mandatory'  — genuine clarify round; the ONLY valid reply is
 *                      `<workflow-clarify>` (RFC-100 gate);
 *       'suppressed' — channel wired but this run is a review reject /
 *                      iterate re-production: NOT invited, and (RFC-183) a
 *                      disobedient `<workflow-clarify>` is rejected — the
 *                      prompt carries zero clarify bytes, so acceptance
 *                      would be an invite/accept asymmetry;
 *       'stopped'    — user ended clarification; a disobedient
 *                      `<workflow-clarify>` is rejected (RFC-123);
 *       'delegated'  — (RFC-183) host runs (workgroup / dynamic-workflow):
 *                      BOTH the invite and the acceptance verdict live
 *                      OUTSIDE this ADT — the invite in the caller's
 *                      workgroupProtocolBlock (WG_CLARIFY_BLOCK, only when
 *                      not autonomous), the verdict in the RFC-181
 *                      envelope-time callback + the scheduler's
 *                      clarify-no-channel check. Renders byte-identically
 *                      to 'suppressed' (pure output protocol).
 *   - `injectStopNotice` — inject the standalone `### User directive:
 *     STOP CLARIFYING` trailer (RFC-122; stop rounds with no prior clarify
 *     content to carry it).
 * Illegal states (stopped/suppressed with no wiring) are unrepresentable.
 */
export type ClarifyChannel =
  | { kind: 'none' }
  | {
      kind: 'self' | 'cross'
      /**
       * RFC-165 (F12) adds 'optional': the clarify channel is OFFERED, not
       * enforced — the agent may reply with EITHER a `<workflow-clarify>`
       * envelope (opens a round) or a `<workflow-output>` (finalizes), and
       * every rerun of the node (initial / retry / post-answer) stays
       * optional. Runner enforcement: 'optional' trips NEITHER the
       * clarify-required gate NOR the clarify-forbidden gate. Precedence
       * when the scheduler composes the value: stopped > optional >
       * mandatory/suppressed.
       */
      directive: ClarifyChannelDirective
      injectStopNotice: boolean
    }

/** The directive axis of {@link ClarifyChannel}, named so the RFC-183
 *  disposition classifier and its tests can enumerate it exhaustively. */
export type ClarifyChannelDirective =
  | 'mandatory'
  | 'suppressed'
  | 'stopped'
  | 'optional'
  | 'delegated'

/**
 * RFC-183 — the single exhaustive invite/accept policy for a clarify-channel
 * directive. Renderer, runner and the golden-matrix tests all consume THIS
 * function instead of testing directive literals independently, so "sample
 * injected ⟺ clarify accepted" is a structural guarantee:
 *
 *   'invite-mandatory' — inject the clarify-only protocol; runner demands
 *                        `<workflow-clarify>` (RFC-100);
 *   'invite-optional'  — inject the dual-envelope protocol; runner accepts
 *                        either envelope (RFC-165);
 *   'reject'           — inject NOTHING clarify-flavored; runner rejects a
 *                        `<workflow-clarify>` (stopped → RFC-123 wording,
 *                        suppressed → RFC-183 re-production wording);
 *   'external'         — ADT abstains: invite + verdict are the host
 *                        caller's contract (see 'delegated' above).
 *
 * Adding a directive without picking a disposition here is a compile error
 * (never check) — the drift this RFC exists to prevent.
 */
export type ClarifyDisposition = 'invite-mandatory' | 'invite-optional' | 'reject' | 'external'

export function clarifyDispositionFor(directive: ClarifyChannelDirective): ClarifyDisposition {
  switch (directive) {
    case 'mandatory':
      return 'invite-mandatory'
    case 'optional':
      return 'invite-optional'
    case 'stopped':
    case 'suppressed':
      return 'reject'
    case 'delegated':
      return 'external'
    default: {
      const exhausted: never = directive
      throw new Error(`unreachable clarify directive: ${String(exhausted)}`)
    }
  }
}

/** RFC-049 structured port-validation failure (followup payload item). */
export interface PortValidationFailure {
  port: string
  kind: string
  subReason: string
  detail?: string
}

/**
 * RFC-148 — how the runner renders this dispatch's user prompt, as ONE
 * discriminated value instead of the four scattered envelopeFollowup*
 * fields. The `followup` arm carries `resumeSessionId` (D2): a follow-up
 * nudge is only meaningful inside the resumed session that already holds
 * the original prompt — "followup without a session" is unrepresentable.
 */
export type PromptMode =
  | { kind: 'initial' }
  | {
      kind: 'followup'
      resumeSessionId: string
      reason: EnvelopeFollowupReason
      clarifyDirective?: 'continue' | 'stop'
      portValidations?: ReadonlyArray<PortValidationFailure>
    }

export interface RenderPromptInput {
  /** Node-level prompt template. May be undefined or empty. */
  promptTemplate?: string
  /** Resolved input ports — { portName -> concatenated content }. */
  inputs: Record<string, string>
  /** Built-in template variables. */
  meta: {
    repoPath: string
    baseBranch: string
    taskId: string
    /** Workflow node id (always available at run time). */
    nodeId?: string
    /** Loop wrapper iteration (0-based). Only present inside a loop. */
    iteration?: number
    /** Shard key for multi-process nodes. Only present in child runs. */
    shardKey?: string
    /**
     * RFC-066: per-repo metadata for the multi-repo placeholders. Single-repo
     * tasks (legacy default) pass a length-1 array whose entry mirrors
     * `repoPath` / `baseBranch` with `worktreeDirName === ''` so the
     * `{{__repo_names__}}` placeholder renders an empty string (byte-baseline
     * for templates that don't use the new tokens). When absent, the legacy
     * `{{__repo_path__}}` / `{{__base_branch__}}` substitutions still work and
     * the three new tokens render to ''.
     */
    repos?: Array<{
      repoPath: string
      worktreePath: string
      worktreeDirName: string
      baseBranch: string
    }>
  }
  /** Declared outputs for the protocol block instructions. */
  agentOutputs: string[]
  /**
   * Per-port `outputKinds` map from the agent (RFC-005). When a port's kind is
   * `markdown_file`, the trailing protocol block calls out — explicitly and by
   * name — that the agent MUST write the markdown body to a file inside the
   * worktree BEFORE emitting only the worktree-relative path inside `<port>`.
   *
   * Without this hint, agents have been observed to emit a path string with
   * no corresponding file on disk; the framework then fails the run when
   * `resolvePortContent` tries to read it. Surfacing the file-first rule in
   * the protocol block (alongside the existing port list) makes the contract
   * unmissable to the agent. Ports absent from the map default to `string`
   * (legacy behaviour — no extra wording).
   */
  agentOutputKinds?: AgentOutputKindsMap
  /**
   * RFC-164: when set, the trailing protocol block is REPLACED by this
   * workgroup-generated block (leader/worker/fc variants) — the agent's own
   * `outputs` declaration does not apply inside a workgroup task (design §5).
   * Never concatenated with buildProtocolBlock; mandatory ask-back still wins
   * (RFC-183: a workgroup member run is dispatched with directive
   * 'delegated', so in practice the mandatory branch never fires for
   * workgroup runs — the clarify invite, when the group is not autonomous,
   * travels INSIDE this block as WG_CLARIFY_BLOCK).
   */
  workgroupProtocolBlock?: string
  /** RFC-005 review-driven re-run context. Absent for normal first-time runs. */
  reviewContext?: ReviewPromptContext
  /** RFC-023 clarify-driven re-run context. Absent for first runs and runs
   *  where the agent's clarify channel is wired but it hasn't yet asked. */
  clarifyContext?: ClarifyPromptContext
  /**
   * RFC-148: the clarify-channel state for this dispatch (one discriminated
   * value; see `ClarifyChannel`). The renderer consumes two projections
   * (RFC-183: both routed through `clarifyDispositionFor`):
   *   - disposition 'invite-mandatory' ⟺ the historical
   *     effectiveHasClarifyChannel — emits the RFC-100 mandatory ask-back
   *     preamble + clarify-only format (no `<workflow-output>` format) and
   *     selects the RFC-141 ask-back prior-output wording;
   *   - `injectStopNotice` — the RFC-122 standalone STOP CLARIFYING trailer.
   * Absent / kind:'none' / 'suppressed' / 'stopped' / 'delegated' all render
   * the single-envelope output protocol unchanged (their enforcement
   * differences live in the runner's parse layer — which consumes the SAME
   * classifier — not in prompt bytes).
   */
  clarifyChannel?: ClarifyChannel
  /**
   * RFC-119 / RFC-141: prior-output context for a NON-cross-clarify rerun. When
   * set (and cross-clarify is not already owning the prior-output block, and
   * this is not an inline session resume), renderUserPrompt appends the
   * `## Prior Output` + directive pair — update variant on output rounds,
   * ask-back variant when mandatory ask-back is active (RFC-141). Absent for
   * first-time runs and any run with no prior captured output.
   */
  priorOutputUpdate?: PriorOutputUpdateContext
}

const TEMPLATE_RE = /\{\{(\w+)\}\}/g

/**
 * RFC-103 T5 (04-WFM-06/07): single source of truth for the set of built-in
 * `{{__var__}}` prompt placeholders. The substitution engine (renderUserPrompt)
 * and the static validator (workflow.validator.ts) MUST share this set — they
 * were two hand-maintained copies and the validator's copy lagged behind
 * (missing RFC-056 cross-clarify + RFC-066 multi-repo tokens), so valid
 * `{{__repos__}}` / `{{__external_feedback__}}` templates were falsely reported
 * `prompt-template-unresolved` and blocked at launch.
 */
export const BUILTIN_VARS = new Set([
  '__repo_path__',
  '__base_branch__',
  '__task_id__',
  '__node_id__',
  '__iteration__',
  '__shard_key__',
  // RFC-005 review context tokens. They are stable names — see
  // packages/backend/tests/review-prompt-injection.test.ts for the
  // source-code-text grep regression guard.
  '__review_rejection__',
  '__review_comments__',
  '__iterate_target_port__',
  // RFC-014 sibling-outputs token — stable name; same grep contract as the
  // review tokens above. See packages/backend/tests/review-prompt-injection.test.ts.
  '__sibling_outputs__',
  // RFC-023 clarify context tokens. Stable names; renaming is a contract
  // break — see packages/backend/tests/clarify-prompt-injection.test.ts
  // for the source-code-text grep regression guard.
  '__clarify_iteration__',
  '__clarify_remaining__',
  // RFC-056 cross-clarify context tokens. Stable names; renaming is a
  // contract break — see packages/shared/tests/clarify-cross-rfc056.test.ts
  // for the grep guard on `CROSS_CLARIFY_EXTERNAL_FEEDBACK_BLOCK_TITLE` +
  // packages/backend/tests/cross-clarify-prompt-injection-rfc056.test.ts
  // for the per-token presence guard.
  // RFC-066 multi-repo placeholders. Single-repo runs render
  // `__repo_names__` as the empty string (length-1 array, worktreeDirName='');
  // `__repos__` becomes the single worktreePath; `__repo_count__` is '1'.
  // Templates that never reference them stay byte-baseline against
  // pre-RFC-066 outputs.
  '__repos__',
  '__repo_names__',
  '__repo_count__',
])

/**
 * RFC-148 — retired clarify/cross-clarify tokens. Their render paths were
 * deleted with the RFC-132 finish (zero producers), and substitution now
 * falls through to the default branch which renders '' — byte-identical to
 * what these tokens produced for years. They are OUT of BUILTIN_VARS (new
 * templates should not use them) but the validator recognizes them as a
 * DEPRECATION WARNING instead of a `prompt-template-unresolved` error, so
 * a saved workflow whose template still references one keeps launching
 * (impl-gate high: consumer compatibility is not the producer's deadness).
 */
export const DEPRECATED_PROMPT_TOKENS: ReadonlySet<string> = new Set([
  '__clarify_questions__',
  '__clarify_answers__',
  '__external_feedback__',
  '__external_feedback_iteration__',
  '__external_feedback_sources__',
])

/**
 * System ports the framework injects via DEDICATED prompt sections instead of
 * the generic `## ${port_name}` auto-append loop. They appear in
 * `definition.edges` as system-channel targets (RFC-023 clarify channel /
 * RFC-056 cross-clarify channel) so the canvas can render handles + the
 * scheduler can track wiring, but the actual prompt content arrives via the
 * flat `## Clarify Q&A` block rendered below (RFC-132/148). Skipping these
 * here keeps the auto-append from emitting empty,
 * misleading `## __port_name__` headers that make the human reader (and
 * the agent) think the cross-channel content is missing.
 */
// RFC-147: the private 2-port set moved to the shared system-channel-port
// registry — PROMPT_INJECTED_PORT_NAMES is the registry's promptInjected
// projection (today: __clarify_response__ + __external_feedback__).

/**
 * Compose the user-prompt string sent to opencode for one node invocation:
 *
 *   1. Node-level template with `{{port_name}}` + built-in substitutions.
 *   2. Per-port sections for any input not referenced by the template.
 *   3. English protocol block at the end instructing the agent how to format
 *      its `<workflow-output>` reply.
 */
export function renderUserPrompt(input: RenderPromptInput): string {
  // RFC-148 projections of the clarify-channel ADT (see ClarifyChannel),
  // routed through the RFC-183 disposition classifier so injection can never
  // drift from the runner's acceptance verdict: 'invite-mandatory' drives
  // preamble/trailing/prior-output wording, 'invite-optional' the dual
  // protocol; 'reject'/'external' render identically to "no channel" — their
  // enforcement lives in the runner (and, for 'external', the host caller).
  const channel = input.clarifyChannel
  const disposition =
    channel !== undefined && channel.kind !== 'none'
      ? clarifyDispositionFor(channel.directive)
      : undefined
  const mandatoryAskBack = disposition === 'invite-mandatory'
  // RFC-165 (F12): optional ask-back renders the DUAL-envelope protocol —
  // both formats, agent's choice; enforcement stays off in the runner.
  const optionalAskBack = disposition === 'invite-optional'
  const stopNotice =
    channel !== undefined && channel.kind !== 'none' && channel.injectStopNotice === true
  const tpl = input.promptTemplate ?? ''
  const referenced = new Set<string>()
  const rc = input.reviewContext
  const cc = input.clarifyContext
  // RFC-026: inline-mode clarify reruns send opencode a SECOND message in an
  // already-loaded session. The original first-round user prompt — template
  // body + every input port value — is already in opencode's transcript and
  // visible to the agent. Re-substituting input port values into the
  // template, and re-emitting the `## ${port_name}` auto-append sections
  // would just bloat the incremental message with duplicated context and
  // risk the agent re-anchoring on stale large payloads.
  //
  // Strategy:
  //   - `{{port_name}}` tokens substitute to '' instead of the port value
  //     (template structural words survive, port body drops out).
  //   - The auto-append loop skips input port sections entirely.
  //   - Built-in tokens (`{{__repo_path__}}` etc) AND clarify tokens still
  //     resolve — they're context this round needs.
  //
  // Isolated mode is untouched: a fresh opencode process has no prior
  // memory and genuinely needs the inputs re-included.
  const inlineMode = cc?.mode === 'inline'

  const body = tpl.replace(TEMPLATE_RE, (_match, name: string) => {
    referenced.add(name)
    if (BUILTIN_VARS.has(name)) {
      switch (name) {
        case '__repo_path__':
          return input.meta.repoPath
        case '__base_branch__':
          return input.meta.baseBranch
        case '__task_id__':
          return input.meta.taskId
        case '__node_id__':
          return input.meta.nodeId ?? ''
        case '__iteration__':
          return input.meta.iteration !== undefined ? String(input.meta.iteration) : ''
        case '__shard_key__':
          return input.meta.shardKey ?? ''
        case '__review_rejection__':
          return rc?.rejection ?? ''
        case '__review_comments__':
          return rc?.comments ?? ''
        case '__iterate_target_port__':
          return rc?.iterateTargetPort ?? ''
        case '__sibling_outputs__':
          return rc?.siblingOutputs ?? ''
        case '__clarify_iteration__':
          return cc?.iteration ?? ''
        case '__clarify_remaining__':
          return cc?.remaining ?? ''
        case '__repos__':
          return (input.meta.repos ?? []).map((r) => r.worktreePath).join('\n')
        case '__repo_names__':
          return (input.meta.repos ?? []).map((r) => r.worktreeDirName).join('\n')
        case '__repo_count__':
          return String((input.meta.repos ?? []).length)
      }
    }
    // RFC-148: retired tokens render '' unconditionally — historically their
    // substitution cases returned empty (zero producers), and they must NOT
    // fall through to the input lookup: a saved workflow with an inbound
    // port that happens to share the retired name (validator only warns)
    // would otherwise render upstream content where years of prompts had
    // an empty string (impl-gate re-review high).
    if (DEPRECATED_PROMPT_TOKENS.has(name)) return ''
    // RFC-026: drop input port values from inline-mode reruns (see comment
    // above the inlineMode declaration).
    if (inlineMode) return ''
    const v = input.inputs[name]
    return v ?? ''
  })

  let sections = ''
  for (const [name, content] of Object.entries(input.inputs)) {
    if (referenced.has(name)) continue
    // RFC-026: inline mode — skip the `## ${port}` auto-append for the same
    // reason input substitution above drops to ''.
    if (inlineMode) continue
    // System ports (`__clarify_response__`, `__external_feedback__`, etc.)
    // are framework-injected via the flat `## Clarify Q&A` block below
    // (RFC-132/148), not via real edge dataflow. Rendering them as `## __port_name__`
    // sections produces empty / misleading headers that imply the
    // cross-clarify or self-clarify content is missing when it's actually
    // present further down. Skip the auto-append entry for them.
    if (PROMPT_INJECTED_PORT_NAMES.has(name)) continue
    sections += `\n\n## ${name}\n${content}`
  }

  // RFC-005: auto-append review context sections when the template didn't
  // reference the tokens. Lets author-written prompts stay terse while still
  // getting the rejection / comments / target-port surfaced at the tail.
  if (rc !== undefined) {
    if (
      rc.rejection !== undefined &&
      rc.rejection.trim().length > 0 &&
      !referenced.has('__review_rejection__')
    ) {
      sections += `\n\n## Review Rejection\n${rc.rejection}`
    }
    if (
      rc.comments !== undefined &&
      rc.comments.trim().length > 0 &&
      !referenced.has('__review_comments__')
    ) {
      sections += `\n\n## Review Comments\n${rc.comments}`
    }
    if (
      rc.iterateTargetPort !== undefined &&
      rc.iterateTargetPort.length > 0 &&
      !referenced.has('__iterate_target_port__')
    ) {
      sections += `\n\n## Iterate Target Port\n${rc.iterateTargetPort}`
    }
    // RFC-014: auto-append sibling outputs when the iterate path populated them.
    if (
      rc.siblingOutputs !== undefined &&
      rc.siblingOutputs.trim().length > 0 &&
      !referenced.has('__sibling_outputs__')
    ) {
      sections += `\n\n## Sibling Outputs\n${rc.siblingOutputs}`
    }
  }

  // RFC-023/026/132 clarify injection — the flat `## Clarify Q&A` block is
  // the single surface (RFC-148 removed the legacy round-grouped sections;
  // inline mode needs no special title because the block is round-agnostic).
  if (cc?.flatBlock !== undefined && cc.flatBlock.trim().length > 0) {
    // RFC-132 (PR-C): the unified flat `## Clarify Q&A` block — self /
    // questioner / designer all render as equal peers inside it (§5). Emit
    // it verbatim (it owns its own heading). The block is round-agnostic, so
    // inline mode needs no separate "current round" title. RFC-148: the
    // legacy round-grouped else-branch that used to follow is deleted — the
    // scheduler has produced flatBlock-only contexts since RFC-132 PR-C.
    sections += `\n\n${cc.flatBlock}`
  }

  // RFC-119 / RFC-141: generalized rerun prior-output. Emits ONLY when:
  //   - the scheduler set priorOutputUpdate.block (a prior run captured output), AND
  //   - NOT an inline session resume (the resumed session already holds the prior
  //     output — re-injecting wastes tokens and re-anchors on stale text).
  // RFC-141: a mandatory ask-back round now ALSO renders it — with the
  // clarify-flavored title + directive pair (frame your QUESTIONS around revising
  // the draft) instead of the update pair (which demands a <workflow-output>
  // this very round and would contradict the clarify-only protocol). The variant
  // is selected off the SAME hasClarifyChannel signal that picks the trailing
  // protocol below, so wording and protocol can never disagree.
  const pou = input.priorOutputUpdate
  if (pou?.block !== undefined && pou.block.trim().length > 0 && !inlineMode) {
    if (mandatoryAskBack) {
      sections += `\n\n${ASKBACK_PRIOR_OUTPUT_BLOCK_TITLE}\n${pou.block}`
      sections += `\n\n${ASKBACK_PRIOR_OUTPUT_DIRECTIVE_BLOCK_TITLE}\n${ASKBACK_PRIOR_OUTPUT_DIRECTIVE_TEXT}`
    } else {
      sections += `\n\n${PRIOR_OUTPUT_BLOCK_TITLE}\n${pou.block}`
      sections += `\n\n${UPDATE_DIRECTIVE_BLOCK_TITLE}\n${UPDATE_DIRECTIVE_TEXT}`
    }
  }

  // RFC-122: per-(task, asking-node) STOP override on a run that has no prior
  // answered clarify round to carry the trailer (a first run / pre-clarify
  // error-retry). `hasClarifyChannel` is already false (the scheduler forced
  // ask-back off), so the agent gets the output protocol below; this section
  // makes the user's "stop clarifying" decision explicit so the agent doesn't
  // re-ask out of its own bias. When a prior round exists the scheduler routes
  // the trailer through the flat clarify block instead and leaves this flag
  // false — never
  // both, so the STOP CLARIFYING trailer appears exactly once.
  if (stopNotice && !mandatoryAskBack) {
    sections += `\n\n${renderClarifyDirectiveTrailer('stop')}`
  }

  // Trailing protocol selection (RFC-100 — mandatory ask-back).
  //
  // `mandatoryAskBack` here is the scheduler's historical effectiveHasClarifyChannel:
  // true ⟺ a clarify channel is wired AND the user has not clicked "Stop
  // clarifying" (directive !== 'stop'). Call that state clarifyActive.
  //
  //   - clarifyActive + isolated → mandatory ask-back preamble + clarify-only
  //     format. NO <workflow-output> format is emitted, so the agent is never
  //     told how to finalize and must ask back.
  //   - clarifyActive + inline → a short reminder; the mandatory preamble +
  //     clarify format already live in the resumed opencode session.
  //   - NOT clarifyActive (stop round, or no clarify channel) → the output
  //     protocol block. The `hasClarifyChannel` check MUST come before the
  //     `inlineMode` check: on an inline STOP round every prior round was
  //     clarify-only, so the session has never seen the output format — this
  //     is the first time it must be emitted. Routing inline-stop to the
  //     reminder (as pre-RFC-100 did) would leave the agent with no port list.
  let trailing: string
  if (mandatoryAskBack) {
    trailing = inlineMode
      ? buildClarifyInlineReminder()
      : buildMandatoryClarifyPreamble() + buildClarifyProtocolBlock()
  } else if (optionalAskBack) {
    // RFC-165 (F12): optional ask-back — the agent sees BOTH envelope
    // formats and picks one. Inline (post-answer / same-session) rounds get
    // a short dual-choice reminder; the full formats already live in the
    // session transcript from the first round.
    trailing = inlineMode
      ? buildOptionalClarifyInlineReminder()
      : buildOptionalClarifyPreamble() +
        buildOptionalDualProtocolBlock(input.agentOutputs, input.agentOutputKinds)
  } else if (input.workgroupProtocolBlock !== undefined) {
    // RFC-164: workgroup runs replace (never extend) the agent-outputs block.
    trailing = input.workgroupProtocolBlock
  } else {
    trailing = buildProtocolBlock(input.agentOutputs, input.agentOutputKinds)
  }
  return body + sections + trailing
}

/**
 * The English output protocol block. Appended to the user prompt (never the
 * agent's system prompt — agent.md body is passed through verbatim) whenever
 * the node is NOT in mandatory ask-back mode: a node with no clarify channel,
 * or a clarify node on the user's "Stop clarifying" round. Instructs the agent
 * to end its reply with a `<workflow-output>` envelope listing the declared
 * ports.
 *
 * RFC-100 removed the old bi-modal (`hasClarifyChannel === true`) branch:
 * while a clarify channel is active the agent is given ONLY the clarify format
 * (see {@link buildMandatoryClarifyPreamble} + {@link buildClarifyProtocolBlock}),
 * never this block, so there is no longer an "output OR clarify" preamble to
 * emit here and no output-side escape hatch. The output-path wording below is
 * byte-identical to the pre-RFC-100 `hasClarifyChannel !== true` branch.
 *
 * When `agentOutputKinds` declares any port as `markdown_file`, the block
 * additionally emits explicit "write the file first, then emit only the
 * worktree-relative path" instructions for those ports. This fixes the
 * observed failure mode where agents return a path with no corresponding
 * file on disk and the framework's later `resolvePortContent` read fails.
 */
export function buildProtocolBlock(
  agentOutputs: string[],
  agentOutputKinds?: AgentOutputKindsMap,
): string {
  // RFC-080: per-port bullet / example annotation is owned by each kind's
  // handler (parsed-kind dispatch) — no more literal `=== 'markdown_file'`
  // branch. string/markdown → null suffix + '...' example (byte-identical to
  // the legacy plain bullet); path → the file-first suffix + path example;
  // signal → empty example.
  const handlerFor = (port: string) => {
    const parsed = parsePortKind(agentOutputKinds?.[port])
    return { parsed, handler: getHandlerForParsedKind(parsed) }
  }

  const renderBullet = (port: string): string => {
    const { parsed, handler } = handlerFor(port)
    const suffix = handler.bulletSuffix(parsed)
    return suffix !== null ? `  - ${port} ${suffix}\n` : `  - ${port}\n`
  }

  const renderExample = (port: string): string => {
    const { parsed, handler } = handlerFor(port)
    return `  <port name="${port}">${handler.examplePlaceholder(parsed)}</port>\n`
  }

  // RFC-049/080: per-kind prompt guidance is owned by each kind's handler.
  // Bucket the agent's declared ports by their parsed kind and concatenate
  // each handler's non-null guidance — string / markdown add nothing;
  // path / list emit their two-step / per-item reminders.
  const renderPerKindGuidance = (): string => {
    const groups = groupPortsByParsedKind(agentOutputs, agentOutputKinds)
    let out = ''
    for (const { handler, ports, portKinds } of groups) {
      const segment = handler.buildPromptGuidance({ ports, portKinds })
      if (segment !== null) out += segment
    }
    return out
  }

  let s = '\n\n---\nYou MUST end your reply with a `<workflow-output>` block listing these ports:\n'
  for (const port of agentOutputs) {
    s += renderBullet(port)
  }
  s += renderPerKindGuidance()
  s += '\nFormat:\n<workflow-output>\n'
  for (const port of agentOutputs) {
    s += renderExample(port)
  }
  s += '</workflow-output>'
  return s
}

/**
 * RFC-100 — the mandatory ask-back preamble. Emitted (followed immediately by
 * {@link buildClarifyProtocolBlock}) whenever a clarify channel is active
 * (wired AND the user has not clicked "Stop clarifying"). It REPLACES the old
 * RFC-039 bi-modal preamble: the agent is told it must ask back and is given
 * NO `<workflow-output>` format at all this round, so it cannot finalize early.
 * The output format returns only on the stop round, via {@link buildProtocolBlock}.
 *
 * Returns a leading `\n\n---\n` so callers can concatenate without their own
 * separator. The wording is locked by clarify-prompt regression tests — it is
 * the product contract for "no assumptions until the human has given every
 * detail", so changing it is a behavioural change, not a cosmetic one.
 */
export function buildMandatoryClarifyPreamble(): string {
  return (
    '\n\n---\n' +
    '**This node is in MANDATORY ASK-BACK (clarify) mode.** The user wired a clarify channel because they require you to interrogate intent BEFORE doing any work. Your ONLY valid reply this round is a `<workflow-clarify>` envelope (format below). You may NOT emit `<workflow-output>` — the framework will reject it and re-prompt you. You are released to produce final output only after the user clicks "Stop clarifying".\n\n' +
    'Operate with ZERO guessing. Treat every unstated detail as a blocker you resolve by asking, never by assuming.\n' +
    '- **Investigate first, then ask.** Read the inputs, the repository, referenced files, and every prior-round answer; use any skills and tools available to resolve what you can on your own — never spend a question on something you could determine yourself.\n' +
    '- **Ask the consequential things, in priority order.** Lead with the decisions that most change the outcome (naming, data shapes, API / contracts, UX behavior, scope boundaries, acceptance criteria, risky edge cases). Batch closely-related points into one question. Do NOT pad with low-stakes "just confirming…" questions — depth over breadth.\n' +
    '- **Pin down every detail that actually matters before acting.** Do not begin the deliverable until each decision needed to do it correctly is settled by the human. "Mostly clear" is not clear enough.\n' +
    '- **Never guess unfamiliar terms.** Any proprietary term, acronym, internal system / file / convention you do not fully understand — you MUST ask what it means; never infer or invent a meaning.\n' +
    '- **No assumptions, no fabrication, no silent defaults.** The moment you catch yourself hedging, writing "TBD", inventing a constraint the inputs didn\'t state, or choosing between plausible alternatives without a stated preference — stop and turn it into a question instead.\n' +
    '- **Ask in the same language as the inputs / the user.**\n' +
    '- **Asking back is the correct outcome here, not a failure.** Returning early because you "have enough to start" defeats the purpose of this node.'
  )
}

/**
 * RFC-023 / RFC-100 — the clarify format block. Appended right after
 * {@link buildMandatoryClarifyPreamble} while a clarify channel is active. It
 * is now the ONLY envelope format the agent sees this round — RFC-100 removed
 * the parallel `<workflow-output>` format from clarify rounds, so the agent
 * has no way to finalize until the user stops clarifying. Returns a leading
 * `\n\n` so callers can concatenate without injecting their own separator.
 */
/** RFC-023 — the clarify envelope format example (shared by the mandatory and
 *  optional protocol blocks so the two renderings can never drift). */
export const CLARIFY_FORMAT_EXAMPLE = `Format:
<workflow-clarify>
{
  "questions": [
    {
      "id": "<stable-id>",
      "title": "<question text>",
      "kind": "single" | "multi",
      "options": [
        {
          "label": "<picker text>",
          "description": "<what this option does / expected outcome / trade-offs>",
          "recommended": true | false,
          "recommendationReason": "<why the user should pick this one>"
        }
      ]
    }
  ]
}
</workflow-clarify>`

/** RFC-023 — the structural clarify rules shared by both directive modes
 *  (question/option caps, labels, legacy form, Q&A echo semantics). */
export const CLARIFY_STRUCTURAL_RULES = `- Limits: at most 5 questions, each question 2–4 options — any option beyond the 4th is silently dropped, so cap each question at 4. Do NOT add a "free text / other" option — the framework appends a user-input row automatically.
- Each option needs a non-empty "label". The other three fields are optional but strongly recommended: "description" (always render an explanation of what picking this option means), and — when "recommended" is true — "recommendationReason" (why this is your pick).
- Mark at most a couple of options across the whole envelope as "recommended": true. Recommended options sort to the top of the picker for the user.
- Legacy form is also accepted: \`"options": ["a", "b", "c"]\` — strings are lifted into \`{label, description:"", recommended:false, recommendationReason:""}\`. Prefer the structured form for new emissions.
- Once the user submits answers, you will receive every question answered so far in the next prompt under "## Clarify Q&A" — a single flat list where each question is an equal peer with the user's answer (a deterministic synthesis line). Treat every listed answer as an already-resolved decision.`

export function buildClarifyProtocolBlock(): string {
  return (
    `\n\n---\n` +
    '**Clarify format.** Emit exactly one <workflow-clarify> block and nothing else — no <workflow-output> anywhere in the reply. Asking back is the expected outcome of this round.\n\n' +
    CLARIFY_FORMAT_EXAMPLE +
    '\n\nHard rules — violation is treated as a malformed reply and the node will fail / retry:\n' +
    '- Your reply MUST contain exactly one <workflow-clarify> block and NO <workflow-output> — emitting <workflow-output> is rejected until the user stops clarifying. Defer all output ports to a later round; do not output partial data.\n' +
    CLARIFY_STRUCTURAL_RULES
  )
}

/**
 * RFC-026 / RFC-100 — the short reminder appended when a clarify rerun runs in
 * `inline` session mode AND the channel is still active (the user clicked
 * "Keep clarifying", not "Stop"). In inline mode opencode is resumed with
 * `--session <previous-id>`, so the mandatory ask-back preamble + clarify
 * format from earlier rounds already live in session memory; re-emitting them
 * would burn tokens and re-anchor the agent. This reminder just (a) acks the
 * fresh answers and (b) reasserts that the node is still in mandatory ask-back
 * mode.
 *
 * Note: the inline STOP round does NOT use this reminder — it routes to
 * {@link buildProtocolBlock} in renderUserPrompt (the session has never seen
 * the output format, so the stop round emits it in full).
 *
 * Returns a leading `\n\n---\n` separator so callers can concatenate after the
 * body / sections without re-injecting their own divider.
 */
export function buildClarifyInlineReminder(): string {
  return (
    '\n\n---\n' +
    'The user has answered your previous `<workflow-clarify>` round (see "Clarify Q&A — User Answers (Current Round)" above). ' +
    'This node stays in MANDATORY ask-back mode until the user clicks "Stop clarifying" — your next reply MUST be another `<workflow-clarify>` envelope. ' +
    'Do not emit `<workflow-output>`; it will be rejected. ' +
    'The full clarify format and asking-back rules from earlier in this session still apply and have not been re-emitted.'
  )
}

/**
 * RFC-165 (F12) — the OPTIONAL ask-back preamble. Unlike the mandatory
 * variant it explicitly offers BOTH outcomes and is followed by BOTH format
 * blocks (clarify + output); the agent must pick exactly one envelope.
 * Returns a leading `\n\n` like its mandatory sibling.
 */
export function buildOptionalClarifyPreamble(): string {
  return (
    '\n\n---\n' +
    '**This node has an OPTIONAL clarify channel.** If anything material to doing this task correctly is unclear — scope, contracts, naming, acceptance criteria, unfamiliar terms — ask the user FIRST by replying with a `<workflow-clarify>` envelope (format below). If the task is already unambiguous, skip asking and produce the final `<workflow-output>` directly.\n\n' +
    '- Reply with EXACTLY ONE envelope: either `<workflow-clarify>` or `<workflow-output>`, never both.\n' +
    '- Prefer asking over assuming: an unstated detail you cannot resolve from the inputs / repository yourself is worth a question, not a guess.\n' +
    '- Do not pad with low-stakes confirmations — if you ask, ask only the decisions that change the outcome.\n' +
    '- Ask in the same language as the inputs / the user.'
  )
}

/**
 * RFC-165 (F12, implementation-gate P1 fix) — the OPTIONAL dual-envelope
 * protocol block. The naive composition (mandatory clarify block + mandatory
 * output block) issued CONTRADICTORY commands — "reply MUST be clarify, no
 * output anywhere" followed by "you MUST end with output". This builder
 * renders the two formats as an explicit either/or: Option A (ask) with the
 * clarify format + its structural rules, Option B (finalize) with the port
 * protocol re-headed for choice. Returns a leading `\n\n`.
 */
export function buildOptionalDualProtocolBlock(
  agentOutputs: string[],
  agentOutputKinds?: AgentOutputKindsMap,
): string {
  const optionA =
    `\n\n---\n` +
    '**Option A — ask the user (reply with ONE `<workflow-clarify>` block and nothing else).**\n\n' +
    `FORMAT_PLACEHOLDER\n\n` +
    'Rules if you choose Option A — violation is treated as a malformed reply:\n' +
    '- The reply must contain exactly one <workflow-clarify> block and NO <workflow-output> — you finalize in a LATER round, after the user answers.\n' +
    `RULES_PLACEHOLDER`

  const MANDATORY_HEAD =
    'You MUST end your reply with a `<workflow-output>` block listing these ports:'
  const OPTIONAL_HEAD =
    '**Option B — finalize (reply with ONE `<workflow-output>` block).** If you choose to finalize instead of asking, end your reply with a `<workflow-output>` block listing these ports:'
  const outputBlock = buildProtocolBlock(agentOutputs, agentOutputKinds)
  // The head swap is locked by tests; if the mandatory head ever changes,
  // fall back to prefixing so the choice framing is never silently lost.
  const optionB = outputBlock.includes(MANDATORY_HEAD)
    ? outputBlock.replace(MANDATORY_HEAD, OPTIONAL_HEAD)
    : `\n\n---\n${OPTIONAL_HEAD}${outputBlock}`

  return optionA + optionB
}

/**
 * RFC-165 (F12) — the optional-mode inline (same-session) reminder: the user
 * answered the previous round; the agent may ask again OR finalize now. The
 * full formats from the first round still stand in the session transcript.
 */
export function buildOptionalClarifyInlineReminder(): string {
  return (
    '\n\n---\n' +
    'The user has answered your previous `<workflow-clarify>` round (see "Clarify Q&A — User Answers (Current Round)" above). ' +
    'This node remains in OPTIONAL ask-back mode: if something material is still unclear, reply with another `<workflow-clarify>` envelope; otherwise produce the final `<workflow-output>` now. ' +
    'Reply with exactly one of the two envelopes — the formats from earlier in this session still apply and have not been re-emitted.'
  )
}

/**
 * RFC-042 — short follow-up prompt sent in the SAME opencode session when the
 * agent's previous reply did not produce a parseable envelope. Used by the
 * runner's `envelopeFollowup` branch (see services/runner.ts) which kicks in
 * only when scheduler's `decideEnvelopeFollowup` determines the prior attempt
 * exited cleanly (exitCode === 0), captured a session id, emitted at least one
 * text line, and failed for a recognized envelope reason
 * (none / both / clarify-malformed).
 *
 * Critically this function does NOT take inputs / promptTemplate / agentOutputs
 * / reviewContext / clarifyContext — the prior round in the same session
 * already includes all of that, and re-emitting it would burn tokens and risk
 * re-anchoring the agent on stale framing. Mirrors RFC-026
 * `buildClarifyInlineReminder` design: deliberately short, deliberately bare.
 *
 * The clarifyDirective='continue' branch carries the RFC-039 strong-bias
 * "REQUIRED to be another <workflow-clarify>" wording verbatim — the user
 * explicitly clicked "Keep clarifying" on the previous round and the followup
 * must not let the agent skip back to <workflow-output> for brevity.
 */
/**
 * RFC-145 — the 6-value RENDER domain for envelope follow-up prompts. This
 * union used to be copied verbatim in three places (scheduler decision output,
 * runner RunNodeOptions, this input type); it is now defined once here and
 * imported by both backend sites.
 */
export type EnvelopeFollowupReason =
  | 'envelope-missing'
  | 'both-present'
  | 'clarify-malformed'
  | 'port-validation'
  | 'clarify-required'
  | 'envelope-port-malformed'

/**
 * RFC-145 — projection from the 7-value PRODUCER domain (`FAILURE_CODES`,
 * declared by the runner at each stamp point and persisted on
 * `node_runs.failure_code`) onto the 6-value render reason above.
 * `decideEnvelopeFollowup` (scheduler) looks this up instead of parsing
 * errorMessage prefixes with an order-sensitive startsWith chain.
 *
 * The one deliberate many-to-one edge: `clarify-forbidden` renders as
 * 'envelope-missing' — the agent asked another clarify after the user chose
 * "stop asking"; the correct follow-up instruction is "produce the output
 * envelope now", which IS the envelope-missing wording. This downgrade was
 * previously an implicit branch buried at the tail of the startsWith chain.
 *
 * `Record<FailureCode, …>` makes adding a code without a policy row a compile
 * error (same exhaustiveness idiom as GATE2_EXPECTED in the rerun-cause gates).
 */
export const FOLLOWUP_POLICY: Record<FailureCode, { reason: EnvelopeFollowupReason }> = {
  'envelope-missing': { reason: 'envelope-missing' },
  'clarify-and-output-both': { reason: 'both-present' },
  'clarify-questions-malformed': { reason: 'clarify-malformed' },
  'clarify-required': { reason: 'clarify-required' },
  'clarify-forbidden': { reason: 'envelope-missing' },
  'envelope-port-malformed': { reason: 'envelope-port-malformed' },
  'port-validation-failed': { reason: 'port-validation' },
}

/**
 * The ONE default budget for "how many times may a probabilistic model slip
 * be retried" across every engine (scheduling-architecture review 2026-07-14:
 * this `3` used to be hand-copied at four sites — scheduler
 * `defaultNodeRetries ?? 3`, workgroup `WG_PROTOCOL_RETRIES = 3`, dynamic
 * workflow `DW_MAX_GENERATE_ATTEMPTS = 3`, free_collab reopen `< 3` — kept in
 * sync by comments only). Semantics stay per-site (retries-after-first vs
 * total attempts; each site documents its own reading); the shared constant
 * only guarantees the sites can't silently diverge. Runtime overrides
 * (`defaultNodeRetries`) still win where offered.
 */
export const DEFAULT_PROTOCOL_RETRY_BUDGET = 3

export interface EnvelopeFollowupInput {
  /**
   * Whether the agent node has a clarify channel wired (RFC-023). Drives the
   * choice between the single-envelope follow-up wording and the bi-modal
   * follow-up wording.
   */
  hasClarifyChannel: boolean
  /**
   * Latest clarify session directive when hasClarifyChannel is true.
   * - 'continue' → append the RFC-039 strong-bias sentence at the tail.
   * - 'stop' / undefined → do not append it. ('stop' rounds have their own
   *   single-shot rerun path and would not normally reach a followup attempt;
   *   the explicit no-op here is defensive.)
   * Ignored when hasClarifyChannel is false.
   */
  clarifyDirective?: 'continue' | 'stop'
  /**
   * Which failure category scheduler observed on the prior attempt — used to
   * customize the opening line so the agent knows exactly what to fix.
   * Mapping from runner.ts errorMessage prefixes:
   *   'envelope-missing'   ← 'no <workflow-output> envelope found in stdout'
   *   'both-present'       ← 'clarify-and-output-both-present: ...'
   *   'clarify-malformed'  ← 'clarify-questions-...: ...'
   *   'port-validation'    ← 'port-validation-<kind>-<sub>: ...' (RFC-049)
   *   'clarify-required'   ← 'clarify-required-...' (RFC-100; emitted while a
   *                          clarify channel is ACTIVE and the agent produced
   *                          <workflow-output> / both / neither instead of a
   *                          <workflow-clarify> envelope)
   *   'envelope-port-malformed' ← 'envelope-port-malformed: ...' (a port was
   *                          opened but its </port> close was missing/corrupted,
   *                          e.g. `</|DSML|port>`, so the port could not be
   *                          extracted)
   *
   * When hasClarifyChannel is false, 'both-present' / 'clarify-malformed' /
   * 'clarify-required' are not reachable (those errors require an active
   * clarify channel); the function falls back to the 'envelope-missing'
   * opening line in that case.
   *
   * 'port-validation' and 'envelope-port-malformed' are reachable in BOTH
   * clarify-on and clarify-off modes because they concern `<workflow-output>`
   * ports regardless of channel wiring (in practice malformed-port only fires
   * with the channel inactive — RFC-100's runtime guard rejects output before
   * the envelope is even parsed while clarify is active — so both are preserved
   * across the hasClarifyChannel=false narrowing below).
   */
  reason: EnvelopeFollowupReason
  /**
   * RFC-049: backend-prerendered per-kind repair segments. shared/prompt.ts
   * does NOT import the OutputKindHandler registry (handlers live in
   * @agent-workflow/shared but are exercised via backend's NODE_VALIDATE_IO;
   * the *text* each handler emits is computed at the call site and threaded
   * through here so the renderer remains a pure string-splicer with no
   * cross-kind knowledge baked in). Each entry is a complete repair segment
   * including its own section header marker — the renderer joins them with
   * blank lines and inserts the joined block between the bi-modal preamble
   * and the RFC-039 strong-bias trailer.
   *
   * Only consumed when `reason === 'port-validation'`. Other reasons ignore
   * this field even if a backend bug threads it through.
   */
  perKindRepairBlocks?: ReadonlyArray<string>
  /**
   * RFC-165 (F12, implementation-gate P2 fix): true when the clarify channel
   * is OPTIONAL — the correction round must keep BOTH envelopes on the table
   * (the mandatory-only bullets would forbid a perfectly valid output-only
   * recovery). Only meaningful when `hasClarifyChannel` is true.
   */
  clarifyOptional?: boolean
}

export function renderEnvelopeFollowupPrompt(input: EnvelopeFollowupInput): string {
  const hasClarify = input.hasClarifyChannel
  // hasClarifyChannel=false narrows the reason — 'both-present' and
  // 'clarify-malformed' both require a clarify channel; 'port-validation' AND
  // 'envelope-port-malformed' are preserved across both modes (both concern
  // <workflow-output> ports regardless of channel wiring — and malformed-port
  // in practice only occurs with the channel inactive, so coercing it to
  // 'envelope-missing' here would drop its tailored opening line exactly when
  // it fires).
  const reason = hasClarify
    ? input.reason
    : input.reason === 'port-validation'
      ? 'port-validation'
      : input.reason === 'envelope-port-malformed'
        ? 'envelope-port-malformed'
        : 'envelope-missing'

  const isPortValidation = reason === 'port-validation'

  // ---------------------------------------------------------------------------
  // Section 1 — opening line.
  // ---------------------------------------------------------------------------
  let opening: string
  if (isPortValidation) {
    opening =
      'Your previous reply in this session emitted a `<workflow-output>` envelope, but one or more of its ports failed content validation. Re-emit the envelope with the failing ports fixed per the per-kind notes below.'
  } else if (reason === 'envelope-port-malformed') {
    // Placed before the generic `!hasClarify` branch: malformed-port failures
    // occur with the clarify channel inactive, so this would otherwise be
    // swallowed by the envelope-missing wording. A targeted message tells the
    // agent exactly what broke (the </port> close), which is more actionable
    // than "no envelope found".
    opening =
      'Your previous reply in this session emitted a `<workflow-output>` envelope, but one or more `<port name="...">` tags were never properly closed — the matching `</port>` was missing or corrupted (for example a stray token turned it into `</|...|port>`), so the framework could not extract those ports. Re-emit the envelope and make sure EVERY port is closed with a literal `</port>` tag — nothing inside the close tag, no extra characters.'
  } else if (!hasClarify) {
    opening =
      'Your previous reply in this session did not contain a `<workflow-output>` envelope. The framework cannot parse your result without it.'
  } else if (reason === 'both-present') {
    opening =
      'Your previous reply in this session contained BOTH `<workflow-output>` AND `<workflow-clarify>` — the framework requires exactly one. Pick one and re-emit.'
  } else if (reason === 'clarify-malformed') {
    opening =
      'Your previous reply in this session contained a `<workflow-clarify>` envelope but its JSON body could not be parsed. Re-emit a valid `<workflow-clarify>` body following the format previously specified in this session.'
  } else if (reason === 'clarify-required') {
    opening =
      'Your previous reply in this session did not ask back — it emitted a `<workflow-output>` envelope (or no `<workflow-clarify>` envelope) while this node is in MANDATORY ask-back mode. The framework rejected it. Your next reply MUST be a `<workflow-clarify>` envelope.'
  } else {
    opening =
      'Your previous reply in this session did not contain either a `<workflow-output>` or a `<workflow-clarify>` envelope. The framework cannot parse your result without exactly one of them.'
  }

  // ---------------------------------------------------------------------------
  // Section 2 — bullets. RFC-100: the clarify-channel branch is now
  // single-envelope too — while a clarify channel is active the agent MUST
  // emit `<workflow-clarify>` and may NOT emit `<workflow-output>`.
  //
  // `port-validation` is the exception: it only fires after a `<workflow-output>`
  // envelope was ACCEPTED (a stop round / no clarify channel — RFC-100's runtime
  // guard rejects output before validation while clarify is active), so its fix
  // is always to re-emit `<workflow-output>` with the failing ports corrected.
  // It therefore uses the output-oriented bullets regardless of channel.
  // ---------------------------------------------------------------------------
  const optional = hasClarify && input.clarifyOptional === true
  let bullets: string
  if (optional && !isPortValidation && reason !== 'envelope-port-malformed') {
    bullets =
      '- This node has an OPTIONAL clarify channel: reply with EXACTLY ONE envelope — either a `<workflow-clarify>` block (if something material is still unclear) or a `<workflow-output>` block (if you are ready to finalize), using the formats previously specified in this session.\n' +
      '- Never emit both, and do not emit anything after the closing tag of whichever envelope you pick.\n' +
      '- If you were mid-investigation, finish it first, then pick one envelope.'
  } else if (isPortValidation || reason === 'envelope-port-malformed' || !hasClarify) {
    bullets =
      '- If you have finished the requested work, end your NEXT reply with a `<workflow-output>` block using the EXACT format previously specified in this session (the same port list, the same `<port name="...">...</port>` shape). Do not summarize, do not omit the block.\n' +
      '- If you were not finished, complete the remaining work first, THEN emit the `<workflow-output>` block. The envelope is mandatory either way.\n' +
      '- For any list-typed port, re-emit EVERY item using the SAME per-item format previously specified in this session (one item per line, or — for a list of markdown documents — one full body per boundary-separated block). Sending only the first item or a truncated subset is the most common failure; the framework keeps only what this reply contains, so output the complete list.\n' +
      '- Do not emit anything after the closing `</workflow-output>` tag.'
  } else {
    bullets =
      '- This node is in MANDATORY ask-back mode: your reply MUST be exactly one `<workflow-clarify>` block, using the format previously specified in this session. Do NOT emit `<workflow-output>` — it will be rejected until the user clicks "Stop clarifying".\n' +
      '- If the previous reply was an in-progress draft, finish your investigation first, then ask every still-open question in a single `<workflow-clarify>`.\n' +
      '- Do not emit anything after the closing `</workflow-clarify>` tag.'
  }

  // ---------------------------------------------------------------------------
  // Section 3 — RFC-049 per-kind repair blocks. Only rendered when reason is
  // port-validation. Each handler self-renders its section header marker; we
  // join with blank lines so the markdown reads naturally between bullets and
  // the trailer.
  // ---------------------------------------------------------------------------
  const repairBlocks =
    isPortValidation && input.perKindRepairBlocks && input.perKindRepairBlocks.length > 0
      ? input.perKindRepairBlocks.join('\n')
      : ''

  // ---------------------------------------------------------------------------
  // Section 4 — RFC-039 strong-bias trailer (clarify-driven continue only).
  // ---------------------------------------------------------------------------
  let trailer = ''
  if (hasClarify && input.clarifyDirective === 'continue') {
    trailer = optional
      ? '\n\nThe user answered your previous questions. This node remains in OPTIONAL ask-back mode — ask again with `<workflow-clarify>` if something material is still unclear, or finalize now with `<workflow-output>`.'
      : '\n\nThe user clicked "Keep clarifying" — this node remains in mandatory ask-back mode, so your reply MUST be another `<workflow-clarify>` envelope. `<workflow-output>` is not an option until the user clicks "Stop clarifying".'
  }

  // ---------------------------------------------------------------------------
  // Header label keeps the same legacy "Envelope missing — follow-up." anchor
  // for RFC-042-shape failures so existing logs / tests don't shift; the
  // port-validation reason swaps to its own label for parity.
  // ---------------------------------------------------------------------------
  const label = isPortValidation
    ? 'Port content validation — follow-up.'
    : 'Envelope missing — follow-up.'

  return `\n\n---\n**${label}** ${opening}\n\n${bullets}${repairBlocks}${trailer}`
}

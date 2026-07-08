// Prompt assembly logic shared between the backend runner and the frontend
// preview pane (NodeInspector). Pure functions — no Bun / Node / DB
// imports. Mirrors design.md §7.2.

import type { AgentOutputKindsMap } from './schemas/agent'
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
 *   {{__clarify_questions__}}  ← questionsBlock (markdown listing of what the agent asked)
 *   {{__clarify_answers__}}    ← answersBlock   (markdown listing of user answers + synthesis)
 *   {{__clarify_iteration__}}  ← iteration      (string form of the clarify generation)
 *   {{__clarify_remaining__}}  ← remaining      (string; "max - current" when inside a
 *                                                wrapper-loop with a cap, "" otherwise)
 *
 * Templates that don't reference these tokens get framework-auto-appended
 * sections at the tail of the user prompt — same auto-append pattern as the
 * RFC-005 review context.
 */
export interface ClarifyPromptContext {
  /**
   * RFC-132 (PR-C): the single flat `## Clarify Q&A` block (built by
   * `renderFlatClarifyQueue` via `buildClarifyQueueContext`). When SET,
   * `renderUserPrompt` emits it VERBATIM and SKIPS the legacy round-grouped
   * `questionsBlock` / `answersBlock` auto-append sections (and, since the
   * scheduler no longer passes a `crossClarifyContext` in the flat path, the
   * designer's Q&A rides this same block — §5 ②b). ADDITIVE: when UNSET, the
   * renderer's behavior is byte-for-byte the legacy round-grouped path (the
   * frontend preview + prompt-injection tests stay green). The block already
   * carries its own `## Clarify Q&A` heading, so it is appended raw.
   */
  flatBlock?: string
  /** Markdown listing of the last-round questions. */
  questionsBlock?: string
  /** Markdown listing of user answers (incl. deterministic synthesis line per question). */
  answersBlock?: string
  /** Current clarifyIteration as string. '0' means first asking-back; '1' means
   *  first answers-received run; '2' means second ask-then-answer, etc. */
  iteration?: string
  /** Empty string when not inside a wrapper-loop with a cap; otherwise
   *  String(max_iterations - current iteration). Agent reads this to know how
   *  many ask-back rounds it has left before the framework exhausts the loop. */
  remaining?: string
  /** RFC-023 directive iteration: 'stop' means the runner MUST NOT append the
   *  `<workflow-clarify>` protocol block for this rerun, regardless of the
   *  agent node's clarify channel wiring. Not consumed by `renderUserPrompt`
   *  directly — it is read by the scheduler to override `hasClarifyChannel`
   *  before calling the runner. `undefined` (default) preserves legacy
   *  behaviour: the channel is gated purely on the workflow definition. */
  directive?: 'continue' | 'stop'
  /**
   * RFC-026: which clarify session mode emitted this context. Defaults to
   * `'isolated'` (treats missing / undefined the same as RFC-023 behavior).
   *
   * When `'inline'`, the runner has spawned opencode with `--session <id>`
   * and the prior rounds' Q&A + protocol blocks already live in opencode's
   * session memory. `renderUserPrompt` then:
   *   1. Skips the prior-rounds questions / answers auto-append sections
   *      (replaced by a single "User Answers (Current Round)" section,
   *      because `answersBlock` carries only the freshly submitted answers).
   *   2. Replaces the trailing protocol block(s) with a short inline
   *      reminder via `buildClarifyInlineReminder()` — re-emitting the
   *      full bi-modal preamble + format block would just burn tokens
   *      duplicating context the session already has.
   */
  mode?: 'isolated' | 'inline'
  /**
   * RFC-026: when `true` (always true under `mode === 'inline'`), the
   * `answersBlock` represents ONLY the most-recent round, NOT the
   * cumulative multi-round dump. The renderer uses this flag to pick the
   * correct section title ("User Answers (Current Round)" vs the legacy
   * "Prior Rounds (Answers)"). Kept as a separate boolean — rather than
   * implied from `mode === 'inline'` — so future modes can mix-and-match
   * without conflating semantics.
   */
  currentRoundOnly?: boolean
}

/**
 * RFC-056 cross-clarify-driven re-run context (designer side).
 *
 * Filled when an agent is being re-spawned because the cross-clarify scheduler
 * has aggregated submitted answers from one or more downstream questioner
 * nodes and is now triggering the designer rerun. All fields are pre-rendered
 * strings — the structured-to-markdown serialization lives in
 * shared/clarify-cross.ts so this module stays a pure substitution engine.
 *
 * Builtin tokens populated from this context:
 *   {{__external_feedback__}}            ← block (markdown body produced by
 *                                          buildExternalFeedbackBlock)
 *   {{__external_feedback_iteration__}}  ← iteration (string form of
 *                                          designer's clarifyIteration when
 *                                          triggered by external feedback)
 *   {{__external_feedback_sources__}}    ← sourcesCsv (comma-separated source
 *                                          questioner node ids, dictionary order)
 *
 * Templates that don't reference these tokens get framework-auto-appended
 * sections at the tail of the user prompt — same auto-append pattern as the
 * RFC-005 review context and RFC-023 clarify context.
 */
export interface CrossClarifyPromptContext {
  /** Pre-rendered markdown body listing every source's Q&A for this batch
   *  (dictionary-sorted by source questioner nodeId — see
   *  `buildExternalFeedbackBlock`). */
  block?: string
  /** Designer's current `clarifyIteration` as string (when triggered by an
   *  external feedback round — runtime API unchanged after RFC-064). '0' means
   *  the designer has never been triggered by external feedback; '1' is the
   *  first answers-received rerun; '2' is the second, etc. */
  iteration?: string
  /** Comma-separated list of source questioner nodeIds the current batch
   *  drew Q&A from. Lets agent templates reference "you are being reviewed
   *  by {{__external_feedback_sources__}} this round". */
  sourcesCsv?: string
  /**
   * RFC-056 §6 update mode (2026-05-22 amendment): pre-rendered markdown body
   * of the designer's last done output (one `### <port_name>` section per
   * declared output port). When present, `shared/prompt.ts` emits a
   * `## Prior Output (to update or regenerate)` section AND a `## Update Directive`
   * section so the agent knows to update the prior draft rather than
   * regenerate. The scheduler populates this only when the rerun was
   * triggered by a cross-clarify submit (NOT for fresh first-time runs).
   *
   * Empty string OR undefined means "no prior output to update" — emit
   * neither section (legacy regenerate-from-inputs behaviour).
   */
  priorOutputBlock?: string
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
 * Mutually exclusive with `crossClarifyContext.priorOutputBlock` — the scheduler
 * sets at most one, and `renderUserPrompt` suppresses this when cross-clarify is
 * already rendering its prior output. Empty / undefined `block` ⇒ no sections.
 */
export interface PriorOutputUpdateContext {
  block?: string
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
  /** RFC-005 review-driven re-run context. Absent for normal first-time runs. */
  reviewContext?: ReviewPromptContext
  /** RFC-023 clarify-driven re-run context. Absent for first runs and runs
   *  where the agent's clarify channel is wired but it hasn't yet asked. */
  clarifyContext?: ClarifyPromptContext
  /** RFC-056 cross-clarify-driven designer re-run context. Absent for first
   *  runs and runs that were not triggered by a cross-clarify submit batch. */
  crossClarifyContext?: CrossClarifyPromptContext
  /**
   * RFC-023 / RFC-039 / RFC-100: the scheduler's effectiveHasClarifyChannel —
   * true ⟺ a clarify channel is wired AND the user has not clicked "Stop
   * clarifying". When true, renderUserPrompt emits the RFC-100 mandatory
   * ask-back preamble + clarify-only format and NO `<workflow-output>` format,
   * so the agent must ask back and cannot finalize. When undefined / false
   * (stop round, or no clarify channel), the single-envelope output protocol
   * block is emitted unchanged. RFC-141: the same signal also selects the
   * prior-output directive variant (ask-back wording vs update wording), so
   * the directive can never contradict the trailing protocol.
   */
  hasClarifyChannel?: boolean
  /**
   * RFC-119 / RFC-141: prior-output context for a NON-cross-clarify rerun. When
   * set (and cross-clarify is not already owning the prior-output block, and
   * this is not an inline session resume), renderUserPrompt appends the
   * `## Prior Output` + directive pair — update variant on output rounds,
   * ask-back variant when mandatory ask-back is active (RFC-141). Absent for
   * first-time runs and any run with no prior captured output.
   */
  priorOutputUpdate?: PriorOutputUpdateContext
  /**
   * RFC-122: the scheduler set the per-(task, asking-node) clarify directive to
   * `stop` for THIS dispatch AND there is no prior-rounds `clarifyContext` whose
   * `answersBlock` already carries the trailer (i.e. a first run / a run with no
   * answered clarify round). When true the renderer injects the
   * `### User directive: STOP CLARIFYING` trailer right before the trailing
   * output protocol so the agent is told to proceed without asking even on its
   * very first run. `hasClarifyChannel` is already false by construction (the
   * scheduler forced ask-back off), so the output protocol is what trails.
   * Undefined / false (the override is absent or `continue`, or the trailer is
   * already inside `clarifyContext.answersBlock`) ⇒ byte-for-byte unchanged.
   */
  clarifyStopNotice?: boolean
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
  '__clarify_questions__',
  '__clarify_answers__',
  '__clarify_iteration__',
  '__clarify_remaining__',
  // RFC-056 cross-clarify context tokens. Stable names; renaming is a
  // contract break — see packages/shared/tests/clarify-cross-rfc056.test.ts
  // for the grep guard on `CROSS_CLARIFY_EXTERNAL_FEEDBACK_BLOCK_TITLE` +
  // packages/backend/tests/cross-clarify-prompt-injection-rfc056.test.ts
  // for the per-token presence guard.
  '__external_feedback__',
  '__external_feedback_iteration__',
  '__external_feedback_sources__',
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
 * System ports the framework injects via DEDICATED prompt sections instead of
 * the generic `## ${port_name}` auto-append loop. They appear in
 * `definition.edges` as system-channel targets (RFC-023 clarify channel /
 * RFC-056 cross-clarify channel) so the canvas can render handles + the
 * scheduler can track wiring, but the actual prompt content arrives via the
 * `## Clarify Q&A — Prior Rounds` / `## External Feedback` blocks rendered
 * below. Skipping these here keeps the auto-append from emitting empty,
 * misleading `## __port_name__` headers that make the human reader (and
 * the agent) think the cross-channel content is missing.
 */
const SYSTEM_PORT_NAMES = new Set<string>([
  '__clarify_response__', // RFC-023 self-clarify answers target
  '__external_feedback__', // RFC-056 cross-clarify designer feedback target
])

/**
 * Compose the user-prompt string sent to opencode for one node invocation:
 *
 *   1. Node-level template with `{{port_name}}` + built-in substitutions.
 *   2. Per-port sections for any input not referenced by the template.
 *   3. English protocol block at the end instructing the agent how to format
 *      its `<workflow-output>` reply.
 */
export function renderUserPrompt(input: RenderPromptInput): string {
  const tpl = input.promptTemplate ?? ''
  const referenced = new Set<string>()
  const rc = input.reviewContext
  const cc = input.clarifyContext
  const xcc = input.crossClarifyContext
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
        case '__clarify_questions__':
          return cc?.questionsBlock ?? ''
        case '__clarify_answers__':
          return cc?.answersBlock ?? ''
        case '__clarify_iteration__':
          return cc?.iteration ?? ''
        case '__clarify_remaining__':
          return cc?.remaining ?? ''
        case '__external_feedback__':
          return xcc?.block ?? ''
        case '__external_feedback_iteration__':
          return xcc?.iteration ?? ''
        case '__external_feedback_sources__':
          return xcc?.sourcesCsv ?? ''
        case '__repos__':
          return (input.meta.repos ?? []).map((r) => r.worktreePath).join('\n')
        case '__repo_names__':
          return (input.meta.repos ?? []).map((r) => r.worktreeDirName).join('\n')
        case '__repo_count__':
          return String((input.meta.repos ?? []).length)
      }
    }
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
    // are framework-injected via dedicated prompt blocks below
    // (`## Clarify Q&A — Prior Rounds (Answers)` / `## External Feedback`),
    // not via real edge dataflow. Rendering them as `## __port_name__`
    // sections produces empty / misleading headers that imply the
    // cross-clarify or self-clarify content is missing when it's actually
    // present further down. Skip the auto-append entry for them.
    if (SYSTEM_PORT_NAMES.has(name)) continue
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

  // RFC-023 / RFC-026: auto-append the clarify Q&A sections at the prompt
  // tail when the author's template did not explicitly reference the tokens.
  //
  // Inline mode (RFC-026): opencode session memory already holds prior
  // rounds. Skip the "Prior Rounds (Questions)" section; emit a single
  // "User Answers (Current Round)" carrying just the freshly submitted
  // answers. The questions block is suppressed entirely in inline mode —
  // re-rendering questions the agent already saw burns tokens and re-anchors
  // it to the prior wording. (Authors who explicitly reference
  // `{{__clarify_questions__}}` still get substitution above — that path is
  // a deliberate template choice.)
  if (cc?.flatBlock !== undefined && cc.flatBlock.trim().length > 0) {
    // RFC-132 (PR-C): the unified flat `## Clarify Q&A` block supersedes the
    // round-grouped questions/answers sections below (self / questioner /
    // designer all render as equal peers inside it — §5). Emit it verbatim (it
    // owns its own heading) and SKIP the legacy sections. The block is
    // round-agnostic, so inline mode needs no separate "current round" title.
    sections += `\n\n${cc.flatBlock}`
  } else if (cc !== undefined) {
    if (
      !inlineMode &&
      cc.questionsBlock !== undefined &&
      cc.questionsBlock.trim().length > 0 &&
      !referenced.has('__clarify_questions__')
    ) {
      sections += `\n\n## Clarify Q&A — Prior Rounds (Questions)\n${cc.questionsBlock}`
    }
    if (
      cc.answersBlock !== undefined &&
      cc.answersBlock.trim().length > 0 &&
      !referenced.has('__clarify_answers__')
    ) {
      const heading =
        inlineMode || cc.currentRoundOnly === true
          ? 'Clarify Q&A — User Answers (Current Round)'
          : 'Clarify Q&A — Prior Rounds (Answers)'
      sections += `\n\n## ${heading}\n${cc.answersBlock}`
    }
  }

  // RFC-056: auto-append the External Feedback section when the designer's
  // template didn't reference `{{__external_feedback__}}` directly. Placed
  // after RFC-023 self-clarify auto-append so a designer that has BOTH
  // sources of feedback in the same rerun shows them in stable order:
  //   ## Self Clarify Q&A (RFC-023, if any)
  //   ## Prior Output (to update or regenerate) (RFC-056 update mode, if any)
  //   ## External Feedback (RFC-056, if any)
  //   ## Update Directive (RFC-056 update mode, if any)
  // A single `clarifyIteration` counter covers both self-clarify and
  // cross-clarify rounds via RFC-064 unification (the `kind` column on
  // `clarify_rounds` is the only "self vs cross" discriminator the runtime
  // needs); see RFC-064 design.md §3 + RFC-056 design.md §6.3.
  if (xcc !== undefined) {
    // §6 update-mode prior-output section (renders BEFORE External Feedback
    // so the agent reads "here's the draft you're updating" → "here's what
    // the user wants changed" in that order).
    if (xcc.priorOutputBlock !== undefined && xcc.priorOutputBlock.trim().length > 0) {
      sections += `\n\n${PRIOR_OUTPUT_BLOCK_TITLE}\n${xcc.priorOutputBlock}`
    }
    if (
      xcc.block !== undefined &&
      xcc.block.trim().length > 0 &&
      !referenced.has('__external_feedback__')
    ) {
      sections += `\n\n## External Feedback\n${xcc.block}`
    }
    // §6 update-mode directive (renders AFTER External Feedback so it's the
    // last instruction before the protocol block — primes the agent's
    // "what do I do this round" mental model on update-mode terms).
    if (xcc.priorOutputBlock !== undefined && xcc.priorOutputBlock.trim().length > 0) {
      sections += `\n\n${UPDATE_DIRECTIVE_BLOCK_TITLE}\n${UPDATE_DIRECTIVE_TEXT}`
    }
  }

  // RFC-119 / RFC-141: generalized rerun prior-output. Emits ONLY when:
  //   - the scheduler set priorOutputUpdate.block (a prior run captured output), AND
  //   - cross-clarify is NOT already rendering its own prior output (mutual
  //     exclusion — never inject two prior-output blocks in one prompt), AND
  //   - NOT an inline session resume (the resumed session already holds the prior
  //     output — re-injecting wastes tokens and re-anchors on stale text).
  // RFC-141: a mandatory ask-back round now ALSO renders it — with the
  // clarify-flavored title + directive pair (frame your QUESTIONS around revising
  // the draft) instead of the update pair (which demands a <workflow-output>
  // this very round and would contradict the clarify-only protocol). The variant
  // is selected off the SAME hasClarifyChannel signal that picks the trailing
  // protocol below, so wording and protocol can never disagree.
  const pou = input.priorOutputUpdate
  if (
    pou?.block !== undefined &&
    pou.block.trim().length > 0 &&
    !(xcc?.priorOutputBlock !== undefined && xcc.priorOutputBlock.trim().length > 0) &&
    !inlineMode
  ) {
    if (input.hasClarifyChannel === true) {
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
  // the trailer through `clarifyContext.answersBlock` instead (via
  // buildPromptContext's directiveOverride) and leaves this flag false — never
  // both, so the STOP CLARIFYING trailer appears exactly once.
  if (input.clarifyStopNotice === true && input.hasClarifyChannel !== true) {
    sections += `\n\n${renderClarifyDirectiveTrailer('stop')}`
  }

  // Trailing protocol selection (RFC-100 — mandatory ask-back).
  //
  // `input.hasClarifyChannel` here is the scheduler's effectiveHasClarifyChannel:
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
  if (input.hasClarifyChannel === true) {
    trailing = inlineMode
      ? buildClarifyInlineReminder()
      : buildMandatoryClarifyPreamble() + buildClarifyProtocolBlock()
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
export function buildClarifyProtocolBlock(): string {
  return `

---
**Clarify format.** Emit exactly one <workflow-clarify> block and nothing else — no <workflow-output> anywhere in the reply. Asking back is the expected outcome of this round.

Format:
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
</workflow-clarify>

Hard rules — violation is treated as a malformed reply and the node will fail / retry:
- Your reply MUST contain exactly one <workflow-clarify> block and NO <workflow-output> — emitting <workflow-output> is rejected until the user stops clarifying. Defer all output ports to a later round; do not output partial data.
- Limits: at most 5 questions, each question 2–4 options — any option beyond the 4th is silently dropped, so cap each question at 4. Do NOT add a "free text / other" option — the framework appends a user-input row automatically.
- Each option needs a non-empty "label". The other three fields are optional but strongly recommended: "description" (always render an explanation of what picking this option means), and — when "recommended" is true — "recommendationReason" (why this is your pick).
- Mark at most a couple of options across the whole envelope as "recommended": true. Recommended options sort to the top of the picker for the user.
- Legacy form is also accepted: \`"options": ["a", "b", "c"]\` — strings are lifted into \`{label, description:"", recommended:false, recommendationReason:""}\`. Prefer the structured form for new emissions.
- Once the user submits answers, you will receive every question answered so far in the next prompt under "## Clarify Q&A" — a single flat list where each question is an equal peer with the user's answer (a deterministic synthesis line). Treat every listed answer as an already-resolved decision.`
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
  let bullets: string
  if (isPortValidation || reason === 'envelope-port-malformed' || !hasClarify) {
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
    trailer =
      '\n\nThe user clicked "Keep clarifying" — this node remains in mandatory ask-back mode, so your reply MUST be another `<workflow-clarify>` envelope. `<workflow-output>` is not an option until the user clicks "Stop clarifying".'
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

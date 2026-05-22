// Prompt assembly logic shared between the backend runner and the frontend
// preview pane (NodeInspector). Pure functions — no Bun / Node / DB
// imports. Mirrors design.md §7.2.

import type { AgentOutputKindsMap } from './schemas/agent'
import { CROSS_CLARIFY_UPDATE_DIRECTIVE_TEXT } from './clarify-cross'
import { groupPortsByKind } from './outputKinds'

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
 *   {{__clarify_iteration__}}  ← iteration      (string form of source.clarifyIteration)
 *   {{__clarify_remaining__}}  ← remaining      (string; "max - current" when inside a
 *                                                wrapper-loop with a cap, "" otherwise)
 *
 * Templates that don't reference these tokens get framework-auto-appended
 * sections at the tail of the user prompt — same auto-append pattern as the
 * RFC-005 review context.
 */
export interface ClarifyPromptContext {
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
 *                                          designer's crossClarifyIteration)
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
  /** Designer's current `cross_clarify_iteration` as string. '0' means the
   *  designer has never been triggered by external feedback; '1' is the
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
   * `## Prior Output (to be updated)` section AND a `## Update Directive`
   * section so the agent knows to update the prior draft rather than
   * regenerate. The scheduler populates this only when the rerun was
   * triggered by a cross-clarify submit (NOT for fresh first-time runs).
   *
   * Empty string OR undefined means "no prior output to update" — emit
   * neither section (legacy regenerate-from-inputs behaviour).
   */
  priorOutputBlock?: string
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
   * RFC-023 + RFC-039: when true, the trailing protocol block is rewritten
   * as a bi-modal preamble. RFC-039 made the basetone "default to (B)
   * `<workflow-clarify>`; emit (A) `<workflow-output>` only when every
   * decision is already pinned down" — the legacy "MUST end with
   * <workflow-output>" wording anchored the agent toward output, and the
   * intermediate "equally first-class" framing was still too soft. The
   * clarify-format block is appended after. When undefined / false, the
   * legacy single-envelope wording is emitted unchanged.
   */
  hasClarifyChannel?: boolean
}

const TEMPLATE_RE = /\{\{(\w+)\}\}/g

const BUILTIN_VARS = new Set([
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
  if (cc !== undefined) {
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
  //   ## Prior Output (to be updated) (RFC-056 update mode, if any)
  //   ## External Feedback (RFC-056, if any)
  //   ## Update Directive (RFC-056 update mode, if any)
  // Two iteration counters (clarifyIteration / crossClarifyIteration) run
  // orthogonally — see RFC-056 design.md §6.3 + 2026-05-22 amendment.
  if (xcc !== undefined) {
    // §6 update-mode prior-output section (renders BEFORE External Feedback
    // so the agent reads "here's the draft you're updating" → "here's what
    // the user wants changed" in that order).
    if (xcc.priorOutputBlock !== undefined && xcc.priorOutputBlock.trim().length > 0) {
      sections += `\n\n## Prior Output (to be updated)\n${xcc.priorOutputBlock}`
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
      sections += `\n\n## Update Directive\n${CROSS_CLARIFY_UPDATE_DIRECTIVE_TEXT}`
    }
  }

  // Trailing protocol selection:
  //   - inline mode: opencode session already has the bi-modal preamble +
  //     full clarify format block from earlier rounds. Emit only a short
  //     reminder so the agent knows fresh user answers landed.
  //   - has-clarify-channel (RFC-023): bi-modal preamble + clarify format.
  //   - default: legacy single-envelope output protocol.
  let trailing: string
  if (inlineMode) {
    trailing = buildClarifyInlineReminder()
  } else if (input.hasClarifyChannel === true) {
    trailing =
      buildProtocolBlock(input.agentOutputs, true, input.agentOutputKinds) +
      buildClarifyProtocolBlock()
  } else {
    trailing = buildProtocolBlock(input.agentOutputs, false, input.agentOutputKinds)
  }
  return body + sections + trailing
}

/**
 * The English protocol block. Always appended to user prompt, never to the
 * agent's system prompt (agent.md body is passed through verbatim).
 *
 * When `hasClarifyChannel` is true (RFC-023 + RFC-039), the block is rewritten
 * as a bi-modal preamble. RFC-039 sharpened the basetone: the default is now
 * "you should ask back (B)"; emitting `<workflow-output>` directly is allowed
 * ONLY when every decision needed to satisfy the inputs has already been
 * pinned down. The user wired a clarify channel because they expect ask-back;
 * the legacy "equally first-class" wording was too soft and let agents glide
 * into output mode whenever the inputs looked plausible. The clarify-format
 * block is appended by `renderUserPrompt` immediately after. No runner-side
 * hard rejection — the agent retains an escape hatch when inputs are truly
 * unambiguous.
 *
 * When `agentOutputKinds` declares any port as `markdown_file`, the block
 * additionally emits explicit "write the file first, then emit only the
 * worktree-relative path" instructions for those ports. This fixes the
 * observed failure mode where agents return a path with no corresponding
 * file on disk and the framework's later `resolvePortContent` read fails.
 */
export function buildProtocolBlock(
  agentOutputs: string[],
  hasClarifyChannel?: boolean,
  agentOutputKinds?: AgentOutputKindsMap,
): string {
  const isMdFile = (port: string): boolean => agentOutputKinds?.[port] === 'markdown_file'

  const renderBullet = (port: string): string =>
    isMdFile(port)
      ? `  - ${port} (markdown_file — write the file first, then emit only its worktree-relative path)\n`
      : `  - ${port}\n`

  const renderExample = (port: string): string =>
    isMdFile(port)
      ? `  <port name="${port}"><worktree-relative path to the .md file you just wrote></port>\n`
      : `  <port name="${port}">...</port>\n`

  // RFC-049: per-kind prompt guidance is now owned by each kind's handler.
  // Iterate the registered handlers for the kinds declared on this agent and
  // concatenate their non-null guidance segments. Handlers see ONLY ports
  // declared as their kind — string / markdown handlers add nothing today;
  // markdown_file handler emits the two-step protocol reminder.
  const renderPerKindGuidance = (): string => {
    const groups = groupPortsByKind(agentOutputs, agentOutputKinds)
    let out = ''
    for (const { handler, ports } of groups) {
      const segment = handler.buildPromptGuidance({ ports })
      if (segment !== null) out += segment
    }
    return out
  }

  if (hasClarifyChannel !== true) {
    let s =
      '\n\n---\nYou MUST end your reply with a `<workflow-output>` block listing these ports:\n'
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

  let s = '\n\n---\n'
  s +=
    '**This node has a clarify channel. The user has wired it because they expect you to ask back when intent is under-specified.**\n\n'
  s +=
    'By default, your next reply should be (B) `<workflow-clarify>` — ask the user to disambiguate before you commit a final answer. You may emit (A) `<workflow-output>` directly ONLY when every decision needed to satisfy the inputs has already been pinned down by the prompt / inputs / earlier rounds — i.e. there is genuinely nothing left to ask. Picking (A) means you are taking full responsibility that no naming choice, technical option, UX decision, or unstated constraint is being guessed at.\n\n'
  s +=
    'If, while drafting, you find yourself: hedging, marking decisions as "TBD", inventing constraints not given by the inputs, choosing between plausible alternatives without a stated preference, or rationalizing your own pick of the user\'s intent — you do NOT have the green light for (A); emit (B) instead.\n\n'
  s +=
    '  (A) `<workflow-output>` — final answer, format described under "(A) `<workflow-output>` format" below.\n'
  s +=
    '  (B) `<workflow-clarify>` — ask the user; format described under "Clarify mode is enabled for this node" further below.\n\n'
  s += '— (A) `<workflow-output>` format —\n'
  s +=
    'When you are ready to commit the final answer, end your reply with a `<workflow-output>` block listing these ports:\n'
  for (const port of agentOutputs) {
    s += renderBullet(port)
  }
  s += renderPerKindGuidance()
  s += '\n<workflow-output>\n'
  for (const port of agentOutputs) {
    s += renderExample(port)
  }
  s += '</workflow-output>'
  return s
}

/**
 * RFC-023 — the clarify protocol block. Appended to the user prompt by the
 * runner only when the current agent node has a clarify channel wired
 * (i.e. an outbound edge on its system port `__clarify__`). When present, it
 * lives AFTER the standard `<workflow-output>` block so the agent reads both
 * envelopes and chooses exactly one. Returns a leading `\n\n` so callers can
 * concatenate without injecting their own separator.
 */
export function buildClarifyProtocolBlock(): string {
  return `

---
**Clarify mode is enabled for this node.** When you have unresolved questions, missing context, or decisions you would otherwise have to guess at, ask back by emitting a <workflow-clarify> block instead of <workflow-output> (no <workflow-output> in the same reply). Ask-back is a first-class outcome — prefer it over guessing.

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
- A reply must contain EITHER one <workflow-output> block OR one <workflow-clarify> block — NEVER both, NEVER neither.
- Asking back means deferring all output ports to the next round; do not also output partial data.
- Limits: at most 5 questions, each question 2–4 options — any option beyond the 4th is silently dropped, so cap each question at 4. Do NOT add a "free text / other" option — the framework appends a user-input row automatically.
- Each option needs a non-empty "label". The other three fields are optional but strongly recommended: "description" (always render an explanation of what picking this option means), and — when "recommended" is true — "recommendationReason" (why this is your pick).
- Mark at most a couple of options across the whole envelope as "recommended": true. Recommended options sort to the top of the picker for the user.
- Legacy form is also accepted: \`"options": ["a", "b", "c"]\` — strings are lifted into \`{label, description:"", recommended:false, recommendationReason:""}\`. Prefer the structured form for new emissions.
- Once the user submits answers, you will receive every prior round's Q&A in the next prompt under "## Clarify Q&A — Prior Rounds (Answers)" — each round is wrapped in a "### Round N" header with a deterministic synthesis line per question. Treat earlier rounds as already-resolved decisions; only the latest round carries the user's standing continue/stop directive.`
}

/**
 * RFC-026 — the short reminder appended to the user prompt when a clarify
 * rerun is running in `inline` session mode.
 *
 * In inline mode the runner spawns opencode with `--session <previous-id>`,
 * so the prior bi-modal preamble + full clarify protocol block are already
 * in opencode's session memory. Re-emitting them would burn tokens and risk
 * re-anchoring the agent on stale wording. This reminder is the minimum
 * needed to (a) acknowledge the fresh user answers landed, (b) keep the
 * two-envelope choice salient for the next reply.
 *
 * Returns a leading `\n\n---\n` separator so callers can concatenate after
 * the body / sections without re-injecting their own divider.
 */
export function buildClarifyInlineReminder(): string {
  return (
    '\n\n---\n' +
    'The user has answered your previous `<workflow-clarify>` round (see "Clarify Q&A — User Answers (Current Round)" above). ' +
    'Reply with EXACTLY ONE envelope — either `<workflow-output>` if the answers unblocked you, or another `<workflow-clarify>` if real blockers remain. ' +
    'Earlier rounds, the full envelope formats, and the asking-back rules are still in this session — they have not been re-emitted.'
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
   *
   * When hasClarifyChannel is false, 'both-present' / 'clarify-malformed' are
   * not reachable (those errors require a clarify channel to exist); the
   * function falls back to the 'envelope-missing' opening line in that case.
   *
   * 'port-validation' is reachable in BOTH clarify-on and clarify-off modes
   * because port content validation runs against `<workflow-output>` ports
   * regardless of channel wiring.
   */
  reason: 'envelope-missing' | 'both-present' | 'clarify-malformed' | 'port-validation'
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
  // 'clarify-malformed' both require a clarify channel; 'port-validation'
  // is preserved across both modes (port content validation runs against
  // <workflow-output> regardless of channel wiring).
  const reason = hasClarify
    ? input.reason
    : input.reason === 'port-validation'
      ? 'port-validation'
      : 'envelope-missing'

  const isPortValidation = reason === 'port-validation'

  // ---------------------------------------------------------------------------
  // Section 1 — opening line.
  // ---------------------------------------------------------------------------
  let opening: string
  if (isPortValidation) {
    opening =
      'Your previous reply in this session emitted a `<workflow-output>` envelope, but one or more of its ports failed content validation. Re-emit the envelope with the failing ports fixed per the per-kind notes below.'
  } else if (!hasClarify) {
    opening =
      'Your previous reply in this session did not contain a `<workflow-output>` envelope. The framework cannot parse your result without it.'
  } else if (reason === 'both-present') {
    opening =
      'Your previous reply in this session contained BOTH `<workflow-output>` AND `<workflow-clarify>` — the framework requires exactly one. Pick one and re-emit.'
  } else if (reason === 'clarify-malformed') {
    opening =
      'Your previous reply in this session contained a `<workflow-clarify>` envelope but its JSON body could not be parsed. Re-emit a valid `<workflow-clarify>` body following the format previously specified in this session.'
  } else {
    opening =
      'Your previous reply in this session did not contain either a `<workflow-output>` or a `<workflow-clarify>` envelope. The framework cannot parse your result without exactly one of them.'
  }

  // ---------------------------------------------------------------------------
  // Section 2 — bullets (bi-modal preamble for clarify channel agents,
  // single-envelope for everyone else).
  // ---------------------------------------------------------------------------
  let bullets: string
  if (!hasClarify) {
    bullets =
      '- If you have finished the requested work, end your NEXT reply with a `<workflow-output>` block using the EXACT format previously specified in this session (the same port list, the same `<port name="...">...</port>` shape). Do not summarize, do not omit the block.\n' +
      '- If you were not finished, complete the remaining work first, THEN emit the `<workflow-output>` block. The envelope is mandatory either way.\n' +
      '- Do not emit anything after the closing `</workflow-output>` tag.'
  } else {
    bullets =
      '- By default, per the clarify protocol previously stated in this session, your next reply should be (B) `<workflow-clarify>` — ask back to disambiguate. Emit (A) `<workflow-output>` directly ONLY when every decision is already pinned down. (RFC-039 bias still applies.)\n' +
      '- If the previous reply was an in-progress draft, finish the work first, then commit to EXACTLY ONE envelope.\n' +
      '- A reply must contain EITHER one `<workflow-output>` block OR one `<workflow-clarify>` block — NEVER both, NEVER neither.\n' +
      '- Do not emit anything after the closing envelope tag.'
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
      '\n\nThe user has explicitly clicked "Keep clarifying" — unless every still-unresolved detail has been pinned down by the answers earlier in this session, your reply is REQUIRED to be another `<workflow-clarify>` envelope. Skipping to `<workflow-output>` for the sake of brevity is not allowed.'
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

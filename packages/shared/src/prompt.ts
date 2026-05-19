// Prompt assembly logic shared between the backend runner and the frontend
// preview pane (NodeInspector). Pure functions — no Bun / Node / DB
// imports. Mirrors design.md §7.2.

import type { AgentOutputKindsMap } from './schemas/agent'

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
  const mdFilePorts = agentOutputs.filter(isMdFile)

  const renderBullet = (port: string): string =>
    isMdFile(port)
      ? `  - ${port} (markdown_file — write the file first, then emit only its worktree-relative path)\n`
      : `  - ${port}\n`

  const renderExample = (port: string): string =>
    isMdFile(port)
      ? `  <port name="${port}"><worktree-relative path to the .md file you just wrote></port>\n`
      : `  <port name="${port}">...</port>\n`

  if (hasClarifyChannel !== true) {
    let s =
      '\n\n---\nYou MUST end your reply with a `<workflow-output>` block listing these ports:\n'
    for (const port of agentOutputs) {
      s += renderBullet(port)
    }
    if (mdFilePorts.length > 0) {
      s += buildMarkdownFilePortGuidance(mdFilePorts)
    }
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
  if (mdFilePorts.length > 0) {
    s += buildMarkdownFilePortGuidance(mdFilePorts)
  }
  s += '\n<workflow-output>\n'
  for (const port of agentOutputs) {
    s += renderExample(port)
  }
  s += '</workflow-output>'
  return s
}

/**
 * Rendered guidance block inserted into `buildProtocolBlock` whenever the
 * agent declares ≥ 1 `markdown_file` output port.
 *
 * Why this exists: production agents have been observed to emit a worktree
 * path inside `<port>` without first creating the file on disk. The
 * framework's `resolvePortContent` (envelope.ts) then fails the run when it
 * tries to `readFileSync` the missing file. The contract was always
 * "markdown_file = worktree-relative path to a real file", but the protocol
 * block didn't say so loudly enough — the bare port list + `...` placeholder
 * looked the same regardless of kind, so agents free-styled. This block makes
 * the file-first rule unmissable and names the offending ports explicitly so
 * the agent can't conflate them with sibling `string` / `markdown` ports.
 */
function buildMarkdownFilePortGuidance(mdFilePorts: string[]): string {
  const list = mdFilePorts.map((p) => `\`${p}\``).join(', ')
  return (
    '\n' +
    `For ports declared \`markdown_file\` above (${list}) you MUST follow this two-step protocol — emitting only a path without the file behind it will fail the run:\n` +
    '  1. First, USE A FILE-WRITING TOOL (Write / Edit / shell `cat > path` / equivalent) to persist the FULL markdown body to a file inside the current working directory (the task worktree). Pick a stable worktree-relative path such as `report.md` or `docs/findings.md`.\n' +
    '  2. THEN, place ONLY that worktree-relative path inside the matching `<port>` tag — no markdown body, no code fences, no surrounding prose, no leading or trailing whitespace, no placeholder. The framework reads the file at that path; a path that does not point to an existing file causes the run to fail.\n'
  )
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
   *   'envelope-missing' ← 'no <workflow-output> envelope found in stdout'
   *   'both-present'     ← 'clarify-and-output-both-present: ...'
   *   'clarify-malformed' ← 'clarify-questions-...: ...'
   *
   * When hasClarifyChannel is false, 'both-present' / 'clarify-malformed' are
   * not reachable (those errors require a clarify channel to exist); the
   * function falls back to the 'envelope-missing' opening line in that case.
   */
  reason: 'envelope-missing' | 'both-present' | 'clarify-malformed'
}

export function renderEnvelopeFollowupPrompt(input: EnvelopeFollowupInput): string {
  const hasClarify = input.hasClarifyChannel
  const reason = hasClarify ? input.reason : 'envelope-missing'

  let opening: string
  if (!hasClarify) {
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

  let trailer = ''
  if (hasClarify && input.clarifyDirective === 'continue') {
    trailer =
      '\n\nThe user has explicitly clicked "Keep clarifying" — unless every still-unresolved detail has been pinned down by the answers earlier in this session, your reply is REQUIRED to be another `<workflow-clarify>` envelope. Skipping to `<workflow-output>` for the sake of brevity is not allowed.'
  }

  return `\n\n---\n**Envelope missing — follow-up.** ${opening}\n\n${bullets}${trailer}`
}

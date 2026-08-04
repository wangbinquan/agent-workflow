// RFC-242 T1 — the frozen `agent.permission` → Claude tool-gate mapping.
//
// `agent.permission` IS opencode's permission vocabulary (verbatim passthrough,
// RFC-073 / `shared/schemas/agent.ts`), and Claude has no equivalent: opencode
// grades ACTION CLASSES three ways, Claude prunes a LOADED TOOL SET by name.
// There is no natural bijection, so the translation is an explicit, frozen,
// test-locked contract rather than an inference.
//
// Source of truth for both vocabularies (read, not remembered):
//  - opencode: `packages/core/src/v1/config/permission.ts` — Action =
//    'ask'|'allow'|'deny'; known keys read/edit/glob/grep/list/bash/task/
//    external_directory/todowrite/question/webfetch/websearch/lsp/doom_loop/
//    skill; a Rule may be an Action OR a Record<pattern, Action>; a bare
//    top-level Action normalizes to `{'*': action}`.
//  - claude 2.1.220 built-in load set (init event, hands-on): Task, Bash,
//    Edit, NotebookEdit, Read, Skill, WebFetch, WebSearch, Write, plus
//    harness-only tools (Cron*, Task*, Monitor, …) the platform never grants.
//
// Design decisions (user, 2026-07-31):
//  - `ask` has no meaning in headless mode (nobody can answer) → treated as
//    `deny`, and the caller surfaces a save-time warning.
//  - An UNKNOWN permission key fails closed: it grants nothing. Unknown keys
//    never widen the gate.
//  - A pattern Rule (Record<pattern, Action>) cannot be expressed in a load-set
//    prune. It is honored conservatively: the tool loads only if at least one
//    pattern allows, and the caller is told the granularity was lost.

import type { AgentPermission } from '@agent-workflow/shared'

/** Claude built-ins the platform is willing to grant to a business node. */
const GRANTABLE = [
  'Read',
  'Glob',
  'Grep',
  'Edit',
  'Write',
  'NotebookEdit',
  'Bash',
  'Task',
  'WebFetch',
  'WebSearch',
  'Skill',
] as const
export type GrantableClaudeTool = (typeof GRANTABLE)[number]

/**
 * The frozen table. Keys are opencode permission keys; values are the Claude
 * tools that key governs. Keys absent here grant nothing (fail closed).
 *
 * Deliberate notes:
 *  - `read` also governs Glob/Grep only when those have no own key; opencode
 *    ships explicit `glob`/`grep` keys, so they map independently.
 *  - `edit` covers every write-shaped built-in (Edit/Write/NotebookEdit):
 *    opencode's `edit` is the write action class, and leaving Write ungoverned
 *    would let an `edit: deny` agent still create files.
 *  - `list` has no Claude counterpart (Glob covers enumeration) → maps to
 *    nothing; it neither grants nor denies on its own.
 *  - `external_directory` is a PATH domain, not a tool → not part of the load
 *    set (§ handled by cwd containment, not by --tools).
 *  - `lsp` / `doom_loop` / `todowrite` / `question` have no grantable Claude
 *    equivalent in a business node → intentionally empty.
 */
const TABLE: Readonly<Record<string, readonly GrantableClaudeTool[]>> = Object.freeze({
  read: ['Read'],
  glob: ['Glob'],
  grep: ['Grep'],
  edit: ['Edit', 'Write', 'NotebookEdit'],
  bash: ['Bash'],
  task: ['Task'],
  webfetch: ['WebFetch'],
  websearch: ['WebSearch'],
  skill: ['Skill'],
  list: [],
  external_directory: [],
  todowrite: [],
  question: [],
  lsp: [],
  doom_loop: [],
})

export type PermissionAction = 'ask' | 'allow' | 'deny'

export interface ClaudeToolGate {
  /** `--tools` value: the tools that survive the mapping, in table order. */
  tools: readonly GrantableClaudeTool[]
  /** Human-facing notes the caller surfaces at save time (never silent). */
  warnings: readonly string[]
}

function actionOf(rule: unknown): { action: PermissionAction; patterned: boolean } | null {
  if (rule === 'allow' || rule === 'deny' || rule === 'ask') {
    return { action: rule, patterned: false }
  }
  if (rule !== null && typeof rule === 'object' && !Array.isArray(rule)) {
    // Record<pattern, Action>: conservative — allow only if some pattern allows.
    const values = Object.values(rule as Record<string, unknown>)
    const anyAllow = values.some((v) => v === 'allow')
    return { action: anyAllow ? 'allow' : 'deny', patterned: true }
  }
  return null
}

/**
 * Translate one agent's permission map into a Claude load set.
 *
 * `'*'` (opencode's normalized bare action) sets the baseline for every
 * grantable tool; explicit keys then override it. With no `'*'` the baseline is
 * `deny` — a claude business node must be granted, never assumed.
 */
export function mapAgentPermissionToClaudeTools(permission: AgentPermission): ClaudeToolGate {
  const warnings: string[] = []
  const granted = new Set<GrantableClaudeTool>()

  const applyWildcard = (rule: unknown): void => {
    const resolved = actionOf(rule)
    if (resolved === null) return
    if (resolved.action === 'ask') {
      warnings.push(
        "permission '*': 'ask' has no meaning in headless mode; treated as 'deny' for every tool",
      )
      return
    }
    if (resolved.action === 'allow') for (const tool of GRANTABLE) granted.add(tool)
  }

  if ('*' in permission) applyWildcard(permission['*'])

  for (const [key, rule] of Object.entries(permission)) {
    if (key === '*') continue
    const mapped = TABLE[key]
    if (mapped === undefined) {
      warnings.push(`permission '${key}': unknown key — grants nothing on the claude-code runtime`)
      continue
    }
    const resolved = actionOf(rule)
    if (resolved === null) {
      warnings.push(`permission '${key}': unrecognized value — treated as 'deny'`)
      for (const tool of mapped) granted.delete(tool)
      continue
    }
    if (resolved.patterned) {
      warnings.push(
        `permission '${key}': per-pattern rules cannot be expressed as a claude load set; ` +
          `the tool is ${resolved.action === 'allow' ? 'loaded (some pattern allows)' : 'not loaded'} as a whole`,
      )
    }
    if (resolved.action === 'ask') {
      warnings.push(`permission '${key}': 'ask' has no meaning in headless mode; treated as 'deny'`)
    }
    if (resolved.action === 'allow') for (const tool of mapped) granted.add(tool)
    else for (const tool of mapped) granted.delete(tool)
  }

  // 2026-08-04 audit: an agent that declares ONLY denials (the natural
  // translation of an OpenCode permission map, where the built-in default is
  // `{"*": "allow", …}` and a declaration only subtracts) lands here with an
  // EMPTY grant set and — until this warning — no diagnostic at all. `--tools ""`
  // is the CLI's documented "disable all tools", so the node starts, the model
  // talks, and not one tool is loaded. Every other lossy translation in this
  // function already warns; the total loss did not.
  const tools = GRANTABLE.filter((tool) => granted.has(tool))
  if (tools.length === 0 && Object.keys(permission).length > 0) {
    warnings.push(
      'permission grants no claude built-in tool: the node will load NONE ' +
        "(claude's baseline is deny-unless-granted, unlike opencode's allow-unless-denied). " +
        "Add '*': 'allow' to keep the opencode-style semantics, or grant the tools explicitly.",
    )
  }
  // Table order, so the produced argv is deterministic.
  return { tools, warnings }
}

/** `--tools` argv value for a gate (empty string = no built-ins at all). */
export function claudeToolsValue(gate: ClaudeToolGate): string {
  return gate.tools.join(',')
}

/**
 * RFC-242 — the SINGLE definition of "this claude business node is controlled".
 *
 * A node is controlled iff its agent declared a permission map: that is what
 * turns on the tool gate (T2), the byte-frozen binary (T2b) and the local-MCP
 * network fence (T5). An agent with NO declaration stays unconstrained by the
 * user decision of 2026-07-31 (existing workflows must not break), and every
 * one of those mechanisms must agree on that fact — `businessContainmentProfile`
 * decides the containment DEMAND before the spawn is built, while
 * `buildBusinessSpawn` decides what to MATERIALIZE, and a drift between the two
 * would either over-block a launch or promise a boundary that never gets built.
 *
 * Returns the gate (controlled) or null (unconstrained).
 */
export function claudeBusinessGate(permission: AgentPermission | undefined): ClaudeToolGate | null {
  const declared = permission ?? {}
  if (Object.keys(declared).length === 0) return null
  return mapAgentPermissionToClaudeTools(declared)
}

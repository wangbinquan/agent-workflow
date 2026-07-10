// RFC-166 — agent capability card: a structured projection of an agent's
// declared capability (description + input/output ports with kinds + role +
// a system-prompt summary), rendered as a markdown block for injection into
// an orchestrator's / leader's prompt, and consumed by frontend previews.
//
// Prompt-isolation invariant (RFC-099): the card carries ONLY the agent's own
// declared fields — never ownerUserId / visibility / timestamps. The input
// type is a `Pick<>` that pins the visible surface at the type layer so a
// caller cannot accidentally leak an ACL/audit field, and the render output
// is asserted (tests) to contain no user id.

import type { Agent } from './schemas/agent'

/** The exact, whitelisted field surface a capability card may read. */
export type CapabilitySource = Pick<
  Agent,
  'name' | 'description' | 'inputs' | 'outputs' | 'outputKinds' | 'role'
> & {
  /** bodyMd is optional here so callers can omit it when promptBudget = 0. */
  bodyMd?: string
}

export interface CapabilityCardOptions {
  /** System-prompt summary char budget. 0 → omit the prompt line. Default 600. */
  promptBudget?: number
}

const DEFAULT_PROMPT_BUDGET = 600

/** Clip to `budget` chars on a word-ish boundary, appending an ellipsis. */
function clipSummary(text: string, budget: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= budget) return collapsed
  const cut = collapsed.slice(0, budget)
  const lastSpace = cut.lastIndexOf(' ')
  return `${(lastSpace > budget * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
}

/** A resolved input port for a capability card (required normalized to bool). */
export interface CapabilityInputPort {
  name: string
  kind: string
  required: boolean
}

/** A resolved output port for a capability card (kind from the sidecar map). */
export interface CapabilityOutputPort {
  name: string
  kind: string
}

/**
 * The structured projection behind a capability card — the SINGLE source both
 * the markdown renderer (backend prompt injection) and the frontend UI card
 * derive from, so the two can never drift (design §2). Whitelisted fields only;
 * no ownerUserId / visibility (the CapabilitySource Pick<> already excludes
 * them, and nothing here re-introduces an ACL/audit field).
 */
export interface CapabilityCardModel {
  name: string
  /** trimmed; '' when the agent has no description. */
  description: string
  role: string
  inputs: CapabilityInputPort[]
  outputs: CapabilityOutputPort[]
  /** clipped bodyMd summary, or null when promptBudget=0 / body is empty. */
  promptSummary: string | null
}

/** Build the structured capability-card model. Pure — no DB, no ACL fields. */
export function capabilityCardModel(
  agent: CapabilitySource,
  opts?: CapabilityCardOptions,
): CapabilityCardModel {
  const budget = opts?.promptBudget ?? DEFAULT_PROMPT_BUDGET
  const inputs: CapabilityInputPort[] = (agent.inputs ?? []).map((p) => ({
    name: p.name,
    kind: p.kind,
    required: p.required === true,
  }))
  const outputs: CapabilityOutputPort[] = (agent.outputs ?? []).map((name) => ({
    name,
    kind: agent.outputKinds?.[name] ?? 'string',
  }))
  const hasBody = agent.bodyMd !== undefined && agent.bodyMd.trim().length > 0
  return {
    name: agent.name,
    // Defensive `?? ''`: the type says description is a required string, but a
    // frontend preview may be fed a partial agent (e.g. a minimal picker mock,
    // or a list endpoint that omits it) — a bare `.trim()` there would throw and
    // unmount the surrounding UI. Guard so the model degrades to an empty desc.
    description: (agent.description ?? '').trim(),
    role: agent.role ?? 'normal',
    inputs,
    outputs,
    promptSummary: budget > 0 && hasBody ? clipSummary(agent.bodyMd as string, budget) : null,
  }
}

/** Render one input port: `name (kind, required)`. */
function renderInputPort(p: CapabilityInputPort): string {
  return `${p.name} (${p.required ? `${p.kind}, required` : p.kind})`
}

/**
 * Render an agent's capability card as markdown. Pure — no DB, no ACL fields.
 * Derived from `capabilityCardModel` so it never drifts from the UI card.
 * Callers that want the compact form (no prompt summary) pass `promptBudget: 0`.
 */
export function renderAgentCapabilityCard(
  agent: CapabilitySource,
  opts?: CapabilityCardOptions,
): string {
  const m = capabilityCardModel(agent, opts)
  const lines: string[] = [`### ${m.name}`]
  if (m.description.length > 0) lines.push(m.description)
  lines.push(`- role: ${m.role}`)
  lines.push(
    `- inputs: ${m.inputs.length > 0 ? m.inputs.map(renderInputPort).join(', ') : '(none declared)'}`,
  )
  lines.push(
    `- outputs: ${
      m.outputs.length > 0
        ? m.outputs.map((o) => `${o.name} (${o.kind})`).join(', ')
        : '(none declared)'
    }`,
  )
  if (m.promptSummary !== null) lines.push(`- prompt: ${m.promptSummary}`)
  return lines.join('\n')
}

export interface RosterCardsOptions extends CapabilityCardOptions {
  /**
   * Total char budget across ALL cards (leader roster with many members).
   * When set and exceeded, later cards are dropped with a trailing note.
   * 0 / undefined → no roster-level cap (per-card promptBudget still applies).
   */
  rosterBudget?: number
}

/**
 * Render a roster of capability cards (orchestrator agent-pool / leader
 * roster). Joined by blank lines; roster-level budget drops the tail with a
 * note so token usage stays bounded.
 */
export function renderRosterCapabilityCards(
  agents: readonly CapabilitySource[],
  opts?: RosterCardsOptions,
): string {
  const rosterBudget = opts?.rosterBudget ?? 0
  const cards: string[] = []
  let used = 0
  let dropped = 0
  for (const agent of agents) {
    const card = renderAgentCapabilityCard(agent, opts)
    if (rosterBudget > 0 && used + card.length > rosterBudget && cards.length > 0) {
      dropped = agents.length - cards.length
      break
    }
    cards.push(card)
    used += card.length + 2
  }
  if (dropped > 0) {
    cards.push(`_(${dropped} more agent(s) omitted — roster budget reached)_`)
  }
  return cards.join('\n\n')
}

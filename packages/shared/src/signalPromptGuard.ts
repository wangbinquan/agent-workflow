// RFC-060 PR-B — prompt template signal-port reference guard.
//
// `signal` is a control-flow-only AgentOutputKind: a port whose wire
// content is always the empty string. Referencing such a port via
// `{{port_name}}` in an agent's user-prompt template is a logic error
// — the rendered prompt would contain nothing useful and likely
// indicates the author confused a control edge for a data edge.
//
// This helper performs a syntax-only scan: it extracts `{{identifier}}`
// references from the template and reports any that resolve to a
// port whose ParsedKind is `{ kind: 'base', name: 'signal' }`. PR-B
// ships the helper only; PR-D wires it into runner.ts's pre-spawn
// validation pass alongside renderUserPrompt.

import { tryParseKind, type ParsedKind } from './kindParser'

const TEMPLATE_REF_RE = /\{\{(\w+)\}\}/g

export interface SignalPromptViolation {
  /** Port name referenced by the prompt template. */
  port: string
  /** Stringified port kind (e.g. 'signal') for the diagnostic message. */
  kindRepr: string
}

/**
 * Returns the list of `{{port}}` template references whose port kind is
 * `signal`. Empty array = no violations.
 *
 * `portKinds` maps port name → either a parsed kind or its string form.
 * String forms are accepted so callers can pass the raw
 * `agent.outputKinds` map without re-parsing. Ports absent from the map
 * are treated as non-signal (the legacy default kind is `string`).
 *
 * The scan does NOT honor double-braces escape syntax or comment blocks
 * — it matches the same regex `renderUserPrompt` uses, so any reference
 * that would be substituted at render time is also flagged here.
 */
export function findPromptSignalRefs(
  template: string | undefined,
  portKinds: Record<string, string | ParsedKind | undefined>,
): SignalPromptViolation[] {
  if (template === undefined || template.length === 0) return []
  const seen = new Set<string>()
  const out: SignalPromptViolation[] = []
  // Reset regex lastIndex defensively — TEMPLATE_REF_RE is module-level.
  TEMPLATE_REF_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TEMPLATE_REF_RE.exec(template)) !== null) {
    const port = m[1]!
    if (seen.has(port)) continue
    seen.add(port)
    const rawKind = portKinds[port]
    if (rawKind === undefined) continue
    const parsed = typeof rawKind === 'string' ? tryParseKind(rawKind) : rawKind
    if (parsed === null) continue
    if (parsed.kind === 'base' && parsed.name === 'signal') {
      out.push({ port, kindRepr: 'signal' })
    }
  }
  return out
}

/**
 * Throwing variant: when any prompt template references a signal port,
 * throw `SignalPortInPromptError`. Callers (runner.ts in PR-D) wrap
 * this to surface a `signal-port-in-prompt` errCode at the wire.
 */
export class SignalPortInPromptError extends Error {
  constructor(
    message: string,
    public readonly violations: readonly SignalPromptViolation[],
  ) {
    super(message)
    this.name = 'SignalPortInPromptError'
  }
}

export function assertNoPromptSignalRefs(
  template: string | undefined,
  portKinds: Record<string, string | ParsedKind | undefined>,
): void {
  const violations = findPromptSignalRefs(template, portKinds)
  if (violations.length === 0) return
  const portList = violations.map((v) => `'${v.port}'`).join(', ')
  throw new SignalPortInPromptError(
    `prompt template references signal port(s) ${portList} which carry no data; signal edges are control-flow only`,
    violations,
  )
}

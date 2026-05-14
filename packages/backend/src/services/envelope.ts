// Workflow-output envelope parser.
//
// agent stdout must end with:
//   <workflow-output>
//     <port name="audit_findings">...</port>
//     <port name="summary">...</port>
//   </workflow-output>
//
// Rules per design/proposal.md §7:
//   - The LAST matching <workflow-output>...</workflow-output> wins
//     (anything before is treated as drafts the agent emitted while thinking).
//   - Port name must be a declared agent output; extras are kept but flagged
//     as `undeclared` for the caller to warn on.
//   - Declared ports missing from the envelope come back as empty strings
//     so downstream nodes get an explicit "" rather than undefined.

const ENVELOPE_RE = /<workflow-output>([\s\S]*?)<\/workflow-output>/g
// Accept both "name" and 'name' attribute quotes. Tolerant of arbitrary
// whitespace inside the opening tag.
const PORT_RE = /<port\s+name=(?:"([^"]+)"|'([^']+)')\s*>([\s\S]*?)<\/port>/g

export interface EnvelopeParseResult {
  /**
   * Resolved port content for every entry in `declaredOutputs`, in declaration
   * order. Ports omitted by the agent are present with an empty string.
   */
  ports: Map<string, string>
  /** Names listed in `declaredOutputs` but absent from the envelope. */
  missingDeclared: string[]
  /** Ports emitted by the agent that aren't declared in agent.outputs. */
  undeclared: Array<{ name: string; content: string }>
}

/**
 * Find the last `<workflow-output>...</workflow-output>` block in `text`.
 * Returns the entire matched block (incl. open/close tags), or null if none.
 */
export function extractLastEnvelope(text: string): string | null {
  const matches = [...text.matchAll(ENVELOPE_RE)]
  if (matches.length === 0) return null
  const last = matches[matches.length - 1]
  return last ? last[0] : null
}

/**
 * Parse <port> elements inside an envelope block. Returns a structured result
 * suitable for upserting into node_run_outputs + WS broadcast.
 *
 * Trims whitespace around each port's content (agents often pad with leading
 * newlines from XML pretty-printing).
 */
export function parseEnvelope(envelopeXml: string, declaredOutputs: string[]): EnvelopeParseResult {
  const collected = new Map<string, string>()
  const undeclared: Array<{ name: string; content: string }> = []

  for (const m of envelopeXml.matchAll(PORT_RE)) {
    const name = m[1] ?? m[2] ?? ''
    const content = (m[3] ?? '').trim()
    if (name.length === 0) continue
    if (declaredOutputs.includes(name)) {
      // If an agent emits the same port name twice, keep the LAST one — most
      // intuitive for a buggy / iterating agent.
      collected.set(name, content)
    } else {
      undeclared.push({ name, content })
    }
  }

  const ports = new Map<string, string>()
  for (const name of declaredOutputs) {
    ports.set(name, collected.get(name) ?? '')
  }
  const missingDeclared = declaredOutputs.filter((p) => !collected.has(p))

  return { ports, missingDeclared, undeclared }
}

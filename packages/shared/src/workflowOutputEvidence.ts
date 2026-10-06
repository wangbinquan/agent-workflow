/** Pure metadata needed to classify a missing workflow envelope. Full runtime
 * observations may carry additional fields; no runtime owner is required here. */
export interface WorkflowOutputEvidence {
  readonly assistantTextSeen: boolean
  readonly observedAssistantTextBytes: number
  readonly retainedAssistantTextBytes: number
  readonly eventTextCapHit: boolean
  readonly terminalResult: 'success' | 'error' | 'not-observed'
}

export type MissingEnvelopeReason =
  | 'output-cap-hit'
  | 'no-assistant-text'
  | 'terminal-without-envelope'
  | 'assistant-stopped-without-envelope'
  | 'runtime-shape-unknown'

/** The original System/Intent classifier; preserve branch priority verbatim. */
export function classifyMissingEnvelope(
  evidence: WorkflowOutputEvidence | undefined,
): MissingEnvelopeReason {
  if (evidence === undefined) return 'runtime-shape-unknown'
  if (
    evidence.eventTextCapHit ||
    evidence.observedAssistantTextBytes > evidence.retainedAssistantTextBytes
  ) {
    return 'output-cap-hit'
  }
  if (!evidence.assistantTextSeen) return 'no-assistant-text'
  if (evidence.terminalResult !== 'not-observed') return 'terminal-without-envelope'
  if (evidence.assistantTextSeen) return 'assistant-stopped-without-envelope'
  return 'runtime-shape-unknown'
}

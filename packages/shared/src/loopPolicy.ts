// RFC-236 — shared parser for wrapper-loop max-iteration behavior.
//
// WorkflowNodeSchema intentionally keeps kind-specific fields in passthrough
// data, so every consumer must use this helper instead of truthiness. Missing
// is the backward-compatible hard-fail policy; malformed values fail closed.

export function readContinueOnMaxIterations(node: object): boolean | null {
  const raw = (node as Record<string, unknown>).continueOnMaxIterations
  if (raw === undefined) return false
  return typeof raw === 'boolean' ? raw : null
}

import { ConflictError } from '@/util/errors'

// Native generators are process-owned and abort with this process. This small
// registry shares their activity with the original round seal; it owns no answers.
const active = new Map<string, string>()
export function beginClarifyFollowup(nodeRunId: string, requestId: string): () => void {
  assertClarifyFollowupIdle(nodeRunId)
  active.set(nodeRunId, requestId)
  return () => {
    if (active.get(nodeRunId) === requestId) active.delete(nodeRunId)
  }
}
export function assertClarifyFollowupIdle(nodeRunId: string): void {
  if (active.has(nodeRunId))
    throw new ConflictError(
      'clarify-followup-busy',
      'A follow-up is being generated. Wait for it or cancel it before submitting.',
    )
}

// RFC-480: moved here from public/types — bootstrap hands the factory's reader to development-automation, which names its
// own port (`GraphHumanInputFacts`), so no other context names this interface; the infrastructure reader implements it.
import type { ClarifyQuestion, ClarifyAnswer } from '@agent-workflow/shared'

/** Exact committed content provenance for consumers of human decisions. */
export interface CollaborationHumanInputQueries {
  clarificationRounds(taskId: string): Promise<
    readonly {
      readonly id: string
      readonly taskId: string
      readonly askingNodeRunId: string
      readonly intermediaryNodeRunId: string
      readonly status: 'awaiting_human' | 'answered' | 'canceled' | 'abandoned'
      readonly questions: readonly ClarifyQuestion[]
      readonly answers: readonly ClarifyAnswer[]
    }[]
  >
  reviewDecision(
    taskId: string,
    nodeRunId: string,
  ): Promise<{
    readonly receiptId: string
    readonly taskId: string
    readonly nodeRunId: string
    readonly decision: 'approved' | 'rejected' | 'iterated'
    readonly decidedAt: number
    readonly reason: string
    readonly documentDigests: readonly string[]
  } | null>
}

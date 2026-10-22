import type { ClarifyAnswer, ClarifyQuestion } from '@agent-workflow/shared'

/** Consumer-owned read ports, fulfilled by owner public contracts at bootstrap. */
export interface GraphHumanInputFacts {
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

export interface GraphExecutionFacts {
  read(input: { readonly caseId: string; readonly executionRef: string }): Promise<{
    readonly taskId: string
    readonly roundRef: string
    readonly status: string
    readonly artifacts: readonly {
      readonly nodeRunId: string
      readonly portName: string
      readonly content: string
      readonly digest: string
    }[]
    readonly reviewRunIds: readonly string[]
  } | null>
}

export interface GraphRequestObservation {
  observe(input: {
    sourceRef: { id: string; revision: number }
    eventTypeRef: { id: string; revision: number }
    subject: { typeId: string; subjectRef: string }
    occurredAt: number
    dedupeKey: string
    summary: string
    payloadArtifactRef: string
  }): Promise<{ eventId: string }>
}

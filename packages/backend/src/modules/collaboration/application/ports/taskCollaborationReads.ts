import type { ClarifyRoundStatus } from '@agent-workflow/shared'

export interface ArchiveCollaborationSections {
  readonly sections: readonly string[]
  load(
    taskIds: readonly string[],
  ): Promise<Readonly<Record<string, readonly Readonly<Record<string, unknown>>[]>>>
}

export interface RecoveryHumanGateFacts {
  designerParkEntries(taskId: string): Promise<
    readonly {
      readonly dispatchedAt: number | null
      readonly triggerRunId: string | null
      readonly defaultTargetNodeId: string | null
      readonly overrideTargetNodeId: string | null
    }[]
  >
  lifecycleClarifyRounds(taskIds: readonly string[]): Promise<
    readonly {
      readonly taskId: string
      readonly id: string
      readonly kind: string
      readonly status: string
      readonly directive: string | null
      readonly clarifyNodeRunId: string
      readonly clarifyNodeId: string
    }[]
  >
  hasOpenClarifyRound(taskId: string): Promise<boolean>
}

export interface NodeRunClarifyNav {
  latestRoundStatusByRun(taskId: string): Promise<ReadonlyMap<string, ClarifyRoundStatus>>
}

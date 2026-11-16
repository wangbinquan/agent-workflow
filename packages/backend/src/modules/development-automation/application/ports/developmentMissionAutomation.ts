// RFC-497 (RFC-294 S10 step 4): the members of the development-automation participant that the Mission operations use.
// The participant (`DevelopmentAutomationModule` in composition.ts) extends this port; the declarations moved here unchanged.

import type { ConfirmNoChangeResult } from '../commands/confirmNoChange'
import type { attachMergeRequest, handoffMission, resumeMission } from '../commands/missionHandover'
import type { SubmitAnswersResult } from '../commands/submitMissionAnswers'
import type { EvidenceDownloadQueries } from '../evidenceDownloads'
import type { MissionDriveOutcome } from '../missionDriver'
import type { EvidenceContentQueries } from '../pipelineEvidenceRead'
import type { RequirementMaterializer } from '../requirementMaterializer'

export interface DevelopmentMissionAutomation {
  readonly materializer: RequirementMaterializer
  readonly evidenceContents: EvidenceContentQueries
  readonly evidenceDownloads: EvidenceDownloadQueries
  /** Business-safe child/approval receipts for Mission detail and journey projection. */
  collaboration(missionId: string): Promise<{
    readonly children: readonly {
      readonly stepRunId: string
      readonly childMissionId: string | null
      readonly status: string | null
      readonly completionSatisfied: boolean
      readonly observedAt: number | null
      readonly deadlineAt: number | null
    }[]
    readonly approvals: readonly {
      readonly stepRunId: string
      readonly externalRequestRef: string | null
      readonly status: string
      readonly nextObserveAt: number | null
      readonly deadlineAt: number
      readonly updatedAt: number
    }[]
  }>
  /** Advance settled platform steps until the next real asynchronous boundary. */
  drive(missionId: string): Promise<MissionDriveOutcome>
  /** T55a：no-change 人工确认（唯一能进入 completed-no-change 的通道）。 */
  confirmNoChange(rawInput: unknown): Promise<ConfirmNoChangeResult>
  /** 平台渠道答题（T55：新 revision 会失效 in-flight action）。 */
  submitAnswers(rawInput: unknown): Promise<SubmitAnswersResult>
  /** T80：交接三命令（完整 ports——handoff 撤销含真 agent cancel）。 */
  handoff(rawInput: unknown): ReturnType<typeof handoffMission>
  attachMr(rawInput: unknown): ReturnType<typeof attachMergeRequest>
  resume(rawInput: unknown): ReturnType<typeof resumeMission>
}

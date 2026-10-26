import type { TaskExecutionFailureClass } from '../application/ports/digitalEmployeeExecutionCore'
/**
 * Consumer-owned workspace contract for one Digital Employee Reaction.
 * The implementation may live in source-control or an employee type package;
 * TaskExecution only receives a path-bound, already materialized scene.
 */
export interface DigitalEmployeeWorkspacePort {
  prepare(input: { readonly planJson: string; readonly attemptJson: string }): Promise<
    | { readonly kind: 'scratch' }
    | {
        readonly kind: 'repository'
        readonly workspacePath: string
        readonly baselineSha: string
        readonly platformInputPaths: readonly string[]
        /** Optional business facts discovered while materializing the scene. */
        readonly contractProjectionJson?: string
        /** Scene material directions do not alter the tool's frozen business input schema. */
        readonly materialInstructions?: string
      }
  >
  validate(input: {
    readonly roundRef: string
    readonly taskStatus: string
    readonly outputJson: string | null
  }): Promise<
    | { readonly ok: true }
    | {
        readonly ok: false
        /** RFC-317 T31（DE-03）—— 由校验方直接给出，不再让消费方嗅 errorCode 前缀。 */
        readonly errorClass: TaskExecutionFailureClass
        readonly errorCode: string
        readonly errorDetail: string
      }
  >
}

import type { ClarifyRoundStatus } from '@agent-workflow/shared'
import type { TaskArchiveCollaborationSectionsPort } from '../application/ports/taskArchiveSections'

export type { TaskArchiveCollaborationSectionsPort }

export interface TaskRecoveryHumanGateFactsPort {
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

export interface TaskNodeRunClarifyNavPort {
  latestRoundStatusByRun(taskId: string): Promise<ReadonlyMap<string, ClarifyRoundStatus>>
}

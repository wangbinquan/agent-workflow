import type { WorkspaceFailureClass } from '@/modules/digital-employee/public/types'
export type {
  HumanGateOpenParticipant,
  HumanGateOpenParticipantResult,
} from '../application/ports/humanGateOpenParticipant'
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
        readonly errorClass: WorkspaceFailureClass
        readonly errorCode: string
        readonly errorDetail: string
      }
  >
}

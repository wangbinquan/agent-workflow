import type { PersistenceTx } from '@/platform/persistence/persistenceDb'
import type { ClarifyDirective } from '@agent-workflow/shared'

export interface ClarifySealDecisionParticipantInTx {
  acceptTx(input: {
    readonly tx: PersistenceTx
    readonly taskId: string
    readonly roundId: string
    readonly originNodeRunId: string
    readonly roundKind: 'self' | 'cross'
    readonly directive: ClarifyDirective
    readonly sealedQuestionIds: readonly string[]
    readonly roundFullySealed: boolean
    readonly now: number
  }): Promise<void>
}

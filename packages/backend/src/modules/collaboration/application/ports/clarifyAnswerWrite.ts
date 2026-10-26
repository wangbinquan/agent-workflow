import type { ClarifyDraftValue, ClarifyRoundStatus, TaskActorRole } from '@agent-workflow/shared'
import type { PersistenceTx } from '@/platform/persistence/persistenceDb'
import type { sealClarifyAnswers } from '../../domain/clarifyAnswers'
import type { appendClarifyQuestions } from '../../domain/clarifyQuestions'

/** Target rows use revision CAS; clients retain per-question last-write-wins. */
export interface ClarifyAnswerWritePort {
  saveDraft(input: {
    readonly roundId: string
    readonly intermediaryNodeRunId: string
    readonly questionId: string
    readonly value: ClarifyDraftValue
    readonly editor: { userId: string; role: TaskActorRole }
  }): Promise<{ taskId: string; updatedAt: number }>
  seal(
    tx: PersistenceTx,
    roundId: string,
    transition: ReturnType<typeof sealClarifyAnswers>,
  ): Promise<void>
  appendQuestions(
    tx: PersistenceTx,
    roundId: string,
    revision: ReturnType<typeof appendClarifyQuestions>,
  ): Promise<void>
  transition(
    input: {
      readonly roundId: string
      readonly kind: 'reopen' | 'cancel' | 'abandon'
      readonly taskId?: string
      readonly roundKind?: 'self' | 'cross'
      readonly expectedStatus?: ClarifyRoundStatus
      readonly now?: number
    },
    tx?: PersistenceTx,
  ): Promise<boolean>
}

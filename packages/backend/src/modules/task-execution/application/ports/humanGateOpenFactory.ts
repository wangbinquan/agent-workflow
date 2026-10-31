import type { PersistenceTx } from '@/platform/persistence/persistenceDb'
import type { HistoryRestrictionPort } from '@/platform/contracts/historyRestriction'
import type { HumanGateTaskLifecycle, HumanGateTaskParkResult } from './humanGateTaskLifecycle'
import type { HumanGatePersistenceParticipantInTx } from './humanGatePersistenceParticipant'
import type {
  NodeRunMintInput,
  NodeRunLifecycleParticipantInTx,
} from './nodeRunLifecyclePersistence'
import type { ConsumedInputsParticipantInTx } from './consumedInputs'

type PreparedGate = Parameters<HumanGateTaskLifecycle['parkPrepared']>[0]['prepared']

export interface HumanGateOpenParticipantInTx {
  consumePreparedGateTx(input: {
    readonly prepared: PreparedGate
    readonly taskRevision: number
    readonly now: number
  }): Promise<
    Omit<HumanGateTaskParkResult, 'taskRevision'> & {
      readonly gate: { readonly kind: PreparedGate['gateKind'] }
    }
  >
  listPreparedManualQuestionParksTx(taskId: string): Promise<readonly string[]>
  consumeManualQuestionParkTx(input: {
    readonly operationId: string
    readonly taskId: string
    readonly now: number
  }): Promise<{ readonly outstanding: boolean }>
}

export interface HumanGateOpenParticipantScope {
  inTransaction(
    tx: PersistenceTx,
    taskParticipants: {
      readonly mint: { mint(input: NodeRunMintInput): Promise<string> }
      readonly lifecycle: NodeRunLifecycleParticipantInTx
      readonly consumedInputs: ConsumedInputsParticipantInTx<PersistenceTx>
    },
  ): HumanGateOpenParticipantInTx
}

export type HumanGateOpenParticipantFactory = (input: {
  readonly taskPersistenceInTransaction: (tx: PersistenceTx) => HumanGatePersistenceParticipantInTx
  readonly historyRestrictions: HistoryRestrictionPort
}) => HumanGateOpenParticipantScope

// human-gate 操作日志的共享形状（租约常量 / 工件声明与快照 / begin 的回答）。
//
// RFC-359 W4-D26：此前这里还声明着一份 `DbTxSync` 版的 `HumanGateOperationTransactionStore`
// 接口，唯一实现 `SqliteHumanGateOperationStore` 已随手工提问写面合一而退役；事务内日志的
// 唯一契约现在是 `humanGateOperationJournal.ts` 的 `HumanGateOperationJournal`（中立 + 异步）。

import type {
  HumanGateArtifactState,
  HumanGateOperationSnapshot,
} from '../domain/humanGateOperation'

export const DEFAULT_HUMAN_GATE_CLAIM_LEASE_MS = 30_000

export type BegunHumanGateOperation = Readonly<{
  operation: HumanGateOperationSnapshot
  replayed: boolean
}>

export interface HumanGateArtifactDeclaration {
  readonly artifactKey: string
  readonly stagedPath: string
  readonly finalPath: string
  readonly sha256: string
  readonly byteSize: number
}

export interface HumanGateArtifactSnapshot extends HumanGateArtifactDeclaration {
  readonly operationId: string
  readonly artifactKind: 'review-doc'
  readonly state: HumanGateArtifactState
  readonly receiptJson: string | null
  readonly updatedAt: number
}

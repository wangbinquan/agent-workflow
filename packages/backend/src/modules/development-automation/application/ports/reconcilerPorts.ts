// RFC-310 PR-2 —— reconciler 消费的窄执行端口（T26）。
//
// application 层只认这些接口；生产实现由 provider adapter 经装配点注入
// （repository facts 采集归 PR-5 T53、MR facts 归 PR-7 T72、effect 执行与
// Agent launch 归 PR-4/PR-5、upload placement 归 PR-3 T36a），测试注入 typed
// fake。端口缺席不是静默跳过：对应 decision arm 会以 typed block
// （`*-not-wired`）落库——「没接上」必须可见（dev-gotchas「缺席的接线不会红」
// 教训的反向设计）。

import type { FactCellValue } from '../../domain/facts'
import type { FactCell } from '../../domain/factCell'
import type { OperationFailureReceipt } from '../../domain/operationFailure'

export interface RepositoryFactsCollectorPort {
  collect(input: { readonly missionId: string; readonly repositoryId: string }): Promise<{
    readonly cells: Record<string, FactCell<FactCellValue>>
    readonly factsRef: string
  }>
}

export interface MergeRequestFactsCollectorPort {
  collect(input: { readonly missionId: string; readonly mrClaimId: string | null }): Promise<{
    readonly cells: Record<string, FactCell<FactCellValue>>
    readonly snapshotRef: string
    readonly headSha: string | null
    readonly targetSha: string | null
  }>
}

export type PortOutcome<T> =
  | ({ readonly ok: true } & T)
  | { readonly ok: false; readonly failure: OperationFailureReceipt }

export interface MissionEffectExecutorPort {
  execute(input: {
    readonly effectId: string
    readonly effectKind: string
    readonly intentDigest: string
  }): Promise<PortOutcome<{ readonly receiptRef: string }>>
}

export interface AgentActionLauncherPort {
  launch(input: {
    readonly actionRunId: string
    readonly capabilityId: string
    readonly templateId: string
    readonly templateRevision: number
  }): Promise<PortOutcome<{ readonly executionRef: string }>>
}

export interface UploadPlacementPort {
  place(input: {
    readonly missionId: string
    readonly uploadPlanRef: string
  }): Promise<PortOutcome<{ readonly seedTreeDigest: string }>>
}

/** fact snapshot 的读侧（store port 只有 insert；读回合并归本接口）。 */
export interface FactSnapshotReader {
  getCells(snapshotId: string): Record<string, FactCell<FactCellValue>> | null
}

export interface ReconcilerPorts {
  readonly repositoryFacts?: RepositoryFactsCollectorPort
  readonly mergeRequestFacts?: MergeRequestFactsCollectorPort
  readonly effectExecutor?: MissionEffectExecutorPort
  readonly agentLauncher?: AgentActionLauncherPort
  readonly uploadPlacement?: UploadPlacementPort
}

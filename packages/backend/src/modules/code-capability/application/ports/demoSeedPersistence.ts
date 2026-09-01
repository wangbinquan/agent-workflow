import type { CapabilityTemplateRecord } from './capabilityTemplatePersistence'

export interface SeededCodeWorkItemRecord {
  readonly id: string
  readonly codeHostEndpointId: string
  readonly stableProjectId: string
  readonly capability: string
  readonly anchorKind: 'mr' | 'issue' | 'pipeline' | 'platform'
  readonly anchorId: string
  readonly status: 'settled'
  readonly epoch: number
  readonly currentRoundId: string
  readonly createdAt: number
  readonly updatedAt: number
}

export interface SeededCodeRoundRecord {
  readonly id: string
  readonly workItemId: string
  readonly roundSeq: number
  readonly epoch: number
  readonly baselineSha: string
  readonly stageContractVer: number
  readonly outcome: 'awaiting' | 'published' | 'failed' | 'canceled' | 'superseded'
  readonly startedAt: number
  readonly endedAt: number
}

export interface SeededCodeRoundStageRecord {
  readonly id: string
  readonly roundId: string
  readonly stageSeq: number
  readonly stageName: string
  readonly stageKind: 'program' | 'script' | 'ai' | 'invoke'
  readonly status: 'pending' | 'running' | 'done' | 'failed' | 'skipped'
  readonly startedAt: number
  readonly endedAt: number
}

/** One owner-native aggregate; provider adapters commit it atomically and idempotently. */
export interface CodeCapabilityDemoSeedAggregate {
  readonly template: CapabilityTemplateRecord
  readonly history: {
    readonly workItem: SeededCodeWorkItemRecord
    readonly round: SeededCodeRoundRecord
    readonly stages: readonly SeededCodeRoundStageRecord[]
  } | null
}

export interface CodeCapabilityDemoSeedPersistence {
  ensure(aggregate: CodeCapabilityDemoSeedAggregate): Promise<void>
}

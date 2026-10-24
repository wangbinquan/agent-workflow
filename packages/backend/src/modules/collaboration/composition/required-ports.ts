import type { PersistenceTx } from '@/platform/persistence/persistenceDb'

export interface ReviewUpstreamAgentPort {
  outputProfile(agentId: string): Promise<{
    readonly syncOutputsOnIterate: boolean
    readonly outputs: string
    readonly frontmatterExtra: string
  } | null>
}

export interface HumanGateTaskLockParticipant {
  lockTask(taskId: string): Promise<void>
}

export type HumanGateTaskLockPort = (tx: PersistenceTx) => HumanGateTaskLockParticipant

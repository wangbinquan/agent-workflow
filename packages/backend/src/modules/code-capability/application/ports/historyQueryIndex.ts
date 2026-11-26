import type { CodeHistoryReader } from './historyReader'
import type { WorkItemProjectionReadPort } from './workItemProjectionRead'
import type { RoundAttemptsReadPort } from './roundAttemptsRead'
import type { DeliveryChainReadPort } from './deliveryChainRead'
import type { CodeMetricsReadPort } from './codeMetricsRead'

/** A prepared, durable read model. No member may build it or reopen an archive. */
export interface CodeHistoryQueryReader extends CodeHistoryReader {
  readonly workItems: WorkItemProjectionReadPort
  readonly attempts: RoundAttemptsReadPort
  readonly deliveries: DeliveryChainReadPort
  readonly metrics: CodeMetricsReadPort
}

export interface CodeHistoryIndexBuildReceipt {
  readonly kind: 'fresh-install' | 'ready'
  readonly buildId: string | null
  readonly previousBuildId: string | null
  readonly reused: boolean
  readonly records: number
}

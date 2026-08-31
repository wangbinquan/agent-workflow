import type { DeliveryOutcome, DeliveryStep } from '../../domain/deliveryChain'

export interface DeliveryRow {
  readonly id: string
  readonly correlationId: string
  readonly capability: string | null
  readonly step: DeliveryStep
  readonly outcome: DeliveryOutcome['kind']
  readonly reason: string | null
  readonly queuedAt: number | null
  readonly queuePosition: number | null
  readonly waitingOn: string | null
  readonly roundId: string | null
  readonly isProbe: boolean
  readonly createdAt: number
  readonly updatedAt: number
}

/** Provider-neutral read mechanics for the delivery troubleshooting chain. */
export interface DeliveryChainReadPort {
  recent(input: {
    readonly stableProjectId: string
    readonly limit?: number
  }): Promise<DeliveryRow[]>
  byCorrelation(correlationId: string): Promise<DeliveryRow[]>
  failures(input: {
    readonly stableProjectId?: string
    readonly limit?: number
  }): Promise<DeliveryRow[]>
}

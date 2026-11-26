// RFC-602: online queries use the explicitly prepared durable projection.
import type { CodeHistoryQueryReader } from '../application/ports/historyQueryIndex'
import type { DeliveryChainReadPort } from '../application/ports/deliveryChainRead'

export function createDeliveryChainRead(history: CodeHistoryQueryReader): DeliveryChainReadPort {
  return history.deliveries
}

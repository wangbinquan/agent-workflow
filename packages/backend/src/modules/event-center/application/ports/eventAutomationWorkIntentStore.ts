import type { EventDeliveryRecord } from '../../domain/model'
import type {
  EmployeeAutomationWorkStartV1,
  EventAutomationOriginBindingPort,
  EventAutomationOriginRef,
  EventAutomationPortId,
  EventDeliveryClaimScope,
  EventDeliverySettlement,
  TaskAutomationWorkStartV1,
} from '../../composition/required-ports'

export type PreparedEventAutomationIntent =
  | Readonly<{
      kind: 'task'
      origin: EventAutomationOriginRef
      portId: 'task-automation-work-start.v1'
      ownerUserId: string
      input: TaskAutomationWorkStartV1
      receiptRef: string | null
    }>
  | Readonly<{
      kind: 'employee'
      origin: EventAutomationOriginRef
      portId: 'employee-automation-work-start.v1'
      ownerUserId: string
      input: EmployeeAutomationWorkStartV1
      receiptRef: string | null
    }>

export interface EventAutomationWorkIntentStorePort extends EventAutomationOriginBindingPort {
  prepare(input: {
    readonly delivery: EventDeliveryRecord
    readonly claim: EventDeliveryClaimScope
    readonly now: number
  }): Promise<
    | { readonly kind: 'obsolete' }
    | { readonly kind: 'prepared'; readonly intent: PreparedEventAutomationIntent }
  >
  recordReceipt(input: {
    readonly origin: EventAutomationOriginRef
    readonly portId: EventAutomationPortId
    readonly receiptRef: string
    readonly now: number
  }): Promise<void>
  recordFailure(input: {
    readonly origin: EventAutomationOriginRef
    readonly error: string
    readonly now: number
  }): Promise<void>
  settle(input: EventDeliverySettlement): Promise<boolean>
}

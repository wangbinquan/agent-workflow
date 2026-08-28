import type {
  OpenWrapperGeneration,
  WrapperExecutionRequest,
  WrapperNodeKind,
  WrapperSettlement,
} from '../../domain/wrapperExecution'

/** Durable wrapper-row lifecycle. Concrete persistence remains at composition. */
export interface WrapperRunLedgerPort {
  openGeneration<K extends WrapperNodeKind>(
    kind: K,
    request: WrapperExecutionRequest<K>,
  ): Promise<OpenWrapperGeneration<K>>

  settle<K extends WrapperNodeKind>(
    generation: OpenWrapperGeneration<K>,
    settlement: WrapperSettlement,
  ): Promise<void>
}

import type { RuntimeKind } from '../../public/types'
import type {
  NormalizedEvent,
  RuntimeDriverCapabilities,
  SystemEventObservation,
} from '@/services/runtime/types'
import type { RuntimeUsageMeter, RuntimeUsageMeterInput } from '../../domain/usageMeter'

/** Pure protocol behavior; selecting it does not select an execution target. */
export interface AgentInvocationProtocol {
  readonly kind: RuntimeKind
  readonly capabilities: RuntimeDriverCapabilities
  parseEvent(line: string): NormalizedEvent | null
  /** RFC-371 v2: stream-only usage meter (material evidence adds the native store). */
  usageMeter?(input: RuntimeUsageMeterInput): RuntimeUsageMeter
  observeSystemEvent?(line: string): SystemEventObservation
  parseTerminalResultError?(line: string): string | null
}

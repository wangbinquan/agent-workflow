import type { RuntimeKind } from '../../public/types'
import type {
  NormalizedEvent,
  RuntimeDriverCapabilities,
  SystemEventObservation,
} from '@/services/runtime/types'
import type { RuntimeUsageContext, RuntimeUsageFrame } from '@/services/runtime/usage'

/** Pure protocol behavior; selecting it does not select an execution target. */
export interface AgentInvocationProtocol {
  readonly kind: RuntimeKind
  readonly capabilities: RuntimeDriverCapabilities
  parseEvent(line: string): NormalizedEvent | null
  normalizeUsage?(raw: unknown, context: RuntimeUsageContext): RuntimeUsageFrame
  observeSystemEvent?(line: string): SystemEventObservation
  parseTerminalResultError?(line: string): string | null
}

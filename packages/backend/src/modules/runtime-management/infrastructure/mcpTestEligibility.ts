import { tryGetRuntimeDriver } from '@/services/runtime'
import type { RuntimeMcpTestEligibilityInput } from '../public/types'
export function isRuntimeMcpTestEligible(row: RuntimeMcpTestEligibilityInput): boolean {
  // RFC-280 T6: playground support = the driver implements the session
  // strategy (the spawn itself is the ordinary system-agent surface now).
  // RFC-282 实现门 P2-1 — this rides the /api/runtimes LIST (display path):
  // a dirty protocol on one row must read as "not eligible", not 500 the page.
  return tryGetRuntimeDriver(row.protocol)?.mcpTestSessionReference !== undefined
}

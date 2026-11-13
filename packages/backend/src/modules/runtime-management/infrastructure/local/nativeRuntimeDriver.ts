// RFC-491 — a runtime kind's native driver, selected for Task Execution's native system-agent run and the local MCP
// diagnostic (their own driver window, bound by bootstrap). The same registered driver singleton.
import { getRuntimeDriver } from '@/services/runtime'
import type { RuntimeKind } from '../../public/types'

export function selectNativeRuntimeDriver(kind: RuntimeKind) {
  return getRuntimeDriver(kind)
}

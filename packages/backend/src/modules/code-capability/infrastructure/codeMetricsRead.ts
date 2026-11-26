// RFC-602: online queries use the explicitly prepared durable projection.
import type { CodeHistoryQueryReader } from '../application/ports/historyQueryIndex'
import type { CodeMetricsReadPort } from '../application/ports/codeMetricsRead'

export function createCodeMetricsRead(history: CodeHistoryQueryReader): CodeMetricsReadPort {
  return history.metrics
}

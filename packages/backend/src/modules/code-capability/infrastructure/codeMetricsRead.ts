import type { CodeHistoryReader } from '../application/ports/historyReader'
import type { CodeMetricsReadPort } from '../application/ports/codeMetricsRead'

export function createCodeMetricsRead(history: CodeHistoryReader): CodeMetricsReadPort {
  return {
    async loadSince(since) {
      const [findings, items, rounds] = await Promise.all([
        history.rows('code_findings'),
        history.rows('code_work_items'),
        history.rows('code_work_rounds'),
      ])
      const capabilities = new Map(items.map((item) => [item.id, item.capability]))
      return {
        findings: findings
          .filter((row) => row.external_id !== null && row.created_at >= since)
          .map((row) => ({
            capability: row.capability,
            resolvedAt: row.resolved_at,
            codeChangedAt: row.code_changed_at,
          })),
        rounds: rounds.flatMap((row) => {
          const capability = capabilities.get(row.work_item_id)
          return row.started_at < since || capability === undefined
            ? []
            : [
                {
                  capability,
                  outcome: row.outcome,
                  endedAt: row.ended_at,
                  n: 1,
                },
              ]
        }),
      }
    },
  }
}

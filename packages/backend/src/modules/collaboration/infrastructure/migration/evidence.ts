import type { RuleContext } from '@/platform/persistence/migration/conversion/rule'
import type {
  JsonValue,
  SourceRow,
  TargetRef,
} from '@/platform/persistence/migration/conversion/types'
import type { TaskFacts } from '@/platform/persistence/migration/conversion/lookups/keys'
import { encodeStagedValue } from '@/platform/persistence/migration/conversion/staging'

export function recordCollaborationDecision(
  row: SourceRow,
  ctx: RuleContext,
  decision: { code: string; detail: JsonValue },
  targets: readonly TargetRef[],
  history?: { execution: TaskFacts['execution']; missingFields: readonly string[] },
): void {
  const archive = ctx.out.archive({
    kind: 'source-journal',
    sourceTable: row.table,
    format: 'logical-row@1',
    bytes: new TextEncoder().encode(encodeStagedValue(row)),
    rows: 1,
  })
  ctx.out.exception({
    sourceTable: row.table,
    sourceKey: row.encodedKey,
    class: 'converted',
    kind: history && history.execution !== 'executable' ? 'history-only' : 'conflict-resolved',
    targets,
    archive,
    decision,
    ...(row.codecTakeovers?.length
      ? { codecColumns: row.codecTakeovers.map((failure) => failure.column) }
      : {}),
    ...(history && history.execution !== 'executable'
      ? {
          history: {
            taskId: String(row.values.task_id),
            runId:
              typeof row.values.intermediary_node_run_id === 'string'
                ? row.values.intermediary_node_run_id
                : null,
            execution: history.execution,
            missingFields: history.missingFields,
          },
        }
      : {}),
  })
}

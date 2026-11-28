import { rowBlock } from '@/platform/persistence/migration/conversion/blockCodes'
import type { RuleContext } from '@/platform/persistence/migration/conversion/rule'
import type { TaskFacts } from '@/platform/persistence/migration/conversion/lookups/keys'
import type {
  SourceRow,
  TargetRef,
  JsonValue,
} from '@/platform/persistence/migration/conversion/types'

export interface TaskIssue {
  readonly code: string
  readonly missingFields: readonly string[]
  readonly detail: JsonValue
  readonly alwaysBlock?: boolean
  readonly repoOrdinal?: number | null
}

export function recordTaskIssues(
  row: SourceRow,
  facts: TaskFacts,
  issues: readonly TaskIssue[],
  targets: readonly TargetRef[],
  ctx: RuleContext,
): void {
  for (const issue of issues)
    if (issue.alwaysBlock)
      ctx.out.block(rowBlock(issue.code, row, issue.detail, issue.missingFields))
    // RFC-626 §3.2.1: the task could continue, so its records must be provable. With automatic
    // resolution the task is ended instead; operator resolution keeps this exact block.
    else if (facts.execution === 'executable')
      ctx.out.blockExecutable(
        { taskId: facts.taskId, status: facts.status },
        rowBlock(
          issue.code,
          row,
          {
            ...(issue.detail && typeof issue.detail === 'object' && !Array.isArray(issue.detail)
              ? issue.detail
              : { facts: issue.detail }),
            executableTask: { taskId: facts.taskId, status: facts.status },
          },
          issue.missingFields,
        ),
      )
  if (
    issues.length &&
    facts.execution !== 'executable' &&
    !issues.some((issue) => issue.alwaysBlock)
  )
    ctx.out.exception({
      sourceTable: row.table,
      sourceKey: row.encodedKey,
      class: 'converted',
      kind: 'history-only',
      targets,
      archive: null,
      ...(row.codecTakeovers?.length
        ? { codecColumns: row.codecTakeovers.map((failure) => failure.column) }
        : {}),
      history: {
        taskId: facts.taskId,
        runId: null,
        execution: facts.execution,
        missingFields: [...new Set(issues.flatMap((issue) => issue.missingFields))],
      },
      decision: {
        code: 'v2-task-history-only',
        detail: issues.map((issue) => ({ code: issue.code, detail: issue.detail })),
      },
    })
}

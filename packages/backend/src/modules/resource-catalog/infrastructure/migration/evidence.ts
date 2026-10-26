import type { RuleContext } from '@/platform/persistence/migration/conversion/rule'
import type {
  JsonValue,
  SourceRow,
  TargetRef,
} from '@/platform/persistence/migration/conversion/types'
import { encodeStagedValue } from '@/platform/persistence/migration/conversion/staging'

export function resourceDecision(
  row: SourceRow,
  ctx: RuleContext,
  code: string,
  detail: JsonValue,
  targets: readonly TargetRef[],
  deleted = false,
): void {
  const archive = ctx.out.archive({
    kind: deleted ? 'deleted-row' : 'source-journal',
    sourceTable: row.table,
    format: 'logical-row@1',
    bytes: new TextEncoder().encode(encodeStagedValue(row)),
    rows: 1,
  })
  ctx.out.exception({
    sourceTable: row.table,
    sourceKey: row.encodedKey,
    class: 'converted',
    kind: deleted ? 'deleted-placeholder' : 'conflict-resolved',
    targets,
    archive,
    decision: { code, detail },
  })
}

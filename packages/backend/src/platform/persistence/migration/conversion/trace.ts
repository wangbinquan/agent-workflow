import type { ConversionInput } from './plan'
import { executeConversion } from './engine'
import { encodeMigrationKey } from './migrationKey'
import type {
  ConversionBlock,
  DispositionClass,
  EncodedKey,
  LoadRejectionDecision,
  MigrationKey,
  RowDisposition,
  SettlementRewrite,
  SourcePhase,
  TargetRef,
  ChunkReceipt,
} from './types'

export interface RowExplanation {
  readonly sourceTable: string
  readonly sourceKey: EncodedKey
  readonly sourcePhase: SourcePhase
  readonly found: boolean
  readonly class: DispositionClass | null
  readonly targets: readonly TargetRef[]
  readonly dispositions: readonly RowDisposition[]
  readonly receipts: readonly ChunkReceipt[]
  readonly blocks: readonly ConversionBlock[]
  /** RFC-626: what ending its task rewrote on this row; null when nothing was rewritten. */
  readonly settlement: SettlementRewrite | null
}
export async function explainSourceRow(
  input: ConversionInput,
  table: string,
  key: MigrationKey,
  phase: SourcePhase = 'current',
  /** RFC-626: the load rejections the run persisted, so a replay sets the same rows aside. */
  loadRejections?: ReadonlyMap<string, readonly LoadRejectionDecision[]>,
): Promise<RowExplanation> {
  const encoded = encodeMigrationKey(table, key)
  const targets: TargetRef[] = []
  const dispositions: RowDisposition[] = []
  const receipts: ChunkReceipt[] = []
  const blocks: ConversionBlock[] = []
  let disposition: DispositionClass | null = null
  let found = false
  let settlement: SettlementRewrite | null = null
  await executeConversion(
    input,
    {
      async open() {
        return { committedUnitIds: new Set(), ...(loadRejections ? { loadRejections } : {}) }
      },
      async commitUnit() {},
      async finish(summary) {
        blocks.push(
          ...summary.blocks.filter(
            (block) =>
              block.scope !== 'row' && (block.sourceTable === table || block.scope === 'global'),
          ),
        )
      },
    },
    {
      unit(output, rows, links) {
        const row = rows.find(
          (row) => row.table === table && row.phase === phase && row.encodedKey === encoded,
        )
        if (!row) return
        found = true
        settlement = row.settlement ?? null
        targets.push(...links(row))
        receipts.push(output.receipt)
        const exceptions = output.dispositions.filter((item) => item.sourceKey === encoded)
        for (const exception of exceptions)
          for (const ref of exception.targets)
            if (!targets.some((target) => target.table === ref.table && target.key === ref.key))
              targets.push(ref)
        dispositions.push(...exceptions)
        blocks.push(...output.blocks.filter((block) => block.sourceKey === encoded))
        disposition = exceptions.some((item) => item.class === 'blocked')
          ? 'blocked'
          : exceptions.some((item) => item.class === 'archived')
            ? 'archived'
            : (exceptions.at(-1)?.class ??
              (output.receipt.sources.find((source) => source.table === table)?.counts.preserved
                ? 'preserved'
                : 'converted'))
      },
    },
  )
  return {
    sourceTable: table,
    sourceKey: encoded,
    sourcePhase: phase,
    found,
    class: disposition,
    targets,
    dispositions,
    receipts,
    blocks,
    settlement,
  }
}

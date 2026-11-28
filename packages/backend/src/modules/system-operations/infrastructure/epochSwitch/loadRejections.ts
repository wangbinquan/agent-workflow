import {
  RESOLUTION_CODES,
  type LoadRejectionDecision,
} from '@/platform/persistence/migration/conversion/types'
import type { MigrationMetaStore } from './metaStore'

/**
 * RFC-626 §3.3: the refusals each committed unit of a run set rows aside for, by unit, exactly
 * as they were persisted with the unit. A unit converted again — on resume, or in a trace
 * replay — reaches its committed digest only when these decisions are applied verbatim: which
 * target was refused, by which constraint and with what message cannot be recomputed.
 */
export async function readLoadRejections(
  meta: Pick<MigrationMetaStore, 'select'>,
  runId: string,
): Promise<ReadonlyMap<string, readonly LoadRejectionDecision[]>> {
  const found = new Map<string, LoadRejectionDecision[]>()
  for (const row of await meta.select('migration_row_dispositions', { runId, kind: 'archived' })) {
    const decision = row.decisionJson as { code?: unknown; detail?: unknown } | null
    if (decision?.code !== RESOLUTION_CODES.loadRejected) continue
    const unitId = String(row.unitId)
    found.set(unitId, [...(found.get(unitId) ?? []), decision.detail as LoadRejectionDecision])
  }
  return found
}

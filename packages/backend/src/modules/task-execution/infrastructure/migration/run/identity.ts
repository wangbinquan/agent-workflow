import type { TaskFacts } from '@/platform/persistence/migration/conversion/lookups/keys'
import { deriveLegacyNodeRunIdentity } from '../../../domain/runSelection/legacyIdentity'
import type {
  LegacyNodeRunIdentity,
  LegacyNodeRunRow,
} from '../../../domain/runSelection/legacyFacts'
import type { FrozenRunDefinition } from './definitions'
import type { WriterFacts } from './writers'

export function deriveRunIdentities(
  rows: readonly LegacyNodeRunRow[],
  task: TaskFacts,
  definition: FrozenRunDefinition,
  writers: WriterFacts,
): ReadonlyMap<string, LegacyNodeRunIdentity> {
  const byId = new Map(rows.map((row) => [row.id, row]))
  const writer = (id: string) => writers.writers.get(id) ?? writers.conflicts.get(id)
  const related = (id: string | null | undefined) => {
    const row = id == null ? undefined : byId.get(id)
    return row === undefined ? undefined : { row, writer: writer(row.id) }
  }
  return new Map(
    rows.map((row) => {
      const identity = deriveLegacyNodeRunIdentity(row, {
        task: {
          id: task.taskId,
          ...(task.subjectKind === 'unknown' ? {} : { subject: task.subjectKind }),
          engine: writer(row.id)?.writer === 'dynamic-workflow' ? 'dw-generate' : task.engineKind,
          ...(definition.readable
            ? {
                definition: {
                  nodes:
                    definition.platformHost === 'dw-generate' &&
                    writer(row.id)?.writer === 'dynamic-workflow'
                      ? definition.nodes.filter((node) => node.id !== '__dw_orchestrator__')
                      : definition.nodes,
                },
                fanouts: definition.fanouts,
              }
            : {}),
        },
        parent: related(row.parentNodeRunId),
        container: related(row.containerRunId),
        writer: writer(row.id),
      })
      if (writers.conflicts.has(row.id))
        return [
          row.id,
          {
            ...identity,
            role: null,
            syntheticKind: null,
            slot: null,
            family: null,
            recordMode: 'history-only' as const,
            provenanceQuality: 'unknown' as const,
            evidence: {
              ...identity.evidence,
              conflicts: [...new Set([...identity.evidence.conflicts, 'writer.user-node'])],
            },
          },
        ]
      return [row.id, identity]
    }),
  )
}

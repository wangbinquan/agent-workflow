// Explicit fixture selections for pure frontier tests. Provider tests inject the real table reader.
import { deriveFrontier as deriveWithSelection } from '@/modules/task-execution/composition/dagFrontier'
export type { Frontier, FrontierRunRow } from '@/modules/task-execution/composition/dagFrontier'
type Arguments =
  Parameters<typeof deriveWithSelection> extends [unknown, unknown, ...infer Rest] ? Rest : never
export async function deriveFrontier(...[input, ...rest]: Arguments) {
  // Legacy test builders used monotonic IDs; allocate fixture seq once, before invoking production.
  const ids = [...new Set(input.map((row) => row.id))].sort()
  const rows = input.map((row) => ({ ...row, seq: row.seq ?? ids.indexOf(row.id) + 1 }))
  return deriveWithSelection(
    {
      async currentInFrame(_taskId, frame) {
        const selected = new Map<string, { id: string }>()
        for (const row of [...rows].sort((a, b) => a.seq - b.seq)) {
          if (
            row.parentNodeRunId === null &&
            row.containerRunId === frame.containerRunId &&
            row.iteration === frame.iteration
          )
            selected.set(row.nodeId, { id: row.id })
        }
        return selected
      },
    },
    'frontier-fixture',
    rows,
    ...rest,
  )
}

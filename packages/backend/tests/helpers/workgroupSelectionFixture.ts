import { projectWorkgroupRunSelections as project } from '@/modules/task-execution/infrastructure/runSelection/workgroupProjection'
type Host = Parameters<typeof project>[0][number]
export function projectWorkgroupRunSelections<R extends Host>(input: readonly R[]) {
  const ids = [...new Set(input.map((row) => row.id))].sort()
  const rows = input.map((row) => ({ ...row, seq: row.seq ?? ids.indexOf(row.id) + 1 }))
  return project(
    rows,
    {
      async current(_taskId, slot) {
        if (slot.kind !== 'workgroup-host') throw new Error('unexpected test slot')
        return (
          [...rows]
            .filter((row) => row.nodeId === slot.nodeId && row.shardKey === slot.shardKey)
            .sort((a, b) => a.seq - b.seq)
            .at(-1) ?? null
        )
      },
    },
    'fixture',
  )
}

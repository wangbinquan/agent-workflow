import type { NodeRunStatus } from '@agent-workflow/shared'
import type { WorkgroupRunSelectionProjection } from '@/platform/runSelectionProjection'
import { createRunHistorySnapshot } from './oracle/historySnapshot'

interface HostRunFacts {
  readonly id: string
  readonly seq: number | null
  readonly nodeId: string
  readonly shardKey: string | null
  readonly status: string
  readonly wgRound?: number | null
}

/** 工作组按宿主槽位取选中；wg_round 是属性，不进入槽位。纯快照无数据库查询。 */
export async function projectWorkgroupRunSelections<R extends HostRunFacts>(
  rows: readonly R[],
): Promise<Array<R & { readonly selection: WorkgroupRunSelectionProjection }>> {
  const reader = createRunHistorySnapshot(
    '',
    rows.map((row) => ({ ...row, status: row.status as NodeRunStatus, taskId: '' })),
  )
  const history = await reader.familyHistory('', {})
  const order = new Map(history.map((row, index) => [row.id, index]))
  const legacy = new Map<string, string>()
  for (const row of history) legacy.set(JSON.stringify([row.nodeId, row.shardKey ?? '']), row.id)
  const slots = new Map<string, string | null>()
  for (const row of rows) {
    const slot = { kind: 'workgroup-host' as const, nodeId: row.nodeId, shardKey: row.shardKey }
    const key = JSON.stringify(slot)
    if (!slots.has(key)) slots.set(key, (await reader.current('', slot))?.id ?? null)
  }
  return rows.map((row) => {
    const slot = { kind: 'workgroup-host' as const, nodeId: row.nodeId, shardKey: row.shardKey }
    return {
      ...row,
      selection: {
        slot,
        current: slots.get(JSON.stringify(slot)) === row.id,
        legacyGroupCurrent: legacy.get(JSON.stringify([row.nodeId, row.shardKey ?? ''])) === row.id,
        sequence: order.get(row.id)!,
      },
    }
  })
}

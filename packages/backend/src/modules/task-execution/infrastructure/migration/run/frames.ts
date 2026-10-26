import { compareNodeRunMintOrder } from '@agent-workflow/shared'
import { childScopePath } from '../../../domain/environmentChain'

export interface FrameRow {
  readonly seq: number | null
  readonly id: string
  readonly nodeId: string
  readonly iteration: number
  readonly parentNodeRunId: string | null
  readonly containerRunId: string | null
  readonly scopePath: string
}
export interface FrameUpdate {
  readonly id: string
  readonly containerRunId: string
  readonly scopePath: string
}

/** Port of 5ffdbace7^ domain/legacyMigration/frameBackfill.ts; no startup side effects. */
export function backfillLegacyFrames(input: {
  readonly parentOf: ReadonlyMap<string, string>
  readonly rows: readonly FrameRow[]
}): { updates: readonly FrameUpdate[]; unresolved: readonly string[] } {
  const wrapperIds = new Set(input.parentOf.values())
  const rows = [...input.rows].sort(compareNodeRunMintOrder)
  const settledById = new Map<string, FrameRow>()
  const latestRowOfNode = new Map<string, FrameRow>()
  const updates: FrameUpdate[] = []
  const unresolved: string[] = []
  const settle = (row: FrameRow, containerRunId: string | null, scopePath: string) => {
    const settled = { ...row, containerRunId, scopePath }
    settledById.set(row.id, settled)
    latestRowOfNode.set(row.nodeId, settled)
  }
  const backfill = (row: FrameRow, containerRunId: string, scopePath: string) => {
    updates.push({ id: row.id, containerRunId, scopePath })
    settle(row, containerRunId, scopePath)
  }
  for (const row of rows) {
    if (row.containerRunId !== null) {
      settle(row, row.containerRunId, row.scopePath)
      continue
    }
    const parent = row.parentNodeRunId === null ? undefined : settledById.get(row.parentNodeRunId)
    if (parent !== undefined) {
      if (wrapperIds.has(parent.nodeId))
        backfill(row, parent.id, childScopePath(parent.scopePath, parent.nodeId, row.iteration))
      else if (parent.containerRunId !== null)
        backfill(row, parent.containerRunId, parent.scopePath)
      else settle(row, null, '')
      continue
    }
    const wrapperId = input.parentOf.get(row.nodeId)
    if (wrapperId === undefined) {
      settle(row, null, '')
      continue
    }
    const generation = latestRowOfNode.get(wrapperId)
    if (generation === undefined) {
      unresolved.push(row.id)
      settle(row, null, '')
      continue
    }
    backfill(row, generation.id, childScopePath(generation.scopePath, wrapperId, row.iteration))
  }
  return { updates, unresolved }
}

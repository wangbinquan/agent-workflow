// RFC-354 — load the generation rows a frame walk needs, once per dispatch.
//
// `resolveSourceFrame` (domain/environmentChain) is pure and walks outward one
// generation row per hop through a synchronous lookup. Dispatch reads rows
// asynchronously, so this helper materializes the consumer's frame chain —
// from its own generation row up to the top — into a Map and hands back the
// lookup. Chains are as deep as the wrapper nesting (a handful of rows), never
// the whole task.

import type { ContainerRunRow, FrameCoordinate } from '../domain/environmentChain'

export interface FrameChain {
  readonly rows: ReadonlyMap<string, ContainerRunRow>
  readonly lookup: (id: string) => ContainerRunRow | undefined
}

export async function loadFrameChain(
  read: (nodeRunId: string) => Promise<ContainerRunRow | null | undefined>,
  frame: FrameCoordinate,
): Promise<FrameChain> {
  const rows = new Map<string, ContainerRunRow>()
  let current = frame.containerRunId
  while (current !== null && !rows.has(current)) {
    const row = await read(current)
    if (row === null || row === undefined) break
    rows.set(current, {
      id: row.id,
      nodeId: row.nodeId,
      containerRunId: row.containerRunId ?? null,
      iteration: row.iteration,
    })
    current = row.containerRunId ?? null
  }
  return { rows, lookup: (id) => rows.get(id) }
}

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
}

/** RFC-481: the generation-row reader a frame walk takes (a closed interface, not a bare callback). */
export interface ContainerRunReader {
  read(nodeRunId: string): Promise<ContainerRunRow | null | undefined>
}

export async function loadFrameChain(
  reader: ContainerRunReader,
  frame: FrameCoordinate,
): Promise<FrameChain> {
  const rows = new Map<string, ContainerRunRow>()
  let current = frame.containerRunId
  while (current !== null && !rows.has(current)) {
    const row = await reader.read(current)
    if (row === null || row === undefined) break
    rows.set(current, {
      id: row.id,
      nodeId: row.nodeId,
      containerRunId: row.containerRunId ?? null,
      iteration: row.iteration,
    })
    current = row.containerRunId ?? null
  }
  return { rows }
}

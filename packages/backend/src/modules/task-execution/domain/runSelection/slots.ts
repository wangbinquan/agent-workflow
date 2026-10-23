import type { NodeRunSyntheticKind } from '../nodeRunRole'

export interface Frame {
  readonly containerRunId: string | null
  readonly iteration: number
}

export type RunSlot =
  | { readonly kind: 'node'; readonly nodeId: string; readonly frame: Frame }
  | { readonly kind: 'container'; readonly nodeId: string; readonly frame: Frame }
  | {
      readonly kind: 'shard'
      readonly nodeId: string
      readonly iteration: number
      /** null 是 fanout 的 shared/broadcast 行。 */
      readonly shardKey: string | null
    }
  | { readonly kind: 'aggregator'; readonly nodeId: string; readonly iteration: number }
  | {
      readonly kind: 'synthetic'
      readonly owner: { readonly kind: 'task' | 'attempt'; readonly id: string }
      readonly syntheticKind: Exclude<NodeRunSyntheticKind, 'workgroup-host'>
      readonly discriminator: string
    }
  | { readonly kind: 'workgroup-host'; readonly nodeId: string; readonly shardKey: string | null }

const syntheticKinds: readonly NodeRunSyntheticKind[] = [
  'repo-prep',
  'commit-push',
  'commit-session',
  'merge-resolve',
  'dw-gate',
  'wg-gate',
  'dw-orchestrator',
]

/** 数组位置固定，JSON 转义负责分隔符；shard / aggregator 故意没有外层帧。 */
export function encodeRunSlot(slot: RunSlot): string {
  switch (slot.kind) {
    case 'node':
    case 'container':
      return JSON.stringify([
        'rs1',
        slot.kind,
        slot.nodeId,
        slot.frame.containerRunId,
        slot.frame.iteration,
      ])
    case 'shard':
      return JSON.stringify(['rs1', slot.kind, slot.nodeId, slot.iteration, slot.shardKey])
    case 'aggregator':
      return JSON.stringify(['rs1', slot.kind, slot.nodeId, slot.iteration])
    case 'synthetic':
      return JSON.stringify([
        'rs1',
        slot.kind,
        slot.owner.kind,
        slot.owner.id,
        slot.syntheticKind,
        slot.discriminator,
      ])
    case 'workgroup-host':
      return JSON.stringify(['rs1', slot.kind, slot.nodeId, slot.shardKey])
  }
}

/** 只接收规范 rs1；未知版本、额外维度和非规范表示不能变成另一个槽位。 */
export function decodeRunSlot(encoded: string): RunSlot {
  let value: unknown
  try {
    value = JSON.parse(encoded)
  } catch {
    throw new Error('invalid-run-slot')
  }
  if (!Array.isArray(value) || value[0] !== 'rs1') throw new Error('invalid-run-slot')
  const nullableString = (v: unknown): v is string | null => v === null || typeof v === 'string'
  const iteration = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0
  let slot: RunSlot | undefined
  switch (value[1]) {
    case 'node':
    case 'container':
      if (
        value.length === 5 &&
        typeof value[2] === 'string' &&
        nullableString(value[3]) &&
        iteration(value[4])
      )
        slot = {
          kind: value[1],
          nodeId: value[2],
          frame: { containerRunId: value[3], iteration: value[4] },
        }
      break
    case 'shard':
      if (
        value.length === 5 &&
        typeof value[2] === 'string' &&
        iteration(value[3]) &&
        nullableString(value[4])
      )
        slot = { kind: 'shard', nodeId: value[2], iteration: value[3], shardKey: value[4] }
      break
    case 'aggregator':
      if (value.length === 4 && typeof value[2] === 'string' && iteration(value[3]))
        slot = { kind: 'aggregator', nodeId: value[2], iteration: value[3] }
      break
    case 'synthetic':
      if (
        value.length === 6 &&
        (value[2] === 'task' || value[2] === 'attempt') &&
        typeof value[3] === 'string' &&
        syntheticKinds.includes(value[4]) &&
        typeof value[5] === 'string'
      )
        slot = {
          kind: 'synthetic',
          owner: { kind: value[2], id: value[3] },
          syntheticKind: value[4],
          discriminator: value[5],
        }
      break
    case 'workgroup-host':
      if (value.length === 4 && typeof value[2] === 'string' && nullableString(value[3]))
        slot = { kind: 'workgroup-host', nodeId: value[2], shardKey: value[3] }
      break
  }
  if (slot === undefined || encodeRunSlot(slot) !== encoded) throw new Error('invalid-run-slot')
  return slot
}

export function runSlotsEqual(a: RunSlot, b: RunSlot): boolean {
  return encodeRunSlot(a) === encodeRunSlot(b)
}

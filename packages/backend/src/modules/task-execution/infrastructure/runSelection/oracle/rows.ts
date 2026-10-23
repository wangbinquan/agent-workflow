import type { NodeRunStatus } from '@agent-workflow/shared'
import { deriveNodeRunRole } from '../../../domain/nodeRunRole'
import { isStructurallySuperseded } from './supersession'
import { requireSupersessionScope, requireTaskLabelScope } from './scope'
import type { RunRef, RunSlot, SelectedRun } from '../../../application/ports/runSelection'

/** 旧 schema 的窄投影；不加载 prompt、inventory 或 checkpoint 大列。 */
export interface OracleRunRow {
  readonly id: string
  readonly taskId: string
  readonly nodeId: string
  readonly seq: number | null
  readonly status: NodeRunStatus
  readonly retryIndex: number
  readonly iteration: number
  readonly parentNodeRunId: string | null
  readonly containerRunId: string | null
  readonly shardKey: string | null
  readonly shardValueHash: string | null
  readonly reviewIteration: number
  readonly wgRound: number | null
  readonly rerunCause: string | null
  readonly wrapperProgressJson: string | null
  readonly consumedUpstreamRunsJson: string | null
  readonly childTaskId: string | null
  readonly startedAt: number | null
  readonly mergeState: string | null
  readonly supersededByReview: string | null
}

const labelIndexes = new WeakMap<
  readonly OracleRunRow[],
  { containers: ReadonlySet<string | null>; shards: ReadonlySet<string> }
>()
function labelIndex(rows: readonly OracleRunRow[]) {
  requireTaskLabelScope(rows, 'role')
  let index = labelIndexes.get(rows)
  if (index === undefined) {
    index = {
      containers: new Set(rows.map((row) => row.containerRunId)),
      shards: new Set(
        rows.filter((row) => row.rerunCause === 'fanout-shard').map((row) => row.nodeId),
      ),
    }
    labelIndexes.set(rows, index)
  }
  return index
}

export function oracleRunRole(row: OracleRunRow, rows: readonly OracleRunRow[]) {
  requireTaskLabelScope(rows, 'role')
  return deriveNodeRunRole({
    nodeId: row.nodeId,
    rerunCause: row.rerunCause,
    wrapperProgressJson: row.wrapperProgressJson,
    hasContainerChildren: labelIndex(rows).containers.has(row.id),
  })
}

export function oracleRunSlot(row: OracleRunRow, rows: readonly OracleRunRow[]): RunSlot {
  requireTaskLabelScope(rows, 'slot')
  const role = oracleRunRole(row, rows)
  if (role.syntheticKind === 'workgroup-host')
    return { kind: 'workgroup-host', nodeId: row.nodeId, shardKey: row.shardKey }
  if (role.syntheticKind !== null)
    return {
      kind: 'synthetic',
      owner:
        row.parentNodeRunId === null
          ? { kind: 'task', id: row.taskId }
          : { kind: 'attempt', id: row.parentNodeRunId },
      syntheticKind: role.syntheticKind,
      discriminator: row.nodeId,
    }
  if (role.role === 'container')
    return {
      kind: 'container',
      nodeId: row.nodeId,
      frame: { containerRunId: row.containerRunId, iteration: row.iteration },
    }
  if (row.parentNodeRunId !== null) {
    // 无 shard 的 shared/broadcast 与 aggregator 共用旧物理形状；旧 cause 仍在时可区分。
    const shared = row.rerunCause === 'fanout-shard' || labelIndex(rows).shards.has(row.nodeId)
    if (row.shardKey !== null || shared)
      return {
        kind: 'shard',
        nodeId: row.nodeId,
        iteration: row.iteration,
        shardKey: row.shardKey,
      }
    return { kind: 'aggregator', nodeId: row.nodeId, iteration: row.iteration }
  }
  return {
    kind: 'node',
    nodeId: row.nodeId,
    frame: { containerRunId: row.containerRunId, iteration: row.iteration },
  }
}

const refSources = new WeakMap<
  RunRef,
  {
    row: OracleRunRow
    rows: readonly OracleRunRow[]
    slot?: RunSlot
  }
>()
const refFields = [
  'id',
  'taskId',
  'nodeId',
  'seq',
  'status',
  'retryIndex',
  'iteration',
  'parentNodeRunId',
  'containerRunId',
  'shardKey',
  'shardValueHash',
  'reviewIteration',
  'wgRound',
  'rerunCause',
  'childTaskId',
  'startedAt',
  'mergeState',
  'supersededByReview',
] as const
// Keep the enumerable DTO surface while sharing accessor functions across refs.
const refDescriptors: PropertyDescriptorMap = {
  ...Object.fromEntries(
    refFields.map((field) => [
      field,
      {
        enumerable: true,
        get(this: RunRef) {
          return refSources.get(this)!.row[field]
        },
      },
    ]),
  ),
  role: {
    enumerable: true,
    get(this: RunRef) {
      const { row, rows } = refSources.get(this)!
      return oracleRunRole(row, rows).role
    },
  },
  syntheticKind: {
    enumerable: true,
    get(this: RunRef) {
      const { row, rows } = refSources.get(this)!
      return oracleRunRole(row, rows).syntheticKind
    },
  },
  slot: {
    enumerable: true,
    get(this: RunRef) {
      const { row, rows, slot } = refSources.get(this)!
      requireTaskLabelScope(rows, 'slot')
      return slot ?? oracleRunSlot(row, rows)
    },
  },
  structurallySuperseded: {
    enumerable: true,
    get(this: RunRef) {
      const { row, rows } = refSources.get(this)!
      requireSupersessionScope(row, rows)
      return isStructurallySuperseded(row, rows)
    },
  },
}

export function oracleRunRef(
  row: OracleRunRow,
  rows: readonly OracleRunRow[],
  slot?: RunSlot,
): RunRef {
  const ref = Object.defineProperties({}, refDescriptors) as RunRef
  refSources.set(ref, { row, rows, slot })
  return ref
}

export function oracleSelectedRun(
  row: OracleRunRow,
  rows: readonly OracleRunRow[],
  slot?: RunSlot,
): SelectedRun {
  return Object.assign(oracleRunRef(row, rows, slot), {
    revision: null,
    // wrapper.findResumable 先取最新，再判终态；canceled/interrupted 沿用旧可续跑口径。
    resumable: row.status !== 'done' && row.status !== 'failed' && row.status !== 'exhausted',
  })
}

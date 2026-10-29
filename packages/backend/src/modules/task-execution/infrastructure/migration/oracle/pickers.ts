import { compareLegacyNodeRunMintOrder } from './legacyOrder'
import { pickFreshestRun, pickLatestRunInFrame } from './legacyPickers'
import { isStructurallySuperseded } from './supersession'
import { requireSupersessionScope, requireTaskLabelScope } from './scope'
import { runSlotsEqual } from '../../../domain/runSelection/slots'
import type {
  FamilyRef,
  Frame,
  HistoryFilter,
  LegacyRunSeq,
  RunSlot,
} from '../../../application/ports/runSelection'
import { oracleRunRole, oracleRunSlot, type OracleRunRow } from './rows'

export function oracleSlotRows(
  rows: readonly OracleRunRow[],
  slot: RunSlot,
): readonly OracleRunRow[] {
  switch (slot.kind) {
    case 'node':
    case 'container':
      return rows.filter(
        (row) =>
          row.nodeId === slot.nodeId &&
          row.iteration === slot.frame.iteration &&
          row.containerRunId === slot.frame.containerRunId &&
          (slot.kind === 'container' || row.parentNodeRunId === null),
      )
    case 'shard':
      return rows.filter(
        (row) =>
          row.nodeId === slot.nodeId &&
          row.iteration === slot.iteration &&
          row.parentNodeRunId !== null &&
          row.shardKey === slot.shardKey,
      )
    case 'aggregator':
      return rows.filter(
        (row) =>
          row.nodeId === slot.nodeId &&
          row.iteration === slot.iteration &&
          row.parentNodeRunId !== null &&
          row.shardKey === null,
      )
    case 'workgroup-host':
      return rows.filter((row) => row.nodeId === slot.nodeId && row.shardKey === slot.shardKey)
    case 'synthetic':
      requireTaskLabelScope(rows, 'slot')
      return rows.filter((row) => runSlotsEqual(oracleRunSlot(row, rows), slot))
  }
}

export function oracleCurrent(
  rows: readonly OracleRunRow[],
  slot: RunSlot,
): OracleRunRow | undefined {
  const candidates = oracleSlotRows(rows, slot)
  for (const row of candidates) void row.seq
  if (slot.kind === 'node') return pickLatestRunInFrame(candidates, slot.frame)
  if (slot.kind === 'synthetic' && slot.syntheticKind === 'repo-prep')
    return oracleHistory(candidates, rows, { order: 'retry-index' }).at(-1)
  return pickFreshestRun(candidates, { topLevelOnly: false })
}

export function oracleCurrentInFrame(
  rows: readonly OracleRunRow[],
  frame: Frame,
): ReadonlyMap<string, OracleRunRow> {
  const selected = new Map<string, OracleRunRow>()
  for (const row of rows) void row.seq
  for (const row of [...rows].sort(compareLegacyNodeRunMintOrder)) {
    if (
      row.parentNodeRunId !== null ||
      row.containerRunId !== frame.containerRunId ||
      row.iteration !== frame.iteration
    )
      continue
    const previous = selected.get(row.nodeId)
    if (previous === undefined || compareLegacyNodeRunMintOrder(row, previous) > 0)
      selected.set(row.nodeId, row)
  }
  return selected
}

export function oracleFamilyRows(
  rows: readonly OracleRunRow[],
  family: FamilyRef,
): readonly OracleRunRow[] {
  if (family.syntheticKind !== undefined) requireTaskLabelScope(rows, 'role')
  return rows.filter(
    (row) =>
      (family.syntheticKind === undefined ||
        oracleRunRole(row, rows).syntheticKind === family.syntheticKind) &&
      (family.nodeId === undefined || row.nodeId === family.nodeId) &&
      (family.nodeIds === undefined || family.nodeIds.includes(row.nodeId)) &&
      (family.iteration === undefined || row.iteration === family.iteration) &&
      (family.shardKey === undefined || row.shardKey === family.shardKey) &&
      (family.reviewIteration === undefined || row.reviewIteration === family.reviewIteration) &&
      (family.parentNodeRunId === undefined || row.parentNodeRunId === family.parentNodeRunId) &&
      (family.containerRunId === undefined || row.containerRunId === family.containerRunId) &&
      (family.wgRound === undefined || row.wgRound === family.wgRound) &&
      (family.runIds === undefined || family.runIds.includes(row.id)),
  )
}

export function oracleHistory(
  candidates: readonly OracleRunRow[],
  allRows: readonly OracleRunRow[],
  filter: HistoryFilter<LegacyRunSeq> = {},
): readonly OracleRunRow[] {
  if (filter.excludeSuperseded === true)
    for (const row of candidates) requireSupersessionScope(row, allRows)
  for (const row of candidates) void row.seq
  const rows = candidates.filter(
    (row) =>
      (filter.attemptIndexGreaterThan === undefined ||
        row.retryIndex > filter.attemptIndexGreaterThan) &&
      (filter.statusIn === undefined || filter.statusIn.includes(row.status)) &&
      (filter.topLevelOnly !== true || row.parentNodeRunId === null) &&
      (filter.childOnly !== true || row.parentNodeRunId !== null) &&
      (filter.consumedOnly !== true || row.consumedUpstreamRunsJson !== null) &&
      (filter.childTaskOnly !== true || row.childTaskId !== null) &&
      (filter.rerunCause === undefined || row.rerunCause === filter.rerunCause) &&
      (filter.through === undefined || compareLegacyNodeRunMintOrder(row, filter.through) <= 0) &&
      (filter.from === undefined || compareLegacyNodeRunMintOrder(row, filter.from) >= 0) &&
      (filter.before === undefined || compareLegacyNodeRunMintOrder(row, filter.before) < 0) &&
      (filter.after === undefined || compareLegacyNodeRunMintOrder(row, filter.after) > 0) &&
      (filter.excludeSuperseded !== true || !isStructurallySuperseded(row, allRows)),
  )
  return rows.sort((a, b) => {
    let priority = 0
    switch (filter.order) {
      case 'started-at':
        priority = (a.startedAt ?? 0) - (b.startedAt ?? 0)
        break
      case 'api-timeline':
        // DTO 保留 NULLS FIRST；started-at 仅是历史排序，不能用作 call 收养。
        priority =
          a.startedAt === null
            ? b.startedAt === null
              ? 0
              : -1
            : b.startedAt === null
              ? 1
              : a.startedAt - b.startedAt
        break
      case 'retry-index':
        priority = a.retryIndex - b.retryIndex
        break
      case 'iteration':
        priority = a.iteration - b.iteration
        break
      case 'running-first':
        priority = Number(a.status === 'running') - Number(b.status === 'running')
        break
    }
    return (
      (priority || compareLegacyNodeRunMintOrder(a, b)) * (filter.direction === 'desc' ? -1 : 1)
    )
  })
}

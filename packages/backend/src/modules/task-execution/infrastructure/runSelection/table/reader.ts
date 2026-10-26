import { structurallySupersededCondition } from './supersessionSql'
import { and, asc, eq, inArray, isNull, type SQL } from 'drizzle-orm'
import { isMergeStateSettled } from '@agent-workflow/shared'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import type {
  FamilyRef,
  HistoryFilter,
  RunRef,
  RunSelectionReader,
  RunSlot,
  SelectedRun,
  ShardSetView,
} from '../../../application/ports/runSelection'
import {
  decodeCanonicalRunSlot,
  encodeCanonicalRunSlot,
} from '../../../domain/runSelection/slotKey'

async function loadRows(db: PersistenceDb, taskId: string, scope?: SQL) {
  const {
    nodeRuns: r,
    nodeRunConfigs: c,
    nodeRunRuntimeStates: s,
    nodeRunResults: o,
    nodeRunSelections: selected,
  } = tablesOf(db)
  return db
    .select({
      id: r.id,
      taskId: r.taskId,
      nodeId: r.nodeId,
      seq: r.seq,
      status: r.status,
      slotKey: r.slotKey,
      role: r.role,
      recordMode: r.recordMode,
      retryIndex: r.attemptIndex,
      iteration: r.iteration,
      parentNodeRunId: r.historicalParentId,
      containerRunId: r.containerRunId,
      shardKey: r.shardKey,
      shardValueHash: c.shardValueHash,
      reviewIteration: r.reviewIteration,
      wgRound: r.wgRound,
      rerunCause: r.rerunCause,
      childTaskId: r.childTaskId,
      startedAt: r.startedAt,
      mergeState: s.mergeState,
      supersededByReview: o.supersededByReview,
      inputsRecorded: r.inputsRecorded,
      structurallySuperseded: structurallySupersededCondition(db).mapWith(Boolean),
      revision: selected.revision,
    })
    .from(r)
    .leftJoin(c, eq(c.nodeRunId, r.id))
    .leftJoin(s, eq(s.nodeRunId, r.id))
    .leftJoin(o, eq(o.nodeRunId, r.id))
    .leftJoin(
      selected,
      and(
        eq(selected.taskId, r.taskId),
        eq(selected.slotKey, r.slotKey),
        eq(selected.selectedRunId, r.id),
      ),
    )
    .where(and(eq(r.taskId, taskId), scope))
    .orderBy(asc(r.seq))
}
type Row = Awaited<ReturnType<typeof loadRows>>[number]

/** Unknown converted identity is history evidence, never an executable selection. */
export interface UnresolvedRunHistoryRef extends Omit<RunRef, 'slot' | 'role' | 'retryIndex'> {
  readonly identity: 'unknown'
  readonly recordMode: 'history-only'
  readonly slot: RunSlot | null
  readonly role: RunRef['role'] | null
  readonly retryIndex: number | null
}
export type RunHistoryRef = RunRef | UnresolvedRunHistoryRef
export interface TableShardSetView extends ShardSetView {
  readonly history: readonly RunHistoryRef[]
}
export interface TableRunSelectionReader extends Omit<
  RunSelectionReader,
  'slotHistory' | 'familyHistory' | 'shardSet'
> {
  /** Zero only when no row exists; a cleared slot retains its last revision. */
  revision(taskId: string, slot: RunSlot): Promise<number>
  slotHistory(
    taskId: string,
    slot: RunSlot,
    filter?: HistoryFilter,
  ): Promise<readonly RunHistoryRef[]>
  familyHistory(
    taskId: string,
    family: FamilyRef,
    filter?: HistoryFilter,
  ): Promise<readonly RunHistoryRef[]>
  shardSet(
    taskId: string,
    wrapper: Parameters<RunSelectionReader['shardSet']>[1],
  ): Promise<TableShardSetView>
}

function hasKnownIdentity(row: Row): row is Row & {
  readonly role: NonNullable<Row['role']>
  readonly slotKey: string
  readonly retryIndex: number
} {
  return row.role !== null && row.slotKey !== null && row.retryIndex !== null
}

/** Structural history remains a predicate, not a destructive clear of reusable shards. */
function supersededIds(rows: readonly Row[]): ReadonlySet<string> {
  return new Set(rows.filter((row) => row.structurallySuperseded).map((row) => row.id))
}

function historyRef(row: Row, superseded: ReadonlySet<string>): RunHistoryRef {
  const slot = row.slotKey === null ? null : decodeCanonicalRunSlot(row.slotKey)
  const syntheticKind =
    slot?.kind === 'synthetic'
      ? slot.syntheticKind
      : slot?.kind === 'workgroup-host'
        ? 'workgroup-host'
        : null
  const facts: Omit<RunRef, 'slot' | 'role' | 'retryIndex'> = {
    id: row.id,
    taskId: row.taskId,
    nodeId: row.nodeId,
    seq: row.seq,
    syntheticKind,
    status: row.status,
    iteration: row.iteration,
    containerRunId: row.containerRunId,
    parentNodeRunId: row.parentNodeRunId,
    shardKey: row.shardKey,
    shardValueHash: row.shardValueHash,
    reviewIteration: row.reviewIteration,
    wgRound: row.wgRound,
    rerunCause: row.rerunCause,
    childTaskId: row.childTaskId,
    startedAt: row.startedAt,
    mergeState: row.mergeState,
    supersededByReview: row.supersededByReview,
    structurallySuperseded: superseded.has(row.id),
  }
  if (hasKnownIdentity(row))
    return {
      ...facts,
      slot: decodeCanonicalRunSlot(row.slotKey),
      role: row.role,
      retryIndex: row.retryIndex,
    }
  return {
    ...facts,
    identity: 'unknown',
    recordMode: 'history-only',
    slot,
    role: row.role,
    retryIndex: row.retryIndex,
  }
}
function ref(row: Row, superseded: ReadonlySet<string>): RunRef {
  const value = historyRef(row, superseded)
  if ('identity' in value) throw new Error(`node-run-history-identity-unresolved:${row.id}`)
  return value
}
function selectedRef(row: Row | undefined, superseded: ReadonlySet<string>): SelectedRun | null {
  if (!row || !hasKnownIdentity(row) || row.recordMode !== 'executable') return null
  return {
    ...ref(row, superseded),
    revision: row.revision,
    resumable:
      row.recordMode === 'executable' &&
      row.status !== 'done' &&
      row.status !== 'failed' &&
      row.status !== 'exhausted',
  }
}
function familyMatches(row: Row, family: FamilyRef): boolean {
  const slot =
    family.syntheticKind === undefined || row.slotKey === null
      ? null
      : decodeCanonicalRunSlot(row.slotKey)
  const syntheticKind =
    slot?.kind === 'synthetic'
      ? slot.syntheticKind
      : slot?.kind === 'workgroup-host'
        ? 'workgroup-host'
        : null
  return (
    (family.syntheticKind === undefined || syntheticKind === family.syntheticKind) &&
    (family.nodeId === undefined || row.nodeId === family.nodeId) &&
    (family.nodeIds === undefined || family.nodeIds.includes(row.nodeId)) &&
    (family.iteration === undefined || row.iteration === family.iteration) &&
    (family.shardKey === undefined || row.shardKey === family.shardKey) &&
    (family.reviewIteration === undefined || row.reviewIteration === family.reviewIteration) &&
    (family.parentNodeRunId === undefined || row.parentNodeRunId === family.parentNodeRunId) &&
    (family.containerRunId === undefined || row.containerRunId === family.containerRunId) &&
    (family.wgRound === undefined || row.wgRound === family.wgRound) &&
    (family.runIds === undefined || family.runIds.includes(row.id))
  )
}
function history(
  rows: readonly Row[],
  superseded: ReadonlySet<string>,
  filter: HistoryFilter = {},
): RunHistoryRef[] {
  for (const boundary of [filter.through, filter.from, filter.before, filter.after])
    if (boundary && boundary.seq === null) throw new Error('run-sequence-required')
  return rows
    .filter(
      (row) =>
        (filter.executableOnly !== true || row.recordMode === 'executable') &&
        (filter.attemptIndexGreaterThan === undefined ||
          (row.retryIndex !== null && row.retryIndex > filter.attemptIndexGreaterThan)) &&
        (filter.statusIn === undefined || filter.statusIn.includes(row.status)) &&
        (filter.topLevelOnly !== true || row.parentNodeRunId === null) &&
        (filter.childOnly !== true || row.parentNodeRunId !== null) &&
        (filter.consumedOnly !== true || row.inputsRecorded) &&
        (filter.childTaskOnly !== true || row.childTaskId !== null) &&
        (filter.rerunCause === undefined || row.rerunCause === filter.rerunCause) &&
        (filter.through === undefined || row.seq <= filter.through.seq!) &&
        (filter.from === undefined || row.seq >= filter.from.seq!) &&
        (filter.before === undefined || row.seq < filter.before.seq!) &&
        (filter.after === undefined || row.seq > filter.after.seq!) &&
        (filter.excludeSuperseded !== true || !superseded.has(row.id)),
    )
    .sort((a, b) => {
      let priority = 0
      switch (filter.order) {
        case 'started-at':
          priority = (a.startedAt ?? 0) - (b.startedAt ?? 0)
          break
        case 'api-timeline':
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
          priority = (a.retryIndex ?? 0) - (b.retryIndex ?? 0)
          break
        case 'iteration':
          priority = a.iteration - b.iteration
          break
        case 'running-first':
          priority = Number(a.status === 'running') - Number(b.status === 'running')
          break
      }
      return (priority || a.seq - b.seq) * (filter.direction === 'desc' ? -1 : 1)
    })
    .map((row) => historyRef(row, superseded))
}

/** Current reads the persisted choice, including repo-prep's retry-priority initialization.
 * Neither IDs nor timestamps reconstruct a missing selection. */
export function createRunSelectionReader(db: PersistenceDb): TableRunSelectionReader {
  const consumed: RunSelectionReader['consumed'] = async (runId) => {
    const { nodeRunInputs } = tablesOf(db)
    return db
      .select({
        producerNodeId: nodeRunInputs.producerNodeId,
        producerRunId: nodeRunInputs.producerRunId,
      })
      .from(nodeRunInputs)
      .where(
        and(eq(nodeRunInputs.consumerRunId, runId), eq(nodeRunInputs.inputKind, 'frame-input')),
      )
      .orderBy(asc(nodeRunInputs.ordinal))
  }
  return {
    async revision(taskId, slot) {
      const { nodeRunSelections } = tablesOf(db)
      const [row] = await db
        .select({ revision: nodeRunSelections.revision })
        .from(nodeRunSelections)
        .where(
          and(
            eq(nodeRunSelections.taskId, taskId),
            eq(nodeRunSelections.slotKey, encodeCanonicalRunSlot(slot)),
          ),
        )
        .limit(1)
      return row?.revision ?? 0
    },
    async current(taskId, slot) {
      const key = encodeCanonicalRunSlot(slot)
      const { nodeRuns, nodeRunSelections } = tablesOf(db)
      const rows = await loadRows(
        db,
        taskId,
        and(eq(nodeRuns.slotKey, key), eq(nodeRunSelections.selectedRunId, nodeRuns.id)),
      )
      return selectedRef(
        rows.find((row) => row.slotKey === key && row.revision !== null),
        supersededIds(rows),
      )
    },
    async currentInFrame(taskId, frame) {
      const { nodeRuns } = tablesOf(db)
      const rows = await loadRows(
        db,
        taskId,
        and(
          isNull(nodeRuns.historicalParentId),
          eq(nodeRuns.iteration, frame.iteration),
          frame.containerRunId === null
            ? isNull(nodeRuns.containerRunId)
            : eq(nodeRuns.containerRunId, frame.containerRunId),
        ),
      )
      const superseded = supersededIds(rows)
      const result = new Map<string, SelectedRun>()
      const selectedSlots = new Set(
        rows.filter((row) => row.revision !== null).map((row) => row.slotKey),
      )
      for (const row of rows) {
        if (
          !hasKnownIdentity(row) ||
          row.recordMode !== 'executable' ||
          row.parentNodeRunId !== null ||
          row.containerRunId !== frame.containerRunId ||
          row.iteration !== frame.iteration
        )
          continue
        // The frontier's synthetic timeline historically uses seq, independently
        // of repo-prep's retry-priority current() slot. Ordinary slots use selections.
        const slot = row.slotKey === null ? null : decodeCanonicalRunSlot(row.slotKey)
        if (
          row.revision === null &&
          (slot?.kind !== 'synthetic' || !selectedSlots.has(row.slotKey))
        )
          continue
        const previous = result.get(row.nodeId)
        if (!previous || row.seq > previous.seq!)
          result.set(row.nodeId, selectedRef(row, superseded)!)
      }
      return result
    },
    async slotHistory(taskId, slot, filter) {
      const { nodeRuns } = tablesOf(db)
      const rows = await loadRows(db, taskId, eq(nodeRuns.slotKey, encodeCanonicalRunSlot(slot)))
      return history(
        rows.filter((row) => row.slotKey === encodeCanonicalRunSlot(slot)),
        supersededIds(rows),
        filter,
      )
    },
    async familyHistory(taskId, family, filter) {
      const { nodeRuns: r } = tablesOf(db)
      if (family.nodeIds?.length === 0 || family.runIds?.length === 0) return []
      const scope = and(
        family.nodeId === undefined ? undefined : eq(r.nodeId, family.nodeId),
        family.nodeIds === undefined ? undefined : inArray(r.nodeId, [...family.nodeIds]),
        family.iteration === undefined ? undefined : eq(r.iteration, family.iteration),
        family.parentNodeRunId === undefined
          ? undefined
          : family.parentNodeRunId === null
            ? isNull(r.historicalParentId)
            : eq(r.historicalParentId, family.parentNodeRunId),
        family.containerRunId === undefined
          ? undefined
          : family.containerRunId === null
            ? isNull(r.containerRunId)
            : eq(r.containerRunId, family.containerRunId),
        family.shardKey === undefined
          ? undefined
          : family.shardKey === null
            ? isNull(r.shardKey)
            : eq(r.shardKey, family.shardKey),
      )
      const { runIds, ...matchingFamily } = family
      const rows: Row[] = []
      if (runIds === undefined) rows.push(...(await loadRows(db, taskId, scope)))
      else {
        const ids = [...new Set(runIds)]
        for (let offset = 0; offset < ids.length; offset += 400)
          rows.push(
            ...(await loadRows(
              db,
              taskId,
              and(scope, inArray(r.id, ids.slice(offset, offset + 400))),
            )),
          )
      }
      const superseded = supersededIds(rows)
      return history(
        rows.filter((row) => familyMatches(row, matchingFamily)),
        superseded,
        filter,
      )
    },
    consumed,
    async shardSet(taskId, wrapper): Promise<TableShardSetView> {
      const { nodeRuns } = tablesOf(db)
      const nodeIds = [
        ...new Set([
          ...wrapper.shards.map((shard) => shard.nodeId),
          ...(wrapper.aggregatorNodeId === undefined ? [] : [wrapper.aggregatorNodeId]),
        ]),
      ]
      const rows =
        nodeIds.length === 0
          ? []
          : await loadRows(
              db,
              taskId,
              and(inArray(nodeRuns.nodeId, nodeIds), eq(nodeRuns.iteration, wrapper.iteration)),
            )
      const superseded = supersededIds(rows)
      const forced = wrapper.processRetryIndex !== undefined
      const participating: RunRef[] = []
      const inSlot = (slot: RunSlot) =>
        rows.filter(
          (row) =>
            row.slotKey === encodeCanonicalRunSlot(slot) &&
            hasKnownIdentity(row) &&
            row.recordMode === 'executable',
        )
      const shards = wrapper.shards.map((request) => {
        const slot = {
          kind: 'shard' as const,
          nodeId: request.nodeId,
          iteration: wrapper.iteration,
          shardKey: request.shardKey,
        }
        const candidates = inSlot(slot)
        const current = candidates.find((row) => row.revision !== null)
        const input = candidates
          .filter(
            (row) =>
              row.status === 'done' &&
              (row.shardValueHash === null ||
                request.valueHash === null ||
                row.shardValueHash === request.valueHash),
          )
          .at(-1)
        if (input) participating.push(ref(input, superseded))
        const reusable = forced || wrapper.reuseDisabled === true ? undefined : input
        const merged = candidates.filter(
          (row) => row.status === 'done' && row.mergeState === 'merged',
        )
        return {
          slot,
          current: selectedRef(current, superseded),
          reusable: reusable ? ref(reusable, superseded) : null,
          replayable:
            reusable !== undefined &&
            reusable.id === current?.id &&
            (isMergeStateSettled(reusable.mergeState) || reusable.mergeState === 'conflict-human'),
          rerunInPlace:
            !forced &&
            current !== undefined &&
            current.status !== 'done' &&
            current.parentNodeRunId === wrapper.wrapperRunId,
          singleMergedCandidate: merged.length === 1 ? ref(merged[0]!, superseded) : null,
        }
      })
      const aggregator =
        wrapper.aggregatorNodeId === undefined
          ? undefined
          : inSlot({
              kind: 'aggregator',
              nodeId: wrapper.aggregatorNodeId,
              iteration: wrapper.iteration,
            }).find((row) => row.revision !== null)
      const newer =
        aggregator !== undefined && participating.every((row) => aggregator.seq > row.seq!)
      const { nodeRunInputs } = tablesOf(db)
      const inputs = aggregator
        ? await db
            .select({
              producerNodeId: nodeRunInputs.producerNodeId,
              producerRunId: nodeRunInputs.producerRunId,
              inputKind: nodeRunInputs.inputKind,
            })
            .from(nodeRunInputs)
            .where(
              and(
                eq(nodeRunInputs.consumerRunId, aggregator.id),
                inArray(nodeRunInputs.inputKind, ['frame-input', 'aggregator-shard']),
              ),
            )
            .orderBy(asc(nodeRunInputs.ordinal))
        : []
      return {
        history: history(
          rows.filter(
            (row) =>
              row.iteration === wrapper.iteration &&
              (row.nodeId === wrapper.aggregatorNodeId ||
                wrapper.shards.some(
                  (request) => row.nodeId === request.nodeId && row.shardKey === request.shardKey,
                )),
          ),
          superseded,
        ),
        shards,
        participating,
        aggregator: selectedRef(aggregator, superseded),
        aggregatorInputs: inputs.map(({ producerNodeId, producerRunId }) => ({
          producerNodeId,
          producerRunId,
        })),
        aggregatorInputEvidence: inputs.some((input) => input.inputKind === 'aggregator-shard')
          ? 'aggregator-shard'
          : inputs.length === 0
            ? 'unrecorded'
            : 'source-node',
        aggregatorNewerThanInputs: newer,
        aggregatorReplayable:
          !forced &&
          wrapper.reuseDisabled !== true &&
          aggregator !== undefined &&
          aggregator.status === 'done' &&
          newer &&
          (isMergeStateSettled(aggregator.mergeState) ||
            aggregator.mergeState === 'conflict-human'),
        aggregatorRerunInPlace:
          !forced &&
          aggregator !== undefined &&
          aggregator.status !== 'done' &&
          aggregator.parentNodeRunId === wrapper.wrapperRunId,
      }
    },
  }
}

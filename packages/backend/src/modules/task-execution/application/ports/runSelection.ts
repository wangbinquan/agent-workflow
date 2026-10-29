import type { NodeRunStatus } from '@agent-workflow/shared'
import type { DerivedNodeRunRole } from '../../domain/nodeRunRole'
import type { Frame, RunSlot } from '../../domain/runSelection/slots'
import type { SelectionChange, SelectionRevision } from '../../domain/runSelection/changes'
export type { Frame, RunSlot } from '../../domain/runSelection/slots'
export type { SelectionChange, SelectionRevision } from '../../domain/runSelection/changes'

/**
 * RFC-395 D4: epoch-2 rows always carry their allocated seq. Only the epoch-1 migration
 * oracle reads rows minted before RFC-374, so only it instantiates these views with
 * `LegacyRunSeq`.
 */
export type LegacyRunSeq = number | null

export interface RunRef<Seq extends LegacyRunSeq = number> {
  readonly id: string
  readonly taskId: string
  readonly nodeId: string
  readonly seq: Seq
  readonly slot: RunSlot
  readonly role: DerivedNodeRunRole['role']
  readonly syntheticKind: DerivedNodeRunRole['syntheticKind']
  readonly status: NodeRunStatus
  readonly retryIndex: number
  readonly iteration: number
  readonly containerRunId: string | null
  readonly parentNodeRunId: string | null
  readonly shardKey: string | null
  readonly shardValueHash: string | null
  readonly reviewIteration: number
  readonly wgRound: number | null
  readonly rerunCause: string | null
  readonly childTaskId: string | null
  readonly startedAt: number | null
  readonly mergeState: string | null
  readonly supersededByReview: string | null
  readonly structurallySuperseded: boolean
}

/** Converted unresolved identity is available to history readers only. */
export interface UnresolvedRunHistoryRef<Seq extends LegacyRunSeq = number> extends Omit<
  RunRef<Seq>,
  'slot' | 'role' | 'retryIndex'
> {
  readonly identity: 'unknown'
  readonly recordMode: 'history-only'
  readonly slot: RunSlot | null
  readonly role: RunRef['role'] | null
  readonly retryIndex: number | null
}
export type RunHistoryRef<Seq extends LegacyRunSeq = number> =
  | RunRef<Seq>
  | UnresolvedRunHistoryRef<Seq>

export interface SelectedRun<Seq extends LegacyRunSeq = number> extends RunRef<Seq> {
  /** Epoch-2 selections carry a durable revision; only frozen epoch-1 evidence can be null. */
  readonly revision: number | null
  readonly resumable: boolean
}

/** 旧载荷只有 source-node 粒度，不能补造 input port / ordinal / shard。 */
export interface ConsumedEdge {
  readonly producerNodeId: string
  readonly producerRunId: string
}

export interface FamilyRef {
  /** 省略表示整个任务；跨帧范围必须由调用方显式选择 familyHistory。 */
  readonly syntheticKind?: RunRef['syntheticKind']
  readonly nodeId?: string
  readonly nodeIds?: readonly string[]
  readonly iteration?: number
  readonly shardKey?: string | null
  readonly reviewIteration?: number
  readonly parentNodeRunId?: string | null
  readonly containerRunId?: string | null
  readonly wgRound?: number | null
  readonly runIds?: readonly string[]
}

export interface HistoryFilter<Seq extends LegacyRunSeq = number> {
  readonly executableOnly?: boolean
  readonly attemptIndexGreaterThan?: number
  readonly statusIn?: readonly NodeRunStatus[]
  readonly topLevelOnly?: boolean
  readonly childOnly?: boolean
  readonly excludeSuperseded?: boolean
  readonly consumedOnly?: boolean
  readonly childTaskOnly?: boolean
  readonly rerunCause?: string
  /** 默认 seq；显式旧口径只给尚未统一的历史读者使用；call 收养总是 current(node)。 */
  readonly order?:
    | 'seq'
    | 'started-at'
    | 'api-timeline'
    | 'retry-index'
    | 'iteration'
    | 'running-first'
  readonly direction?: 'asc' | 'desc'
  readonly through?: { readonly id: string; readonly seq: Seq }
  readonly from?: { readonly id: string; readonly seq: Seq }
  readonly before?: { readonly id: string; readonly seq: Seq }
  readonly after?: { readonly id: string; readonly seq: Seq }
}

export interface ShardRequest {
  readonly nodeId: string
  readonly shardKey: string | null
  readonly valueHash: string | null
}

export interface WrapperSlotRef {
  readonly wrapperRunId: string
  readonly iteration: number
  /** 调用方给出今天实际参与聚合的 source/shard；不能从历史行猜当前拓扑。 */
  readonly shards: readonly ShardRequest[]
  readonly aggregatorNodeId?: string
  readonly reuseDisabled?: boolean
  readonly processRetryIndex?: number
}

export interface ShardSelectionView<Seq extends LegacyRunSeq = number> {
  readonly slot: Extract<RunSlot, { kind: 'shard' }>
  readonly current: SelectedRun<Seq> | null
  readonly reusable: RunRef<Seq> | null
  readonly replayable: boolean
  readonly rerunInPlace: boolean
  readonly singleMergedCandidate: RunRef<Seq> | null
}

export interface ShardSetView<Seq extends LegacyRunSeq = number> {
  readonly shards: readonly ShardSelectionView<Seq>[]
  readonly aggregator: SelectedRun<Seq> | null
  readonly participating: readonly RunRef<Seq>[]
  readonly aggregatorInputs: readonly ConsumedEdge[]
  /** 旧聚合器不写 shard 输入集合；不能把参与候选冒充已记录的消费事实。 */
  readonly aggregatorInputEvidence: 'source-node' | 'aggregator-shard' | 'unrecorded'
  readonly aggregatorNewerThanInputs: boolean
  readonly aggregatorReplayable: boolean
  readonly aggregatorRerunInPlace: boolean
}

export interface RunSelectionReader<Seq extends LegacyRunSeq = number> {
  /** Zero means no slot row; a clear retains the tombstone revision. */
  revision(taskId: string, slot: RunSlot): Promise<number>
  current(taskId: string, slot: RunSlot): Promise<SelectedRun<Seq> | null>
  currentInFrame(taskId: string, frame: Frame): Promise<ReadonlyMap<string, SelectedRun<Seq>>>
  shardSet(taskId: string, wrapper: WrapperSlotRef): Promise<ShardSetView<Seq>>
  slotHistory(
    taskId: string,
    slot: RunSlot,
    filter?: HistoryFilter<Seq>,
  ): Promise<readonly RunHistoryRef<Seq>[]>
  familyHistory(
    taskId: string,
    family: FamilyRef,
    filter?: HistoryFilter<Seq>,
  ): Promise<readonly RunHistoryRef<Seq>[]>
  consumed(runId: string): Promise<readonly ConsumedEdge[]>
}

export interface TableShardSetView extends ShardSetView {
  readonly history: readonly RunHistoryRef[]
}
export interface TableRunSelectionReader extends RunSelectionReader {
  shardSet(taskId: string, wrapper: WrapperSlotRef): Promise<TableShardSetView>
}

export interface RunSelectionParticipantInTx<Tx> {
  apply(tx: Tx, changes: readonly SelectionChange[]): Promise<readonly SelectionRevision[]>
}

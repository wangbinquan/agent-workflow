// RFC-395 II-a A1: public projection inputs, independent of the future physical table split.
import type { FixtureJson } from './core'
import type { RunCheckpointFixture, ConsumedEdgeFixture } from './checkpoint'

export interface NodeRunFixtureSpec {
  id: string
  taskId: string
  nodeId: string
  parentNodeRunId?: string | null
  containerRunId?: string | null
  scopePath?: string
  iteration?: number
  shardKey?: string | null
  retryIndex?: number
  wgRound?: number | null
  reviewIteration?: number
  status:
    | 'pending'
    | 'running'
    | 'done'
    | 'failed'
    | 'canceled'
    | 'interrupted'
    | 'skipped'
    | 'exhausted'
    | 'awaiting_review'
    | 'awaiting_human'
  startedAt?: number | null
  finishedAt?: number | null
  pid?: number | null
  spawnBinaryPath?: string | null
  spawnLaunchNonce?: string | null
  exitCode?: number | null
  errorMessage?: string | null
  failureCode?: string | null
  promptText?: string | null
  promptPath?: string | null
  envelopeNonce?: string | null
  forceActivated?: boolean
  tokInput?: number | null
  tokOutput?: number | null
  tokCacheCreate?: number | null
  tokCacheRead?: number | null
  tokTotal?: number | null
  opencodeSessionId?: string | null
  runtime?: string | null
  runtimeBinary?: string | null
  runtimeParamsJson?: FixtureJson
  inventorySnapshotJson?: FixtureJson
  runtimeInventoryJson?: FixtureJson
  startupVerificationJson?: FixtureJson
  wrapperProgressJson?: FixtureJson
  injectedMemories?: FixtureJson
  portValidationFailures?: FixtureJson
  commitPush?: FixtureJson
  isoWorktreePath?: string | null
  mergeState?: string | null
  shardValueHash?: string | null
  rerunCause?: string | null
  supersededByReview?: string | null
  rolledBack?: boolean | null
  agentOverrideName?: string | null
  agentOverrideId?: string | null
  childTaskId?: string | null
  continuationSlotKey?: string | null
  lineageSlotPathJson?: FixtureJson
  operationGeneration?: number
  seq?: number
  checkpoints?: readonly RunCheckpointFixture[]
  consumedEdges?: readonly ConsumedEdgeFixture[]
  preSnapshot?: never
  preSnapshotReposJson?: never
  isoBaseSnapshot?: never
  isoBaseSnapshotReposJson?: never
  isoNodeTree?: never
  isoNodeTreeReposJson?: never
  isoSubmodulesJson?: never
  isoSubmodulesReposJson?: never
  consumedUpstreamRunsJson?: never
}

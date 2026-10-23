// RFC-395 II-a A1: public projection inputs, independent of the future physical table split.
import type { FixtureJson } from './core'
import type { TaskRepoFixtureSpec } from './taskRepo.spec'

export interface TaskFixtureSpec {
  id: string
  name?: string
  workflowId: string
  workflowSnapshot: FixtureJson
  workflowVersion?: number | null
  repoPath: string
  repoUrl?: string | null
  cachedRepoId?: string | null
  repoGroupId?: string | null
  repoGroupName?: string | null
  worktreePath: string
  baseBranch: string
  branch: string
  baseCommit?: string | null
  status:
    | 'pending'
    | 'running'
    | 'done'
    | 'failed'
    | 'canceled'
    | 'interrupted'
    | 'awaiting_review'
    | 'awaiting_human'
  inputs: FixtureJson
  maxDurationMs?: number | null
  maxTotalTokens?: number | null
  startedAt: number
  runningMs?: number
  runningSince?: number | null
  finishedAt?: number | null
  errorSummary?: string | null
  errorMessage?: string | null
  failedNodeId?: string | null
  autoRecoveryAttempts?: number
  autoRecoverySuspended?: boolean
  autoRecoveryWindowStartedAt?: number | null
  expiresAt?: number | null
  deletedAt?: number | null
  schemaVersion?: number
  ownerUserId?: string | null
  launchOrigin?: 'manual' | 'scheduled' | 'event' | 'webhook' | 'api'
  catalogVisibility?: 'public' | 'internal'
  gitUserName?: string | null
  gitUserEmail?: string | null
  workingBranch?: string | null
  autoCommitPush?: boolean
  scheduledTaskId?: string | null
  webhookTriggerId?: string | null
  webhookFireId?: string | null
  eventSubscriptionId?: string | null
  eventDeliveryId?: string | null
  lifecycleEventRevision?: number
  sourceTerminationBinding?: string | null
  sourceTerminationLaunchRev?: number | null
  sourceTerminationFence?: 'closed' | 'merged' | null
  sourceTerminationEffectRev?: number | null
  workgroupId?: string | null
  workgroupConfigJson?: FixtureJson
  spaceKind?: 'local' | 'remote' | 'scratch' | 'internal' | 'inherited'
  sourceAgentName?: string | null
  codeRoundId?: string | null
  digitalEmployeeRoundId?: string | null
  digitalEmployeeCaseId?: string | null
  sourceAgentId?: string | null
  workspacePruningAt?: number | null
  workspacePruneCause?: 'webhook-terminal' | null
  workspacePrunedAt?: number | null
  parentTaskId?: string | null
  parentNodeRunId?: string | null
  invocationDepth?: number
  refClosureJson?: FixtureJson
  triggerContextJson?: FixtureJson
  platformInputPathsJson?: FixtureJson
  branchStartedAt?: number
  rootTaskId?: string | null
  executionLineageId?: string | null
  lineageSlotPathJson?: FixtureJson
  repos?: readonly Omit<TaskRepoFixtureSpec, 'taskId'>[]
  repoCount?: never
}

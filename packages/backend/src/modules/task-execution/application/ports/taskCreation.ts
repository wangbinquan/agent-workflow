import type { SpaceKind, TaskCatalogVisibility, TaskStatus } from '@agent-workflow/shared'
import type { TaskCreationLaunch } from '../../domain/taskCreation'
import type { TaskRepositoryMount } from '../../domain/taskRepository'
import type { TaskSubject } from '../../domain/taskSubject'

export interface TaskCreationInput {
  readonly subject: TaskSubject
  readonly core: {
    id: string
    name: string
    status: TaskStatus
    startedAt: number
    finishedAt?: number | null
    errorSummary?: string | null
    errorMessage?: string | null
    ownerUserId: string | null
    catalogVisibility: TaskCatalogVisibility
    branchStartedAt: number
    parentTaskId?: string | null
    parentNodeRunId?: string | null
    invocationDepth?: number
    workspacePrunedAt?: number | null
  }
  readonly definition: {
    definitionOrigin: 'authored' | 'platform'
    workflowSnapshot: string
    workflowVersion: number | null
    inputs: string
    maxDurationMs?: number | null
    maxTotalTokens?: number | null
    workgroupConfigJson?: string | null
    refClosureJson?: string | null
  }
  readonly launch: TaskCreationLaunch
  readonly launchContext: {
    scheduledTaskId?: string | null
    webhookTriggerId?: string | null
    webhookFireId?: string | null
    eventSubscriptionId?: string | null
    eventDeliveryId?: string | null
    triggerContextJson?: string | null
    platformInputPathsJson?: string | null
    sourceTerminationBinding?: string | null
    sourceTerminationLaunchRev?: number | null
    sourceTerminationFence?: 'closed' | 'merged' | null
    sourceTerminationEffectRev?: number | null
    digitalEmployeeRoundId?: string | null
    digitalEmployeeCaseId?: string | null
  }
  readonly workspace: {
    repoPath: string
    repoUrl?: string | null
    cachedRepoId?: string | null
    repoGroupId?: string | null
    repoGroupName?: string | null
    worktreePath: string
    baseBranch: string
    branch: string
    baseCommit: string | null
    workingBranch?: string | null
    gitUserName?: string | null
    gitUserEmail?: string | null
    autoCommitPush?: boolean
    spaceKind: SpaceKind
  }
  readonly repos: readonly TaskRepositoryMount[]
  readonly nodePaths: readonly string[]
}

export interface TaskCreationReceipt {
  readonly rootTaskId: string
  readonly executionLineageId: string
  readonly lineageSlotPathJson: string
}

export interface TaskCreationParticipantInTx {
  create(input: TaskCreationInput): Promise<TaskCreationReceipt>
}

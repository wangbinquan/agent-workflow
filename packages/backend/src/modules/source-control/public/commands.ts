import type {
  CodeHostProvider,
  OwnCodeHostPushCredentialSummary,
  PutOwnCodeHostPushCredentialRequest,
} from '@agent-workflow/shared'
import type { OwnRepositoryCredentialSubject } from './types'

export interface OwnRepositoryTransportCredentialCommands {
  put(
    subject: OwnRepositoryCredentialSubject,
    provider: CodeHostProvider,
    request: PutOwnCodeHostPushCredentialRequest,
  ): Promise<OwnCodeHostPushCredentialSummary>
  remove(
    subject: OwnRepositoryCredentialSubject,
    provider: CodeHostProvider,
  ): Promise<{ readonly removed: boolean }>
}

type WorkspaceGcPhase = 'worktree' | 'iso' | 'scratch' | 'orphan' | 'partial'

interface WorkspaceGcInput {
  readonly phase: WorkspaceGcPhase
  readonly activeTaskIds: readonly string[]
  readonly worktreeAutoGc: {
    readonly enabled: boolean
    readonly olderThanDays?: number
    readonly onlyMerged?: boolean
  }
  readonly gitCloneTimeoutMs: number
  readonly now?: number
}

interface WorkspaceGcReceipt {
  readonly scanned: number
  readonly removed: number
  readonly skipped: number
}

interface WorkspaceRecoveryInput {
  readonly activeTaskIds: readonly string[]
  readonly now?: number
  /**
   * RFC-300 webhook-terminal 认领的接管范围：周期 ticker 只接管过期租约（'stale'，默认）；boot 持有
   * 单实例锁且孤儿已收割，接管全部（'all'）。
   */
  readonly webhookClaims?: 'stale' | 'all'
}

interface WorkspaceRecoveryReceipt {
  readonly completed: number
  readonly failed: number
  readonly skipped: number
  /** RFC-165 R3-2-r4：目录已消失但没有 tombstone 的终态任务补上 workspace_pruned_at 的条数。 */
  readonly healed: number
}

/** Provider-selected Source Control cleanup command consumed by RFC-338. */
export interface WorkspaceMaintenanceCommand {
  runGcPhase(input: WorkspaceGcInput): Promise<WorkspaceGcReceipt>
  recover(input: WorkspaceRecoveryInput): Promise<WorkspaceRecoveryReceipt>
}

/** Closed Source Control hand-off used after Task Execution releases a workspace. */
export interface WorkspaceClaimFinalizationCommand {
  /**
   * Finish a workspace-prune claim already attached to a terminal task.
   *
   * TaskExecution invokes this after releasing its durable owner.  Keeping the
   * operation on the selected Source Control command prevents the PostgreSQL
   * runtime from reaching back into SQLite's systemWorkspaceGc facade.
   */
  finalizeClaimedWorkspace(taskId: string, now?: number): Promise<void>
}

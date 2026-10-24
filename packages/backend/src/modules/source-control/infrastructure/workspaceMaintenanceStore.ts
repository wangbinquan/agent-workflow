import { WORKSPACE_PRUNING_LEASE_MS } from '../application/workspaceMaintenance'
import type {
  WorkspaceMaintenanceStore,
  WorkspaceTaskRecord,
} from '../application/ports/workspaceMaintenance'
import type {
  WorkspaceGcTask,
  WorkspaceGcTaskPort,
  TaskWorkspacePruneParticipant,
} from '../composition/required-ports'

function taskRecord(task: WorkspaceGcTask): WorkspaceTaskRecord {
  return {
    id: task.taskId,
    status: task.status,
    spaceKind: task.spaceKind,
    worktreePath: task.workspaceRootRef ?? '',
    ...task.primary,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    workspacePruningAt: task.prune.pruningAt,
    workspacePruneCause: task.prune.cause,
    workspacePrunedAt: task.prune.prunedAt,
    lifecycleEventRevision: task.lifecycleRevision,
  }
}

export class PortWorkspaceMaintenanceStore implements WorkspaceMaintenanceStore {
  constructor(
    private readonly ports: {
      readonly workspaceGc: WorkspaceGcTaskPort
      readonly workspacePrune: TaskWorkspacePruneParticipant
    },
  ) {}
  async listGcCandidates() {
    return (await this.ports.workspaceGc.listGcCandidates()).map(taskRecord)
  }
  async listTasks(ids: readonly string[]) {
    return (await this.ports.workspaceGc.listTasks(ids)).map(taskRecord)
  }
  listTaskRepositories(taskId: string) {
    return this.ports.workspaceGc.listMounts(taskId)
  }
  anchoredTaskIds(ids: readonly string[]) {
    return this.ports.workspaceGc.existingTaskIds(ids)
  }
  hasLiveOrRevivableChild(taskId: string) {
    return this.ports.workspaceGc.hasLiveOrRevivableChild(taskId)
  }
  claimWorkspace(taskId: string, now: number) {
    return this.ports.workspacePrune.claim(taskId, now, now - WORKSPACE_PRUNING_LEASE_MS)
  }
  claimIsoWorkspace(taskId: string, now: number) {
    return this.ports.workspacePrune.claimIsolation(taskId, now)
  }
  reclaimWebhookWorkspace(taskId: string, expectedAt: number, now: number) {
    return this.ports.workspacePrune.reclaimWebhook(taskId, expectedAt, now)
  }
  finalizeWorkspace(taskId: string, now: number) {
    return this.ports.workspacePrune.finalize(taskId, now)
  }
  releaseIsoClaim(taskId: string, expectedAt?: number) {
    return this.ports.workspacePrune.releaseIsolation(taskId, expectedAt)
  }
  healMissingWorkspace(
    taskId: string,
    now: number,
    expected: Pick<WorkspaceTaskRecord, 'worktreePath' | 'lifecycleEventRevision'>,
  ) {
    return this.ports.workspacePrune.healMissing(taskId, now, {
      workspaceRootRef: expected.worktreePath,
      lifecycleRevision: expected.lifecycleEventRevision,
    })
  }
  async listStaleWebhookClaims(staleBefore: number) {
    return (await this.ports.workspaceGc.listStaleWebhookClaims(staleBefore)).map((row) => ({
      id: row.taskId,
      workspacePruningAt: row.pruningAt,
    }))
  }
  async listUnstampedTerminalWorkspaces() {
    return (await this.ports.workspaceGc.listUnstampedTerminalWorkspaces()).map((row) => ({
      id: row.taskId,
      worktreePath: row.workspaceRootRef,
      lifecycleEventRevision: row.lifecycleRevision,
    }))
  }
}

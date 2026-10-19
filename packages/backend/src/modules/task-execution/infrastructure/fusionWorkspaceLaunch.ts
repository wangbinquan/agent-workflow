import type {
  FusionWorkspaceEffects,
  FusionWorkspacePreparation,
} from '@/modules/source-control/public/participants'

/**
 * RFC-370 §10 V20 — the fusion engine task's pre-materialized lane, shared by
 * both launch adapters. Source Control prepares the workspace from the seed (a
 * failed preparation leaves nothing behind); the launch admits the task with it
 * as its transferred workspace. A launch that fails before the task row exists
 * gives the workspace back; once the task exists, the task owns it and the
 * fusion releases it when the task has settled.
 */
export async function launchInFusionWorkspace(input: {
  readonly workspaces: FusionWorkspaceEffects
  readonly request: Parameters<FusionWorkspaceEffects['prepare']>[0]
  /** Whether the task row exists; an unanswerable check keeps the workspace. */
  readonly admitted: () => Promise<boolean>
  readonly launch: (workspace: FusionWorkspacePreparation) => Promise<void>
}): Promise<void> {
  const workspace = await input.workspaces.prepare(input.request)
  try {
    await input.launch(workspace)
  } catch (error) {
    if (!(await input.admitted().catch(() => true))) {
      await input.workspaces
        .release({
          taskId: input.request.taskId,
          worktreePath: workspace.worktreePath,
          mode: 'abandon',
        })
        .catch(() => undefined)
    }
    throw error
  }
}

/** The settled task's workspace back to Source Control (`finished`). */
export async function releaseFusionWorkspace(
  workspaces: FusionWorkspaceEffects,
  task: { readonly taskId: string; readonly worktreePath: string } | null,
): Promise<void> {
  if (task === null) return
  await workspaces.release({ ...task, mode: 'finished' })
}

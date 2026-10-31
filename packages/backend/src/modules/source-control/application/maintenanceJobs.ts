// RFC-399 B1: owner-owned maintenance bodies; slicing and result projection are unchanged.
import type { WorkspaceMaintenanceCommand } from '../public/commands'
import type { MaintenanceJobHandlers } from '@/platform/contracts/maintenanceJob'
import type { MaintenanceWorkerDelta } from '@/platform/background/maintenanceProtocol'
import { parseMaintenanceJobPayload } from '@/platform/background/maintenanceJobPayload'

const NONE: MaintenanceWorkerDelta = { kind: 'none' }

const WORKTREE_GC_PHASES = ['worktree', 'iso', 'scratch', 'orphan', 'partial'] as const
type WorktreeGcPhase = (typeof WORKTREE_GC_PHASES)[number]

function worktreeGcPhase(value: unknown): WorktreeGcPhase {
  if (value === undefined || value === null) return 'worktree'
  if (
    typeof value !== 'object' ||
    value === null ||
    (value as { version?: unknown }).version !== 1 ||
    !WORKTREE_GC_PHASES.includes((value as { phase?: WorktreeGcPhase }).phase as WorktreeGcPhase)
  ) {
    throw new Error('maintenance-worktree-gc-cursor-invalid')
  }
  return (value as { phase: WorktreeGcPhase }).phase
}

function nextWorktreeGcPhase(phase: WorktreeGcPhase): WorktreeGcPhase | null {
  const index = WORKTREE_GC_PHASES.indexOf(phase)
  return WORKTREE_GC_PHASES[index + 1] ?? null
}

export function createSourceControlMaintenanceJobHandlers(
  commands: WorkspaceMaintenanceCommand,
): Pick<MaintenanceJobHandlers, 'worktreeGc' | 'workspaceRecovery'> {
  return {
    async worktreeGc(input) {
      const payload = parseMaintenanceJobPayload('worktreeGc', input.payload)
      const phase = worktreeGcPhase(input.cursor)
      const result = await commands.runGcPhase({
        phase,
        activeTaskIds: payload.activeTaskIds,
        worktreeAutoGc: payload.worktreeAutoGc,
        gitCloneTimeoutMs: payload.gitCloneTimeoutMs ?? 0,
        now: Date.now(),
      })
      const nextPhase = nextWorktreeGcPhase(phase)
      return {
        counters: { scanned: result.scanned, removed: result.removed, skipped: result.skipped },
        delta: NONE,
        ...(nextPhase === null
          ? {}
          : {
              continuation: {
                cursor: { version: 1, phase: nextPhase },
                resumeAfterMs: 25,
              },
            }),
      }
    },
    async workspaceRecovery(input) {
      const payload = parseMaintenanceJobPayload('workspaceRecovery', input.payload)
      const result = await commands.recover({
        activeTaskIds: payload.activeTaskIds,
        now: Date.now(),
      })
      return {
        counters: { ...result },
        delta: NONE,
      }
    },
  }
}

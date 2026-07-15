// RFC-191 (T4) — single source of truth for WorkgroupMode → StatusChipKind,
// mirroring lib/task-status.ts#TASK_STATUS_KIND. The gallery card renders the
// mode as a semantic StatusChip (three modes, three colors); future surfaces
// (room header, detail) reuse this map so the colors can never drift.

import type { WorkgroupMode } from '@agent-workflow/shared'
import type { StatusChipKind } from '@/components/StatusChip'

export const WORKGROUP_MODE_KIND: Record<WorkgroupMode, StatusChipKind> = {
  leader_worker: 'info',
  free_collab: 'neutral',
  dynamic_workflow: 'warn',
}

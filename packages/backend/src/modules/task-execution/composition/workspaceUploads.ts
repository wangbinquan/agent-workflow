import type { WorkspaceUploadContentFactory } from '@/modules/source-control/public/types'
import { runWorkspaceUploadPolicy, workspaceUploadPolicy } from '../application/workspaceUploads'
import type {
  WorkspaceUploadPlan,
  WorkspaceUploadResult,
} from '../application/ports/workspaceUploads'

export function applyWorkspaceUploads(
  plan: WorkspaceUploadPlan,
  selected?: WorkspaceUploadContentFactory,
): Promise<WorkspaceUploadResult> {
  return runWorkspaceUploadPolicy(workspaceUploadPolicy(plan, selected))
}

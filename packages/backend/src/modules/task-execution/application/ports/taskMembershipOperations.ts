import type { Actor } from '@/auth/actor'
import type { AssignableTaskMemberRole, TaskMembers } from '@agent-workflow/shared'

export interface TaskMembershipOperationsPort {
  canViewTask(
    actor: Actor,
    task: { readonly id: string; readonly ownerUserId: string | null },
  ): Promise<boolean>
  getTaskMembers(
    actor: Actor,
    task: { readonly id: string; readonly ownerUserId: string | null },
  ): Promise<TaskMembers>
  requireTaskOperator(
    actor: Actor,
    task: { readonly id: string; readonly ownerUserId: string | null },
  ): Promise<void>
  updateTaskMembers(
    actor: Actor,
    task: { readonly id: string; readonly ownerUserId: string | null },
    body: {
      ownerUserId?: string
      members?: Array<{ userId: string; role: AssignableTaskMemberRole }>
    },
  ): Promise<TaskMembers>
  assertCanReplaySourceTask(actor: Actor, sourceTaskId: string): Promise<void>
}

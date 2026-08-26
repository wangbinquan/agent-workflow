// RFC-036 — task collaboration schemas. RFC-099 (D6) removed the node-level
// assignment mechanism (NodeAssignment*): task membership is the answer-rights
// boundary, and the role tags collapsed to 'owner' | 'collaborator'.
// RFC-324 added a third tag, 'observer' — membership still decides visibility,
// but only owner/collaborator carry answer and operation rights.

import { z } from 'zod'
import { UserPublicSchema } from './user'

/**
 * RFC-324 added `observer`, the read-only third grade.
 *
 * A collaborator holds the owner's operational rights (cancel / retry / resume)
 * and is the answer-rights boundary for reviews and clarifications. That was the
 * ONLY grade a member could have, so "let them watch this task" and "let them
 * steer it" were the same act. An observer sees every read-only face of the task
 * — detail, node runs, diff, change narrative — and can do none of the above.
 */
export const TaskCollaboratorRoleSchema = z.enum(['owner', 'collaborator', 'observer'])

export type TaskCollaboratorRole = z.infer<typeof TaskCollaboratorRoleSchema>

/** The grades a member can be ASSIGNED — owner is expressed by `ownerUserId`, not here. */
export const AssignableTaskMemberRoleSchema = z.enum(['collaborator', 'observer'])
export type AssignableTaskMemberRole = z.infer<typeof AssignableTaskMemberRoleSchema>

/** One member row as the panel renders it. */
export const TaskMemberSchema = z.object({
  user: UserPublicSchema,
  role: AssignableTaskMemberRoleSchema,
})
export type TaskMember = z.infer<typeof TaskMemberSchema>

export const TaskCollaboratorSchema = z.object({
  taskId: z.string().min(1),
  userId: z.string().min(1),
  role: TaskCollaboratorRoleSchema,
  addedBy: z.string().min(1),
  addedAt: z.number().int().nonnegative(),
})

export type TaskCollaborator = z.infer<typeof TaskCollaboratorSchema>

/**
 * RFC-330 —— 成员面的**资源中立基础**：任务与数字员工案例共用同一 wire（owner +
 * 分档成员 + 两个判定位）。任务变体加 `taskId`，案例变体加 `caseId`；前端的
 * MembersPanelAdapter 也只认这份基础。
 */
export const MembersSchema = z.object({
  ownerUserId: z.string().nullable(),
  owner: UserPublicSchema.nullable(),
  /** RFC-324 — members with their grade; was a bare `users: UserPublic[]`. */
  members: z.array(TaskMemberSchema),
  /** True when the current actor may PUT members (owner or admin). */
  canManage: z.boolean(),
  /**
   * RFC-324 — true when the current actor may ACT on the task (cancel / resume /
   * diagnose, answer reviews and clarifications). False for observers, which is
   * what the task UI reads to disable those controls instead of letting the
   * click land on a 403.
   */
  canOperate: z.boolean(),
})
export type MembersBase = z.infer<typeof MembersSchema>

/** GET /api/tasks/:id/members response (RFC-099 task members panel). */
export const TaskMembersSchema = MembersSchema.extend({
  taskId: z.string().min(1),
})
export type TaskMembers = z.infer<typeof TaskMembersSchema>

/** RFC-330 D19 —— GET /api/employee-cases/:id/members response（案例变体）。 */
export const CaseMembersSchema = MembersSchema.extend({
  caseId: z.string().min(1),
})
export type CaseMembers = z.infer<typeof CaseMembersSchema>

/**
 * PUT …/members body — full-replace `members`; both optional but at least one.
 * RFC-324 replaced `userIds: string[]`; `role` deliberately cannot be `owner`,
 * so ownership has exactly one wire representation (`ownerUserId`). RFC-330:
 * shared by tasks and employee cases (same normalization rules server-side).
 */
export const UpdateMembersBodySchema = z
  .object({
    ownerUserId: z.string().min(1).optional(),
    members: z
      .array(z.object({ userId: z.string().min(1), role: AssignableTaskMemberRoleSchema }))
      .max(256)
      .optional(),
  })
  .refine((b) => b.ownerUserId !== undefined || b.members !== undefined, {
    message: 'at least one of ownerUserId / members is required',
  })
export type UpdateMembersBody = z.infer<typeof UpdateMembersBodySchema>

/** Task-named alias of {@link UpdateMembersBodySchema} (kept for existing callers). */
export const UpdateTaskMembersBodySchema = UpdateMembersBodySchema
export type UpdateTaskMembersBody = UpdateMembersBody

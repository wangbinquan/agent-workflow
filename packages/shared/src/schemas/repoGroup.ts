// RFC-249 — 仓库组是一棵显式目录树，代码仓/子组只是目录节点上的可选挂载。
// root path = ''，它与其它节点同构，不承载“主仓”产品语义。

import { z } from 'zod'

export const MAX_GROUP_DEPTH = 5
export const MAX_FLAT_REPOS = 32
export const MAX_GROUP_NODES = 128
export const MAX_FLAT_NODES = 256

export const MOUNT_PATH_ERRORS = [
  'mount-path-absolute',
  'mount-path-traversal',
  'mount-path-unsafe-char',
  'mount-path-duplicate',
  'mount-path-multiple-roots',
] as const
export type MountPathError = (typeof MOUNT_PATH_ERRORS)[number]

export const REPO_GROUP_STRUCTURE_ERRORS = [
  'repo-group-cycle',
  'repo-group-depth-exceeded',
  'repo-group-too-many-repos',
  'repo-group-member-not-found',
  'repo-group-root-missing',
  'repo-group-multiple-roots',
  'repo-group-parent-missing',
  'repo-group-node-limit',
  'repo-group-attachment-conflict',
] as const
export type RepoGroupStructureError = (typeof REPO_GROUP_STRUCTURE_ERRORS)[number]

const RepoAttachmentInputObject = z.object({
  kind: z.literal('repo'),
  cachedRepoId: z.string().min(1).optional(),
  /** RAW URL；服务端只在保存时导入，响应永远只返回脱敏形态。 */
  repoUrl: z.string().min(1).optional(),
  ref: z.string().default(''),
  subdir: z.string().default(''),
  readonly: z.boolean().default(false),
})

export const RepoGroupNodeAttachmentInputSchema = z
  .discriminatedUnion('kind', [
    RepoAttachmentInputObject,
    z.object({
      kind: z.literal('group'),
      childGroupId: z.string().min(1),
      readonly: z.boolean().default(false),
    }),
  ])
  .superRefine((value, ctx) => {
    if (value.kind !== 'repo') return
    if ((value.cachedRepoId === undefined) === (value.repoUrl === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'exactly one of cachedRepoId / repoUrl is required',
        path: ['cachedRepoId'],
      })
    }
  })
export type RepoGroupNodeAttachmentInput = z.infer<typeof RepoGroupNodeAttachmentInputSchema>

export const RepoGroupNodeInputSchema = z.object({
  /** 相对任务根的规范目录路径；'' = root。 */
  path: z.string(),
  /** null = 纯目录。挂载仓/子组后仍可有子节点。 */
  attachment: RepoGroupNodeAttachmentInputSchema.nullable().default(null),
})
export type RepoGroupNodeInput = z.infer<typeof RepoGroupNodeInputSchema>

const RepoGroupNodeAttachmentSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('repo'),
    cachedRepoId: z.string(),
    repoUrlRedacted: z.string(),
    ref: z.string(),
    subdir: z.string(),
    readonly: z.boolean(),
  }),
  z.object({
    kind: z.literal('group'),
    childGroupId: z.string(),
    childGroupName: z.string(),
    readonly: z.boolean(),
  }),
])

export const RepoGroupNodeSchema = z.object({
  path: z.string(),
  attachment: RepoGroupNodeAttachmentSchema.nullable(),
})
export type RepoGroupNode = z.infer<typeof RepoGroupNodeSchema>

// ── RFC-248 read-only compatibility projection ──────────────────────────────
// v2 写接口明确拒绝 members；GET 暂留这份从 attachment nodes 无损派生的投影，
// 让既有只读客户端与回归测试平滑升级。它不是持久化事实源，也无法写回。
export const RepoGroupMemberInputSchema = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('repo'),
      cachedRepoId: z.string().min(1).optional(),
      repoUrl: z.string().min(1).optional(),
      ref: z.string().default(''),
      subdir: z.string().default(''),
      mountPath: z.string().default(''),
      readonly: z.boolean().default(false),
    }),
    z.object({
      kind: z.literal('group'),
      childGroupId: z.string().min(1),
      mountPath: z.string().default(''),
      readonly: z.boolean().default(false),
    }),
  ])
  .superRefine((value, ctx) => {
    if (value.kind !== 'repo') return
    if ((value.cachedRepoId === undefined) === (value.repoUrl === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'exactly one of cachedRepoId / repoUrl is required',
        path: ['cachedRepoId'],
      })
    }
  })
export type RepoGroupMemberInput = z.infer<typeof RepoGroupMemberInputSchema>

export const RepoGroupMemberSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('repo'),
    memberIndex: z.number().int().nonnegative(),
    cachedRepoId: z.string(),
    repoUrlRedacted: z.string(),
    ref: z.string(),
    subdir: z.string(),
    mountPath: z.string(),
    readonly: z.boolean(),
  }),
  z.object({
    kind: z.literal('group'),
    memberIndex: z.number().int().nonnegative(),
    childGroupId: z.string(),
    childGroupName: z.string(),
    mountPath: z.string(),
    readonly: z.boolean(),
  }),
])
export type RepoGroupMember = z.infer<typeof RepoGroupMemberSchema>

export const RepoGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  version: z.number().int().positive(),
  schemaVersion: z.number().int().positive().optional(),
  createdByUserId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** v2 canonical definition. Optional only so pre-v2 fixture objects remain readable. */
  nodes: z.array(RepoGroupNodeSchema).optional(),
  /** Deprecated read-only projection; v2 write routes reject this key. */
  members: z.array(RepoGroupMemberSchema),
  directNodeCount: z.number().int().nonnegative().optional(),
  flatRepoCount: z.number().int().nonnegative(),
  boundMemories: z.number().int().nonnegative(),
})
export type RepoGroup = z.infer<typeof RepoGroupSchema>

export const PlannedRepoSchema = z.object({
  cachedRepoId: z.string(),
  repoUrlRedacted: z.string(),
  ref: z.string(),
  subdir: z.string(),
  mountPath: z.string(),
  readonly: z.boolean(),
  viaGroups: z.array(z.object({ id: z.string(), name: z.string() })),
})
export type PlannedRepo = z.infer<typeof PlannedRepoSchema>

export const PlannedDirectoryNodeSchema = z.object({
  path: z.string(),
  origins: z.array(
    z.object({
      groupId: z.string(),
      groupName: z.string(),
      viaGroups: z.array(z.object({ id: z.string(), name: z.string() })),
    }),
  ),
})
export type PlannedDirectoryNode = z.infer<typeof PlannedDirectoryNodeSchema>

export const CreateRepoGroupSchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().max(4096).default(''),
  nodes: z.array(RepoGroupNodeInputSchema).min(1).max(MAX_GROUP_NODES),
})
export type CreateRepoGroup = z.infer<typeof CreateRepoGroupSchema>

export const PreviewRepoGroupSchema = z.object({
  name: z.string().max(255).optional(),
  nodes: z.array(RepoGroupNodeInputSchema).min(1).max(MAX_GROUP_NODES),
})
export type PreviewRepoGroup = z.infer<typeof PreviewRepoGroupSchema>

export const UpdateRepoGroupSchema = CreateRepoGroupSchema.extend({
  expectedVersion: z.number().int().positive().optional(),
})
export type UpdateRepoGroup = z.infer<typeof UpdateRepoGroupSchema>

/** 仅供内部兼容测试/过渡 helper；公开 v2 route 不解析该形态。 */
export interface LegacyRepoGroupWrite {
  name: string
  description: string
  members: RepoGroupMemberInput[]
}

export const RepoGroupLayoutResponseSchema = z.object({
  groupId: z.string(),
  groupName: z.string(),
  repos: z.array(PlannedRepoSchema),
  /** v2 explicit directory tree; optional only for pre-v2 response fixtures. */
  nodes: z.array(PlannedDirectoryNodeSchema).optional(),
  totalRepos: z.number().int().nonnegative(),
  totalNodes: z.number().int().nonnegative().optional(),
  maxDepth: z.number().int().nonnegative(),
})
export type RepoGroupLayoutResponse = z.infer<typeof RepoGroupLayoutResponseSchema>

export const ListRepoGroupsResponseSchema = z.object({ items: z.array(RepoGroupSchema) })
export type ListRepoGroupsResponse = z.infer<typeof ListRepoGroupsResponseSchema>

export const DeleteRepoGroupResponseSchema = z.object({
  ok: z.literal(true),
  archivedMemories: z.number().int().nonnegative(),
  detachedReferences: z.number().int().nonnegative(),
  disabledSchedules: z.number().int().nonnegative(),
})
export type DeleteRepoGroupResponse = z.infer<typeof DeleteRepoGroupResponseSchema>

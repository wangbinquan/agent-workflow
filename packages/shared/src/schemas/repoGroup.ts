// RFC-248 — 仓库组（repo groups）。一个可命名、可复用、可绑定记忆的执行空间
// 定义：哪几个仓 + 各自 checkout 什么 + 在运行目录里怎么摆。
//
// 三个层次（design §1）必须分清：
//   - RepoGroupMember  定义层。`mountPath` 相对于**它所在的那个组**。
//   - PlannedRepo      展平层。`mountPath` 相对于**任务根**（cwd），由外层路径
//                      逐层前缀拼成。
//   - task_repos 行    快照层（D8）。启动后组再改也不影响它。
//
// 纯 schema + 常量；展平 / 校验的算法在 `../repoGroupLayout` （无 DB 依赖，
// 前端布局预览与后端物化共用同一份）。

import { z } from 'zod'

/**
 * D18 —— 组嵌套深度上限。上限存在的意义是给环检测兜底（环检测本身用递归链，
 * 见 repoGroupLayout.flattenRepoGroup），以及挡住「五层组展开出上百个仓」。
 */
export const MAX_GROUP_DEPTH = 5

/**
 * D18 —— **展平后**的总仓数上限（不是直接成员数）。真正的成本是「启动时要建
 * 多少个 git worktree + 跑多少次子模块初始化」，所以按展平后算。
 * 取代 RFC-066 的 `MULTI_REPO_MAX = 8`。
 */
export const MAX_FLAT_REPOS = 32

/**
 * 挂载路径的规范化 / 校验错误码（design §1.2）。
 *
 * 设计稿里曾有第六条 `mount-path-empty`（「非空但折叠成空」），实现时发现
 * **不可达**：非空且不以 `/` 开头的串必然至少有一个非空段，而全是斜杠的串会
 * 先被 `mount-path-absolute` 挡掉。死码不留，已删。
 */
export const MOUNT_PATH_ERRORS = [
  'mount-path-absolute',
  'mount-path-traversal',
  'mount-path-unsafe-char',
  'mount-path-duplicate',
  'mount-path-multiple-roots',
] as const
export type MountPathError = (typeof MOUNT_PATH_ERRORS)[number]

/** 展平期才可能出现的结构性错误码。 */
export const REPO_GROUP_STRUCTURE_ERRORS = [
  'repo-group-cycle',
  'repo-group-depth-exceeded',
  'repo-group-too-many-repos',
  'repo-group-member-not-found',
] as const
export type RepoGroupStructureError = (typeof REPO_GROUP_STRUCTURE_ERRORS)[number]

/**
 * 成员定义。`kind='repo'` 时 `cachedRepoId` ⊕ `repoUrl`——D7 允许建组时直接粘
 * 一个还没导入的 URL，服务端 resolve 后回填 id 并只回脱敏形态。
 * `kind='group'` 时不带 `ref` / `subdir`（D19：内层组的 ref 完全听它自己的）。
 */
// NOTE: zod v3 的 `discriminatedUnion` 要求每个成员是**裸** ZodObject——
// `.refine()` 会把它包成 ZodEffects，而 ZodEffects 没有 `.shape`，构造时直接
// 抛 `type.shape[discriminator] is undefined`。所以 `cachedRepoId ⊕ repoUrl`
// 的 XOR 校验挂在联合**外层**的 superRefine 上，不挂在成员上。
export const RepoGroupMemberInputSchema = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('repo'),
      cachedRepoId: z.string().min(1).optional(),
      /** RAW URL；服务端 resolve 后不回传（RFC-204 只出脱敏形态）。 */
      repoUrl: z.string().min(1).optional(),
      /** '' = 该仓默认分支（D6：存在组里，启动时不可改）。 */
      ref: z.string().default(''),
      /** '' = 整仓；否则 sparse 只检出这个仓内子目录（D17，非 cone）。 */
      subdir: z.string().default(''),
      /** '' = 挂根（D2：至多一个成员可以挂根）。 */
      mountPath: z.string().default(''),
      /** D11：只读成员不快照 / 不进 diff / 不自动提交推送。 */
      readonly: z.boolean().default(false),
    }),
    z.object({
      kind: z.literal('group'),
      childGroupId: z.string().min(1),
      mountPath: z.string().default(''),
      /** D20：只读取并集——外层标只读 ⇒ 内层全部只读；外层不标则听内层自己的。 */
      readonly: z.boolean().default(false),
    }),
  ])
  .superRefine((v, ctx) => {
    if (v.kind !== 'repo') return
    if ((v.cachedRepoId === undefined) === (v.repoUrl === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'exactly one of cachedRepoId / repoUrl is required',
        path: ['cachedRepoId'],
      })
    }
  })
export type RepoGroupMemberInput = z.infer<typeof RepoGroupMemberInputSchema>

/** 持久化 / 出网形态：URL 只出脱敏，且 `cachedRepoId` 已必然回填。 */
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
  createdByUserId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  members: z.array(RepoGroupMemberSchema),
  /** 展平后的总仓数；列表页直接显示，不用每行再算一次。 */
  flatRepoCount: z.number().int().nonnegative(),
  /**
   * 设计门 G5 —— 绑在本组上的**未归档**记忆条数。删除确认弹窗要显示它
   * （删组会把这些记忆置为 archived）。
   */
  boundMemories: z.number().int().nonnegative(),
})
export type RepoGroup = z.infer<typeof RepoGroupSchema>

/**
 * 展平结果的一行。`mountPath` 已是相对任务根的最终路径，`readonly` 已取过并集，
 * `viaGroups` 记录它是经由哪条组链进来的（UI 的来源链展示 + 排错）。
 */
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

export const CreateRepoGroupSchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().max(4096).default(''),
  members: z.array(RepoGroupMemberInputSchema).min(1).max(MAX_FLAT_REPOS),
})
export type CreateRepoGroup = z.infer<typeof CreateRepoGroupSchema>

/**
 * RFC-248 T36：编辑器实时预览的入参。名字可省（预览不关心），成员**可以为空**
 * ——用户刚打开编辑器时就是空的，那时也该看到一棵空树而不是 422。
 */
export const PreviewRepoGroupSchema = z.object({
  name: z.string().max(255).optional(),
  members: z.array(RepoGroupMemberInputSchema).max(MAX_FLAT_REPOS),
})
export type PreviewRepoGroup = z.infer<typeof PreviewRepoGroupSchema>

/**
 * 改组 = 建组的字段 + **OCC 栅栏** `expectedVersion`。
 *
 * 曾经它只是 `CreateRepoGroupSchema` 的别名——于是客户端老老实实发了
 * `expectedVersion`，zod（非 strict）**静默剥掉**，路由也就没什么可转发的，
 * 服务层那道 409 永远不触发：两个人同时编辑同一个组，后写的无声覆盖先写的
 * （Codex 实现门 P1）。栅栏是可选的：不传就是「我知道会覆盖」。
 */
export const UpdateRepoGroupSchema = CreateRepoGroupSchema.extend({
  expectedVersion: z.number().int().positive().optional(),
})
export type UpdateRepoGroup = z.infer<typeof UpdateRepoGroupSchema>

export const RepoGroupLayoutResponseSchema = z.object({
  groupId: z.string(),
  groupName: z.string(),
  repos: z.array(PlannedRepoSchema),
  totalRepos: z.number().int().nonnegative(),
  maxDepth: z.number().int().nonnegative(),
})
export type RepoGroupLayoutResponse = z.infer<typeof RepoGroupLayoutResponseSchema>

export const ListRepoGroupsResponseSchema = z.object({ items: z.array(RepoGroupSchema) })
export type ListRepoGroupsResponse = z.infer<typeof ListRepoGroupsResponseSchema>

export const DeleteRepoGroupResponseSchema = z.object({
  ok: z.literal(true),
  /** 设计门 G5：删组同事务把组记忆置 archived，回报条数。 */
  archivedMemories: z.number().int().nonnegative(),
  /** `force=1` 时从别的组里摘掉的引用行数。 */
  detachedReferences: z.number().int().nonnegative(),
  /** RFC-248 #10：`force=1` 时被**禁用**（不是删除）的定时任务数。 */
  disabledSchedules: z.number().int().nonnegative(),
})
export type DeleteRepoGroupResponse = z.infer<typeof DeleteRepoGroupResponseSchema>

// RFC-257 — 代码平台 Webhook 触发器的 shared 契约层（RFC-259 扩 github provider）。
// 三块内容：①归一化事件信封（provider 无关，各 provider adapter 产出）；②触发器
// 规则与三形态启动参数「模板封套」（对齐 scheduled_tasks 的 launchKind 模型，
// 但 repo 源/ref/name 由 fire 时按事件注入（RFC-268 的 scratch 是唯一显式
// 例外）——设计门 F-3：不能直接复用
// scheduledPayloadSchemaFor，StartTaskSchema 的 repo 三态 superRefine 与
// 「模板留空」矛盾）；③投递/触发记录的 closed enum（emit 域，读域另行放宽时
// 必须走独立常量，见 RFC-251 实现门 P0 的教训）。
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Provider 与事件类型
// ---------------------------------------------------------------------------

export const CODE_HOST_PROVIDERS = ['gitlab', 'github'] as const
export const CodeHostProviderSchema = z.enum(CODE_HOST_PROVIDERS)
export type CodeHostProvider = z.infer<typeof CodeHostProviderSchema>

/** 平台内部事件类型（GitLab object_kind + 判别字段归一化后的形态，design §2.3）。 */
export const CODE_HOST_EVENT_TYPES = [
  'push',
  'tag_push',
  'mr_opened',
  'mr_updated',
  'mr_merged',
  'mr_closed',
  'note',
  'pipeline_failed',
  'pipeline_succeeded',
] as const
export const CodeHostEventTypeSchema = z.enum(CODE_HOST_EVENT_TYPES)
export type CodeHostEventType = z.infer<typeof CodeHostEventTypeSchema>

/**
 * 忽略名单的作用域（设计门 F-1 / D14）：只有这些事件类型按 author 过滤命中；
 * pipeline 类事件不过滤——流水线失败是客观事实，bot push 引发的失败必须能
 * 继续触发修到绿循环（author 身份改为参与熔断重置判定，见 evaluateCircuit）。
 */
export const AUTHOR_FILTERED_EVENT_TYPES: ReadonlyArray<CodeHostEventType> = [
  'push',
  'tag_push',
  'mr_opened',
  'mr_updated',
  'mr_merged',
  'mr_closed',
  'note',
]

// ---------------------------------------------------------------------------
// 归一化事件信封（design §2.2）
// ---------------------------------------------------------------------------

/**
 * 平台无关的事件信封。核心分流逻辑只读这个形状；GitLab 特有字段留在 `raw`
 * （只入库审计 + {{event_json}} 模板变量，multica channel/doc.go 边界规则——
 * 核心代码永不解构 raw）。
 */
export const CodeHostEventSchema = z.object({
  provider: CodeHostProviderSchema,
  /** 投递去重 id（X-Gitlab-Event-UUID / X-GitHub-Delivery）；可空 —— 缺失时该投递无去重（降级模式，设计门 F-18）。 */
  eventUuid: z.string().nullable(),
  eventType: CodeHostEventTypeSchema,
  /** project.path_with_namespace，规则匹配的主键（如 `platform/backend/api`）。 */
  repoPath: z.string().min(1),
  repoHttpUrl: z.string().min(1),
  repoSshUrl: z.string().min(1),
  /** 事件分支：push=被推分支；MR 类/note/MR-pipeline=source_branch；tag_push=tag。 */
  branch: z.string().optional(),
  targetBranch: z.string().optional(),
  mrIid: z.string().optional(),
  mrTitle: z.string().optional(),
  commitSha: z.string().optional(),
  commentText: z.string().optional(),
  author: z.object({
    username: z.string().optional(),
    name: z.string().optional(),
  }),
  pipelineStatus: z.string().optional(),
  // -------------------------------------------------------------------------
  // RFC-263 —— 「事件之后能跟的动作」所需的 API 定位参数（design §1）。
  // 推导方式不是「把 payload 里的 id 抄一遍」，而是先列每类事件之后现实存在的
  // 动作（回复线程 / 新建行内评论 / resolve / 设 commit status / retry 流水线 /
  // 拉 job 日志 / 建 MR），再取这些动作 API 的必需参数并集（proposal §3）。
  //
  // 全部 optional 且 **软提取**：任何一个字段缺失或类型不符都不得把投递判成
  // parse-failed —— 那会把一条本可正常触发的事件整条丢掉（proposal C4）。
  // 数值型 id 在 adapter 侧统一转字符串（沿既有 mrIid 的姿势）。
  // -------------------------------------------------------------------------
  /** 平台项目主键：GitLab `project.id`（`/projects/:id` 的实参）/ GitHub `repository.id`。 */
  projectId: z.string().optional(),
  /** GitHub REST 的 `{owner}` / `{repo}` 路径段；GitLab 为 namespace / project path。 */
  repoOwner: z.string().optional(),
  repoName: z.string().optional(),
  /** 推导值：GitLab `<实例>/api/v4`；GitHub `https://api.github.com` 或 GHES `<实例>/api/v3`。 */
  apiBaseUrl: z.string().optional(),
  projectWebUrl: z.string().optional(),
  defaultBranch: z.string().optional(),
  /** 事件作者的平台用户 id（指派 / 审计）。 */
  authorId: z.string().optional(),
  /** MR/PR 的 **global id**，区别于 REST 路径用的 `mrIid`。 */
  mrId: z.string().optional(),
  mrUrl: z.string().optional(),
  commentId: z.string().optional(),
  /** 讨论线程 id：GitLab `discussion_id`；GitHub `in_reply_to_id ?? comment.id`（design §5.1）。 */
  commentThreadId: z.string().optional(),
  commentUrl: z.string().optional(),
  /**
   * 行内评论位置，**结构化对象**（序列化与上限在 `eventVarsOf`，design §5.2）。
   * 键名与该平台建评论 API 的参数名一一对应，agent 原样回传即可。
   */
  commentPosition: z.unknown().optional(),
  /** GitLab pipeline id / GitHub workflow run id。 */
  pipelineId: z.string().optional(),
  pipelineUrl: z.string().optional(),
  /** push 的前一个 sha（与 `commitSha` = after 配对）。 */
  commitBefore: z.string().optional(),
  raw: z.unknown(),
})
export type CodeHostEvent = z.infer<typeof CodeHostEventSchema>

// ---------------------------------------------------------------------------
// 触发器规则
// ---------------------------------------------------------------------------

/** repo 匹配范围：全部 / path 前缀（GitLab group 天然是前缀）/ 精确清单。 */
export const WebhookRepoScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }),
  z.object({ kind: z.literal('prefix'), prefix: z.string().trim().min(1).max(500) }),
  z.object({
    kind: z.literal('exact'),
    paths: z
      .array(z.string().trim().min(1).max(500))
      .min(1)
      .max(500)
      .transform((a) => Array.from(new Set(a))),
  }),
])
export type WebhookRepoScope = z.infer<typeof WebhookRepoScopeSchema>

export const WEBHOOK_LAUNCH_KINDS = ['workflow', 'agent', 'workgroup'] as const
export const WebhookLaunchKindSchema = z.enum(WEBHOOK_LAUNCH_KINDS)
export type WebhookLaunchKind = z.infer<typeof WebhookLaunchKindSchema>

// ---------------------------------------------------------------------------
// 模板变量（design §4.2）
// ---------------------------------------------------------------------------

export const WEBHOOK_TEMPLATE_VARS = [
  'event_type',
  'provider',
  'repo_path',
  'repo_http_url',
  'repo_ssh_url',
  'branch',
  'target_branch',
  'default_branch',
  'mr_iid',
  'mr_id',
  'mr_title',
  'mr_url',
  'commit_sha',
  'commit_before',
  'comment_text',
  'comment_author',
  'comment_id',
  'comment_thread_id',
  'comment_url',
  'comment_position_json',
  'pipeline_status',
  'pipeline_id',
  'pipeline_url',
  'api_base_url',
  'project_id',
  'project_web_url',
  'repo_owner',
  'repo_name',
  'author_id',
  'event_json',
] as const
export type WebhookTemplateVar = (typeof WEBHOOK_TEMPLATE_VARS)[number]

/**
 * RFC-263：`project`/`repository` 与 `user`/`sender` 块在 9 类事件的 payload 里
 * 都在，所以这 8 个 API 定位变量与原有 6 个一样进 common 集。
 * （GitHub org 级 `ping` 无 repository，但它在 repository 解析之前就返回
 * unsupported，githubAdapter.ts 的 ping 分支，不构成例外。）
 */
const COMMON_VARS: ReadonlyArray<WebhookTemplateVar> = [
  'event_type',
  'provider',
  'repo_path',
  'repo_http_url',
  'repo_ssh_url',
  'branch',
  'default_branch',
  'api_base_url',
  'project_id',
  'project_web_url',
  'repo_owner',
  'repo_name',
  'author_id',
  'event_json',
]

/**
 * 每个事件类型「声明」的变量集（保存期静态校验依据）。声明 = 该事件类型
 * 结构上可能提供该值；运行期个别缺值（如分支流水线无 mr_iid）渲染为空串。
 * pipeline 声明 mr_iid/target_branch（MR 流水线才有值）但不声明 mr_title
 * （payload 是否携带待 T3 fixture 实证，实证后可放宽）。
 */
const MR_VARS: ReadonlyArray<WebhookTemplateVar> = [
  'target_branch',
  'mr_iid',
  'mr_id',
  'mr_title',
  'mr_url',
]

export const WEBHOOK_EVENT_VAR_MATRIX: Readonly<
  Record<CodeHostEventType, ReadonlyArray<WebhookTemplateVar>>
> = {
  push: [...COMMON_VARS, 'commit_sha', 'commit_before'],
  tag_push: [...COMMON_VARS, 'commit_sha', 'commit_before'],
  mr_opened: [...COMMON_VARS, ...MR_VARS, 'commit_sha'],
  mr_updated: [...COMMON_VARS, ...MR_VARS, 'commit_sha'],
  mr_merged: [...COMMON_VARS, ...MR_VARS, 'commit_sha'],
  mr_closed: [...COMMON_VARS, ...MR_VARS, 'commit_sha'],
  note: [
    ...COMMON_VARS,
    ...MR_VARS,
    'comment_text',
    'comment_author',
    'comment_id',
    'comment_thread_id',
    'comment_url',
    'comment_position_json',
  ],
  pipeline_failed: [
    ...COMMON_VARS,
    ...MR_VARS.filter((v) => v !== 'mr_title'),
    'commit_sha',
    'pipeline_status',
    'pipeline_id',
    'pipeline_url',
  ],
  pipeline_succeeded: [
    ...COMMON_VARS,
    ...MR_VARS.filter((v) => v !== 'mr_title'),
    'commit_sha',
    'pipeline_status',
    'pipeline_id',
    'pipeline_url',
  ],
}

/**
 * RFC-263：变量表 13 → 30 后，一行 chips 会挤成一坨 —— UI 按「事件上下文」与
 * 「API 定位」两组呈现。单一事实源放在这里而不是前端：漏登记一个新变量会让它
 * 在 UI 里直接消失，测试锁定两组并集 === 全表且交集为空。
 */
export const WEBHOOK_VAR_GROUPS = [
  {
    key: 'context',
    vars: [
      'event_type',
      'provider',
      'repo_path',
      'repo_http_url',
      'repo_ssh_url',
      'branch',
      'target_branch',
      'default_branch',
      'mr_iid',
      'mr_title',
      'commit_sha',
      'commit_before',
      'comment_text',
      'comment_author',
      'pipeline_status',
      'event_json',
    ],
  },
  {
    key: 'api',
    vars: [
      'api_base_url',
      'project_id',
      'project_web_url',
      'repo_owner',
      'repo_name',
      'author_id',
      'mr_id',
      'mr_url',
      'comment_id',
      'comment_thread_id',
      'comment_url',
      'comment_position_json',
      'pipeline_id',
      'pipeline_url',
    ],
  },
] as const satisfies ReadonlyArray<{ key: string; vars: ReadonlyArray<WebhookTemplateVar> }>

export type WebhookVarGroupKey = (typeof WEBHOOK_VAR_GROUPS)[number]['key']

// ---------------------------------------------------------------------------
// 启动参数模板封套（触发器 launch_payload；设计门 F-3 的派生 schema）
//
// 与 Scheduled*PayloadSchema 的三点不同（不能直接复用的原因）：
//   1. repo 源（repoUrl/cachedRepoId/repoGroupId/sourceTaskId）与 ref 一律禁填
//      —— fire 时按事件动态注入（D9/D17）；RFC-268 仅允许显式 `scratch:true`
//      选择临时工作区。StartTaskSchema 的 superRefine 强制三态必给其一
//      （start-task-source-required），因此这里仍不能直接复用它。
//   2. `name` 禁填 —— fire 时自动生成（`[触发器名] repoPath!mrIid`）。
//   3. ref-id（workflowId/agentId/workgroupId）外置在触发器行的 launch_ref_id
//      列（单一事实源），payload 内不重复。
// strict：未知键（含上述被禁键）直接拒绝——「以为配了实际被丢」是静默降级。
// ---------------------------------------------------------------------------

/**
 * workflow 输入映射值：text 类输入用 `template`（可含 {{var}}）；git 类输入用
 * `event-branch`（fire 时平台代包 `{"kind":"branch","ref":"<event.branch>"}`——
 * 设计门 F-10：git kind 是 packed JSON 格式，模板字面量既过不了保存期
 * workflowLaunchInputIssues 也不是运行期合法值）。enum/files/upload 输入不支持
 * 映射（保存期拒绝，校验在服务层结合 workflow 定义做）。
 */
export const WebhookInputMappingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('template'), template: z.string().max(65536) }),
  z.object({ kind: z.literal('event-branch') }),
])
export type WebhookInputMapping = z.infer<typeof WebhookInputMappingSchema>

const CommonTemplateFields = {
  /** RFC-268：显式选择空白临时 Git 工作区；缺省继续使用事件仓库。 */
  scratch: z.literal(true).optional(),
  workingBranch: z.string().optional(),
  autoCommitPush: z.boolean().optional(),
  maxDurationMs: z.number().int().positive().optional(),
  maxTotalTokens: z.number().int().positive().optional(),
} as const

type WebhookTemplateSpaceFields = {
  scratch?: true
  workingBranch?: string
  autoCommitPush?: boolean
}

/** 与 StartTaskSchema 保持同一冲突码：临时空间没有可写回的远端分支。 */
function refineWebhookTemplateSpace(value: WebhookTemplateSpaceFields, ctx: z.RefinementCtx): void {
  if (value.scratch !== true) return

  if (value.workingBranch !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'scratch-remote-only-option',
      path: ['workingBranch'],
    })
  }
  if (value.autoCommitPush !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'scratch-remote-only-option',
      path: ['autoCommitPush'],
    })
  }
}

export const WebhookWorkflowPayloadTemplateSchema = z
  .object({
    /** 键 = workflow 声明的 input key；值 = 映射（服务层按 workflow 定义校验必填覆盖与 kind 匹配）。 */
    inputs: z.record(z.string(), WebhookInputMappingSchema).default({}),
    ...CommonTemplateFields,
  })
  .strict()
  .superRefine(refineWebhookTemplateSpace)
export type WebhookWorkflowPayloadTemplate = z.infer<typeof WebhookWorkflowPayloadTemplateSchema>

export const WebhookAgentPayloadTemplateSchema = z
  .object({
    /** 零端口 agent 的任务提示词模板（对齐 StartAgentTaskSchema.description ≤65536）。 */
    description: z.string().trim().min(1).max(65536).optional(),
    /** 声明端口 agent 的端口值模板（对齐 StartAgentTaskSchema.inputs）。 */
    inputs: z.record(z.string(), z.string().max(65536)).optional(),
    allowClarify: z.boolean().optional(),
    ...CommonTemplateFields,
  })
  .strict()
  .superRefine(refineWebhookTemplateSpace)
export type WebhookAgentPayloadTemplate = z.infer<typeof WebhookAgentPayloadTemplateSchema>

export const WebhookWorkgroupPayloadTemplateSchema = z
  .object({
    /** 工作组任务目标模板（对齐 StartWorkgroupTaskSchema.goal ≤65536）。 */
    goal: z.string().trim().min(1).max(65536),
    ...CommonTemplateFields,
  })
  .strict()
  .superRefine(refineWebhookTemplateSpace)
export type WebhookWorkgroupPayloadTemplate = z.infer<typeof WebhookWorkgroupPayloadTemplateSchema>

export type WebhookLaunchPayloadTemplate =
  | WebhookWorkflowPayloadTemplate
  | WebhookAgentPayloadTemplate
  | WebhookWorkgroupPayloadTemplate

/** save/edit/fire 共用的封套选择器（对齐 scheduledPayloadSchemaFor 的单选择器模式）。 */
export function webhookPayloadTemplateSchemaFor(
  kind: WebhookLaunchKind,
): z.ZodType<WebhookLaunchPayloadTemplate, z.ZodTypeDef, unknown> {
  const schema =
    kind === 'workflow'
      ? WebhookWorkflowPayloadTemplateSchema
      : kind === 'agent'
        ? WebhookAgentPayloadTemplateSchema
        : WebhookWorkgroupPayloadTemplateSchema
  return schema as unknown as z.ZodType<WebhookLaunchPayloadTemplate, z.ZodTypeDef, unknown>
}

// ---------------------------------------------------------------------------
// 投递 / 触发记录 closed enum（emit 域）
// ---------------------------------------------------------------------------

export const WEBHOOK_DELIVERY_STATUSES = [
  'received', // 已落库、分发未开始（三段式中间态，D23）
  'processing', // 异步分发中
  'rejected', // 验签失败（不占去重索引位）
  'ignored', // 平台侧决定不处理（对 GitLab 一律 200，防 auto-disable）
  'matched', // ≥1 个触发器命中（fire 结果看 webhook_trigger_fires）
  'failed', // 内部错误 / interrupted（不占去重索引位）
] as const
export const WebhookDeliveryStatusSchema = z.enum(WEBHOOK_DELIVERY_STATUSES)
export type WebhookDeliveryStatus = z.infer<typeof WebhookDeliveryStatusSchema>

export const WEBHOOK_DELIVERY_REASONS = [
  'invalid-token',
  'missing-token',
  'endpoint-disabled',
  'no-trigger-matched',
  'unsupported-event',
  'parse-failed',
  'internal-error',
  'interrupted', // daemon 重启时 received/processing 遗留行的终态（恢复 = replay）
] as const
export const WebhookDeliveryReasonSchema = z.enum(WEBHOOK_DELIVERY_REASONS)
export type WebhookDeliveryReason = z.infer<typeof WebhookDeliveryReasonSchema>

export const WEBHOOK_FIRE_OUTCOMES = [
  'launched',
  'launch-failed', // owner 有效但启动失败（repo-fetch/payload-invalid/内部错误）
  'skipped-circuit-open', // 熔断（D22）
  'skipped-repo-unregistered', // 仓未导入且 autoRegisterRepos=false
  'skipped-owner-invalid', // owner 缺失/禁用/失去目标启动权（统一 skipped-*，设计门 F-14）
  'skipped-trigger-disabled', // 匹配后启动前被并发禁用
] as const
export const WebhookFireOutcomeSchema = z.enum(WEBHOOK_FIRE_OUTCOMES)
export type WebhookFireOutcome = z.infer<typeof WebhookFireOutcomeSchema>

// ---------------------------------------------------------------------------
// 端点 wire schema（管理面 manage-only；secret 三形态：创建/轮换响应一次性明文、
// 存储 secretBox 密封、读取面只有 hasSecret + 尾 4 位 hint —— RFC-255 姿势）
// ---------------------------------------------------------------------------

export const WebhookEndpointNameSchema = z.string().trim().min(1).max(255)

export const CreateWebhookEndpointSchema = z
  .object({
    name: WebhookEndpointNameSchema,
    provider: CodeHostProviderSchema.default('gitlab'),
    preferredCloneProtocol: z.enum(['http', 'ssh']).default('http'),
  })
  .strict()
export type CreateWebhookEndpoint = z.infer<typeof CreateWebhookEndpointSchema>

/** provider 不可变（换 provider = 重建端点）。 */
export const UpdateWebhookEndpointSchema = z
  .object({
    name: WebhookEndpointNameSchema.optional(),
    enabled: z.boolean().optional(),
    preferredCloneProtocol: z.enum(['http', 'ssh']).optional(),
  })
  .strict()
export type UpdateWebhookEndpoint = z.infer<typeof UpdateWebhookEndpointSchema>

export const WebhookEndpointSchema = z.object({
  id: z.string(),
  name: WebhookEndpointNameSchema,
  provider: CodeHostProviderSchema,
  /**
   * 「给代码平台填的 URL」的 token 段（寻址 + 弱凭据，不是验签锚）。
   * RFC-260 响应分层：明文只出现在 admin 的 **session** 响应里；非 admin 与
   * 一切 PAT（含 admin 的 PAT）拿 null——掩码提示走 urlTokenHint。
   */
  urlToken: z.string().nullable(),
  /** 尾 4 位提示（secretHint 同款姿势）；所有 viewer 都有，前端统一渲染掩码。 */
  urlTokenHint: z.string().nullable(),
  enabled: z.boolean(),
  preferredCloneProtocol: z.enum(['http', 'ssh']),
  hasSecret: z.boolean(),
  /** 密封 secret 的尾 4 位提示（multica signingSecretHint 姿势）；无 secret 时 null。 */
  secretHint: z.string().nullable(),
  lastDeliveryAt: z.number().int().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
})
export type WebhookEndpoint = z.infer<typeof WebhookEndpointSchema>

// ---------------------------------------------------------------------------
// 触发器 wire schema（owner 制，D19 修订版——非 RFC-231 ACL）
// ---------------------------------------------------------------------------

export const WebhookTriggerNameSchema = z.string().trim().min(1).max(255)

const TriggerRuleFields = {
  repoScope: WebhookRepoScopeSchema,
  eventTypes: z
    .array(CodeHostEventTypeSchema)
    .min(1)
    .transform((a) => Array.from(new Set(a))),
  /** glob；空/缺省 = 不过滤。MR 类事件按目标分支匹配，其余按事件分支（design §4.1）。 */
  branchFilter: z.string().trim().max(500).optional(),
  /** note 事件的指令前缀（如 `/fix`）；非 note 类型忽略。 */
  commandPrefix: z.string().trim().min(1).max(100).optional(),
  ignoreUsernames: z
    .array(z.string().trim().min(1).max(255))
    .max(200)
    .transform((a) => Array.from(new Set(a)))
    .default([]),
  maxConsecutiveFires: z.number().int().min(1).max(100).default(3),
  autoRegisterRepos: z.boolean().default(true),
} as const

export const CreateWebhookTriggerSchema = z
  .object({
    name: WebhookTriggerNameSchema,
    endpointId: z.string().min(1),
    enabled: z.boolean().default(true),
    ...TriggerRuleFields,
    launchKind: WebhookLaunchKindSchema,
    launchRefId: z.string().min(1),
    launchPayload: z.unknown(),
  })
  .superRefine((v, ctx) => {
    // 封套校验留在请求边界（对齐 CreateScheduledTaskSchema 的实现门 P1 修复：
    // unknown 穿透到服务层会炸裸 ZodError → HTTP 500）。
    const r = webhookPayloadTemplateSchemaFor(v.launchKind).safeParse(v.launchPayload)
    if (!r.success) {
      for (const issue of r.error.issues) {
        ctx.addIssue({ ...issue, path: ['launchPayload', ...issue.path] })
      }
    }
  })
export type CreateWebhookTrigger = z.infer<typeof CreateWebhookTriggerSchema>

/** strict partial；`launchKind`/`endpointId` 不可变（提供时必须等于既有值，服务层 422）。 */
export const UpdateWebhookTriggerSchema = z
  .object({
    name: WebhookTriggerNameSchema.optional(),
    endpointId: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
    repoScope: WebhookRepoScopeSchema.optional(),
    eventTypes: z
      .array(CodeHostEventTypeSchema)
      .min(1)
      .transform((a) => Array.from(new Set(a)))
      .optional(),
    branchFilter: z.string().trim().max(500).nullable().optional(),
    commandPrefix: z.string().trim().min(1).max(100).nullable().optional(),
    ignoreUsernames: z
      .array(z.string().trim().min(1).max(255))
      .max(200)
      .transform((a) => Array.from(new Set(a)))
      .optional(),
    maxConsecutiveFires: z.number().int().min(1).max(100).optional(),
    autoRegisterRepos: z.boolean().optional(),
    launchKind: WebhookLaunchKindSchema.optional(),
    launchRefId: z.string().min(1).optional(),
    launchPayload: z.unknown().optional(),
  })
  .strict()
export type UpdateWebhookTrigger = z.infer<typeof UpdateWebhookTriggerSchema>

/** GET 读形（launchPayload 容错：坏行给 null + migrationError，不炸整表——RFC-165 F18 姿势）。 */
export const WebhookTriggerSchema = z.object({
  id: z.string(),
  name: WebhookTriggerNameSchema,
  endpointId: z.string(),
  ownerUserId: z.string(),
  enabled: z.boolean(),
  repoScope: WebhookRepoScopeSchema.nullable(),
  eventTypes: z.array(CodeHostEventTypeSchema).nullable(),
  branchFilter: z.string().nullable(),
  commandPrefix: z.string().nullable(),
  ignoreUsernames: z.array(z.string()).nullable(),
  launchKind: WebhookLaunchKindSchema,
  launchRefId: z.string(),
  launchPayload: z.unknown().nullable(),
  migrationError: z
    .object({
      repoScope: z.string().nullable(),
      eventTypes: z.string().nullable(),
      ignoreUsernames: z.string().nullable(),
      launchPayload: z.string().nullable(),
    })
    .nullable()
    .default(null),
  maxConsecutiveFires: z.number().int(),
  autoRegisterRepos: z.boolean(),
  lastFiredAt: z.number().int().nullable(),
  lastStatus: z.enum(['launched', 'failed']).nullable(),
  lastError: z.string().nullable(),
  lastTaskId: z.string().nullable(),
  consecutiveFailures: z.number().int(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
})
export type WebhookTrigger = z.infer<typeof WebhookTriggerSchema>

// RFC-159 — 定时任务（周期性自动启动任务）schema。
// ScheduleSpec = interval | daily | weekly | monthly 判别联合（预设携创建者 IANA 时区）。
// launchPayload 复用 StartTaskSchema——整份存启动 body，到点参数不变地重放。
import { z } from 'zod'
import { StartAgentTaskSchema, StartTaskSchema } from './task'
import { AgentNameSchema } from './agent'
import { StartWorkgroupTaskSchema, WorkgroupNameSchema } from './workgroup'
import { isValidIanaTz } from '../scheduleTime'

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/ // 'HH:MM' 24h

const AtTimeSchema = z.string().regex(HHMM_RE, 'invalid-time')
const TimezoneSchema = z.string().min(1).refine(isValidIanaTz, { message: 'invalid-timezone' })

/** 每隔 N 分/时/天。 */
export const IntervalSpecSchema = z.object({
  kind: z.literal('interval'),
  every: z.number().int().min(1).max(1000),
  unit: z.enum(['minutes', 'hours', 'days']),
})
export type IntervalSpec = z.infer<typeof IntervalSpecSchema>

/** 每天 HH:MM（创建者时区）。 */
export const DailySpecSchema = z.object({
  kind: z.literal('daily'),
  at: AtTimeSchema,
  timezone: TimezoneSchema,
})
export type DailySpec = z.infer<typeof DailySpecSchema>

/** 每周 W（0=周日..6=周六，可多选）at HH:MM（创建者时区）。 */
export const WeeklySpecSchema = z.object({
  kind: z.literal('weekly'),
  daysOfWeek: z
    .array(z.number().int().min(0).max(6))
    .min(1)
    // 去重 + 升序，语义唯一（[1,1,3] ⇒ [1,3]）。
    .transform((a) => Array.from(new Set(a)).sort((x, y) => x - y)),
  at: AtTimeSchema,
  timezone: TimezoneSchema,
})
export type WeeklySpec = z.infer<typeof WeeklySpecSchema>

/** 每月 N 号（1-31，缺该日的月跳过）at HH:MM（创建者时区）。 */
export const MonthlySpecSchema = z.object({
  kind: z.literal('monthly'),
  dayOfMonth: z.number().int().min(1).max(31),
  at: AtTimeSchema,
  timezone: TimezoneSchema,
})
export type MonthlySpec = z.infer<typeof MonthlySpecSchema>

export const ScheduleSpecSchema = z.discriminatedUnion('kind', [
  IntervalSpecSchema,
  DailySpecSchema,
  WeeklySpecSchema,
  MonthlySpecSchema,
])
export type ScheduleSpec = z.infer<typeof ScheduleSpecSchema>

// ---------------------------------------------------------------------------
// RFC-165 §9b (D11) — 定时任务三主体（launch_kind）
// ---------------------------------------------------------------------------

export const SCHEDULED_LAUNCH_KINDS = ['workflow', 'agent', 'workgroup'] as const
export const ScheduledLaunchKindSchema = z.enum(SCHEDULED_LAUNCH_KINDS)
export type ScheduledLaunchKind = z.infer<typeof ScheduledLaunchKindSchema>

/**
 * kind='agent' 的定时 payload 封套：单 Agent 启动 body + canonical agent id
 * （即时启动时目标在 URL 路径上；定时行必须把目标冻结进 payload）。
 *
 * RFC-223 PR-7: writes MUST carry `agentId`. `agentName` is an optional
 * server-refreshed display snapshot only and is never accepted as identity.
 */
export const ScheduledAgentPayloadSchema = StartAgentTaskSchema.extend({
  agentId: z.string().min(1),
  agentName: AgentNameSchema.optional(),
})
export type ScheduledAgentPayload = z.infer<typeof ScheduledAgentPayloadSchema>

/**
 * kind='workgroup' 的定时 payload 封套：工作组启动 body + canonical workgroup
 * id。`workgroupName` 与 agentName 一样只作服务端刷新后的展示快照。
 */
export const ScheduledWorkgroupPayloadSchema = StartWorkgroupTaskSchema.extend({
  workgroupId: z.string().min(1),
  workgroupName: WorkgroupNameSchema.optional(),
})
export type ScheduledWorkgroupPayload = z.infer<typeof ScheduledWorkgroupPayloadSchema>

/** 三封套的判别联合（DTO 读取面；写入面走 scheduledPayloadSchemaFor）。 */
export const ScheduledLaunchPayloadSchema = z.union([
  StartTaskSchema,
  ScheduledAgentPayloadSchema,
  ScheduledWorkgroupPayloadSchema,
])
export type ScheduledLaunchPayload = z.infer<typeof ScheduledLaunchPayloadSchema>

/**
 * RFC-165 §9b：save/edit/fire/run-now 四处共用的 payload 校验选择器——
 * launch_kind 决定封套 schema，杜绝「按 kind 各写一份校验」的散射。
 */
export function scheduledPayloadSchemaFor(
  kind: ScheduledLaunchKind,
): z.ZodType<ScheduledLaunchPayload, z.ZodTypeDef, unknown> {
  const schema =
    kind === 'workflow'
      ? StartTaskSchema
      : kind === 'agent'
        ? ScheduledAgentPayloadSchema
        : ScheduledWorkgroupPayloadSchema
  // Cast: the three schemas carry .default() fields whose INPUT types differ
  // per arm, which defeats a direct ZodType<union> assignment; output-wise
  // each arm IS a ScheduledLaunchPayload member and callers only need
  // parse/safeParse against unknown input.
  return schema as unknown as z.ZodType<ScheduledLaunchPayload, z.ZodTypeDef, unknown>
}

/** 定时任务名（管理用显示名，≠ 启动 body.name）；trim 后 1..255，拒纯空白。 */
export const ScheduledTaskNameSchema = z.string().trim().min(1).max(255)

/**
 * GET 返回 / 行视图。`lastStatus` = 循环上次尝试触发结果；`lastTaskId` = 最近一次成功启动的 task。
 *
 * RFC-165 (F18/N3)：两个 JSON 列改为逐字段容错三态——一行 legacy/坏 JSON/坏 shape
 * 数据不再让整表 GET/list 崩（旧 row parser 一行坏就抛 `scheduled-task-row-corrupt`）：
 *   * 健康        → 字段有值，`migrationNeeded=false`、`migrationError=null`；
 *   * legacy      → 字段为 null + `migrationNeeded=true`（可修：编辑页重选后保存）；
 *   * degraded    → 字段为 null + `migrationError.<field>` 说明（坏 JSON / 未知 shape）。
 * 创建 / 更新 / 触发（fire、run-now）仍是 STRICT v2 校验——容错只在读取面。
 */
export const ScheduledTaskSchema = z.object({
  id: z.string(),
  name: ScheduledTaskNameSchema,
  ownerUserId: z.string(),
  /** RFC-165 §9b：执行主体 kind；旧行缺省 'workflow'（0086 default 回填）。 */
  launchKind: ScheduledLaunchKindSchema.default('workflow'),
  launchPayload: ScheduledLaunchPayloadSchema.nullable(),
  scheduleSpec: ScheduleSpecSchema.nullable(),
  /** RFC-165：payload 是可识别的退役旧形（如 path 模式），需要用户重存。 */
  migrationNeeded: z.boolean().default(false),
  /** RFC-165：逐字段解析失败说明（null = 两列都健康或仅 legacy）。 */
  migrationError: z
    .object({
      launchPayload: z.string().nullable(),
      scheduleSpec: z.string().nullable(),
    })
    .nullable()
    .default(null),
  /**
   * RFC-165（实现门 P2）：payload 降级为 null 时尽力从原始 JSON 提取的
   * workflowId 提示位——详情页据此保留「编辑任务配置」修复入口（编辑页
   * 空表单 + 全量 PUT 即修复路径）。健康行同样携带；坏 JSON 提不出 → null。
   */
  launchPayloadWorkflowId: z.string().nullable().optional(),
  enabled: z.boolean(),
  nextRunAt: z.number().int().nullable(),
  lastRunAt: z.number().int().nullable(),
  lastStatus: z.enum(['launched', 'failed']).nullable(),
  lastError: z.string().nullable(),
  lastTaskId: z.string().nullable(),
  consecutiveFailures: z.number().int(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
})
export type ScheduledTask = z.infer<typeof ScheduledTaskSchema>

/**
 * POST /api/scheduled-tasks body。`launchPayload` 在 SCHEMA 层保持 unknown ——
 * 服务层按 `launchKind` 经 `scheduledPayloadSchemaFor` 做封套全量校验（单一
 * 选择器，四入口共用）；raw-key 退役键拒收仍在路由层先行。
 */
export const CreateScheduledTaskSchema = z
  .object({
    name: ScheduledTaskNameSchema,
    /** RFC-165 §9b：执行主体；缺省 workflow（向后兼容旧客户端）。 */
    launchKind: ScheduledLaunchKindSchema.default('workflow'),
    launchPayload: z.unknown(),
    scheduleSpec: ScheduleSpecSchema,
    enabled: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    // 实现门 P1 修复：封套校验必须留在请求边界——launchPayload 若只是
    // unknown，坏 payload 会穿透 schema、在服务层炸出裸 ZodError（HTTP
    // 500）。kind 决定封套，issues 原样冒泡（路由 safeParse → 422）。
    const r = scheduledPayloadSchemaFor(v.launchKind).safeParse(v.launchPayload)
    if (!r.success) {
      for (const issue of r.error.issues) {
        ctx.addIssue({ ...issue, path: ['launchPayload', ...issue.path] })
      }
    }
  })
export type CreateScheduledTask = z.infer<typeof CreateScheduledTaskSchema>

/** PUT /api/scheduled-tasks/:id body（strict partial）。`launchKind` 不可变——
 *  提供时必须等于既有值（服务层 422 scheduled-kind-immutable）。 */
export const UpdateScheduledTaskSchema = z
  .object({
    name: ScheduledTaskNameSchema.optional(),
    launchKind: ScheduledLaunchKindSchema.optional(),
    launchPayload: z.unknown().optional(),
    scheduleSpec: ScheduleSpecSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
export type UpdateScheduledTask = z.infer<typeof UpdateScheduledTaskSchema>

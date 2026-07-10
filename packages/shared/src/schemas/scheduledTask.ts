// RFC-159 — 定时任务（周期性自动启动任务）schema。
// ScheduleSpec = interval | daily | weekly | monthly 判别联合（预设携创建者 IANA 时区）。
// launchPayload 复用 StartTaskSchema——整份存启动 body，到点参数不变地重放。
import { z } from 'zod'
import { StartTaskSchema } from './task'
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
  launchPayload: StartTaskSchema.nullable(),
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

/** POST /api/scheduled-tasks body。 */
export const CreateScheduledTaskSchema = z.object({
  name: ScheduledTaskNameSchema,
  launchPayload: StartTaskSchema,
  scheduleSpec: ScheduleSpecSchema,
  enabled: z.boolean().default(true),
})
export type CreateScheduledTask = z.infer<typeof CreateScheduledTaskSchema>

/** PUT /api/scheduled-tasks/:id body（strict partial）。 */
export const UpdateScheduledTaskSchema = z
  .object({
    name: ScheduledTaskNameSchema.optional(),
    launchPayload: StartTaskSchema.optional(),
    scheduleSpec: ScheduleSpecSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
export type UpdateScheduledTask = z.infer<typeof UpdateScheduledTaskSchema>

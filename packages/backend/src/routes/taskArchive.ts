// RFC-311 T19 — 终态任务归档的手动批量入口(design §7.1「另有 admin API + 设置页
// 维护区『按条件批量归档』手动入口(审计行记录操作者与数量)」)。
//
// 两点刻意的设计:
//   - **忽略 `taskArchive.enabled`**:手动入口的意义就是自动归档关着时也能清一次;
//     开关只管 hourly sweeper。
//   - **dryRun 是默认**:归档 == 删除(前台 404 同不存在、无在线回看),所以先给
//     「会归档哪几棵树、共多少任务」的预览,真正执行必须显式 `dryRun: false`。
//
// 权限用 `settings:write`:能翻 `taskArchive.enabled` 的人本来就能让同一批任务被
// 自动归档掉,手动入口不扩大任何边界;而 `tasks:delete` 是资源域按任务成员约束的
// CRUD 动词,答不了「跨全库按条件批量」这个问题。

import type { Hono } from 'hono'
import { z } from 'zod'
import { SETTINGS_NUMERIC_BOUNDS } from '@agent-workflow/shared'

import { actorOf } from '@/auth/actor'
import { loadConfig } from '@/config'
import { registerRoute } from '@/routes/registry'
import type { TaskArchiveMaintenanceCommand } from '@/modules/task-execution/composition/taskArchiveMaintenance'
import { ValidationError } from '@/util/errors'
import { safeJsonOrEmpty } from '@/util/http'
import { Paths } from '@/util/paths'

const RETENTION_BOUND = SETTINGS_NUMERIC_BOUNDS['taskArchive.retentionDays']
// 单次调用的硬上限。归档跑在守护进程那条**同步**的 SQLite 连接上,一次吞下上万棵
// 树会把整站冻住(正是本 RFC 在治的那类问题),所以手动入口按批做、多点几次。
const MAX_TREES_LIMIT = 500

const ArchiveRequestSchema = z.object({
  /** 省略则回落到 config 的 `taskArchive.retentionDays`。 */
  retentionDays: z.number().int().min(RETENTION_BOUND.min).max(RETENTION_BOUND.max).optional(),
  maxTrees: z.number().int().min(1).max(MAX_TREES_LIMIT).optional(),
  /** 省略 = dry-run。只有显式 `false` 才真删。 */
  dryRun: z.boolean().optional(),
})

export interface TaskArchiveRouteDependencies {
  readonly configPath: string
  readonly taskArchiveMaintenance: TaskArchiveMaintenanceCommand
}

export function mountTaskArchiveRoutes(app: Hono, deps: TaskArchiveRouteDependencies): void {
  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/tasks/archive',
      permissions: ['settings:write'],
      tokenAccess: 'allow',
      summary: 'Archive settled task trees older than the retention window (dry-run by default)',
    },
    async (c) => {
      const parsed = ArchiveRequestSchema.safeParse(await safeJsonOrEmpty(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError('task-archive-invalid', parsed.error.message, {
          issues: parsed.error.issues,
        })
      }
      const body = parsed.data
      const configured = loadConfig(deps.configPath).taskArchive
      const retentionDays = body.retentionDays ?? configured?.retentionDays ?? 0
      const maxTrees = body.maxTrees ?? 50
      // 未配置保留期(0 = 不归档)时手动入口也不猜一个默认值:0 天会把**刚刚结束**
      // 的任务一起卷走,这是不可逆删除,宁可要求调用方显式给天数。
      if (retentionDays <= 0) {
        throw new ValidationError(
          'task-archive-retention-unset',
          'retentionDays must be configured (or passed) and greater than 0',
        )
      }

      if (body.dryRun !== false) {
        const trees = await deps.taskArchiveMaintenance.preview({ retentionDays, maxTrees })
        return c.json({
          dryRun: true,
          retentionDays,
          treeCount: trees.length,
          taskCount: trees.reduce((sum, tree) => sum + tree.taskCount, 0),
          trees,
        })
      }

      const actor = actorOf(c)
      const result = await deps.taskArchiveMaintenance.runManual(
        {
          retentionDays,
          maxTrees,
          actorUserId: actor.user.id,
        },
        {
          archiveDir: Paths.taskArchiveDir,
          runsDir: Paths.runsDir,
          logsDir: Paths.logsDir,
        },
      )
      return c.json({
        dryRun: false,
        retentionDays,
        treeCount: result.archived.length,
        taskCount: result.archived.reduce((sum, tree) => sum + tree.taskIds.length, 0),
        skipped: result.skipped,
        trees: result.archived.map((tree) => ({
          rootTaskId: tree.rootTaskId,
          taskCount: tree.taskIds.length,
        })),
      })
    },
  )
}

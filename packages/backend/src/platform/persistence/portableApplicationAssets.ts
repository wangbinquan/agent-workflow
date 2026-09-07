// RFC-359 W9 —— 便携备份 / 还原的「应用侧资产」行选择：一份实现，两个 provider 共用。
//
// 这里的三条查询（导出 workflow、抓 live worktree、按 id 取 worktree 行）**没有任何
// 机制固有差异**：同一张表、同一组列、同一个筛选条件，既不开事务也不用方言函数。
// 合一前却是两份：
//
//   · SQLite     —— `platform/persistence/sqlite/systemProviderBackup.ts` 里内联的
//                  `application` + `systemWorktreeBackup.ts`（drizzle）
//   · PostgreSQL —— `postgresqlProviderBackupApplicationAssets.ts` /
//                  `postgresqlProviderRestoreApplicationAssets.ts` 里的**手写 SQL**：
//                  手写 schema 限定名、手写列别名（`"worktree_path" AS "worktreePath"`）、
//                  手写 `$1,$2…` 占位符表、手写 `requiredString` 行校验。
//
// 手写那一侧与 `db/schema.ts` 之间只有「人记得改」这一条约束：列一改名，SQLite 侧跟着
// drizzle 走，PostgreSQL 侧要等用户真的去点「导出备份」时才炸。行为对拍见
// `tests/rfc359-w9-system-operations-application-assets-conformance.test.ts`。
//
// 为什么落在 `platform/persistence/` 而不是 system-operations 模块内：它是**持久化的
// 词汇**（选哪些行），不是谁的领域概念，而两个消费者一个在模块里、一个在
// `platform/persistence/sqlite/` 这条 legacy 线上。定义在模块内会让后者记一条
// 「legacy 指向模块内部」的越界边（`rfc317-module-boundary` 实测会红）——理由与
// `db/query.ts` 顶端给 `ProviderNeutralDatabase` 选家的那条完全一样。
//
// 合一时取的是 SQLite 侧的错误契约（对拍照出的真分叉）：损坏的 definition 抛
// `ValidationError('workflow-definition-corrupt')`（422 带 workflowId），而不是裸的
// SyntaxError / ZodError（到路由层就是 500 `internal-error`）。判据与
// `resource-catalog` 的 `rowToWorkflow` 逐字同形——那是「读一行 workflow」在全仓的既有
// 契约，备份路径没有理由自己发明一个。

import {
  LIVE_WORKTREE_TASK_STATUSES,
  migrateWorkflowDefinitionToLatest,
  WorkflowDefinitionSchema,
} from '@agent-workflow/shared'
import { eq, inArray } from 'drizzle-orm'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ProviderNeutralDatabase } from '@/db/query'
import { tasks, workflows } from '@/db/schema'
import type { PortableBackupApplicationAssets } from '@/services/portableBackupArchive'
import { stringifyWorkflowYaml } from '@/services/workflow.yaml'
import {
  captureWorktreeRows,
  reconstructWorktreeRows,
  type WorktreeCaptureResult,
  type WorktreeReconstructResult,
} from '@/services/worktreeBackup'
import { ValidationError } from '@/util/errors'
import { createLogger } from '@/util/log'

const log = createLogger('portableApplicationAssets')

/**
 * 解码一行存下来的 definition。与 `resource-catalog` 的 `rowToWorkflow` 同一套判据：
 * 不是 JSON / 不过 schema 都是 `workflow-definition-corrupt`（422），details 带上是
 * **哪一个** workflow ——用户拿着这个 id 才能去修，而不是对着一句 500 猜。
 */
function decodeWorkflowDefinition(workflowId: string, stored: string) {
  let raw: unknown
  try {
    raw = JSON.parse(stored)
  } catch (error) {
    throw new ValidationError('workflow-definition-corrupt', 'stored definition is not JSON', {
      workflowId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
  const parsed = WorkflowDefinitionSchema.safeParse(raw)
  if (!parsed.success) {
    throw new ValidationError('workflow-definition-corrupt', 'stored definition is invalid', {
      workflowId,
      issues: parsed.error.issues,
    })
  }
  return migrateWorkflowDefinitionToLatest(parsed.data)
}

/**
 * 备份要抓的 worktree 行：非终态（`LIVE_WORKTREE_TASK_STATUSES`）任务各一行。
 * 归档机制本身（打包、排除 `.git`、超上限跳过）由 `services/worktreeBackup.ts` 拥有，
 * 这里只负责选行。
 */
export async function captureWorktrees(
  db: ProviderNeutralDatabase,
  stagingDirectory: string,
  options?: { readonly maxBytes?: number },
): Promise<WorktreeCaptureResult> {
  const rows = await db
    .select({
      id: tasks.id,
      worktreePath: tasks.worktreePath,
      branch: tasks.branch,
      repoPath: tasks.repoPath,
      baseCommit: tasks.baseCommit,
    })
    .from(tasks)
    .where(inArray(tasks.status, [...LIVE_WORKTREE_TASK_STATUSES]))
    .all()
  return await captureWorktreeRows(rows, stagingDirectory, options)
}

/**
 * 还原时按归档里的 task id 取当前的 worktree 行。路径 / 分支一律取**库里**的值，
 * 归档里的 JSON 只提供 task id（`services/worktreeBackup.ts` 的既有契约）。
 */
export async function reconstructWorktrees(
  db: ProviderNeutralDatabase,
  extractedDirectory: string,
): Promise<WorktreeReconstructResult> {
  return await reconstructWorktreeRows(
    {
      async findById(taskId: string) {
        return await db
          .select({
            id: tasks.id,
            status: tasks.status,
            worktreePath: tasks.worktreePath,
            branch: tasks.branch,
            repoPath: tasks.repoPath,
          })
          .from(tasks)
          .where(eq(tasks.id, taskId))
          .get()
      },
    },
    extractedDirectory,
  )
}

/**
 * 便携备份的应用侧资产：workflow 的 YAML 导出 + live worktree 的抓取。
 * 外层归档信封（config / skills / manifest / tar）由 `createPortableBackupArchive`
 * 拥有，两个 provider 本来就共用它；这份是它缺的最后一块中立实现。
 */
export function createPortableBackupApplicationAssets(input: {
  readonly db: ProviderNeutralDatabase
  readonly maxWorktreeBytes?: number
}): PortableBackupApplicationAssets {
  return Object.freeze({
    async exportWorkflows(destination: string) {
      const rows = await input.db
        .select({
          id: workflows.id,
          name: workflows.name,
          description: workflows.description,
          definition: workflows.definition,
        })
        .from(workflows)
        .orderBy(workflows.id)
        .all()
      for (const row of rows) {
        writeFileSync(
          join(destination, `${row.id}.yaml`),
          stringifyWorkflowYaml({
            id: row.id,
            name: row.name,
            description: row.description,
            definition: decodeWorkflowDefinition(row.id, row.definition),
          }),
          'utf-8',
        )
      }
      return rows.length
    },
    async captureWorktrees(stagingDirectory: string) {
      const result = await captureWorktrees(
        input.db,
        stagingDirectory,
        input.maxWorktreeBytes === undefined ? undefined : { maxBytes: input.maxWorktreeBytes },
      )
      // 跳过的 worktree 必须留痕：合一前 PostgreSQL 侧把这个返回值整个丢掉，于是
      // 「有几个 worktree 因为超过上限没进备份」在 PG 上连一条日志都没有。
      log.info('backup captured worktrees', {
        captured: result.captured.length,
        skipped: result.skipped.length,
      })
    },
  })
}

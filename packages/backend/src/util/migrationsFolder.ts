// 迁移目录的**唯一**解析入口。
//
// 为什么必须收敛成一处：drizzle 的 migrator 只认文件系统路径，而
// `Paths.migrationsDir`（util/paths.ts:94）指的是**源码树里**的
// `packages/backend/db/migrations`——`bun --compile` 出来的单二进制里没有这个
// 目录，.sql 与 meta/_journal.json 都嵌在可执行文件内部。于是每个要开库的入口
// 都得先「IS_EMBEDDED 时解包到 ~/.agent-workflow/runtime/migrations」。
//
// 这段前置此前被逐字抄了六遍（cli/start.ts、cli/user.ts、cli/auth.ts、
// cli/restore.ts、routes/restore.ts 各一份，措辞还各有出入），而
// `backup` / `migrate` / `migration-report` / `package` 四处**漏抄**——发行版
// 上这四条命令因此全部当场失败，报一句与它们毫无关系的
// `Can't find meta/_journal.json file`（2026-08-25 在 dist 二进制上实测）。
// 判据与回归防护见 packages/backend/tests/cli-embedded-migrations.test.ts。

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { extractMigrationsTo, IS_EMBEDDED } from '@/embed'
import { Paths } from '@/util/paths'

export interface ResolveMigrationsOptions {
  /**
   * 即使目录已存在也重新解包。恢复链路（cli/restore.ts、routes/restore.ts）
   * 用它：那两处要在**校验一个外来 tarball 的迁移代次**之前保证本地这份是完整的。
   */
  readonly force?: boolean
  /**
   * 真正发生了解包时回调：写出的文件数 + 目标目录。`start.ts` 用它记时长与条数。
   * 目录也一并给出，免得调用方再拼一次那个路径——「谁都能自己拼」正是这段前置
   * 被抄了六遍的起点。
   */
  readonly onExtracted?: (count: number, dir: string) => void
}

/**
 * 返回一个 drizzle migrator 能直接用的迁移目录路径。
 *
 * - 源码树运行：就是 `Paths.migrationsDir`，不碰盘。
 * - 单二进制运行：解包到 `~/.agent-workflow/runtime/migrations` 并返回它。
 *   默认只在缺 `meta/_journal.json` 时解包——判据用**那个文件**而不是目录本身，
 *   因为上一次解包被中断时目录会存在但内容不全，只看目录会把半截状态当成好的。
 */
export async function resolveMigrationsFolder(
  opts: ResolveMigrationsOptions = {},
): Promise<string> {
  if (!IS_EMBEDDED) return Paths.migrationsDir
  const dir = join(Paths.root, 'runtime', 'migrations')
  if (opts.force === true || !existsSync(join(dir, 'meta', '_journal.json'))) {
    const count = await extractMigrationsTo(dir)
    opts.onExtracted?.(count, dir)
  }
  return dir
}

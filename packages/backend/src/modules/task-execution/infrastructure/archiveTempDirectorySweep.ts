// RFC-359 W3-T15-B —— 归档 `.tmp-*` 残留目录的收尾：纯文件系统，一份实现，两个 provider 的归档
// 恢复都调它（SQLite `services/taskArchive.ts` 的 `recoverInterruptedArchives` 与 PostgreSQL 的
// `createPostgresqlTaskArchiveMaintenanceCommand().recover`）。
//
// 规则（RFC-311 crash branch B）：RFC-328 认领已经接管的根不碰；其余 `.tmp-{rootTaskId}`——
//   · 任务行还在库里 ⇒ 崩在删库之前：先把挪走的 runs / logs 目录放回原处，全部放回才丢弃 tmp，下轮重做；
//   · 正式目录已存在 ⇒ 丢弃 tmp；
//   · 否则（行已删、崩在 rename 与删库之间）⇒ 提升为正式目录，否则数据就真的没了。

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/** 把 tmp 里挪走的 runs / logs 子目录放回原根；有任何一个目标已存在则停下并报告未完成。 */
export function restoreLegacyMovedDirectories(
  tmpDir: string,
  kind: 'runs' | 'logs',
  root: string,
): boolean {
  const movedRoot = join(tmpDir, kind)
  if (!existsSync(movedRoot)) return true
  mkdirSync(root, { recursive: true })
  for (const entry of readdirSync(movedRoot)) {
    const from = join(movedRoot, entry)
    const to = join(root, entry)
    if (existsSync(to)) return false
    renameSync(from, to)
  }
  return true
}

export interface ArchiveTempDirectorySweepInput {
  readonly archiveRoot: string
  readonly runsDir: string
  readonly logsDir: string
  /** RFC-328 认领已接管的根任务；它们的 tmp 由认领恢复自己处理。 */
  readonly claimedRoots: ReadonlySet<string>
  readonly taskExists: (taskId: string) => Promise<boolean>
}

export interface ArchiveTempDirectorySweepReceipt {
  readonly promoted: readonly string[]
  readonly discarded: readonly string[]
}

export async function sweepArchiveTempDirectories(
  input: ArchiveTempDirectorySweepInput,
): Promise<ArchiveTempDirectorySweepReceipt> {
  const promoted: string[] = []
  const discarded: string[] = []
  if (!existsSync(input.archiveRoot)) return { promoted, discarded }
  for (const entry of readdirSync(input.archiveRoot)) {
    if (!entry.startsWith('.tmp-')) continue
    const rootTaskId = entry.slice('.tmp-'.length)
    if (input.claimedRoots.has(rootTaskId)) continue
    const tmpDir = join(input.archiveRoot, entry)
    if (await input.taskExists(rootTaskId)) {
      const runsRestored = restoreLegacyMovedDirectories(tmpDir, 'runs', input.runsDir)
      const logsRestored = restoreLegacyMovedDirectories(tmpDir, 'logs', input.logsDir)
      if (runsRestored && logsRestored) {
        rmSync(tmpDir, { recursive: true, force: true })
        discarded.push(rootTaskId)
      }
      continue
    }
    const finalDir = join(input.archiveRoot, rootTaskId)
    if (existsSync(finalDir)) {
      rmSync(tmpDir, { recursive: true, force: true })
      discarded.push(rootTaskId)
      continue
    }
    renameSync(tmpDir, finalDir)
    promoted.push(rootTaskId)
  }
  return { promoted, discarded }
}

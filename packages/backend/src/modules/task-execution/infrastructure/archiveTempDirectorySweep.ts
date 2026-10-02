// RFC-359 W3-T15-B / RFC-370 —— 归档 `.tmp-*` 残留目录的收尾：一份规则、所选内容效果，两个 provider 的归档
// 恢复都调它（RFC-359 W8-A 合一后的唯一调用点是
// `taskArchiveMaintenanceCommand.ts` 的 `createDrizzleTaskArchiveMaintenanceCommand().recover`）。
//
// 规则（RFC-311 crash branch B）：RFC-328 认领已经接管的根不碰；其余 `.tmp-{rootTaskId}`——
//   · 任务行还在库里 ⇒ 崩在删库之前：先把挪走的 runs / logs 目录放回原处，全部放回才丢弃 tmp，下轮重做；
//   · 正式目录已存在 ⇒ 丢弃 tmp；
//   · 否则（行已删、崩在 rename 与删库之间）⇒ 提升为正式目录，否则数据就真的没了。

import type { TaskArchiveContentPort } from '../application/ports/taskArchiveContent'

export { restoreFileArchiveMovedDirectories as restoreLegacyMovedDirectories } from './local/fileTaskArchiveContent'

export interface ArchiveTempDirectorySweepInput {
  readonly content: TaskArchiveContentPort
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
  const content = input.content
  const promoted: string[] = []
  const discarded: string[] = []
  if (!(await content.exists(input.archiveRoot))) return { promoted, discarded }
  for (const entry of await content.list(input.archiveRoot)) {
    if (!entry.startsWith('.tmp-')) continue
    const rootTaskId = entry.slice('.tmp-'.length)
    if (input.claimedRoots.has(rootTaskId)) continue
    const tmpDir = content.resolve(input.archiveRoot, entry)
    if (await input.taskExists(rootTaskId)) {
      const runsRestored = await content.restoreMovedDirectories(tmpDir, 'runs', input.runsDir)
      const logsRestored = await content.restoreMovedDirectories(tmpDir, 'logs', input.logsDir)
      if (runsRestored && logsRestored) {
        await content.remove(tmpDir, true)
        discarded.push(rootTaskId)
      }
      continue
    }
    const finalDir = content.resolve(input.archiveRoot, rootTaskId)
    if (await content.exists(finalDir)) {
      await content.remove(tmpDir, true)
      discarded.push(rootTaskId)
      continue
    }
    await content.move(tmpDir, finalDir)
    promoted.push(rootTaskId)
  }
  return { promoted, discarded }
}

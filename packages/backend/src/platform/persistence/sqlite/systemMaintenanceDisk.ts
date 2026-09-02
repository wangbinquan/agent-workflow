// RFC-311 T20 —— 「可回收空间」盘点与清理。
//
// 审计（audit-2026-08-18 §1）在本机量到的磁盘全景是：runs/ 5.9GB > **opencode-stores/
// 2.9GB** > backups/ 2.0GB > worktrees/ 1.1GB，DB 本身只占 ~15%。其中
// `opencode-stores/` 是 RFC-276 退役留下的**零引用死数据**（退役 commit `70deb522`，
// 全仓已无任何代码读写它），没有任何东西会清理它——它只会一直躺在那里。
//
// 另一半是 DB 内部的可回收空间：`freelist_count × page_size`。删除大批行（归档、
// 保留期清理、任务归档）之后这些页留在文件里不还给文件系统，只有 VACUUM 能收回。
// 这里只**报告**它，回收由 `agent-workflow db compact` 停机执行——在线 VACUUM 会
// 持锁重写整个库，对单连接同步 daemon 等于长时间全站冻结，不能提供「一键」。

// System Operations SQLite disk-reclamation projection. Provider-independent filesystem cleanup
// stays here beside the SQLite row-size estimator it reports.

import { sql } from 'drizzle-orm'
import { chmodSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'

import type { DbClient } from '@/db/client'
import type {
  MaintenanceDiskReport,
  ReclaimableDiskItem,
} from '@/modules/system-operations/public/types'
import { createLogger } from '@/util/log'
import { Paths } from '@/util/paths'

const log = createLogger('maintenance-disk')

/** RFC-276 退役的运行时私有 store 根目录名。 */
const RETIRED_STORE_DIR = 'opencode-stores'

export type ReclaimableItem = ReclaimableDiskItem
export type DiskReclaimReport = MaintenanceDiskReport

function dirSize(dir: string): { bytes: number; entries: number } {
  let bytes = 0
  let entries = 0
  const walk = (current: string, depth: number): void => {
    if (depth > 24) return
    let listing: string[]
    try {
      listing = readdirSync(current)
    } catch {
      return
    }
    for (const name of listing) {
      const full = join(current, name)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        entries += 1
        walk(full, depth + 1)
      } else {
        entries += 1
        bytes += st.size
      }
    }
  }
  walk(dir, 0)
  return { bytes, entries }
}

export function reportRetiredRuntimeStores(appHome: string = Paths.root): ReclaimableItem {
  const storePath = join(appHome, RETIRED_STORE_DIR)
  const exists = existsSync(storePath)
  const measured = exists ? dirSize(storePath) : { bytes: 0, entries: 0 }
  return {
    id: 'retired-runtime-stores',
    path: storePath,
    exists,
    bytes: measured.bytes,
    entries: measured.entries,
  }
}

/** 只读盘点。不动任何文件。 */
export function reportDiskReclaimable(
  db: DbClient,
  appHome: string = Paths.root,
): DiskReclaimReport {
  const pragma = (name: string, column: string): number => {
    const rows = db.all<Record<string, number>>(sql.raw(`PRAGMA ${name}`))
    return Number(rows[0]?.[column] ?? 0)
  }
  const pageSize = pragma('page_size', 'page_size')
  const freelist = pragma('freelist_count', 'freelist_count')
  const pageCount = pragma('page_count', 'page_count')

  return {
    items: [reportRetiredRuntimeStores(appHome)],
    dbFreelistBytes: freelist * pageSize,
    dbFileBytes: pageCount * pageSize,
  }
}

/**
 * 给整棵树里的**目录**补上 owner 写位，让随后的 `rmSync` 能 unlink 里面的文件。
 *
 * RFC-276 时代的 store 把每个 business 的 `explicit-config/` 落成 `0o500`
 * （`dr-x------`，同 util/fileTrust.ts 的 `OWNER_READ_EXECUTE_MODE`）。unlink 一个文件
 * 要的是**父目录**的写位、而不是文件自己的，所以 `rmSync(recursive)` 会在第一处这样的
 * 密封目录上以 EACCES 把整棵树的删除中断掉——本机 2.9GB 的退役 store 里 1254 个
 * `explicit-config/` 无一例外，也就是说这个「删除退役运行时存储」按钮在**真实数据**上
 * 从来没成功过（旧测试只喂了可写的假数据，所以一直绿）。
 *
 * 只碰目录、只补 `0o700`；用 Dirent 判类型因而不跟随符号链接（chmod 不会溢出到树外）；
 * 迭代而非递归——退役 store 里躺着 24 层深的 Xcode/python 缓存副本。
 */
function grantOwnerWriteToDirectories(root: string): number {
  let unsealed = 0
  const pending: string[] = [root]
  while (pending.length > 0) {
    const current = pending.pop()!
    try {
      const mode = statSync(current).mode & 0o7777
      if ((mode & 0o700) !== 0o700) {
        chmodSync(current, mode | 0o700)
        unsealed += 1
      }
    } catch {
      continue
    }
    let listing: Dirent[]
    try {
      listing = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of listing) {
      if (entry.isDirectory()) pending.push(join(current, entry.name))
    }
  }
  return unsealed
}

/**
 * 删除退役 store 目录。**不可逆**，所以调用方必须先让用户看过盘点数字并确认。
 * 目录不存在时返回 0 而不是报错（重复点击是无害的）。
 *
 * 遇到 RFC-276 留下的只读目录时先补写位再重试一次，见
 * `grantOwnerWriteToDirectories`。
 */
export function cleanupRetiredStores(appHome: string = Paths.root): { removedBytes: number } {
  const storePath = join(appHome, RETIRED_STORE_DIR)
  if (!existsSync(storePath)) return { removedBytes: 0 }
  const { bytes } = dirSize(storePath)
  try {
    rmSync(storePath, { recursive: true, force: true })
  } catch (err) {
    // 判据是「树里还有没有只读目录」，不是 errno：Bun 只报**顶层**路径 + 最后一次失败
    // 系统调用的错误码，同一棵密封树在不同平台上给的码并不一样（本机 macOS 报 EACCES ——
    // unlink 被父目录拒了；CI 的 macOS runner 报 ENOTEMPTY —— 文件没删掉、随后的 rmdir
    // 落空）。按码白名单必漏，所以改成：补写位；一个都没补到说明不是这类原因，原样把
    // 首个错误抛出去。首轮已经删掉的部分不影响重删。
    const unsealed = grantOwnerWriteToDirectories(storePath)
    if (unsealed === 0) throw err
    log.warn('retired store had read-only directories; granted owner write and retried', {
      path: storePath,
      unsealed,
      error: String(err),
    })
    rmSync(storePath, { recursive: true, force: true })
  }
  log.info('removed retired runtime stores', { path: storePath, bytes })
  return { removedBytes: bytes }
}

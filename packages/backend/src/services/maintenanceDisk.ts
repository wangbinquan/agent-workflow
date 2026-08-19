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

import { sql } from 'drizzle-orm'
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

import type { DbClient } from '@/db/client'
import { createLogger } from '@/util/log'
import { Paths } from '@/util/paths'

const log = createLogger('maintenance-disk')

/** RFC-276 退役的运行时私有 store 根目录名。 */
const RETIRED_STORE_DIR = 'opencode-stores'

export interface ReclaimableItem {
  /** 稳定标识，前端与 CLI 都按它引用。 */
  id: 'retired-runtime-stores'
  path: string
  exists: boolean
  bytes: number
  entries: number
}

export interface DiskReclaimReport {
  items: ReclaimableItem[]
  /** DB 内部已释放但仍占文件空间的字节（VACUUM 可收回）。 */
  dbFreelistBytes: number
  dbFileBytes: number
}

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

/** 只读盘点。不动任何文件。 */
export function reportDiskReclaimable(
  db: DbClient,
  appHome: string = Paths.root,
): DiskReclaimReport {
  const storePath = join(appHome, RETIRED_STORE_DIR)
  const exists = existsSync(storePath)
  const measured = exists ? dirSize(storePath) : { bytes: 0, entries: 0 }

  const pragma = (name: string, column: string): number => {
    const rows = db.all<Record<string, number>>(sql.raw(`PRAGMA ${name}`))
    return Number(rows[0]?.[column] ?? 0)
  }
  const pageSize = pragma('page_size', 'page_size')
  const freelist = pragma('freelist_count', 'freelist_count')
  const pageCount = pragma('page_count', 'page_count')

  return {
    items: [
      {
        id: 'retired-runtime-stores',
        path: storePath,
        exists,
        bytes: measured.bytes,
        entries: measured.entries,
      },
    ],
    dbFreelistBytes: freelist * pageSize,
    dbFileBytes: pageCount * pageSize,
  }
}

/**
 * 删除退役 store 目录。**不可逆**，所以调用方必须先让用户看过盘点数字并确认。
 * 目录不存在时返回 0 而不是报错（重复点击是无害的）。
 */
export function cleanupRetiredStores(appHome: string = Paths.root): { removedBytes: number } {
  const storePath = join(appHome, RETIRED_STORE_DIR)
  if (!existsSync(storePath)) return { removedBytes: 0 }
  const { bytes } = dirSize(storePath)
  rmSync(storePath, { recursive: true, force: true })
  log.info('removed retired runtime stores', { path: storePath, bytes })
  return { removedBytes: bytes }
}

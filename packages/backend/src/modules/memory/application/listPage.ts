// RFC-352 T8（RFC-294 W4-E2）—— 分页列表的编排：把三层查询后过滤接到 domain 的
// keyset 累积原语上。**两个 provider 共用这一份**，各自只提供「原始一批」的取数。
//
// 为什么坚持只写一份：RFC-352 前面已经撞到过一次同类事故——scope 授权判据被抄在两个
// provider 里各一份，随后各自演进，同一个用户在 SQLite 与 PostgreSQL 部署上看到的按钮
// 都不一样。分页的三层过滤顺序（标签 → 可见性 → 候选收窄）与游标语义同理：抄两份就会漂。

import type { MemoryListFilter, MemorySummary } from '@agent-workflow/shared'
import { matchesTagFilter } from '@agent-workflow/shared'

import { ValidationError } from '@/util/errors'

import {
  accumulateMemoryPage,
  decodeMemoryPageCursor,
  type MemoryPageAnchor,
} from '../domain/listPagination'

export type MemoryPageRow = MemorySummary & MemoryPageAnchor

export interface MemoryListPageDeps {
  /** 原始一批：不做任何过滤（见 `MemoryPageInput.fetchBatch` 的契约）。 */
  readonly fetchBatch: (
    after: MemoryPageAnchor | null,
    size: number,
  ) => Promise<readonly MemoryPageRow[]>
  /** scope 可见性：按行批量问 resource-catalog 的 participant。 */
  readonly filterVisible: (rows: readonly MemoryPageRow[]) => Promise<readonly MemoryPageRow[]>
}

export async function listMemoryPage(
  deps: MemoryListPageDeps,
  filter: MemoryListFilter,
  page: { readonly cursor: string | null; readonly limit: number },
  options: { readonly includeCandidates: boolean },
): Promise<{ readonly items: readonly MemoryPageRow[]; readonly nextCursor: string | null }> {
  // 坏游标必须显式失败：静默从头开始会让客户端无限翻第一页，看着像「数据不动」。
  // 直接抛仓里通用的 `ValidationError`（memory 内部已有先例），这样调用方不需要认识
  // 一个 memory 私有的错误类型——少一条 legacy→模块的 value import 边。
  const start = page.cursor === null ? null : decodeMemoryPageCursor(page.cursor)
  if (page.cursor !== null && start === null) {
    throw new ValidationError('invalid-filter', 'invalid cursor')
  }

  return await accumulateMemoryPage<MemoryPageRow>({
    limit: page.limit,
    start,
    fetchBatch: deps.fetchBatch,
    keepVisible: async (rows) => {
      // ① 标签：tags 是 JSON 列，SQL 判不可靠，与全量路径同一实现。
      const byTag = rows.filter((row) => matchesTagFilter(row.tags, filter))
      // ② 候选收窄（RFC-285 Q4）：未经人审的蒸馏产物只对持 `resource-acl:bypass` 的操作者可见。
      const byStatus = options.includeCandidates
        ? byTag
        : byTag.filter((row) => row.status !== 'candidate')
      if (byStatus.length === 0) return []
      // ③ scope 可见性：agent / workflow 随其资源可见性。
      return await deps.filterVisible(byStatus)
    },
  })
}

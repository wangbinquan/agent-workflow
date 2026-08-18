// RFC-311 T26 — `{items, nextCursor}` 分页封套的统一 useInfiniteQuery 包装。
//
// 与 useTaskOperationsPage 同构(该 hook 先于本原语存在,暂各自成文;后续
// intent/deliveries 等接入时收敛到这里)。约定:
//   - 服务端封套至少含 `nextCursor: string | null`;
//   - cursor 为 null 表示到底;
//   - 过滤条件变化 = queryKey 变化 = 自动回到首页(react-query 语义)。

import { keepPreviousData, useInfiniteQuery, type QueryKey } from '@tanstack/react-query'

export interface PagedListOptions<TPage extends { nextCursor: string | null }> {
  queryKey: QueryKey
  /** 拉一页。cursor 为 null 时是首页。 */
  fetchPage: (cursor: string | null, signal: AbortSignal) => Promise<TPage>
  enabled?: boolean
  /** 透传 useInfiniteQuery 的 maxPages(内存里最多保留的页数)。 */
  maxPages?: number
  /** 过滤条件变化(= queryKey 变化)期间保留上一份数据,列表不闪空。
   *  服务端过滤的列表页基本都要开。 */
  keepPreviousData?: boolean
  refetchOnWindowFocus?: boolean
}

export function usePagedList<TPage extends { nextCursor: string | null }>(
  options: PagedListOptions<TPage>,
) {
  return useInfiniteQuery({
    queryKey: options.queryKey,
    initialPageParam: null as string | null,
    enabled: options.enabled ?? true,
    queryFn: ({ pageParam, signal }) => options.fetchPage(pageParam, signal),
    getNextPageParam: (last: TPage) => last.nextCursor ?? undefined,
    ...(options.maxPages === undefined ? {} : { maxPages: options.maxPages }),
    ...(options.keepPreviousData === true ? { placeholderData: keepPreviousData } : {}),
    refetchOnWindowFocus: options.refetchOnWindowFocus ?? false,
  })
}

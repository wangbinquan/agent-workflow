// RFC-327 —— 记忆标签的纯函数面：过滤匹配与 facets 聚合。
//
// 为什么放 shared：REST 列表路由、MCP `resource_read`（query 透传）与将来的前端
// 标签筛选器都要用同一套「多标签 any/all」与「标签计数」语义；放一处、纯函数、
// 先于任何 I/O 可断言（CLAUDE.md §Test-with-every-change「首选可断言面」）。
//
// 语义单源：
//   · `normalizeTagList`：trim → 去空 → 保序去重。逗号拆分由调用方（路由）做，
//     这里只认已经拆好的数组，避免把「逗号是不是分隔符」写死在两处。
//   · `matchesTagFilter`：旧的单值 `tag` 折进 `tags` 一起判，`tagMode` 缺省 any；
//     没有任何想要的标签 ⇒ 恒真（等于不筛）。
//   · `aggregateTagFacets`：同一条记忆里重复标签只计一次；排序 count 降序、
//     同数按标签码元升序，保证输出稳定可比。

export type MemoryTagMode = 'any' | 'all'

export interface MemoryTagFilter {
  readonly tag?: string
  readonly tags?: readonly string[]
  readonly tagMode?: MemoryTagMode
}

export interface MemoryTagFacet {
  readonly tag: string
  readonly count: number
}

/** trim → 去空 → 保序去重。 */
export function normalizeTagList(raw: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const tag = item.trim()
    if (tag === '' || seen.has(tag)) continue
    seen.add(tag)
    out.push(tag)
  }
  return out
}

/** 过滤器真正想要的标签集合（legacy `tag` + `tags`，已归一）。 */
export function wantedTags(filter: MemoryTagFilter): string[] {
  return normalizeTagList([
    ...(filter.tag === undefined ? [] : [filter.tag]),
    ...(filter.tags ?? []),
  ])
}

/** 一条记忆的标签是否满足过滤器；无想要的标签 ⇒ true。 */
export function matchesTagFilter(tags: readonly string[], filter: MemoryTagFilter): boolean {
  const wanted = wantedTags(filter)
  if (wanted.length === 0) return true
  const have = new Set(tags)
  return (filter.tagMode ?? 'any') === 'all'
    ? wanted.every((t) => have.has(t))
    : wanted.some((t) => have.has(t))
}

/** 按标签计数；一条记忆内的重复标签只计一次。count 降序、tag 码元升序。 */
export function aggregateTagFacets(
  items: ReadonlyArray<{ readonly tags: readonly string[] }>,
): MemoryTagFacet[] {
  const counts = new Map<string, number>()
  for (const item of items) {
    for (const tag of new Set(item.tags)) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }
  return [...counts]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0))
}

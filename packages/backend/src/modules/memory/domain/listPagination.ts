// RFC-352 T8（RFC-294 W4-E2）—— 记忆列表分页的**纯**原语：游标编解码 + 累积循环。
// 零 IO、零 DB、零端口：取数与过滤都由调用方以函数传进来。
//
// 为什么不能简单地在 SQL 里 `LIMIT`：可见性过滤发生在**查询之后**——agent / workflow
// scope 的记忆随其资源可见性，判定要问 resource-catalog 的 participant（而不是让 memory
// 去 join 别人的 ACL 表，那会把 RFC-352 T4 刚拆掉的跨 context 耦合装回来）。标签过滤同理
// 在内存里做（tags 是 JSON 列）。所以「先 LIMIT 再过滤」会让每一页少几行，
// 「先全取再切片」又等于没分页。
//
// 正确做法是 **keyset 迭代**：按 `(createdAt, id)` 游标分批取、每批过滤、累积到够一页为止。
// 每次请求的批数封顶，避免「几乎什么都看不见」的调用者触发无界扫描；触顶时返回不满的一页
// 加一个有效游标，客户端继续拉即可。

/** 游标锚点。`id` 是同毫秒 `createdAt` 的决胜位——`created_at` 是毫秒，批量蒸馏会撞。 */
export interface MemoryPageAnchor {
  readonly createdAt: number
  readonly id: string
}

/** 每次请求最多扫多少批。触顶即返回不满的一页 + 有效游标。 */
export const MEMORY_PAGE_MAX_BATCHES = 10

/** 单批取多少行：按页大小放大一档（过滤会吃掉一部分），并受上限约束。 */
export function memoryPageBatchSize(limit: number): number {
  return Math.min(Math.max(limit * 2, limit + 1), 400)
}

/**
 * 游标对客户端不透明：base64url 的 `<createdAt>:<id>`。
 * 不透明不是为了保密，是为了**保留改内部锚点的自由**——客户端一旦开始解析，
 * 排序键就再也改不动了。
 */
export function encodeMemoryPageCursor(anchor: MemoryPageAnchor): string {
  return Buffer.from(`${anchor.createdAt}:${anchor.id}`, 'utf8').toString('base64url')
}

/** 解不出来返回 `null`——调用方据此报 400，而不是当成「从头开始」静默吞掉。 */
export function decodeMemoryPageCursor(raw: string): MemoryPageAnchor | null {
  let decoded: string
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8')
  } catch {
    return null
  }
  const separator = decoded.indexOf(':')
  if (separator <= 0) return null
  const createdAt = Number(decoded.slice(0, separator))
  const id = decoded.slice(separator + 1)
  if (!Number.isSafeInteger(createdAt) || id === '') return null
  return { createdAt, id }
}

export interface MemoryPageInput<T extends MemoryPageAnchor> {
  readonly limit: number
  readonly start: MemoryPageAnchor | null
  /**
   * 按 `(createdAt, id)` 降序取**严格位于** `after` 之后的一批；`after` 为 null 表示从头。
   *
   * ⚠️ **它必须是「原始一批」，不许在里面做任何过滤**：本函数用「返回行数少于 `size`」
   * 判定源已耗尽，如果 fetchBatch 自己先滤掉了几行，那个判据会误报「到底」，
   * 于是列表在中间截断——而且截断点随数据分布漂移，极难复现。
   * 所有查询后的过滤（标签、可见性、候选收窄）一律放 `keepVisible`。
   */
  readonly fetchBatch: (after: MemoryPageAnchor | null, size: number) => Promise<readonly T[]>
  /**
   * 应用**全部**查询后过滤，保持入参顺序。memory 这条链上有三层：
   * 标签（tags 是 JSON 列，SQL 判不了）、scope 可见性（要问 resource-catalog 的
   * participant）、以及候选收窄（RFC-285 Q4）。
   */
  readonly keepVisible: (rows: readonly T[]) => Promise<readonly T[]>
  readonly maxBatches?: number
}

export interface MemoryPageResult<T> {
  readonly items: readonly T[]
  readonly nextCursor: string | null
}

/**
 * 累积一页。
 *
 * 游标语义（两种停止方式取的锚点不同，弄反了会漏行或死循环）：
 *   - **页满**：锚点取最后一条**返回**的行——该批里排在它后面、已扫但未纳入的行下一页要重新考虑；
 *   - **触顶**（批数用完、页未满）：锚点取最后一条**扫过**的行——它们已经判过不可见，不必重扫；
 *   - **源耗尽**：`nextCursor = null`。
 */
export async function accumulateMemoryPage<T extends MemoryPageAnchor>(
  input: MemoryPageInput<T>,
): Promise<MemoryPageResult<T>> {
  const maxBatches = input.maxBatches ?? MEMORY_PAGE_MAX_BATCHES
  const size = memoryPageBatchSize(input.limit)
  const items: T[] = []
  let after = input.start
  let lastScanned: T | null = null

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const rows = await input.fetchBatch(after, size)
    if (rows.length === 0) return { items, nextCursor: null }
    lastScanned = rows[rows.length - 1] ?? lastScanned
    after = lastScanned === null ? after : { createdAt: lastScanned.createdAt, id: lastScanned.id }

    for (const row of await input.keepVisible(rows)) {
      items.push(row)
      if (items.length === input.limit) {
        const anchor = items[items.length - 1]!
        return {
          items,
          nextCursor: encodeMemoryPageCursor({ createdAt: anchor.createdAt, id: anchor.id }),
        }
      }
    }
    // 这一批没取满 ⇒ 源已耗尽，页不满也到底了。
    if (rows.length < size) return { items, nextCursor: null }
  }

  // 批数用完而页未满：从最后扫过的位置继续，别让客户端以为到底了。
  return {
    items,
    nextCursor:
      lastScanned === null
        ? null
        : encodeMemoryPageCursor({ createdAt: lastScanned.createdAt, id: lastScanned.id }),
  }
}

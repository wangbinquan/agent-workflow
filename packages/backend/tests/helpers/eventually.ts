// RFC-359 —— 「响应回了，但那条投影还没落库」的等待原语。
//
// 为什么需要它：有一批投影是**请求应答之后**才写的（`void …record(…)` 的 fire-and-forget，
// 典型是 `/api/*` 中间件里的 token 调用审计）。这个形状在两个 provider 上都一样，但
// **可观测时机不同**：bun:sqlite 的写在同一个 tick 内就落盘，用例紧接着读得到；
// PostgreSQL 是一次真实往返，用例读在前、写在后，于是同一条断言在 SQLite 绿、在 PG 红。
//
// 那不是产品缺陷（契约是「最终会写一条」，两边都成立），也**不该**靠给产品加一次 await 来修
// ——那等于给每个 PAT 请求都加一次库往返。正确的修法是把用例的「立刻读」改成「读到为止」。
//
// 别用裸 `setTimeout`：睡够了才过的用例在慢机器上就是 flaky，而本仓明令
// 「绝不允许『重跑就过了』作为通过依据」。这里是有界轮询——拿到就返回，超时就带上
// **最后一次的实际值**抛出，让失败信息仍然说得清「等到的是什么」。

/** 轮询 `read` 直到 `accept` 成立；超时抛出并附上最后一次读到的值。 */
export async function eventually<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  options?: { readonly timeoutMs?: number; readonly intervalMs?: number; readonly what?: string },
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? 5_000
  const intervalMs = options?.intervalMs ?? 25
  const deadline = Date.now() + timeoutMs
  let last: T = await read()
  while (!accept(last)) {
    if (Date.now() >= deadline) {
      throw new Error(
        `${options?.what ?? 'condition'} still unmet after ${String(timeoutMs)}ms; ` +
          `last value: ${JSON.stringify(last)}`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
    last = await read()
  }
  return last
}

/** `eventually` 的常用特例：等某个列表读到至少 `count` 行。 */
export function eventuallyAtLeast<T>(
  read: () => Promise<readonly T[]>,
  count: number,
  what?: string,
): Promise<readonly T[]> {
  return eventually(read, (rows) => rows.length >= count, {
    what: what ?? `at least ${String(count)} row(s)`,
  })
}

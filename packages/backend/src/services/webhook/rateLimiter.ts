// RFC-257 T5 — 内存滑窗限流（单进程 daemon，无需 Redis）。时钟可注入
// （设计门 F-16：测试用 fake clock，不靠真实时间流逝）。
//
// 两个闸（design §3.2，F-16 修订）：
//   per-endpoint 300/min —— 主闸。反代部署下所有合法投递同源 IP，按 IP 限
//     合法流量会把几百仓的批量 push 风暴误伤成 429（GitLab 不重试 = 真丢事件），
//     所以合法流量只按端点限。
//   全局未命中闸 600/min —— 防扫描。url token 未命中任何端点的请求共享一个
//     桶（代替最初设计的 per-IP：Bun/Hono 下可信 client IP 提取需要显式的
//     受信代理配置面，v1 从简；反代侧的 per-IP 防护见运维指引 T13）。
export type Clock = () => number

export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>()

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly clock: Clock = Date.now,
  ) {}

  /** true = 放行（并记账）；false = 超限。 */
  allow(key: string): boolean {
    const now = this.clock()
    const cutoff = now - this.windowMs
    const arr = this.hits.get(key) ?? []
    // 滑窗修剪：数组按时间递增，找到第一个 >= cutoff 的位置截断头部。
    let start = 0
    while (start < arr.length && arr[start]! < cutoff) start++
    const trimmed = start > 0 ? arr.slice(start) : arr
    if (trimmed.length >= this.limit) {
      if (start > 0) this.hits.set(key, trimmed)
      return false
    }
    trimmed.push(now)
    this.hits.set(key, trimmed)
    return true
  }
}

export const ENDPOINT_RATE_LIMIT_PER_MIN = 300
export const UNMATCHED_RATE_LIMIT_PER_MIN = 600
export const RATE_WINDOW_MS = 60_000

export type WebhookRateLimiters = {
  perEndpoint: SlidingWindowLimiter
  unmatched: SlidingWindowLimiter
}

export function createWebhookRateLimiters(clock: Clock = Date.now): WebhookRateLimiters {
  return {
    perEndpoint: new SlidingWindowLimiter(ENDPOINT_RATE_LIMIT_PER_MIN, RATE_WINDOW_MS, clock),
    unmatched: new SlidingWindowLimiter(UNMATCHED_RATE_LIMIT_PER_MIN, RATE_WINDOW_MS, clock),
  }
}

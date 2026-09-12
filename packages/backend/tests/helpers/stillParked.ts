// RFC-359 AC-20 —— 「证明一个在飞的请求**还卡着**」的等待原语。
//
// 这类用例（并发互斥 / 临界区边界）要断言的是一个**负向**事实：某个请求此刻
// 还没走完。原来的写法一律是「睡 10~30ms 再看 settled 标志」，睡眠时长就是
// 同步手段——而本仓明令「绝不允许『重跑就过了』作为通过依据」，绝对时长在
// 慢机器 / CI 上必然翻车（本仓已实测过 60× 的时序放大）。
//
// 换法：**把一趟无关请求完整驱过同一个 app**，再读那个标志。它比固定睡眠强的
// 地方在于「相对 vs 绝对」——机器越慢，这趟屏障请求本身也越慢，观察窗口跟着
// 一起放大，不会像固定毫秒那样被慢机器吃掉。屏障请求走的是同一个 app、同一个
// 事件循环，它整趟跑完意味着被观察的那个请求早已被派发、其同步前段与微任务
// 都已排空；若它没被互斥挡住，此时就该也走完了。
//
// 诚实交代边界：这是**相对屏障**，不是形式化证明（没有「请求已抵达锁」的可观测
// 钩子可用）。所以它只承担「当时确实并发」这半边；真正的产品契约仍由各用例
// 自己的确定性断言钉死（例如 fence 计数、409 OCC 码、缓存被作废）。
//
// `drive` 必须是一条**不走那把锁**的路径（典型：同资源的 GET 列表）。

export interface StillParkedInput {
  /** 读一下被观察请求是否已经 settle。 */
  readonly settled: () => boolean
  /** 驱一趟无关的、不走那把锁的请求；整趟跑完即构成屏障。 */
  readonly drive: () => Promise<{ readonly status: number }>
  /** 失败信息里的主体名，例如 'config PUT'。 */
  readonly what: string
  /** 驱几趟（默认 2 趟，留一点余量）。 */
  readonly rounds?: number
}

/**
 * 驱动 `rounds` 趟屏障请求，然后返回被观察请求**是否仍卡着**。
 * 屏障请求自身非 2xx 时直接抛错——屏障没成立的话，下面那条负向断言是空的。
 */
export async function stillParkedAfterBarrier(input: StillParkedInput): Promise<boolean> {
  const rounds = input.rounds ?? 2
  for (let round = 0; round < rounds; round += 1) {
    const response = await input.drive()
    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `barrier request for ${input.what} returned ${String(response.status)}; ` +
          'the barrier must be a lock-free path that succeeds, otherwise the ' +
          'negative assertion below proves nothing',
      )
    }
  }
  return !input.settled()
}

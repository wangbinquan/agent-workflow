// RFC-322 —— 周期性维护循环的唯一原语。
//
// 此前 14 个 hourly 维护循环各自复制同一套模板：`let running` 重入守卫 + `.catch`
// 吞错 + `unref()` + `stop()`。复制 14 份的真正代价不是重复代码，而是**「什么时候跑」
// 无人负责**——它们全部在 boot 的同一秒内装配、零相位，于是每小时的同一秒首尾相接地
// 执行。daemon 只有一条 bun:sqlite 同步连接（`db/client.ts`：一条慢语句冻结全部
// HTTP/WS），叠加起来就是生产实测的「整点全站冻结约 30 秒、随后自行恢复」。
//
// 本原语把那四件样板收进来，并补上第五、第六件：**相位**与**每拍耗时度量**。
// 相位值登记在 `daemonCadence.ts` 的 `MAINTENANCE_PHASE`，漏登记由
// `tests/rfc322-maintenance-cadence.test.ts` 拦下。

import { MAINTENANCE_SLOW_TICK_MS } from '@/services/daemonCadence'
import { createLogger } from '@/util/log'

const log = createLogger('maintenance-ticker')

/** 定时器接口。抽出来只为可注入——错峰的判据必须能用假时钟实证，不能靠等一小时。 */
export interface TimerApi {
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
  setInterval: (fn: () => void, ms: number) => unknown
  clearInterval: (handle: unknown) => void
}

const REAL_TIMERS: TimerApi = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
}

export interface MaintenanceTickerOptions {
  /** 日志与度量用的任务名；hourly 任务应与 `MAINTENANCE_PHASE` 的键一致。 */
  job: string
  intervalMs: number
  /**
   * 周期拍的相位偏移：**首个周期拍落在 `T0 + phaseOffsetMs`**，其后每 `intervalMs`
   * 一拍；超过一个 `intervalMs` 时夹到 `intervalMs`。
   * 注意这比原来的 `setInterval(fn, 1h)`（首拍在 `T0 + 1h`）**更早**，不会更晚
   * ——体积封顶类任务本就希望早跑，所以这个方向的偏差是良性的。
   */
  phaseOffsetMs: number
  /**
   * 可选的 boot 首拍，与相位正交：给了就在 `T0 + bootDelayMs` 额外跑一次。
   * 用于保留各 ticker 现有的 boot 语义（归档器 / 终态 sweeper 30s、不变量扫描 5s）。
   */
  bootDelayMs?: number
  /**
   * 一拍的工作。重入守卫、计时、吞错由本原语负责，调用方只写业务。
   *
   * 返回值故意放宽成 `unknown`：各 ticker 的 `.catch()` 收敛出来的类型互不相同
   * （`void` / `Promise<void>` / `Promise<SweepResult | void>` …），收窄成
   * `Promise<void>` 会逼 14 个调用点各加一个 `.then(() => undefined)` 的噪音。
   * 非 promise 返回值等价于「这一拍是同步的」，由 `Promise.resolve` 统一处理。
   */
  onTick: () => unknown
  /** 超过它就 warn 一行；默认 `MAINTENANCE_SLOW_TICK_MS`。 */
  slowTickMs?: number
  /** 测试注入。 */
  timers?: TimerApi
  /** 测试注入。 */
  now?: () => number
}

export interface MaintenanceTickerHandle {
  stop: () => void
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 启动一个带相位的周期性维护循环。
 *
 * 语义保证（`tests/rfc322-maintenance-cadence.test.ts` 逐条锁定）：
 *  - 首个周期拍在 `T0 + phaseOffsetMs`，其后每 `intervalMs` 一拍；
 *  - `bootDelayMs` 给了才有 boot 拍，与周期拍**共用同一个重入守卫**；
 *  - `onTick` 的 reject **与同步抛出**都被吞掉：定时器回调里逃逸的同步异常会变成
 *    uncaughtException 打死整个 daemon（同款教训见 `backupScheduler.ts` 的
 *    checkpoint 循环——一个坏掉的 config.json 不该升级成宕机）；
 *  - 一拍未结束时下一拍被跳过，不排队、不并发；
 *  - 所有 timer 都 `unref()`；`stop()` 之后三种 timer 都不再触发。
 */
export function startMaintenanceTicker(opts: MaintenanceTickerOptions): MaintenanceTickerHandle {
  const timers = opts.timers ?? REAL_TIMERS
  const now = opts.now ?? Date.now
  const slowTickMs = opts.slowTickMs ?? MAINTENANCE_SLOW_TICK_MS

  let running = false
  let stopped = false

  const unref = (handle: unknown): unknown => {
    ;(handle as { unref?: () => void } | null)?.unref?.()
    return handle
  }

  const tick = (): void => {
    if (stopped || running) return
    running = true
    const startedAt = now()
    const settle = (): void => {
      running = false
      const durationMs = now() - startedAt
      // 稳态下这行不该出现；一旦出现就直接点名是哪个维护任务冻结了事件循环，
      // 不必再从一条无辜的 SELECT 反推。
      if (durationMs >= slowTickMs) {
        log.warn('maintenance tick slow', {
          job: opts.job,
          durationMs,
          intervalMs: opts.intervalMs,
        })
      }
    }
    let pending: unknown
    try {
      pending = opts.onTick()
    } catch (err) {
      log.warn('maintenance tick threw', { job: opts.job, error: errorMessage(err) })
      settle()
      return
    }
    void Promise.resolve(pending)
      // 各 ticker 自己 catch 并保留原有文案，所以这里通常不会触发；它是兜底，
      // 防止任何一个漏网的 reject 变成 unhandled rejection。
      .catch((err: unknown) => {
        log.warn('maintenance tick failed', { job: opts.job, error: errorMessage(err) })
      })
      .finally(settle)
  }

  const bootHandle =
    opts.bootDelayMs === undefined ? undefined : unref(timers.setTimeout(tick, opts.bootDelayMs))

  // 相位**不得超过一个周期**。相位表里的值是按 hourly 排的（4–56 分钟），而调用方可以
  // 传入更短的 intervalMs（测试常用几十毫秒，运维也可能调小某个周期）；不夹取的话首拍会
  // 落在周期之外，等于这个 ticker 直接不工作了。夹到一个周期上限之后，短周期场景的行为
  // 与收编前的 `setInterval(fn, intervalMs)` 逐字相同。
  const phaseMs = Math.max(0, Math.min(opts.phaseOffsetMs, opts.intervalMs))

  let periodicHandle: unknown
  const phaseHandle = unref(
    timers.setTimeout(() => {
      tick()
      if (stopped) return
      periodicHandle = unref(timers.setInterval(tick, opts.intervalMs))
    }, phaseMs),
  )

  return {
    stop: () => {
      stopped = true
      if (bootHandle !== undefined) timers.clearTimeout(bootHandle)
      timers.clearTimeout(phaseHandle)
      if (periodicHandle !== undefined) timers.clearInterval(periodicHandle)
    },
  }
}

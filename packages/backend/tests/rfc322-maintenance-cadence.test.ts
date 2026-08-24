// RFC-322 —— 维护节奏错峰与停顿归因。
//
// 这些用例锁的是「整点风暴」这一类回归：14 个 hourly 维护循环曾全部在 boot 的同一秒
// 装配、零相位（`cli/start.ts:885–1376`），每小时同刻首尾相接执行；daemon 只有一条
// bun:sqlite 同步连接，于是表现为「全站冻结约 30 秒、随后自行恢复」。
//
// 现场留下的 `[db-slow] 32648ms` 是一条同库实测 10ms、走索引、表仅 346 行的 SELECT
// ——墙钟单独一个量会骗人。所以这里同时锁住「要看 cpu 才能判别」这个判据：把相位表
// 改回全 0，或把 cpu 字段去掉，下面都必须转红。
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { instrumentSlowStatements } from '../src/db/client'
import {
  HOUR_MS,
  MAINTENANCE_PHASE,
  MAINTENANCE_SLOW_TICK_MS,
  MIN_PHASE_GAP_MS,
} from '../src/services/daemonCadence'
import { startMaintenanceTicker, type TimerApi } from '../src/services/maintenanceTicker'
import { resetLoggerForTest, setLoggerStdoutWriterForTest } from '../src/util/log'

// ---------------------------------------------------------------------------
// 虚拟时钟：错峰的判据必须能实证，不能靠等一小时。
// ---------------------------------------------------------------------------
interface Scheduled {
  id: number
  at: number
  every?: number
  fn: () => void
}

class FakeClock {
  now = 0
  private seq = 0
  private readonly items = new Map<number, Scheduled>()
  private readonly intervals = new Set<number>()

  readonly timers: TimerApi = {
    setTimeout: (fn, ms) => {
      const id = ++this.seq
      this.items.set(id, { id, at: this.now + ms, fn })
      return id
    },
    clearTimeout: (h) => {
      this.items.delete(h as number)
    },
    setInterval: (fn, ms) => {
      const id = ++this.seq
      this.items.set(id, { id, at: this.now + ms, every: ms, fn })
      this.intervals.add(id)
      return id
    },
    clearInterval: (h) => {
      this.items.delete(h as number)
      this.intervals.delete(h as number)
    },
  }

  /** 排空 onTick 的 `Promise.resolve(...).catch(...).finally(settle)` 微任务链。 */
  private static async drain(): Promise<void> {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  }

  async advance(ms: number): Promise<void> {
    const target = this.now + ms
    for (;;) {
      // 真实事件循环里微任务总在下一个宏任务之前排空；不先排空的话，上一拍的
      // `settle`（清 running）会晚于本拍的定时器回调，测试会看到假的「被跳过」。
      await FakeClock.drain()
      let next: Scheduled | undefined
      for (const it of this.items.values()) {
        if (it.at > target) continue
        if (next === undefined || it.at < next.at || (it.at === next.at && it.id < next.id)) {
          next = it
        }
      }
      if (next === undefined) break
      this.now = next.at
      if (this.intervals.has(next.id)) next.at = this.now + (next.every ?? 0)
      else this.items.delete(next.id)
      next.fn()
      await FakeClock.drain()
    }
    this.now = target
  }
}

const MINUTE = 60_000

describe('RFC-322 相位注册表不变量', () => {
  const entries = Object.entries(MAINTENANCE_PHASE)

  test('覆盖全部 14 个 hourly 维护任务（数量锁：少一个说明有人把任务摘出了错峰）', () => {
    expect(entries.length).toBe(14)
  })

  test('每项满足 0 < offset < intervalMs', () => {
    for (const [job, offset] of entries) {
      expect(offset, `${job} 的相位必须为正——0 会让它落回 boot 同刻`).toBeGreaterThan(0)
      expect(offset, `${job} 的相位必须小于一个周期`).toBeLessThan(HOUR_MS)
    }
  })

  test('两两互异，且排序后相邻间距 ≥ MIN_PHASE_GAP_MS', () => {
    const offsets = entries.map(([, v]) => v)
    expect(new Set(offsets).size, '存在相位重合的任务').toBe(offsets.length)
    const sorted = [...offsets].sort((a, b) => a - b)
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i]! - sorted[i - 1]!
      expect(gap, `第 ${i} 与第 ${i - 1} 个相位间距 ${gap}ms 小于下限`).toBeGreaterThanOrEqual(
        MIN_PHASE_GAP_MS,
      )
    }
  })
})

describe('RFC-322 startMaintenanceTicker 语义', () => {
  test('首个周期拍在 T0+phase，其后每 intervalMs 一拍', async () => {
    const clock = new FakeClock()
    const fired: number[] = []
    const t = startMaintenanceTicker({
      job: 'x',
      intervalMs: HOUR_MS,
      phaseOffsetMs: 12 * MINUTE,
      onTick: () => {
        fired.push(clock.now)
      },
      timers: clock.timers,
      now: () => clock.now,
    })
    await clock.advance(11 * MINUTE)
    expect(fired).toEqual([])
    await clock.advance(2 * MINUTE)
    expect(fired).toEqual([12 * MINUTE])
    await clock.advance(HOUR_MS)
    expect(fired).toEqual([12 * MINUTE, 12 * MINUTE + HOUR_MS])
    t.stop()
  })

  test('bootDelayMs 给了才有 boot 拍，且与相位拍正交', async () => {
    const clock = new FakeClock()
    const fired: number[] = []
    const t = startMaintenanceTicker({
      job: 'x',
      intervalMs: HOUR_MS,
      phaseOffsetMs: 12 * MINUTE,
      bootDelayMs: 30_000,
      onTick: () => {
        fired.push(clock.now)
      },
      timers: clock.timers,
      now: () => clock.now,
    })
    await clock.advance(13 * MINUTE)
    expect(fired).toEqual([30_000, 12 * MINUTE])
    t.stop()
  })

  test('一拍未结束时下一拍被跳过，不排队不并发', async () => {
    const clock = new FakeClock()
    let release: (() => void) | undefined
    let started = 0
    const t = startMaintenanceTicker({
      job: 'x',
      intervalMs: 10 * MINUTE,
      phaseOffsetMs: 1 * MINUTE,
      onTick: () =>
        new Promise<void>((resolve) => {
          started += 1
          release = resolve
        }),
      timers: clock.timers,
      now: () => clock.now,
    })
    await clock.advance(1 * MINUTE)
    expect(started).toBe(1)
    // 第一拍还没 settle，推进三个周期：一次都不该再进。
    await clock.advance(30 * MINUTE)
    expect(started).toBe(1)
    release?.()
    await clock.advance(10 * MINUTE)
    expect(started).toBe(2)
    t.stop()
  })

  test('onTick 的 reject 与同步抛出都不逃逸，且不阻断后续拍', async () => {
    const clock = new FakeClock()
    let n = 0
    const t = startMaintenanceTicker({
      job: 'x',
      intervalMs: 10 * MINUTE,
      phaseOffsetMs: 1 * MINUTE,
      onTick: () => {
        n += 1
        if (n === 1) throw new Error('同步炸')
        if (n === 2) return Promise.reject(new Error('异步炸'))
        return Promise.resolve()
      },
      timers: clock.timers,
      now: () => clock.now,
    })
    await clock.advance(1 * MINUTE + 30 * MINUTE)
    // 第 1 拍同步抛、第 2 拍 reject，都必须被吞掉且不影响第 3、4 拍。
    expect(n).toBeGreaterThanOrEqual(3)
    t.stop()
  })

  test('相位超过一个周期时被夹取——短 intervalMs 的 ticker 不会被相位饿死', async () => {
    const clock = new FakeClock()
    const fired: number[] = []
    // 相位表按 hourly 排（4–56 分钟），这里故意给一个 50ms 的周期。
    const t = startMaintenanceTicker({
      job: 'x',
      intervalMs: 50,
      phaseOffsetMs: MAINTENANCE_PHASE.worktreeGc,
      onTick: () => {
        fired.push(clock.now)
      },
      timers: clock.timers,
      now: () => clock.now,
    })
    await clock.advance(160)
    // 不夹取的话首拍要等 4 分钟，这里一次都不会有。夹取后与收编前的
    // `setInterval(fn, 50)` 逐字相同：50 / 100 / 150。
    expect(fired).toEqual([50, 100, 150])
    t.stop()
  })

  test('stop() 之后 boot / 相位 / 周期三种 timer 都不再触发', async () => {
    const clock = new FakeClock()
    const fired: number[] = []
    const t = startMaintenanceTicker({
      job: 'x',
      intervalMs: 10 * MINUTE,
      phaseOffsetMs: 1 * MINUTE,
      bootDelayMs: 30_000,
      onTick: () => {
        fired.push(clock.now)
      },
      timers: clock.timers,
      now: () => clock.now,
    })
    await clock.advance(1 * MINUTE)
    const before = fired.length
    expect(before).toBeGreaterThan(0)
    t.stop()
    await clock.advance(5 * HOUR_MS)
    expect(fired.length).toBe(before)
  })
})

describe('RFC-322 slow-tick 告警', () => {
  const withCapturedLog = async (fn: () => Promise<void>): Promise<string[]> => {
    const lines: string[] = []
    setLoggerStdoutWriterForTest((line: string) => lines.push(line))
    try {
      await fn()
    } finally {
      resetLoggerForTest()
    }
    return lines
  }

  test('超过 MAINTENANCE_SLOW_TICK_MS 的一拍点名告警，含 job 与耗时', async () => {
    const clock = new FakeClock()
    const lines = await withCapturedLog(async () => {
      const t = startMaintenanceTicker({
        job: 'worktreeGc',
        intervalMs: HOUR_MS,
        phaseOffsetMs: 4 * MINUTE,
        onTick: () => {
          clock.now += MAINTENANCE_SLOW_TICK_MS + 500
        },
        timers: clock.timers,
        now: () => clock.now,
      })
      await clock.advance(5 * MINUTE)
      t.stop()
    })
    const slow = lines.filter((l) => l.includes('maintenance tick slow'))
    expect(slow.length).toBe(1)
    expect(slow[0]).toContain('worktreeGc')
    expect(slow[0]).toContain(String(MAINTENANCE_SLOW_TICK_MS + 500))
  })

  test('阈值之下的一拍完全静默', async () => {
    const clock = new FakeClock()
    const lines = await withCapturedLog(async () => {
      const t = startMaintenanceTicker({
        job: 'worktreeGc',
        intervalMs: HOUR_MS,
        phaseOffsetMs: 4 * MINUTE,
        onTick: () => {
          clock.now += 5
        },
        timers: clock.timers,
        now: () => clock.now,
      })
      await clock.advance(5 * MINUTE)
      t.stop()
    })
    expect(lines.filter((l) => l.includes('maintenance tick'))).toEqual([])
  })
})

describe('RFC-322 错峰实证', () => {
  test('一个完整周期内，14 个维护任务的触发时刻两两不重合且间距 ≥ 下限', async () => {
    const clock = new FakeClock()
    const firedAt = new Map<string, number[]>()
    const handles = Object.entries(MAINTENANCE_PHASE).map(([job, phaseOffsetMs]) => {
      firedAt.set(job, [])
      return startMaintenanceTicker({
        job,
        intervalMs: HOUR_MS,
        phaseOffsetMs,
        onTick: () => {
          firedAt.get(job)!.push(clock.now)
        },
        timers: clock.timers,
        now: () => clock.now,
      })
    })

    await clock.advance(2 * HOUR_MS)

    // 每个任务在两小时里各跑两次。
    for (const [job, times] of firedAt) {
      expect(times.length, `${job} 的触发次数`).toBe(2)
    }
    // 关键断言：把所有触发时刻摊平后，同一时刻不得有两个任务。
    const all = [...firedAt.values()].flat().sort((a, b) => a - b)
    expect(new Set(all).size, '存在同刻触发的维护任务——整点风暴回归了').toBe(all.length)
    for (let i = 1; i < all.length; i++) {
      expect(all[i]! - all[i - 1]!).toBeGreaterThanOrEqual(MIN_PHASE_GAP_MS)
    }
    for (const h of handles) h.stop()
  })
})

describe('RFC-322 [db-slow] 的 CPU 判别', () => {
  /** 睡而不烧 CPU——用来构造「墙钟 ≫ CPU」的进程停顿。 */
  const sleepWithoutCpu = (ms: number): void => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  }

  /**
   * 停顿窗口取 300ms、且先做一次不记账的预热——**首版取 60ms、阈值 ms/4，在 CI 上红了**
   * （ubuntu runner 实测 `cpuMs=22` vs 阈值 15）。原因是 `process.cpuUsage()` 统计的是
   * **整个进程所有线程**的 CPU：bun 自带二十来个线程，JIT / GC / 首次 getrusage 的固定
   * 成本都会落进测量窗口，本机安静时只有 0.03ms，CI 上是几十毫秒。
   *
   * 处置是把信噪比做够，而不是把判据调松到没意义：预热把固定成本挪出窗口，300ms 让残余
   * 噪声摊薄。两种噪声模型下都留足余量——固定 ~22ms ⇒ 比值 0.07；即便按 CI 上那个
   * 最坏的 37% 占空比外推 ⇒ 111ms、比值 0.37，都仍在 0.5 的判据之内。
   */
  const STALL_MS = 300

  test('进程被冻住时 cpuMs ≪ ms —— 慢的不是这条 SQL', () => {
    const seen: { ms: number; sql: string; cpuMs: number }[] = []
    let sleepMs = 40
    const fake = {
      prepare: () => ({
        all: () => {
          sleepWithoutCpu(sleepMs)
          return []
        },
      }),
      query: () => ({ all: () => [] }),
      exec: () => undefined,
    }
    // 阈值 100ms：预热那次（40ms）不记账，只把固定成本付掉。
    instrumentSlowStatements(fake as never, 100, (ms, sql, cpuMs) => seen.push({ ms, sql, cpuMs }))
    const run = (): void => {
      ;(fake.prepare as unknown as (s: string) => { all: () => unknown[] })('SELECT 1').all()
    }
    run()
    expect(seen, '预热那次不该被记账，否则固定成本还在测量窗口里').toEqual([])

    sleepMs = STALL_MS
    run()
    expect(seen.length).toBe(1)
    const rec = seen[0]!
    expect(rec.ms).toBeGreaterThanOrEqual(STALL_MS * 0.8)
    // 判据本身：CPU 时间明显小于墙钟 ⇒ 进程在等，不是这条语句在算。
    // 真正在算的语句是 cpuMs ≈ ms（下一条用例守的就是另一侧）。
    expect(rec.cpuMs).toBeLessThan(rec.ms / 2)
    expect(
      rec.ms - rec.cpuMs,
      '墙钟与 CPU 的绝对差要够大，比值再好看也不能只差几毫秒',
    ).toBeGreaterThan(100)
  })

  test('真正吃 CPU 的语句 cpuMs 与 ms 同量级 —— 这才是查询问题', () => {
    const sqlite = new Database(':memory:')
    const seen: { ms: number; cpuMs: number }[] = []
    instrumentSlowStatements(sqlite, 5, (ms, _sql, cpuMs) => seen.push({ ms, cpuMs }))
    sqlite
      .prepare(
        'WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n < 300000) SELECT count(*) AS n FROM c',
      )
      .all()
    expect(seen.length).toBeGreaterThanOrEqual(1)
    const rec = seen[0]!
    expect(rec.cpuMs).toBeGreaterThan(0)
    expect(rec.cpuMs).toBeGreaterThanOrEqual(rec.ms / 2)
    sqlite.close()
  })
})

describe('RFC-322 登记棘轮（AC-2）', () => {
  const SRC = join(import.meta.dir, '..', 'src')

  const tsFiles = (dir: string, acc: string[] = []): string[] => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name)
      if (e.isDirectory()) tsFiles(full, acc)
      else if (e.name.endsWith('.ts')) acc.push(full)
    }
    return acc
  }

  /** 去掉注释——否则文档里写的 `setInterval(…, 3_600_000)` 会被当成真调用。 */
  const stripComments = (text: string): string => {
    let out = ''
    let quote: string | null = null
    for (let i = 0; i < text.length; i++) {
      const c = text[i]!
      if (quote !== null) {
        out += c
        if (c === '\\') {
          out += text[i + 1] ?? ''
          i++
        } else if (c === quote) quote = null
        continue
      }
      if (c === "'" || c === '"' || c === '`') {
        quote = c
        out += c
        continue
      }
      if (c === '/' && text[i + 1] === '/') {
        while (i < text.length && text[i] !== '\n') i++
        out += '\n'
        continue
      }
      if (c === '/' && text[i + 1] === '*') {
        i += 2
        while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
        i++
        out += ' '
        continue
      }
      out += c
    }
    return out
  }

  /** 从 `setInterval(` 的左括号起做括号配平扫描，取出顶层最后一个实参。 */
  const lastArgOf = (text: string, openParen: number): string => {
    let depth = 0
    let quote: string | null = null
    let lastComma = openParen
    for (let i = openParen; i < text.length; i++) {
      const c = text[i]!
      if (quote !== null) {
        if (c === '\\') i++
        else if (c === quote) quote = null
        continue
      }
      if (c === "'" || c === '"' || c === '`') {
        quote = c
        continue
      }
      if (c === '(' || c === '[' || c === '{') depth++
      else if (c === ')' || c === ']' || c === '}') {
        depth--
        if (depth === 0) return text.slice(lastComma + 1, i).trim()
      } else if (c === ',' && depth === 1) lastComma = i
    }
    return ''
  }

  const HOURLY_TOKEN =
    /\b(HOUR_MS|3_600_000|3600000)\b|DAEMON_CADENCE\.(worktreeGc|lifecycleInvariants|intentScratchGc|tokenAuditGc|developmentUploadGc|developmentRetentionSweep)\b/

  test('src 下不得再出现以 hourly 周期直接调用的裸 setInterval', () => {
    // 唯一豁免：原语自己（它调的是注入的 timers.setInterval，那正是收口后的唯一出口）。
    const exempt = ['services/maintenanceTicker.ts']
    const offenders: string[] = []
    for (const file of tsFiles(SRC)) {
      const rel = file.slice(SRC.length + 1)
      if (exempt.some((e) => rel.endsWith(e))) continue
      const text = stripComments(readFileSync(file, 'utf8'))
      let idx = text.indexOf('setInterval(')
      while (idx !== -1) {
        const arg = lastArgOf(text, idx + 'setInterval'.length)
        if (HOURLY_TOKEN.test(arg)) {
          offenders.push(`${rel}: setInterval(…, ${arg})`)
        }
        idx = text.indexOf('setInterval(', idx + 1)
      }
    }
    // 新增 hourly 循环请走 startMaintenanceTicker 并在 MAINTENANCE_PHASE 登记相位，
    // 否则它会和另外 14 个在整点同刻引爆——这正是本 RFC 要消灭的形状。
    expect(offenders).toEqual([])
  })

  test('MAINTENANCE_PHASE 的每个 job 都真的接到了 startMaintenanceTicker 上', () => {
    const all = tsFiles(SRC)
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n')
    for (const job of Object.keys(MAINTENANCE_PHASE)) {
      const hits = all.split(`job: '${job}'`).length - 1
      expect(hits, `${job} 登记了相位却没有任何 ticker 使用它（或被用了多次）`).toBe(1)
    }
  })
})

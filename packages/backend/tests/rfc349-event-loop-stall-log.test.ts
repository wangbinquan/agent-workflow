// 追一次多秒级冻结时最缺的一条信息：**它发生在哪一刻**。
//
// `/api/maintenance/status` 只给一个 30 秒滚动窗口里的 `maxGapMs`，daemon 自己一声不吭，
// 于是 2026-09-03 定位迁移期间那 2.8 秒停顿时，唯一能做的是离线逐个操作实测耗时。
// 现在超过一秒的间隔会当场记一条带时间戳的 WARN，可以直接和 daemon 其余日志对齐。
//
// 门槛取 1s 是有意的：正常运行的间隔是采样周期上下几毫秒，隔着三个数量级，跑一整天也不会
// 有一条；而任何用户能感知的冻结都远在门槛之上。
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const source = readFileSync(
  resolve(import.meta.dir, '..', 'src/platform/background/maintenanceService.ts'),
  'utf8',
)

describe('RFC-349 daemon event-loop stalls are logged when they happen', () => {
  test('a stall over the threshold logs once, with the gap', () => {
    expect(source).toContain("log.warn('event loop stalled'")
    expect(source).toContain('gapMs: Math.round(gapMs)')
  })

  test('the threshold sits far above ordinary sampler jitter', () => {
    const declared = /const EVENT_LOOP_STALL_LOG_MS = ([0-9_]+)/.exec(source)?.[1]
    expect(declared, 'EVENT_LOOP_STALL_LOG_MS 没了 ⇒ 冻结又变成无声的了').toBeDefined()
    const threshold = Number(declared!.replaceAll('_', ''))
    const samplePeriod = Number(
      /const EVENT_LOOP_SAMPLE_MS = ([0-9_]+)/.exec(source)?.[1]?.replaceAll('_', '') ?? '0',
    )
    expect(samplePeriod).toBeGreaterThan(0)
    // 至少比采样周期高一个数量级，否则正常抖动就会刷屏，日志立刻失去信噪比。
    expect(threshold).toBeGreaterThanOrEqual(samplePeriod * 10)
    // 又必须低于任何用户能感知的冻结；取证门对单请求的硬上限是 1000ms。
    expect(threshold).toBeLessThanOrEqual(1_000)
  })

  test('the rolling window still feeds the status projection', () => {
    // 新增的日志是**旁路**：滚动窗口与 maxGapMs 投影必须原样保留，否则取证判据没了来源。
    expect(source).toContain('eventLoopSamples.push({ at: wallNow, gapMs })')
    expect(source).toContain('maxGapMs: eventLoopSamples.reduce(')
  })
})

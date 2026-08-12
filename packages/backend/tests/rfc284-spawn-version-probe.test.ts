// RFC-284 T8（2026-08-12 审计 N20/N21）——spawnVersionProbe 骨架的三态行为锁
// （真子进程，非 mock）。
//
// 骨架收编了三胞胎（opencode/claude --version 探针 + opencode models 枚举），
// 本文件把统一后的语义拍死：探针形态（exit 先行、仅 exit-0 读 stdout、孙进程
// 持管道不楔死）与 models 形态（maxBytes 双流并发 capped 读——失败路径也要
// stderr 文本）的分歧是**有意的**，两形态各自锁。杀链/重构此函数前先读
// design/RFC-284-commons-dedup-and-guardrails/design.md §1.5。

import { describe, expect, test } from 'bun:test'
import { spawnVersionProbe } from '../src/util/process'

const SH = '/bin/sh'

describe('RFC-284 T8 — 探针形态（缺省）', () => {
  test('正常：exit-0 读到 stdout（带 timeout 的 detached 路径）', async () => {
    const r = await spawnVersionProbe(['/bin/echo', 'v1.2.3'], { timeoutMs: 5_000 })
    expect(r.timedOut).toBe(false)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('v1.2.3')
    expect(r.stderr).toBe('')
  })

  test('正常：无 timeout 的历史 flat spawn 路径同样工作', async () => {
    const r = await spawnVersionProbe(['/bin/echo', 'flat'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('flat')
  })

  test('非零退出：stdout 不读（历史语义——输出只在成功时消费）', async () => {
    const r = await spawnVersionProbe([SH, '-c', 'echo noise; exit 3'], { timeoutMs: 5_000 })
    expect(r.timedOut).toBe(false)
    expect(r.exitCode).toBe(3)
    expect(r.stdout).toBe('')
  })

  test('超时：timedOut=true 且组杀后快速返回', async () => {
    const t0 = Date.now()
    const r = await spawnVersionProbe([SH, '-c', 'sleep 5'], { timeoutMs: 150 })
    expect(r.timedOut).toBe(true)
    expect(Date.now() - t0).toBeLessThan(3_000)
  })

  test('立死：binary 不存在 → spawn 抛错原样上抛（调用方各自处置）', async () => {
    expect(spawnVersionProbe(['/definitely/absent/bin-rfc284'])).rejects.toThrow()
  })

  test('孙进程持 stdout 写端不楔死探针（exit 先行 + 有界读）', async () => {
    const t0 = Date.now()
    // 直接子进程立刻 exit 0，但后台孙进程持有继承的 stdout 写端 3 秒。
    const r = await spawnVersionProbe([SH, '-c', 'echo ok; (sleep 3 >/dev/null 2>&1 &); exit 0'], {
      timeoutMs: 400,
    })
    expect(r.exitCode).toBe(0)
    expect(Date.now() - t0).toBeLessThan(2_500)
  })
})

describe('RFC-284 T8 — models 形态（maxBytes）', () => {
  test('双流并发捕获；非零路径也拿得到 stderr（与探针形态的关键分歧）', async () => {
    const ok = await spawnVersionProbe([SH, '-c', 'echo out; echo err 1>&2'], {
      timeoutMs: 5_000,
      maxBytes: 1024,
    })
    expect(ok.exitCode).toBe(0)
    expect(ok.stdout).toContain('out')
    expect(ok.stderr).toContain('err')

    const bad = await spawnVersionProbe([SH, '-c', 'echo boom 1>&2; exit 2'], {
      timeoutMs: 5_000,
      maxBytes: 1024,
      awaitReapMs: 250,
    })
    expect(bad.exitCode).toBe(2)
    expect(bad.stderr).toContain('boom')
  })

  test('cap 语义：整 chunk 粒度累计（可超 cap 一个 chunk——历史语义如实保留）+ 大输出不楔死', async () => {
    // 历史 readCapped 的规则是「total<cap 才收、收就收整个 chunk」——单个大 chunk
    // 可整体越过 cap（本机管道常把 200KB 一口气交付）。这不是 bug 而是被拍死的
    // 原语义：cap 的目的（有界累计+持续排水防楔）成立即可，精确裁剪反而是行为变更。
    const r = await spawnVersionProbe([SH, '-c', 'head -c 200000 /dev/zero | tr "\\0" "a"'], {
      timeoutMs: 5_000,
      maxBytes: 4_096,
    })
    expect(r.exitCode).toBe(0)
    expect(r.stdout.length).toBeGreaterThanOrEqual(4_096)
  })
})

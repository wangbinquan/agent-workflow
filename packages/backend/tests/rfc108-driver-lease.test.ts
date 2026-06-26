// RFC-108 T12 (AR-08) — driver lease.
//
// 为什么这条测试存在：auto loop 落地后会成为第二类「驱动者」，可能和人工
// resume/retry/repair 在同一任务上并发改 live state（worktree / node_run / 活子进程）。
// 本测试锁定租约语义：① 不同 holder 互斥；② 同 holder 可重入；③ release 只能由持有者；
// ④ withDriverLease 在被他人持有时不跑 fn 返回 null、跑完释放（异常也释放）。

import { afterEach, describe, expect, test } from 'bun:test'

import {
  __clearDriverLeasesForTest,
  acquireDriverLease,
  driverLeaseHolder,
  isDriverLeaseHeld,
  releaseDriverLease,
  withDriverLease,
} from '../src/services/driverLease'

afterEach(() => __clearDriverLeasesForTest())

describe('RFC-108 T12 — driver lease', () => {
  test('different holders are mutually exclusive; same holder is re-entrant', () => {
    expect(acquireDriverLease('t1', 'auto-resume')).toBe(true)
    expect(acquireDriverLease('t1', 'auto-repair')).toBe(false) // held by another
    expect(acquireDriverLease('t1', 'auto-resume')).toBe(true) // re-entrant
    expect(driverLeaseHolder('t1')).toBe('auto-resume')
  })

  test('release frees only for the holder', () => {
    acquireDriverLease('t1', 'A')
    releaseDriverLease('t1', 'B') // not the holder → no-op
    expect(isDriverLeaseHeld('t1')).toBe(true)
    releaseDriverLease('t1', 'A')
    expect(isDriverLeaseHeld('t1')).toBe(false)
    expect(acquireDriverLease('t1', 'B')).toBe(true) // now free
  })

  test('withDriverLease runs fn under lease and releases after', async () => {
    let ran = false
    const out = await withDriverLease('t1', 'A', 'auto-resume', async () => {
      ran = true
      expect(isDriverLeaseHeld('t1')).toBe(true)
      return 42
    })
    expect(ran).toBe(true)
    expect(out).toBe(42)
    expect(isDriverLeaseHeld('t1')).toBe(false) // released
  })

  test('withDriverLease returns null WITHOUT running fn when held by another', async () => {
    acquireDriverLease('t1', 'other')
    let ran = false
    const out = await withDriverLease('t1', 'A', 'auto-repair', async () => {
      ran = true
      return 1
    })
    expect(ran).toBe(false)
    expect(out).toBeNull()
    expect(driverLeaseHolder('t1')).toBe('other') // untouched
  })

  test('withDriverLease releases even when fn throws', async () => {
    await expect(
      withDriverLease('t1', 'A', 'auto-resume', async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(isDriverLeaseHeld('t1')).toBe(false) // released despite throw
  })
})

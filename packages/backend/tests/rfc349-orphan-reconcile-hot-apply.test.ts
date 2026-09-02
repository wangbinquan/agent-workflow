// RFC-349 回归防护 —— 周期孤儿对账的节奏旋钮必须**保存即生效**，不需要重启 daemon。
//
// 为什么这条测试存在：RFC-349 把这个循环从 `services/orphanReconcile.ts` 的
// `startOrphanReconcileLoop` 搬进了 provider session 的 `createRestartableLoop`，
// 搬家时把它的 `registerConfigAppliedListener(…, cfg => job.reconfigure(…))` 丢了，
// 并且**把睡多久这件事接到了旋钮上**。于是节奏改动只在循环下一次醒来时才被看见，
// 而下一次醒来的时刻由**改动前**那个值决定：旋钮在「关」时它按
// `DAEMON_CADENCE.orphanReconcile` 睡 10 分钟，运维在设置页把它打开之后最坏要等满
// 这 10 分钟才有第一拍——与「这个旋钮要重启才生效」不可区分。期间任何一次子进程
// 猝死都会留下一条永远 running 的任务，占着并发额度、也永远不会被 resume。
// e2e `rfc319-ops-events-and-repo-sweeps` 的 OPS-X4/OPS-X10 死在这条上。
//
// 判据：①睡多久与旋钮无关（固定监督拍），要不要扫在**醒来时**才判；
// ②监督拍不粗于旋钮配得出来的最细正周期，所以改动最迟一拍生效；
// ③「关」就是一拍都不扫，不是「扫了但放过」。

import { describe, expect, test } from 'bun:test'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { DEFAULT_CONFIG, SETTINGS_NUMERIC_BOUNDS } from '@agent-workflow/shared'
import { DAEMON_CADENCE } from '@/services/daemonCadence'
import { isPeriodicReconcileDue } from '@/modules/task-execution/composition/providerBackground'

const LOOP_SOURCE = resolve(
  import.meta.dir,
  '..',
  'src',
  'modules',
  'task-execution',
  'composition',
  'providerBackground.ts',
)

describe('RFC-349 periodic orphan reconcile cadence is hot-apply', () => {
  test('the sweep is due only once the configured cadence has elapsed', () => {
    const at = 1_000_000
    // 关：任何时刻都不欠一拍。
    for (const configuredMs of [0, -1, Number.NaN]) {
      expect(
        isPeriodicReconcileDue({ configuredMs, lastReconcileAt: 0, now: at }),
        '旋钮关着却判成「该扫了」⇒ 这个开关是假的：运维以为关掉了自动回收，任务照样被判 interrupted',
      ).toBe(false)
    }
    // 开：不到一个周期不扫，满一个周期（含边界）就扫。
    expect(
      isPeriodicReconcileDue({ configuredMs: 60_000, lastReconcileAt: at, now: at + 59_999 }),
      '不到一个周期就又扫一遍 ⇒ 用户配的节奏形同虚设',
    ).toBe(false)
    expect(
      isPeriodicReconcileDue({ configuredMs: 60_000, lastReconcileAt: at, now: at + 60_000 }),
    ).toBe(true)
    expect(
      isPeriodicReconcileDue({ configuredMs: 60_000, lastReconcileAt: at, now: at + 600_000 }),
    ).toBe(true)
    // 关→开：上一拍是很久以前（甚至从未扫过），打开后**下一个监督拍**就该扫。
    expect(isPeriodicReconcileDue({ configuredMs: 60_000, lastReconcileAt: 0, now: at })).toBe(true)
  })

  test('the supervisory tick is never coarser than the finest cadence a user can configure', () => {
    expect(
      DAEMON_CADENCE.orphanReconcileSupervisory,
      '监督拍比旋钮配得出来的最细周期还粗 ⇒ 用户配的节奏被监督拍稀释，改动也要等更久才生效',
    ).toBeLessThanOrEqual(SETTINGS_NUMERIC_BOUNDS.periodicOrphanReconcileMs.positiveMin!)
    expect(DAEMON_CADENCE.orphanReconcileSupervisory).toBeGreaterThan(0)
  })

  test('the registry still answers "how often does this actually sweep?" — it is the knob default', () => {
    // 监督拍进表之后，`DAEMON_CADENCE.orphanReconcile` 不再被任何代码读到；它留在
    // 注册表里是为了回答「这个状态最坏多久被扫到」。把它和旋钮的出厂默认钉在一起，
    // 否则改了默认值而表没改，读者会拿着一个过期数字下判断（那正是这张表要消灭的）。
    expect(
      DEFAULT_CONFIG.periodicOrphanReconcileMs,
      'DAEMON_CADENCE 里记的周期与旋钮的出厂默认对不上 ⇒ 节奏注册表在骗读者',
    ).toBe(DAEMON_CADENCE.orphanReconcile)
  })

  test('the loop sleeps a fixed supervisory tick and decides on wake, not on sleep', () => {
    expect(existsSync(LOOP_SOURCE), 'orphan-reconcile 循环所在文件被挪走了？').toBe(true)
    const source = readFileSync(LOOP_SOURCE, 'utf8')
    const loop = /const orphanReconcile = createRestartableLoop\(\{[\s\S]*?\n {2}\}\)/.exec(
      source,
    )?.[0]
    expect(loop, 'orphan-reconcile 循环块没找到（结构变了？）').toBeDefined()
    // 整段 `delayMs:` 属性（箭头体可能是表达式，也可能是块），到 `async run(` 为止。
    const sleep = /delayMs:[\s\S]*?async run\(/.exec(loop ?? '')?.[0] ?? ''
    expect(
      sleep,
      '睡多久又读回了配置 ⇒ 旋钮改动要等**改动前**那个周期走完才被看见，' +
        '「关」的时候那是十分钟，等价于要重启 daemon',
    ).not.toMatch(/loadConfig|periodicOrphanReconcileMs/)
    expect(sleep).toContain('DAEMON_CADENCE.orphanReconcileSupervisory')
    // 判据在醒来时才下，并且下完要记账，否则每个监督拍都会扫一遍。
    expect(loop).toContain('isPeriodicReconcileDue({')
    expect(loop).toContain('lastReconcileAt = now')
  })
})

// 记忆蒸馏旋钮的守卫：两条部署路径都必须**每 tick 重读配置**并把超时透下去。
//
// 背景（2026-09-21）：`config.memoryDistillTimeoutMs` 是本次新增的用户可调旋钮
// （默认 1 小时，行为覆盖见 memory-distill-timeout-config.test.ts）。start.ts 里有
// **两个** id='memory-distill' 的轮询工厂——PostgreSQL 一条、SQLite 一条——历史上两条
// 语义不一样：PostgreSQL 侧每 tick `loadConfig(Paths.config)`，SQLite 侧（零配置默认
// 部署）读的是引导期快照 `distillBootConfig`，于是同一个设置在一种部署上改完立刻生效、
// 在另一种上要重启 daemon。用户 2026-09-21 定：拉齐成热生效。
//
// 这条守卫锁的就是「别再退回去」：
//   - 快照变量不得复活；
//   - 每条路径都要在 run() 里重读配置；
//   - 每条路径都要把 memoryDistillTimeoutMs 透给 worker。
// 工厂个数一起钉住：新增第三条部署路径时这里会红，逼着新路径也把旋钮接上——
// 「起点面全不全」正是 docs/dev-gotchas.md 对守卫的自检第一问。
//
// 注释先剥再判（docs/dev-gotchas.md：源码文本判据必须先去注释）——上面那段说明
// 「distillBootConfig 曾经存在」的注释就写在 start.ts 里，不剥的话这条守卫会绿在
// 「解释它为什么不在了的那句话」上。

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'

const START = readFileSync(resolve(__dirname, '..', 'src', 'cli', 'start.ts'), 'utf8')
const CODE = START.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

function count(needle: string): number {
  return CODE.split(needle).length - 1
}

/**
 * The body of each `id: 'memory-distill'` polling factory.
 *
 * Scoped rather than file-wide on purpose: `const current = loadConfig(…)` is a
 * common idiom in start.ts (7 occurrences), so a global count would answer a
 * different question than "does THIS factory re-read per tick".
 */
function distillFactoryBodies(): string[] {
  const bodies: string[] = []
  let from = 0
  for (;;) {
    const at = CODE.indexOf(`id: 'memory-distill'`, from)
    if (at === -1) break
    const next = CODE.indexOf('createPollingDaemonRuntimeHandleFactory(', at)
    bodies.push(CODE.slice(at, next === -1 ? CODE.length : next))
    from = at + 1
  }
  return bodies
}

describe('memory distill worker wiring (start.ts)', () => {
  test('both deployment paths exist and are the only ones', () => {
    expect(count(`id: 'memory-distill'`)).toBe(2)
  })

  test('neither path snapshots config at boot', () => {
    expect(CODE).not.toContain('distillBootConfig')
  })

  test('both paths re-read config and forward the timeout knob every tick', () => {
    const bodies = distillFactoryBodies()
    expect(bodies).toHaveLength(2)
    for (const [index, body] of bodies.entries()) {
      expect(body, `distill factory #${index} must re-read config inside run()`).toContain(
        'const current = loadConfig(Paths.config)',
      )
      expect(body, `distill factory #${index} must forward the timeout knob`).toContain(
        'timeoutMs: current.memoryDistillTimeoutMs',
      )
    }
  })

  test('the other distill knobs travel on the same re-read, not a snapshot', () => {
    for (const key of [
      'current.memoryDistillerEnabled',
      'current.memoryDistillRuntime',
      'current.memoryDistillModel',
      'current.memoryDistillSourceContext',
    ]) {
      expect(count(key), `${key} must be read per tick on both paths`).toBe(2)
    }
  })
})

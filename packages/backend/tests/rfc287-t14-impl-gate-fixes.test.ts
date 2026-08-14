// RFC-287 T14 —— 实现门（双路 Codex 半场切）抓出的回归，逐条上锁。
//
// 这批的共同点是：它们都不是「功能没写」，而是**迁移时行为悄悄变了**——五条装配线
// 收敛的价值全在「逐字保持」，一旦保持不住，这个 RFC 就是负资产。所以每条都锁在
// 「迁移前是什么样」这个基准上，而不是锁在「现在恰好是什么样」。
//
// 骨架层的强断言（preAttempt 必须先于一切副作用）在
// `rfc287-t2-assembly-skeleton.test.ts` —— 那条是真跑装配、按副作用判的行为锁，
// 已用变异实证（把抢占挪到 onNextAttempt 之后即红）。本文件补的是「脚本线确实把
// 那个钩子接上了」以及两处对外契约的文本锁。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const schedulerSrc = readFileSync(
  resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'),
  'utf8',
)

/** 截出脚本线 runScriptNode 的函数体——避免锚点误命中别的线（同名回调满天飞）。 */
function scriptLineBody(): string {
  const start = schedulerSrc.indexOf('async function runScriptNode')
  expect(start).toBeGreaterThan(0)
  // 下一个顶层 `\nasync function ` / `\nfunction ` 即边界。
  const rest = schedulerSrc.slice(start + 1)
  const endRel = rest.search(/\n(?:async )?function /)
  return endRel === -1 ? rest : rest.slice(0, endRel)
}

describe('RFC-287 T14 — 脚本线取消不再铸孤儿行', () => {
  // 迁移前：每轮循环最顶上先 `if (opts.signal?.aborted) return canceled`，**先于**
  // 换树与铸行。迁进骨架后只剩 spawn 入口那一处，于是取消若落在换树窗口里，会先丢
  // 旧树、建新树、铸一条 pending 行并把它标成 isolating，spawn 才看见 abort 直接返回
  // 合成 canceled——那条行永远不会被运行也永远不会被终结。后续 retryNode 对它做
  // begin-isolation 会抛非法 merge-state 转移，把一次正常取消升级成 scheduler error。
  test('脚本线的 retryPolicy 声明了 preAttempt（否则抢占窗口根本不存在）', () => {
    const body = scriptLineBody()
    expect(body).toMatch(/retryPolicy:\s*\{[\s\S]{0,600}preAttempt:/)
  })

  // 二轮实现门 A-1：光有 preAttempt **不够**。它只覆盖轮顶那一瞬，覆盖不了取消
  // 发生在 `discardIso` / `iso.create` / `onNextAttempt` 的某个 await 里的情形——
  // 那时新行已经铸出来并标成 isolating，而 spawn 入口若无条件短路就会跳过
  // `runOneScriptAttempt`（迁移前是**无条件**进它、由它把新行终结为 canceled），
  // 于是孤儿行照样留下。所以那道短路必须限定 `attempt === 0`：只有第 0 轮才没有
  // 新铸的行需要终结。
  test('spawn 入口的取消短路必须限定 attempt===0（否则重试轮仍留孤儿行）', () => {
    const body = scriptLineBody()
    // 锚到条件本身，而不是「spawn 起点到 runOneScriptAttempt 之间」——后者会被
    // 中间的长注释与贪婪匹配一起搅乱（实测取到的片段不含条件行）。
    const spawnAt = body.indexOf('spawn: async (_c, attempt) => {')
    expect(spawnAt, '脚本线应有 spawn(ctx, attempt)').toBeGreaterThan(-1)
    const runAt = body.indexOf('await runOneScriptAttempt(', spawnAt)
    expect(runAt).toBeGreaterThan(spawnAt)
    const prelude = body.slice(spawnAt, runAt)
    expect(prelude).toContain('opts.signal?.aborted')
    // 关键：短路条件里必须带 attempt 限定。不带的话，重试轮的取消会跳过行终结。
    expect(prelude, 'spawn 的取消短路不得对 attempt>=1 生效').toMatch(
      /attempt === 0\s*&&\s*opts\.signal\?\.aborted/,
    )
  })

  test('preAttempt 判的是取消信号，且产出 canceled 结局', () => {
    const body = scriptLineBody()
    const m = body.match(/preAttempt:\s*\(\)\s*=>\s*\{([\s\S]{0,400}?)\n {8}\}/)
    expect(m).not.toBeNull()
    const hook = m![1]!
    expect(hook).toContain('opts.signal?.aborted')
    expect(hook).toContain("kind: 'canceled'")
  })
})

describe('RFC-287 T14 — 两处对外契约的文本回归', () => {
  // 迁移前脚本线 iso 建树失败返回 summary='isolated worktree setup failed' /
  // message='iso-setup-failed'。迁移中被改成带节点前缀的 summary 与
  // 'script-iso-setup-failed'——同一个失败输入产生了不同的对外 failure code，既有
  // 按 'iso-setup-failed' 归类的消费方会静默失配。failure code 是产品对外面，
  // refactor RFC 不得顺手改名。
  test("脚本线 iso 建树失败仍报 'iso-setup-failed'（不带 script- 前缀）", () => {
    const body = scriptLineBody()
    expect(body).toMatch(/onIsoSetupFailure[\s\S]{0,400}message: 'iso-setup-failed'/)
    expect(body).not.toContain('script-iso-setup-failed')
  })

  // 骨架在 finally 里 `spec.discardIso(handle).catch(err => log.warn('iso discard
  // failed', ...))`。脚本线若在适配器内先 `.catch(() => {})` 吞一道，这条约定好的
  // 告警就永不可达，残留 worktree / ref 的清理失败彻底没痕迹。
  test('脚本线 discardIso 不得自己吞异常（否则骨架的 warn 永不可达）', () => {
    const body = scriptLineBody()
    const m = body.match(/discardIso:\s*async[\s\S]{0,240}?\n {6}\}/)
    expect(m).not.toBeNull()
    expect(m![0]).not.toMatch(/\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/)
  })

  test('骨架确实在 finally 里 catch 并 warn（上一条依赖它成立）', () => {
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'schedulerAssembly.ts'),
      'utf8',
    )
    expect(src).toMatch(/spec\.discardIso\(handle\)\.catch\([\s\S]{0,160}iso discard failed/)
  })
})

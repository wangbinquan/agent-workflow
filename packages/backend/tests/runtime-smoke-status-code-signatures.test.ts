// runtimeSmoke 的失败分类器 —— 裸状态码 `503` / `529` 必须带 HTTP 语境。
//
// 为什么这条测试存在（2026-08-14，CI 间歇红根因）：
// `MODEL_FAIL_SIGNATURES` 里原先是**无边界**的三位数 `503|529`，而分类用的 haystack
// 含 stdout；冒烟自己发的 nonce 是 `awsmoke-<16 位 hex>`，`MOCK_CLAUDE_ECHO_PROMPT`
// 会把带 nonce 的 prompt 回显进 stdout。于是 hex 串里凑巧出现 "503"/"529" 就把结论
// 从 `stream-nonconforming` 翻成 `model-call-failed`——实测 20 万次随机 nonce 有
// 1327 次误命中（约 0.66%/次）。CI 上表现为
// `smokeRuntime > claude duplicate reset boundaries` 间歇失败，本地几乎复现不了。
//
// **影响不止测试**：生产里任何 stdout/stderr 含这三连数字的失败（commit hash 片段、
// 时间戳、字节数、端口号、耗时 ms）都会被误分类成「限流 / 配额 / 模型不可用」，
// 管理员照着那条提示去查配额，方向完全错。
//
// 所以这里锁两面：真状态码仍须命中，任意位置的三连数字不得命中。

import { describe, expect, test } from 'bun:test'
import { MODEL_FAIL_SIGNATURES } from '@/services/runtimeSmoke'

describe('runtimeSmoke 分类器 — 裸状态码必须带 HTTP 语境', () => {
  // 直接用生产那一条。早先版本试图从源码文本里抠正则，被转义层数骗了一次
  // （源码里的 `\\b` 抠出来是字面两个反斜杠，构造出的正则永不匹配）——
  // 解析源码当断言面本来就脆，导出可断言面才是本仓的定式。
  const sig = MODEL_FAIL_SIGNATURES

  test('真状态码仍然命中（别为了消误判把真阳性也挡了）', () => {
    for (const s of [
      'error: 503 Service Unavailable',
      'API Error: 529 overloaded',
      'HTTP 503',
      'http/1.1 503 bad',
      'status: 529',
      'code: 503',
      '503 service unavailable',
    ]) {
      expect(sig.test(s.toLowerCase()), s).toBe(true)
    }
  })

  test('其余模型失败特征词一条不少', () => {
    for (const s of [
      'rate limit exceeded',
      'quota exceeded',
      'model gpt-x not found',
      'too many requests',
      'Overloaded',
      'insufficient credits',
      'does not have access to model foo',
      '您暂无该模型的使用权限',
      '该模型的使用权限未开通',
    ]) {
      expect(sig.test(s.toLowerCase()), s).toBe(true)
    }
  })

  test('任意位置的三连数字**不得**命中（这就是那条间歇红的根因）', () => {
    for (const s of [
      'awsmoke-a503bc12', // 冒烟自己的 nonce —— 真实肇事者
      'awsmoke-ff529e01',
      'commit 529ab3f',
      'wrote 5031 bytes',
      'listening on port 5290',
      'took 503ms',
    ]) {
      expect(sig.test(s.toLowerCase()), s).toBe(false)
    }
  })

  // 概率性的东西不能靠"跑一次没事"就算过：直接按分布验。旧正则在这条上必红。
  test('十万次真实形态 nonce 零误命中（旧的无边界正则约 0.66%）', () => {
    let hit = 0
    for (let i = 0; i < 100_000; i++) {
      // 与 runtimeSmoke.ts 的 `awsmoke-${randomBytes(8).toString('hex')}` 同形。
      const hex = Array.from({ length: 16 }, () =>
        '0123456789abcdef'.charAt(Math.floor(Math.random() * 16)),
      ).join('')
      if (sig.test(`awsmoke-${hex}`)) hit++
    }
    expect(hit).toBe(0)
  })
})

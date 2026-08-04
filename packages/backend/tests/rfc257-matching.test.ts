// RFC-257 T4 — 分流引擎纯函数锁（AC-6 五维矩阵 / AC-9 streamKey 含 repo 维度 /
// AC-10 熔断三重置源）。两条设计门 P0 的回归锁在此：
//   F-1: bot 作者的 pipeline_failed 必须能命中（不受忽略名单过滤）且熔断计数
//        正常累加——去掉「pipeline 豁免」或把重置条件改回命中条件，本文件红。
//   F-2: 不同 repo 的同号 MR 必须不同流——streamKeyOf 去掉 repo 维度即红。
import { describe, expect, test } from 'bun:test'

import type { CodeHostEvent } from '@agent-workflow/shared'
import {
  branchGlobMatch,
  CIRCUIT_RESET_WINDOW_MS,
  evaluateCircuit,
  matchTrigger,
  streamKeyOf,
  type TriggerRule,
} from '@/services/webhook/matching'

function ev(overrides: Partial<CodeHostEvent> = {}): CodeHostEvent {
  return {
    provider: 'gitlab',
    eventUuid: 'u1',
    eventType: 'pipeline_failed',
    repoPath: 'platform/backend/api',
    repoHttpUrl: 'https://gitlab.example.com/platform/backend/api.git',
    repoSshUrl: 'git@gitlab.example.com:platform/backend/api.git',
    branch: 'feature/x',
    mrIid: '42',
    author: { username: 'aw-bot' },
    pipelineStatus: 'failed',
    raw: {},
    ...overrides,
  }
}

function rule(overrides: Partial<TriggerRule> = {}): TriggerRule {
  return {
    repoScope: { kind: 'prefix', prefix: 'platform/' },
    eventTypes: ['pipeline_failed'],
    ignoreUsernames: ['aw-bot'],
    ...overrides,
  }
}

describe('RFC-257 T4 · matchTrigger 五维矩阵', () => {
  test('repo 范围三态', () => {
    expect(matchTrigger(ev(), rule({ repoScope: { kind: 'all' } })).hit).toBe(true)
    expect(
      matchTrigger(ev(), rule({ repoScope: { kind: 'prefix', prefix: 'platform/' } })).hit,
    ).toBe(true)
    const missPrefix = matchTrigger(ev(), rule({ repoScope: { kind: 'prefix', prefix: 'infra/' } }))
    expect(missPrefix).toEqual({ hit: false, miss: 'repo-scope' })
    expect(
      matchTrigger(ev(), rule({ repoScope: { kind: 'exact', paths: ['platform/backend/api'] } }))
        .hit,
    ).toBe(true)
    expect(
      matchTrigger(ev(), rule({ repoScope: { kind: 'exact', paths: ['other/repo'] } })),
    ).toEqual({ hit: false, miss: 'repo-scope' })
  })

  test('事件类型过滤', () => {
    expect(matchTrigger(ev({ eventType: 'push', mrIid: undefined }), rule())).toEqual({
      hit: false,
      miss: 'event-type',
    })
  })

  test('分支过滤：MR 类按目标分支，其余按事件分支；glob', () => {
    const mrEvent = ev({ eventType: 'mr_opened', branch: 'feature/x', targetBranch: 'main' })
    const mrRule = rule({ eventTypes: ['mr_opened'], branchFilter: 'main', ignoreUsernames: [] })
    expect(matchTrigger(mrEvent, mrRule).hit).toBe(true)
    // 源分支 feature/x 不参与 MR 类过滤——把过滤面写成源分支则此断言红
    expect(matchTrigger(mrEvent, { ...mrRule, branchFilter: 'feature/*' })).toEqual({
      hit: false,
      miss: 'branch-filter',
    })
    const pushEvent = ev({ eventType: 'push', mrIid: undefined, branch: 'release/1.2' })
    const pushRule = rule({ eventTypes: ['push'], branchFilter: 'release/*', ignoreUsernames: [] })
    expect(matchTrigger(pushEvent, pushRule).hit).toBe(true)
  })

  test('评论指令前缀：仅 note 生效，trim 后前缀匹配', () => {
    const note = ev({ eventType: 'note', commentText: '  /fix 空指针', author: { username: 'r' } })
    const noteRule = rule({ eventTypes: ['note'], commandPrefix: '/fix', ignoreUsernames: [] })
    expect(matchTrigger(note, noteRule).hit).toBe(true)
    expect(matchTrigger(ev({ eventType: 'note', commentText: '普通评论' }), noteRule)).toEqual({
      hit: false,
      miss: 'command-prefix',
    })
    // 非 note 事件不受 commandPrefix 影响
    expect(matchTrigger(ev(), rule({ commandPrefix: '/fix', ignoreUsernames: [] })).hit).toBe(true)
  })

  test('忽略名单作用域（设计门 F-1）：push/MR/note 被过滤，pipeline 不被过滤', () => {
    // bot 的 push → 不命中（防自触发风暴）
    expect(
      matchTrigger(
        ev({ eventType: 'push', mrIid: undefined, author: { username: 'aw-bot' } }),
        rule({ eventTypes: ['push'] }),
      ),
    ).toEqual({ hit: false, miss: 'author-ignored' })
    expect(
      matchTrigger(
        ev({ eventType: 'mr_updated', author: { username: 'aw-bot' } }),
        rule({ eventTypes: ['mr_updated'] }),
      ),
    ).toEqual({ hit: false, miss: 'author-ignored' })
    // bot 的 pipeline_failed → 命中（修到绿循环的生存条件——此断言红 = 循环第 2 轮断）
    expect(matchTrigger(ev({ author: { username: 'aw-bot' } }), rule()).hit).toBe(true)
    // 人类的 push → 命中
    expect(
      matchTrigger(
        ev({ eventType: 'push', mrIid: undefined, author: { username: 'dev-a' } }),
        rule({ eventTypes: ['push'] }),
      ).hit,
    ).toBe(true)
  })
})

describe('RFC-257 T4 · streamKeyOf（设计门 F-2：必含 repo 维度）', () => {
  test('跨仓同号 MR 不同流；同仓同 MR 同流', () => {
    const a = ev({ repoPath: 'platform/a', mrIid: '42' })
    const b = ev({ repoPath: 'platform/b', mrIid: '42' })
    expect(streamKeyOf(a)).not.toBe(streamKeyOf(b))
    expect(streamKeyOf(a)).toBe('platform/a|mr:42')
    expect(streamKeyOf(ev({ repoPath: 'platform/a', mrIid: '42', eventType: 'note' }))).toBe(
      'platform/a|mr:42',
    )
  })

  test('无 MR 上下文按分支；跨仓同名分支不同流', () => {
    const p1 = ev({ eventType: 'push', mrIid: undefined, branch: 'main', repoPath: 'r/a' })
    const p2 = ev({ eventType: 'push', mrIid: undefined, branch: 'main', repoPath: 'r/b' })
    expect(streamKeyOf(p1)).toBe('r/a|branch:main')
    expect(streamKeyOf(p1)).not.toBe(streamKeyOf(p2))
  })
})

describe('RFC-257 T4 · evaluateCircuit（D22 三重置源；F-1 修订后语义）', () => {
  const circuitRule = { maxConsecutiveFires: 3, ignoreUsernames: ['aw-bot'] }
  const botEvent = ev({ author: { username: 'aw-bot' } })
  const humanEvent = ev({ author: { username: 'dev-a' } })
  const NOW = 1_000_000_000

  test('修到绿主循环：bot 作者连续累加，达到上限熔断', () => {
    // 无状态首发 → pass
    expect(evaluateCircuit(null, botEvent, circuitRule, NOW).decision).toBe('pass')
    // 计数 1、2 → pass 且不清零
    for (const n of [1, 2]) {
      const d = evaluateCircuit(
        { consecutiveFires: n, lastFireAt: NOW - 1000 },
        botEvent,
        circuitRule,
        NOW,
      )
      expect(d).toEqual({ decision: 'pass', resetCount: false, effectiveCount: n })
    }
    // 计数 3 = 上限 → open（第 4 次 skipped-circuit-open）
    const open = evaluateCircuit(
      { consecutiveFires: 3, lastFireAt: NOW - 1000 },
      botEvent,
      circuitRule,
      NOW,
    )
    expect(open.decision).toBe('open')
  })

  test('人类作者事件清零重计（「人已介入」）——熔断后人 push 恢复循环配额', () => {
    const d = evaluateCircuit(
      { consecutiveFires: 3, lastFireAt: NOW - 1000 },
      humanEvent,
      circuitRule,
      NOW,
    )
    expect(d).toEqual({ decision: 'pass', resetCount: true, effectiveCount: 0 })
    // author 缺失视为人类
    const anon = evaluateCircuit(
      { consecutiveFires: 3, lastFireAt: NOW - 1000 },
      ev({ author: {} }),
      circuitRule,
      NOW,
    )
    expect(anon.decision).toBe('pass')
  })

  test('惰性过期：超过重置窗口视为 0', () => {
    const d = evaluateCircuit(
      { consecutiveFires: 3, lastFireAt: NOW - CIRCUIT_RESET_WINDOW_MS - 1 },
      botEvent,
      circuitRule,
      NOW,
    )
    expect(d.decision).toBe('pass')
    expect(d.effectiveCount).toBe(0)
  })

  test('F-1 回归锁：忽略名单成员的事件绝不清零计数（否则计数封顶 1、熔断不可达）', () => {
    const d = evaluateCircuit(
      { consecutiveFires: 2, lastFireAt: NOW - 1000 },
      botEvent,
      circuitRule,
      NOW,
    )
    expect(d.resetCount).toBe(false)
    expect(d.effectiveCount).toBe(2)
  })
})

describe('RFC-257 T4 · branchGlobMatch', () => {
  test('字面 / 通配 / 锚定 / 特殊字符转义', () => {
    expect(branchGlobMatch('main', 'main')).toBe(true)
    expect(branchGlobMatch('main', 'main-2')).toBe(false)
    expect(branchGlobMatch('release/*', 'release/1.2')).toBe(true)
    expect(branchGlobMatch('release/*', 'release/a/b')).toBe(true)
    expect(branchGlobMatch('release/*', 'hotfix/1')).toBe(false)
    expect(branchGlobMatch('v1.*', 'v1.2')).toBe(true)
    expect(branchGlobMatch('v1.*', 'v192')).toBe(false) // `.` 是字面点
  })
})

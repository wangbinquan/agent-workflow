// RFC-319 T21/T29 —— `routeMatch.ts` 的负 fixture。
//
// 这个模块是两条覆盖账本共同的判据核心：一旦它把「没打到」判成「打到了」，
// 两份账本会朝**漂绿**的方向错——那是最坏的方向，因为账本会安静地缩小，
// 看起来像是覆盖在变好。所以它的每一条语义都要有一个会红的样本钉住。
//
// 这里的每个 case 都对应一次真实的失败形态，而不是为了凑覆盖率：
//   - method 不比对 ⇒ RFC-310 PR-10 删 `PUT` 留 `GET` 时守卫放行三条死 e2e。
//   - 字面量不优先 ⇒ `/api/workflows/new` 被记成 `/api/workflows/:id` 的命中，
//     于是那条字面量路由永远显示「已覆盖」，删掉它也没人会红。
//   - 通配标记用空串 ⇒ `/api//agents` 意外匹配 `/api/:id/agents`。

import { describe, expect, test } from 'bun:test'

import {
  CALL_WILDCARD,
  callIsRegistered,
  compilePatterns,
  resolveConcretePath,
  routeKey,
} from './routeMatch'

const PATTERNS = compilePatterns([
  { method: 'GET', path: '/api/agents' },
  { method: 'POST', path: '/api/agents' },
  { method: 'GET', path: '/api/agents/:id' },
  { method: 'PUT', path: '/api/agents/:id' },
  { method: 'GET', path: '/api/workflows/:id' },
  { method: 'GET', path: '/api/workflows/new' },
  { method: 'GET', path: '/api/:resource/:id/acl' },
  { method: 'GET', path: '/api/worktree-files/:taskId/*' },
])

describe('RFC-319 · 具体路径归一（账本的分子）', () => {
  test('参数段匹配，且返回的是注册形态而不是具体路径', () => {
    const hit = resolveConcretePath(PATTERNS, 'GET', '/api/agents/01JD0000000000000000000000')
    expect(hit).not.toBeNull()
    expect(routeKey(hit!)).toBe('GET /api/agents/:id')
  })

  test('**字面量优先**：/api/workflows/new 不得被记成 /api/workflows/:id 的命中', () => {
    const hit = resolveConcretePath(PATTERNS, 'GET', '/api/workflows/new')
    expect(
      routeKey(hit!),
      '字面量路由被参数路由吞掉时，它会永远显示「已覆盖」——删掉它都不会有人红',
    ).toBe('GET /api/workflows/new')
  })

  test('method 参与比对：DELETE 打在只注册了 GET/PUT 的路径上 ⇒ 对不上', () => {
    expect(resolveConcretePath(PATTERNS, 'DELETE', '/api/agents/01JD')).toBeNull()
  })

  test('段数不同不匹配；query 被剥掉', () => {
    expect(resolveConcretePath(PATTERNS, 'GET', '/api/agents/01JD/extra')).toBeNull()
    expect(routeKey(resolveConcretePath(PATTERNS, 'GET', '/api/agents?tab=all')!)).toBe(
      'GET /api/agents',
    )
  })

  test('注册侧尾通配一次吞掉任意深度的文件路径', () => {
    expect(
      routeKey(
        resolveConcretePath(
          PATTERNS,
          'GET',
          '/api/worktree-files/01JD0000000000000000000000/docs/images/a.png',
        )!,
      ),
    ).toBe('GET /api/worktree-files/:taskId/*')
  })

  test('对不上时返回 null 而不是静默丢弃（反方向的 zombie 信号靠它）', () => {
    expect(resolveConcretePath(PATTERNS, 'GET', '/api/definitely-not-registered')).toBeNull()
  })
})

describe('RFC-319 · 通配调用匹配（api-contract-coverage 复用的那半）', () => {
  test('调用侧通配段匹配任意一段', () => {
    expect(callIsRegistered(PATTERNS, 'GET', ['', 'api', 'agents', CALL_WILDCARD])).toBe(true)
  })

  test('method 不同 ⇒ 不算注册（RFC-310 PR-10 的事故形态）', () => {
    expect(callIsRegistered(PATTERNS, 'DELETE', ['', 'api', 'agents', CALL_WILDCARD])).toBe(false)
  })

  test('通配标记不是空串：/api//agents 不得匹配 /api/:resource/:id/acl 之外的东西', () => {
    // 双斜杠产生一个真实的空段。若 CALL_WILDCARD 用空串，这个空段会通配掉
    // 任意一个 pattern 段，于是下面这条会意外为 true。
    expect(CALL_WILDCARD).not.toBe('')
    expect(callIsRegistered(PATTERNS, 'GET', ['', 'api', '', 'agents'])).toBe(false)
  })
})

// RFC-108 PR-B (AR-01) — per-node hard-timeout floor launch-path wiring lock.
//
// 为什么这条测试存在：`defaultPerNodeTimeoutMs`（config 默认 30min）在 RFC-108 之前
// 「定义了但消费方为零」——`resolveLaunchRuntimeConfig` 只返回 commitPush +
// maxConcurrentNodes，于是 default 配置下节点跑在「无硬超时」，hung-but-alive 的
// opencode 子进程实质永生。本测试锁定：
//   ① resolveLaunchRuntimeConfig 现在把 per-node timeout floor 从 settings 解析出来；
//   ② 该 resolver 已上移到共享模块 @/services/launchRuntimeConfig，被**所有**
//      scheduler-kicking 路由复用——tasks（start/resume/retry/repair）、fusions、
//      parked clarify/review resume（Codex 实现 gate P2：floor 须到达全部
//      StartTaskDeps 构造点，不止 task 路由）。
//
// 注：per-task 预算（defaultPerTaskMaxDurationMs/Tokens）的自动接线在实现期被移出
// PR-B——存量 config 文件已持久化旧的 1h 默认值（loadConfig 无版本迁移），一旦消费
// 会把它当硬上限、limits ticker 取消任务，而 canceled 非 resumable（Codex 实现 gate
// P1）。per-node floor 已兜住 hung 子进程的成本/挂死，per-task 预算自动默认推后。

import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { DEFAULT_CONFIG } from '@agent-workflow/shared'

import { resolveLaunchRuntimeConfig } from '../src/services/launchRuntimeConfig'

describe('RFC-108 T4 resolveLaunchRuntimeConfig — 接线 per-node timeout floor', () => {
  let tmp: string
  let path: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'aw-rfc108-cfg-'))
    path = join(tmp, 'config.json')
  })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  test('显式 defaultPerNodeTimeoutMs 从 settings 解析出来', () => {
    writeFileSync(path, JSON.stringify({ $schema_version: 1, defaultPerNodeTimeoutMs: 120_000 }))
    expect(resolveLaunchRuntimeConfig(path).defaultPerNodeTimeoutMs).toBe(120_000)
  })

  test('default 配置也接线 30min floor（不再恒 undefined）', () => {
    writeFileSync(path, JSON.stringify({ $schema_version: 1 }))
    const out = resolveLaunchRuntimeConfig(path)
    expect(out.defaultPerNodeTimeoutMs).toBe(DEFAULT_CONFIG.defaultPerNodeTimeoutMs)
    expect(out.defaultPerNodeTimeoutMs).toBe(30 * 60 * 1000)
  })

  test('不再泄漏 per-task 预算字段（自动接线移出 PR-B，防 stale-config 误杀）', () => {
    writeFileSync(path, JSON.stringify({ $schema_version: 1 }))
    const out = resolveLaunchRuntimeConfig(path) as Record<string, unknown>
    expect('defaultPerTaskMaxDurationMs' in out).toBe(false)
    expect('defaultPerTaskMaxTotalTokens' in out).toBe(false)
  })
})

describe('RFC-108 T4 源码层接线断言（floor 覆盖全部 StartTaskDeps 站点）', () => {
  const src = (rel: string): string => readFileSync(join(import.meta.dir, '../src', rel), 'utf8')

  test('共享 resolver 读 defaultPerNodeTimeoutMs', () => {
    expect(src('services/launchRuntimeConfig.ts')).toContain('cfg.defaultPerNodeTimeoutMs')
  })

  test('parked clarify / review resume + fusion 都透传 resolveLaunchRuntimeConfig', () => {
    // RFC-132 PR-B (universal deferred model): clarify.ts now has ONE unified resume branch
    // (autoDispatchClarifyRound; the legacy self/cross immediate-mint branches were removed). It
    // still MUST thread the floor.
    const clarifyCalls = (
      src('routes/clarify.ts').match(/resolveLaunchRuntimeConfig\(deps\.configPath\)/g) ?? []
    ).length
    expect(clarifyCalls).toBeGreaterThanOrEqual(1)
    expect(src('routes/reviews.ts')).toContain('resolveLaunchRuntimeConfig(deps.configPath)')
    expect(src('routes/fusions.ts')).toContain('resolveLaunchRuntimeConfig(deps.configPath)')
  })

  test('fusion 引擎把 floor 透传进内部 startTask', () => {
    expect(src('services/fusion.ts')).toContain('defaultPerNodeTimeoutMs')
  })

  test('startTask 不再用 per-task 预算 fallback（自动接线已移出）', () => {
    const taskSrc = src('services/task.ts')
    expect(taskSrc).toContain('maxDurationMs: input.maxDurationMs ?? null')
    expect(taskSrc).not.toContain('deps.defaultPerTaskMaxDurationMs')
  })
})

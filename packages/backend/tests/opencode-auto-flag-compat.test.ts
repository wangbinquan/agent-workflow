// 2026-07-21 机器级故障回归锁 —— opencode 1.18 改名 auto-approve flag。
//
// 事故形态：本机 opencode 于 7/18 升到 1.18.3（`run --dangerously-skip-permissions`
// 被移除、改名 `--auto`，describe 文案逐字相同=纯改名），而 spawn.ts 仍无条件传
// 旧拼写 → 顶层 .strict() 判未知参数 → 自定义 .fail()（opencode/src/index.ts:
// 104-114）对 "Unknown argument" 前缀只 showHelp、**不打印错误行** → 每个业务/
// 系统 spawn 的 stderr 只有一整块 `run` usage + exit 1、零 stdout，全机任务
// （含所有工作组）瘫痪且难归因。
//
// 修法（本文件锁定的三段线）：
//   1. spawn.ts resolveAutoApproveFlag —— 按二进制版本选拼写；未知/不可解析
//      一律旧拼写（golden 与两族测试桩零漂移；真实二进制永远先被 boot 探测）。
//   2. util/opencode-version-registry —— probeOpencode 成功即记录 binary→version
//      （daemon 启动在监听前必探默认二进制），driver 组装 spawn 时查表。
//   3. driver 两条 spawn 路径（system buildSpawn / business buildBusinessSpawn）
//      都把查表结果传进 buildOpencodeSpawn。
//
// 若这文件变红：要么有人动了拼写门槛/默认值（先读 spawn.ts 的事故注释再改），
// 要么 probe→registry→driver 的链路断了——那会原样复刻本次全机瘫痪。

import { beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@agent-workflow/shared'
import { DEFAULT_CONFIG_DIR_PROFILE } from '@agent-workflow/shared'
import {
  OPENCODE_AUTO_FLAG_MIN_VERSION,
  resolveAutoApproveFlag,
} from '@/services/runtime/opencode/spawn'
import { opencodeDriver } from '@/services/runtime/opencode/driver'
import type { BusinessNodeSpawnContext } from '@/services/runtime/types'
import { probeOpencode } from '@/util/opencode'
import {
  getOpencodeBinaryVersion,
  recordOpencodeBinaryVersion,
  resetOpencodeBinaryVersionsForTests,
} from '@/util/opencode-version-registry'
import { createLogger } from '@/util/log'

const LEGACY = '--dangerously-skip-permissions'

beforeEach(() => {
  resetOpencodeBinaryVersionsForTests()
})

describe('resolveAutoApproveFlag — version gate', () => {
  test('≥1.18.0 → --auto（改名边界含端点）', () => {
    expect(OPENCODE_AUTO_FLAG_MIN_VERSION).toBe('1.18.0')
    for (const v of ['1.18.0', '1.18.3', '1.19.0', '2.0.0']) {
      expect(resolveAutoApproveFlag(v)).toBe('--auto')
    }
  })

  test('<1.18.0 → 旧拼写', () => {
    for (const v of ['1.14.0', '1.14.99', '1.17.8']) {
      expect(resolveAutoApproveFlag(v)).toBe(LEGACY)
    }
  })

  test('未知（null/undefined/空串）→ 旧拼写（桩零漂移的根基）', () => {
    expect(resolveAutoApproveFlag(undefined)).toBe(LEGACY)
    expect(resolveAutoApproveFlag(null)).toBe(LEGACY)
    expect(resolveAutoApproveFlag('')).toBe(LEGACY)
  })

  test('不可解析的垃圾串 → 旧拼写（compareSemver 对垃圾返回 0，裸比较会误选 --auto）', () => {
    // 这是个真实的坑：compareSemver('garbage','1.18.0') === 0 ⇒ >=0 ⇒ --auto。
    // resolveAutoApproveFlag 必须先 extractVersion 归一化。
    expect(resolveAutoApproveFlag('garbage')).toBe(LEGACY)
    expect(resolveAutoApproveFlag('stub-opencode')).toBe(LEGACY)
  })

  test('带前后缀的版本串走 extractVersion 归一化（v 前缀 / 预发布尾巴）', () => {
    expect(resolveAutoApproveFlag('v1.18.3-beta.2')).toBe('--auto')
    expect(resolveAutoApproveFlag('opencode version 1.17.8\n')).toBe(LEGACY)
  })
})

describe('version registry — record / get / reset', () => {
  test('未记录 → null；记录后可取回；reset 清空', () => {
    expect(getOpencodeBinaryVersion('opencode')).toBeNull()
    recordOpencodeBinaryVersion('opencode', '1.18.3')
    expect(getOpencodeBinaryVersion('opencode')).toBe('1.18.3')
    recordOpencodeBinaryVersion('/x/fork', null) // 探测到但解析不出
    expect(getOpencodeBinaryVersion('/x/fork')).toBeNull()
    resetOpencodeBinaryVersionsForTests()
    expect(getOpencodeBinaryVersion('opencode')).toBeNull()
  })
})

describe('probeOpencode seeds the registry', () => {
  test('成功探测（fake 二进制）→ 表里出现该 binary 的版本', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aw-oc-flag-'))
    const fake = join(dir, 'fake-opencode-118.sh')
    writeFileSync(fake, '#!/bin/sh\necho "fake-opencode 1.18.2"\n')
    chmodSync(fake, 0o755)
    const probe = await probeOpencode(fake)
    expect(probe.version).toBe('1.18.2')
    expect(getOpencodeBinaryVersion(fake)).toBe('1.18.2')
  })

  test('探测失败（不存在的二进制）→ 不写表（瞬时失败不得覆盖好记录）', async () => {
    const missing = '/nonexistent/aw-opencode-zzz'
    recordOpencodeBinaryVersion(missing, '1.18.3') // 先放一条好记录
    await probeOpencode(missing)
    expect(getOpencodeBinaryVersion(missing)).toBe('1.18.3')
  })
})

describe('driver 两条 spawn 路径都吃版本门', () => {
  const SYSTEM_BASE = {
    agentName: 'aw-memory-distiller',
    systemPrompt: 'PERSONA',
    model: 'zhipuai/glm-5.2',
    prompt: 'USER PROMPT',
    worktreePath: '/tmp/wt',
    runDir: '/tmp/run',
  } as const

  test('buildSpawn（system agent）：registry 有 ≥1.18 → --auto；无记录 → 旧拼写', () => {
    recordOpencodeBinaryVersion('/fork/oc118', '1.18.3')
    const modern = opencodeDriver.buildSpawn({ ...SYSTEM_BASE, runtimeBinary: '/fork/oc118' })
    expect(modern.cmd).toContain('--auto')
    expect(modern.cmd).not.toContain(LEGACY)

    const unknown = opencodeDriver.buildSpawn({
      ...SYSTEM_BASE,
      runtimeBinary: '/fork/never-probed',
    })
    expect(unknown.cmd).toContain(LEGACY)
    expect(unknown.cmd).not.toContain('--auto')
  })

  test('buildSpawn 默认头（PATH 上的 opencode）以 "opencode" 为 key 查表 —— boot 探测种子生效的形状', () => {
    recordOpencodeBinaryVersion('opencode', '1.18.3')
    const plan = opencodeDriver.buildSpawn({ ...SYSTEM_BASE })
    expect(plan.cmd[0]).toBe('opencode')
    expect(plan.cmd).toContain('--auto')
  })

  test('buildBusinessSpawn（业务节点，事故现场的那条路径）：registry ≥1.18 → --auto', async () => {
    const agent: Agent = {
      id: 'agent-a',
      name: 'a',
      description: '',
      outputs: [],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: '',
      schemaVersion: 1,
      createdAt: 0,
      updatedAt: 0,
    }
    const runRoot = mkdtempSync(join(tmpdir(), 'aw-oc-flag-biz-'))
    const ctx: BusinessNodeSpawnContext = {
      agent,
      prompt: 'P',
      injectedMemoryBlock: null,
      dependents: [],
      mcps: [],
      plugins: [],
      resolvedParamsByAgent: new Map(),
      skills: [],
      worktreePath: '/wt',
      runRoot,
      configDir: DEFAULT_CONFIG_DIR_PROFILE.opencode,
      runtimeBinary: '/fork/oc118-biz',
      wantsInventory: false,
      nodeRunId: 'nr-flag',
      log: createLogger('oc-flag-test'),
    }
    recordOpencodeBinaryVersion('/fork/oc118-biz', '1.18.3')
    const modern = await opencodeDriver.buildBusinessSpawn(ctx)
    expect(modern.cmd).toContain('--auto')
    expect(modern.cmd).not.toContain(LEGACY)

    // 同 ctx、无记录 → 旧拼写（默认不漂移）。
    resetOpencodeBinaryVersionsForTests()
    const unknown = await opencodeDriver.buildBusinessSpawn(ctx)
    expect(unknown.cmd).toContain(LEGACY)
  })
})

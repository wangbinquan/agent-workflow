// RFC-297 T8/T9 —— 两个运行时把各自的原始观测**规范化**成同一种事件载荷。
//
// 这是「driver 只做规范化、消费只写一份」的 driver 半边。锁三件事：
//
//  1. claude 的清单是**附加**在既有 `system/init` 事件上的，不是新起一个事件——
//     那一行今天已是结构化事件（kind `step_start`）且是根会话身份的观测点，改判
//     kind 会同时动落库与 session 认领两处高价值既有行为（design §3.2）。
//  2. opencode 的清单在退出后的文件里，由 `drainFinalEvents()` **补发**成普通
//     事件，于是下游无从分辨观测来自流内一行还是一个文件（design §3.2）。
//  3. 两边产出的载荷形状一致，且各自 declaration 声明为 `unsupported` 的字段
//     恒不出现——放松的条目类型靠这条测试收紧（design §2.2）。

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { getRuntimeDriver } from '@/services/runtime'
import { parseEvent } from '@/services/runtime/claudeCode/events'
import type { InventorySnapshotCaptured } from '@agent-workflow/shared'

const INIT_LINE = JSON.stringify({
  type: 'system',
  subtype: 'init',
  session_id: 'claude-root',
  tools: ['Read', 'Write'],
  agents: ['auditor', 'general-purpose'],
  skills: ['lint'],
  mcp_servers: [
    { name: 'rag', status: 'connected' },
    { name: 'broken', status: 'failed' },
  ],
})

describe('claude：清单附加在既有 init 事件上', () => {
  test('四个面进入 data.inventory', () => {
    const ev = parseEvent(INIT_LINE)
    const faces = ev?.data?.inventory?.faces
    expect(faces?.tools?.map((t) => t.key)).toEqual(['Read', 'Write'])
    expect(faces?.agents?.map((a) => a.key)).toEqual(['auditor', 'general-purpose'])
    expect(faces?.skills?.map((s) => s.key)).toEqual(['lint'])
    expect(faces?.mcps?.map((m) => [m.key, m.status])).toEqual([
      ['rag', 'connected'],
      ['broken', 'failed'],
    ])
  })

  test('该行的既有行为一字不动：kind 仍 step_start、sessionId 仍暴露给租约层', () => {
    const ev = parseEvent(INIT_LINE)
    expect(ev?.kind).toBe('step_start')
    expect(ev?.sessionId).toBe('claude-root')
    // 附加载荷不得把这一行从 node_run_events 里摘出去。
    expect(ev?.persist).toBeUndefined()
    expect(ev?.rawLine).toBe(INIT_LINE)
  })

  test('claude 只按名字报告——富字段一律缺席（与其 declaration 一致）', () => {
    const faces = parseEvent(INIT_LINE)?.data?.inventory?.faces
    const declaration = getRuntimeDriver('claude-code').capabilities.inventory
    for (const item of faces?.agents ?? []) {
      expect(item.mode).toBeUndefined()
      expect(item.modelId).toBeUndefined()
      expect(item.source).toBeUndefined()
    }
    expect(declaration.agents.fields.mode).toBe('unsupported')
    // 唯一的富字段例外是 MCP 状态，两边都说 supported。
    expect(faces?.mcps?.[0]?.status).toBe('connected')
    expect(declaration.mcps.fields.status).toBe('supported')
  })

  test('plugins 面缺席——claude 协议上没有插件这个概念', () => {
    expect(parseEvent(INIT_LINE)?.data?.inventory?.faces.plugins).toBeUndefined()
    expect(getRuntimeDriver('claude-code').capabilities.inventory.plugins.support).toBe(
      'unsupported',
    )
  })

  test('非 init 行不带载荷（普通 assistant 帧）', () => {
    const ev = parseEvent(JSON.stringify({ type: 'assistant', message: { content: [] } }))
    expect(ev?.data).toBeUndefined()
  })

  test('init 行一个面都没报 → 不合成空载荷', () => {
    const ev = parseEvent(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }))
    expect(ev?.data).toBeUndefined()
  })
})

describe('opencode：清单由 drainFinalEvents 补发成普通事件', () => {
  const snapshot: InventorySnapshotCaptured = {
    captured: true,
    schemaVersion: 1,
    capturedAt: 1700000000,
    agents: [
      {
        name: 'auditor',
        mode: 'subagent',
        modelProviderId: 'anthropic',
        modelId: 'claude-x',
        source: 'inline',
      },
    ],
    skills: [{ name: 'lint', source: 'managed', path: '/s/lint', description: 'lints' }],
    mcps: [{ name: 'rag', type: 'local', status: 'connected', hint: null }],
    plugins: [{ specifier: 'file:///p.mjs', source: 'inline' }],
  }

  const plantRunRoot = (): string => {
    const runRoot = mkdtempSync(join(tmpdir(), 'rfc297-drain-'))
    mkdirSync(runRoot, { recursive: true })
    writeFileSync(join(runRoot, 'inventory.json'), JSON.stringify(snapshot), 'utf-8')
    return runRoot
  }

  test('fresh 的 agent 运行 → 一个合成事件，载荷带全部富字段（AC-2）', async () => {
    const driver = getRuntimeDriver('opencode')
    const events = await driver.drainFinalEvents!({
      runRoot: plantRunRoot(),
      nodeKind: 'agent-single',
      freshRun: true,
    })
    expect(events).toHaveLength(1)
    const faces = events[0]?.data?.inventory?.faces
    expect(faces?.agents?.[0]).toMatchObject({
      key: 'auditor',
      mode: 'subagent',
      modelProviderId: 'anthropic',
      modelId: 'claude-x',
      source: 'inline',
    })
    expect(faces?.skills?.[0]).toMatchObject({ path: '/s/lint', description: 'lints' })
    expect(faces?.mcps?.[0]).toMatchObject({ type: 'local', status: 'connected' })
    // plugins 的面内键是 specifier。
    expect(faces?.plugins?.[0]?.key).toBe('file:///p.mjs')
    // tools 面缺席：dump 插件不枚举工具集（缺席 ≠ 加载了 0 个）。
    expect(faces?.tools).toBeUndefined()
  })

  test('合成事件不落 node_run_events：专属 kind + persist:false', async () => {
    const driver = getRuntimeDriver('opencode')
    const [event] = await driver.drainFinalEvents!({
      runRoot: plantRunRoot(),
      nodeKind: 'agent-single',
      freshRun: true,
    })
    expect(event?.kind).toBe('startup_inventory')
    expect(event?.persist).toBe(false)
    // 没有原文行——它不是从 stdout 来的。
    expect(event?.rawLine).toBe('')
    expect(event?.timestamp).toBe(1700000000)
  })

  test('复用会话的 followup → 不补发（dump 插件根本没重跑）', async () => {
    const driver = getRuntimeDriver('opencode')
    const events = await driver.drainFinalEvents!({
      runRoot: plantRunRoot(),
      nodeKind: 'agent-single',
      freshRun: false,
    })
    // 读到的只会是上一轮的陈旧文件；这道门以前是调用方传布尔值进来的。
    expect(events).toEqual([])
  })

  test('非 agent 节点 → 不补发', async () => {
    const driver = getRuntimeDriver('opencode')
    const events = await driver.drainFinalEvents!({
      runRoot: plantRunRoot(),
      nodeKind: 'wrapper-git',
      freshRun: true,
    })
    expect(events).toEqual([])
  })

  test('文件缺失/损坏 → 不合成事件（失败归因归读端，事件流只承载真观测）', async () => {
    const driver = getRuntimeDriver('opencode')
    const emptyRoot = mkdtempSync(join(tmpdir(), 'rfc297-drain-empty-'))
    const events = await driver.drainFinalEvents!({
      runRoot: emptyRoot,
      nodeKind: 'agent-single',
      freshRun: true,
    })
    expect(events).toEqual([])
  })
})

describe('claude 不实现 drainFinalEvents（它的观测在流里）', () => {
  test('该能力缺席即表态', () => {
    expect(getRuntimeDriver('claude-code').drainFinalEvents).toBeUndefined()
    expect(getRuntimeDriver('opencode').drainFinalEvents).toBeDefined()
  })
})

describe('AC-10 单次解析（本 RFC 的核心收益，必须有锁）', () => {
  test('claude 的 init 行在 parseEvent 内只被 JSON.parse 一次', () => {
    // 收口前这一行被解析三遍：parseEvent 一遍、parseUnusableMcpServers 一遍、
    // parseStartupInventory 再一遍。清单载荷现在由 parseEvent 在**同一次**解析里
    // 填好——若日后有人图省事在 parseEvent 内部再调一个「自己 JSON.parse 一遍」
    // 的 helper 来取某个面，这条会立刻红。
    const original = JSON.parse
    let calls = 0
    try {
      JSON.parse = ((text: string, reviver?: never) => {
        calls += 1
        return original(text, reviver)
      }) as typeof JSON.parse
      const ev = parseEvent(INIT_LINE)
      expect(ev?.data?.inventory?.faces.tools?.length).toBe(2)
    } finally {
      JSON.parse = original
    }
    expect(calls).toBe(1)
  })

  test('driver 上不再有「只为再解析一遍」而存在的方法', () => {
    // T11 删掉的两个：parseUnusableMcpServers / parseStartupInventory。它们与
    // parseEvent 对同一行各判一次 `type==='system' && subtype==='init'`。
    const claude = getRuntimeDriver('claude-code') as unknown as Record<string, unknown>
    expect(claude.parseStartupInventory).toBeUndefined()
    expect(claude.parseUnusableMcpServers).toBeUndefined()
  })

  test('runner 的 pump 不再对同一行做清单相关的二次解析（源码锁）', () => {
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'runner.ts'),
      'utf-8',
    )
    // 锁**调用形式**而不是词——文件里那两个名字仍出现在解释历史的注释里
    // （反引号引用），锁词会把说明文字也判红，反而逼人删掉解释。
    expect(src).not.toMatch(/\.parseStartupInventory\(/)
    expect(src).not.toMatch(/\.parseUnusableMcpServers\(/)
    // 清单只从事件载荷取，不再自己碰原始行。
    expect(src).toContain('consumeInventoryPayload')
    expect(src).not.toMatch(/JSON\.parse\(line\)/)
  })
})

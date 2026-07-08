// RFC-147 — 系统通道端口注册表：表值锁 + 四投影语义格 + 收敛防回潮棘轮。
//
// 为什么这条测试存在：「哪些端口是系统通道、图遍历该不该当数据流依赖」曾有
// 6 份拷贝 3 种语义家族（成员集已漂移）。收敛后本文件逐格钉死语义——特别是
// channelEdgeDataflowSkip 的 nuanced 格（`__clarify__` 仅 target 为 clarify 才
// 跳、cross-clarify 目标保留为真依赖——2026-05-22 无上游泄洪 bug 的修复语义），
// 该语义曾以手抄对形式存在于 scheduler.buildScopeUpstreams 与
// dispatchFrontier.wrapperExternalUpstreamSources（注释人肉 "keep in lockstep"）。

import {
  PROMPT_INJECTED_PORT_NAMES,
  SYSTEM_CHANNEL_PORTS,
  channelEdgeDataflowSkip,
  declaredPorts,
  isClarifyChannelEdge,
  isSystemChannelEdge,
  touchesSystemChannelPort,
} from '@agent-workflow/shared'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'

const edge = (sourcePort: string, targetPort: string, targetNode = 'T') => ({
  source: { nodeId: 'S', portName: sourcePort },
  target: { nodeId: targetNode, portName: targetPort },
})

describe('SYSTEM_CHANNEL_PORTS — 表值锁', () => {
  test('恰好 5 端口，逐行 side/promptInjected/dataflow', () => {
    expect(SYSTEM_CHANNEL_PORTS).toEqual({
      __clarify__: { side: 'source', promptInjected: false, dataflow: 'unless-target-clarify' },
      __clarify_response__: { side: 'target', promptInjected: true, dataflow: 'never' },
      __external_feedback__: { side: 'target', promptInjected: true, dataflow: 'never' },
      to_designer: { side: 'source', promptInjected: false, dataflow: 'never' },
      to_questioner: { side: 'source', promptInjected: false, dataflow: 'never' },
    })
  })

  test('派生集一致性：PROMPT_INJECTED = {response, feedback}', () => {
    expect([...PROMPT_INJECTED_PORT_NAMES].sort()).toEqual([
      '__clarify_response__',
      '__external_feedback__',
    ])
  })
})

describe('家族 A — isSystemChannelEdge 分侧成员判（= isClarifyChannelEdge）', () => {
  test('五端口按侧命中', () => {
    expect(isSystemChannelEdge(edge('__clarify__', 'questions'))).toBe(true)
    expect(isSystemChannelEdge(edge('answers', '__clarify_response__'))).toBe(true)
    expect(isSystemChannelEdge(edge('to_designer', '__external_feedback__'))).toBe(true)
    expect(isSystemChannelEdge(edge('to_questioner', '__clarify_response__'))).toBe(true)
    expect(isSystemChannelEdge(edge('out', 'in'))).toBe(false)
  })

  test('反侧不命中（分侧语义：source=__clarify_response__ 不是通道边）', () => {
    expect(isSystemChannelEdge(edge('__clarify_response__', 'in'))).toBe(false)
    expect(isSystemChannelEdge(edge('out', 'to_designer'))).toBe(false)
    expect(isSystemChannelEdge(edge('out', '__clarify__'))).toBe(false)
  })

  test('isClarifyChannelEdge 与 isSystemChannelEdge 同一实现（字节等价别名）', () => {
    const cases = [
      edge('__clarify__', 'questions'),
      edge('answers', '__clarify_response__'),
      edge('__clarify_response__', 'in'),
      edge('out', 'to_designer'),
      edge('out', 'in'),
    ]
    for (const e of cases) {
      expect(isClarifyChannelEdge(e as never)).toBe(isSystemChannelEdge(e))
    }
  })

  test('继承键不经原型链命中（constructor/toString/__proto__）', () => {
    expect(isSystemChannelEdge(edge('constructor', 'toString'))).toBe(false)
    expect(touchesSystemChannelPort(edge('__proto__', 'constructor'))).toBe(false)
  })
})

describe('家族 B — touchesSystemChannelPort 任一侧宽判（sync-diff 展示防御）', () => {
  test('正侧命中当然为真', () => {
    expect(touchesSystemChannelPort(edge('__clarify__', 'questions'))).toBe(true)
  })
  test('反侧（畸形定义）也命中——比家族 A 宽', () => {
    expect(touchesSystemChannelPort(edge('__clarify_response__', 'in'))).toBe(true)
    expect(touchesSystemChannelPort(edge('out', 'to_designer'))).toBe(true)
  })
  test('普通数据边不命中', () => {
    expect(touchesSystemChannelPort(edge('out', 'in'))).toBe(false)
  })
})

describe('家族 D — channelEdgeDataflowSkip nuanced 语义格（先钉后收）', () => {
  const kindOf =
    (kinds: Record<string, string>) =>
    (id: string): string | undefined =>
      kinds[id]

  test('__clarify__ → clarify 节点：跳（runner 带外派发，防 agent→clarify→agent 环）', () => {
    expect(
      channelEdgeDataflowSkip(edge('__clarify__', 'questions', 'C'), kindOf({ C: 'clarify' })),
    ).toBe(true)
  })

  test('__clarify__ → clarify-cross-agent：保留（cross 合法等待 questioner——2026-05-22 泄洪修复）', () => {
    expect(
      channelEdgeDataflowSkip(
        edge('__clarify__', 'questions', 'X'),
        kindOf({ X: 'clarify-cross-agent' }),
      ),
    ).toBe(false)
  })

  test('__clarify__ → 其他/未知 kind（残迹边）：保留', () => {
    expect(
      channelEdgeDataflowSkip(edge('__clarify__', 'in', 'A'), kindOf({ A: 'agent-single' })),
    ).toBe(false)
    expect(channelEdgeDataflowSkip(edge('__clarify__', 'in', 'GONE'), kindOf({}))).toBe(false)
  })

  test('target 侧注入口（response/feedback）：一律跳', () => {
    expect(
      channelEdgeDataflowSkip(
        edge('answers', '__clarify_response__', 'A'),
        kindOf({ A: 'agent-single' }),
      ),
    ).toBe(true)
    expect(
      channelEdgeDataflowSkip(
        edge('to_designer', '__external_feedback__', 'D'),
        kindOf({ D: 'agent-single' }),
      ),
    ).toBe(true)
  })

  test('source 侧 to_designer / to_questioner：一律跳', () => {
    expect(channelEdgeDataflowSkip(edge('to_designer', 'in', 'D'), kindOf({}))).toBe(true)
    expect(channelEdgeDataflowSkip(edge('to_questioner', 'in', 'Q'), kindOf({}))).toBe(true)
  })

  test('普通数据边：保留', () => {
    expect(channelEdgeDataflowSkip(edge('out', 'in', 'B'), kindOf({ B: 'agent-single' }))).toBe(
      false,
    )
  })

  test('反侧畸形（source=__clarify_response__）：不跳——分侧语义与家族 A 对齐', () => {
    expect(channelEdgeDataflowSkip(edge('__clarify_response__', 'in', 'B'), kindOf({}))).toBe(false)
  })
})

describe('RFC-147 — 注册表 ↔ declaredPorts 漂移互锁（设计门 high 采纳）', () => {
  // 注册表管「端口家族语义」、declaredPorts 管「哪个 kind 声明哪个口」——两张
  // 表职责不同但成员必须一致：注册表加了新通道端口而 declaredPorts 没给
  // owner kind 声明，会出现「调度当通道跳、画布/validator 却不认识」的分裂。
  // 本测试遍历注册表键，逐一断言其在 owner kind 的 declaredPorts 系统组里；
  // 出现测试不认识的新键时 fail-loud（提示同时补 declaredPorts 行与此处期望）。
  test('每个注册表端口都声明在 owner kind 的系统组', () => {
    const OWNERS: Record<string, { kind: string; group: 'systemInputs' | 'systemOutputs' }> = {
      __clarify__: { kind: 'agent-single', group: 'systemOutputs' },
      __clarify_response__: { kind: 'agent-single', group: 'systemInputs' },
      __external_feedback__: { kind: 'agent-single', group: 'systemInputs' },
      to_designer: { kind: 'clarify-cross-agent', group: 'systemOutputs' },
      to_questioner: { kind: 'clarify-cross-agent', group: 'systemOutputs' },
    }
    for (const port of Object.keys(SYSTEM_CHANNEL_PORTS)) {
      const owner = OWNERS[port]
      expect(
        owner,
        `registry port '${port}' 缺 owner 期望——新端口需同时补 declaredPorts 与此表`,
      ).toBeDefined()
      const node =
        owner!.kind === 'agent-single'
          ? { id: 'n', kind: 'agent-single', agentName: 'a' }
          : { id: 'n', kind: owner!.kind }
      const defn = { $schema_version: 4, inputs: [], nodes: [node], edges: [] }
      const d = declaredPorts(node as never, defn as never, new Map())
      expect(
        d[owner!.group].map((p) => p.name),
        `'${port}' 应声明于 ${owner!.kind}.${owner!.group}`,
      ).toContain(port)
    }
  })
})

describe('RFC-147 ratchet — 六处私有拷贝消亡防回潮', () => {
  const read = (rel: string): string =>
    readFileSync(resolve(import.meta.dir, '..', '..', '..', rel), 'utf8')

  test('workflow-sync-diff / prompt 私有集删除，改查注册表投影', () => {
    const syncDiff = read('packages/shared/src/workflow-sync-diff.ts')
    expect(syncDiff).not.toContain('CHANNEL_PORTS')
    expect(syncDiff).toContain('touchesSystemChannelPort')
    const prompt = read('packages/shared/src/prompt.ts')
    expect(prompt).not.toContain('SYSTEM_PORT_NAMES')
    expect(prompt).toContain('PROMPT_INJECTED_PORT_NAMES')
  })

  test('scheduler / dispatchFrontier 手抄对收敛为 channelEdgeDataflowSkip', () => {
    const scheduler = read('packages/backend/src/services/scheduler.ts')
    const frontier = read('packages/backend/src/services/dispatchFrontier.ts')
    for (const src of [scheduler, frontier]) {
      expect(src).toContain('channelEdgeDataflowSkip(')
      // 手写块指纹：response+feedback+to_* 四端口字面量组成的跳边条件不得回潮
      //（注册表文件本身是唯一的字面量之家）。
      expect(src).not.toMatch(
        /__clarify_response__'[\s\S]{0,200}__external_feedback__'[\s\S]{0,200}to_designer'/,
      )
    }
  })

  test('taskQuestionDispatch 第四变体删除，改共享谓词', () => {
    const tqd = read('packages/backend/src/services/taskQuestionDispatch.ts')
    expect(tqd).not.toMatch(/function isChannelEdge\(/)
    expect(tqd).toContain('isClarifyChannelEdge')
  })

  test('五端口字面量比较式全仓禁绝（常量/注册表是唯一之家）——设计门 high 采纳', () => {
    // 谓词形态（=== '__clarify__' 等）意味着又一份散装语义拷贝。合法家：
    // schemas/workflow.ts（常量定义）与 systemChannelPorts.ts（注册表）。
    // 人读消息串/注释不受限（只扫比较运算符形态）。
    const roots = [
      ['backend', resolve(import.meta.dir, '..', 'src')],
      ['shared', resolve(import.meta.dir, '..', '..', 'shared', 'src')],
    ] as const
    const ALLOW = new Set(['schemas/workflow.ts', 'systemChannelPorts.ts'])
    const LIT =
      /[!=]==\s*'(?:__clarify__|__clarify_response__|__external_feedback__|to_designer|to_questioner)'/
    const violations: string[] = []
    const walk = (dir: string): string[] => {
      const out: string[] = []
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = resolve(dir, entry.name)
        if (entry.isDirectory()) out.push(...walk(full))
        else if (/\.tsx?$/.test(entry.name)) out.push(full)
      }
      return out
    }
    for (const [name, dir] of roots) {
      for (const file of walk(dir)) {
        if ([...ALLOW].some((a) => file.endsWith(a))) continue
        const lines = readFileSync(file, 'utf8').split('\n')
        lines.forEach((line, i) => {
          const t = line.trim()
          if (t.startsWith('//') || t.startsWith('*')) return
          if (LIT.test(line)) violations.push(`${name}:${file}:${i + 1}  ${t}`)
        })
      }
    }
    expect(violations).toEqual([])
  })

  test('clarify.ts isClarifyChannelEdge 降为表驱动薄别名', () => {
    const clarify = read('packages/shared/src/clarify.ts')
    expect(clarify).toContain('isSystemChannelEdge')
    // 五端口手写 or 链不得残留在别名内。
    const fnIdx = clarify.indexOf('export function isClarifyChannelEdge')
    const body = clarify.slice(fnIdx, fnIdx + 400)
    expect(body).not.toContain('CLARIFY_SOURCE_PORT_NAME ||')
  })
})

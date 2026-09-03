// RFC-147 → RFC-354 D6 — 系统通道端口：端口表是唯一来源 + 四投影语义格 + 收敛防回潮棘轮。
//
// 为什么这条测试存在：「哪些端口是系统通道、图遍历该不该当数据流依赖」曾有
// 6 份拷贝 3 种语义家族（成员集已漂移）。RFC-147 先收敛成一张注册表，再用一条
// drift 测试把它和端口表（declaredPorts）互锁；RFC-354 D6 把注册表折进端口表本身
// （`DeclaredPort.channel`），四个投影（isSystemChannelEdge / touchesSystemChannelPort /
// promptInjectedPortNames / channelEdgeDataflowSkip）全部从表派生——没有第二张表可漂。
// 本文件逐格钉死语义——特别是 channelEdgeDataflowSkip 的 nuanced 格（`__clarify__` 仅
// target 为 clarify 才跳、cross-clarify 目标保留为真依赖——2026-05-22 无上游泄洪 bug 的
// 修复语义），该语义曾以手抄对形式存在于 scheduler.buildScopeUpstreams 与
// dispatchFrontier.wrapperExternalUpstreamSources（注释人肉 "keep in lockstep"）。

import {
  channelEdgeDataflowSkip,
  declaredPorts,
  isClarifyChannelEdge,
  isSystemChannelEdge,
  promptInjectedPortNames,
  systemChannelPorts,
  touchesSystemChannelPort,
} from '@agent-workflow/shared'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'

const edge = (sourcePort: string, targetPort: string, targetNode = 'T') => ({
  source: { nodeId: 'S', portName: sourcePort },
  target: { nodeId: targetNode, portName: targetPort },
})

describe('端口表的通道投影 — 表值锁', () => {
  test('恰好 5 端口，逐行 side/promptInjected/dataflow', () => {
    expect(Object.fromEntries(systemChannelPorts())).toEqual({
      __clarify__: { side: 'source', promptInjected: false, dataflow: 'always' },
      __clarify_response__: { side: 'target', promptInjected: true, dataflow: 'never' },
      __external_feedback__: { side: 'target', promptInjected: true, dataflow: 'never' },
      to_designer: { side: 'source', promptInjected: false, dataflow: 'never' },
      to_questioner: { side: 'source', promptInjected: false, dataflow: 'never' },
    })
  })

  test('派生集一致性：promptInjected = {response, feedback}', () => {
    expect([...promptInjectedPortNames()].sort()).toEqual([
      '__clarify_response__',
      '__external_feedback__',
    ])
  })

  test('每个通道端口都是 owner kind 端口表系统组里带 channel 的那一行（side = 组）', () => {
    const OWNERS: Record<string, { kind: string; group: 'systemInputs' | 'systemOutputs' }> = {
      __clarify__: { kind: 'agent-single', group: 'systemOutputs' },
      __clarify_response__: { kind: 'agent-single', group: 'systemInputs' },
      __external_feedback__: { kind: 'agent-single', group: 'systemInputs' },
      to_designer: { kind: 'clarify-cross-agent', group: 'systemOutputs' },
      to_questioner: { kind: 'clarify-cross-agent', group: 'systemOutputs' },
    }
    for (const [port, spec] of systemChannelPorts()) {
      const owner = OWNERS[port]
      expect(
        owner,
        `channel port '${port}' 缺 owner 期望——新端口需同时补端口表与此表`,
      ).toBeDefined()
      const node =
        owner!.kind === 'agent-single'
          ? { id: 'n', kind: 'agent-single', agentName: 'a' }
          : { id: 'n', kind: owner!.kind }
      const defn = { $schema_version: 6, inputs: [], nodes: [node], edges: [] }
      const declared = declaredPorts(node as never, defn as never, new Map())
      const row = declared[owner!.group].find((p) => p.name === port)
      expect(row?.channel, `'${port}' 应带 channel 声明于 ${owner!.kind}.${owner!.group}`).toEqual({
        promptInjected: spec.promptInjected,
        dataflow: spec.dataflow,
      })
      expect(spec.side).toBe(owner!.group === 'systemInputs' ? 'target' : 'source')
    }
  })

  test('注册表文件已删除：没有第二张表', () => {
    expect(
      existsSync(resolve(import.meta.dir, '..', '..', 'shared', 'src', 'systemChannelPorts.ts')),
    ).toBe(false)
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

describe('家族 D — channelEdgeDataflowSkip 语义格（端口表单独裁决，目标 kind 不参与）', () => {
  test('__clarify__ → clarify 节点：保留（RFC-354 D7：gate 是行支撑节点，asker 是它的结构上游）', () => {
    // 曾经是「跳（runner 带外派发）」：gate 不落行时，只有绕过依赖才不会在 t0 空转。
    // gate 落行后依赖回归常态——asker 未 settle 则 gate 不被访问，asker 被分支
    // 关闭则 gate 随之 skipped，asker 提问则 gate 以 awaiting_human 行 park。
    // agent→clarify→agent 不成环：`__clarify_response__` 那一侧仍是 'never'。
    expect(channelEdgeDataflowSkip(edge('__clarify__', 'questions', 'C'))).toBe(false)
  })

  test('__clarify__ → clarify-cross-agent：保留（cross 合法等待 questioner——2026-05-22 泄洪修复）', () => {
    expect(channelEdgeDataflowSkip(edge('__clarify__', 'questions', 'X'))).toBe(false)
  })

  test('__clarify__ → 其他/未知 kind（残迹边）：保留', () => {
    expect(channelEdgeDataflowSkip(edge('__clarify__', 'in', 'A'))).toBe(false)
    expect(channelEdgeDataflowSkip(edge('__clarify__', 'in', 'GONE'))).toBe(false)
  })

  test('target 侧注入口（response/feedback）：一律跳', () => {
    expect(channelEdgeDataflowSkip(edge('answers', '__clarify_response__', 'A'))).toBe(true)
    expect(channelEdgeDataflowSkip(edge('to_designer', '__external_feedback__', 'D'))).toBe(true)
  })

  test('source 侧 to_designer / to_questioner：一律跳', () => {
    expect(channelEdgeDataflowSkip(edge('to_designer', 'in', 'D'))).toBe(true)
    expect(channelEdgeDataflowSkip(edge('to_questioner', 'in', 'Q'))).toBe(true)
  })

  test('普通数据边：保留', () => {
    expect(channelEdgeDataflowSkip(edge('out', 'in', 'B'))).toBe(false)
  })

  test('反侧畸形（source=__clarify_response__）：不跳——分侧语义与家族 A 对齐', () => {
    expect(channelEdgeDataflowSkip(edge('__clarify_response__', 'in', 'B'))).toBe(false)
  })
})

describe('RFC-147 ratchet — 六处私有拷贝消亡防回潮', () => {
  const read = (rel: string): string =>
    readFileSync(resolve(import.meta.dir, '..', '..', '..', rel), 'utf8')

  test('workflow-sync-diff / prompt 私有集删除，改查端口表投影', () => {
    const syncDiff = read('packages/shared/src/workflow-sync-diff.ts')
    expect(syncDiff).not.toContain('CHANNEL_PORTS')
    expect(syncDiff).toContain('touchesSystemChannelPort')
    const prompt = read('packages/shared/src/prompt.ts')
    expect(prompt).not.toContain('SYSTEM_PORT_NAMES')
    expect(prompt).toContain('promptInjectedPortNames()')
  })

  test('taskDagGraph / dispatchFrontier 手抄对收敛为 channelEdgeDataflowSkip', () => {
    const taskDagGraph = read(
      'packages/backend/src/modules/task-execution/composition/taskDagGraph.ts',
    )
    const frontier = read('packages/backend/src/services/dispatchFrontier.ts')
    for (const src of [taskDagGraph, frontier]) {
      expect(src).toContain('channelEdgeDataflowSkip(')
      // 手写块指纹：response+feedback+to_* 四端口字面量组成的跳边条件不得回潮
      //（端口表文件本身是唯一的字面量之家）。
      expect(src).not.toMatch(
        /__clarify_response__'[\s\S]{0,200}__external_feedback__'[\s\S]{0,200}to_designer'/,
      )
    }
  })

  test('taskQuestionDispatch 第四变体删除，改共享谓词', () => {
    const facade = read('packages/backend/src/services/taskQuestionDispatch.ts')
    const implementation = read(
      'packages/backend/src/modules/collaboration/infrastructure/legacySqliteTaskQuestionDispatch.ts',
    )
    expect(facade).toContain(
      "export * from '@/modules/collaboration/infrastructure/legacySqliteTaskQuestionDispatch'",
    )
    expect(implementation).not.toMatch(/function isChannelEdge\(/)
    expect(implementation).toContain('isClarifyChannelEdge')
  })

  test('五端口字面量比较式全仓禁绝（常量/端口表是唯一之家）——设计门 high 采纳', () => {
    // 谓词形态（=== '__clarify__' 等）意味着又一份散装语义拷贝。合法家：
    // schemas/workflow.ts（常量定义）与 nodePorts.ts（端口表）。
    // 人读消息串/注释不受限（只扫比较运算符形态）。
    // RFC-317 T59（findings NK-03）—— **补上 frontend**。
    // 本条测试的标题写着「全仓禁绝」，而根只有两个包；前端当时确实躺着两处违例
    // （`sourceHandle === '__clarify__'`、`fields.sourcePortName === 'to_designer'`），
    // 已同批改 import 共享常量。对照 `rfc146-kind-predicate-guard.test.ts` —— 它一直
    // 走全部三个根。一条声称「全仓」却只扫两个包的规则，比没有规则更糟：
    // 它让人以为这件事已经有人管了。
    const roots = [
      ['backend', resolve(import.meta.dir, '..', 'src')],
      ['shared', resolve(import.meta.dir, '..', '..', 'shared', 'src')],
      ['frontend', resolve(import.meta.dir, '..', '..', 'frontend', 'src')],
    ] as const
    const ALLOW = new Set(['schemas/workflow.ts', 'nodePorts.ts'])
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

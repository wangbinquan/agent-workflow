// RFC-297 —— 结算时把「本轮观测到的东西」构造成跨运行时统一的清单观测。
//
// 这是「消费只写一份」的兑现处：它只认事件上的 `data.inventory` 载荷（claude 挂在
// init 事件上、opencode 由 `drainFinalEvents` 补发的合成事件携带），完全不知道
// claude 有个 init 事件、opencode 有个 dump 文件——若哪天有人在这里加了一个
// `if (runtime === …)`，那就是抽象又漏回调用方了。
//
// 与告警 banner 的关系：这里算出的 `declared-missing` 与 `verifyStartup` 报的
// missing 共用 shared 的同一个纯函数（RFC-297 T3），两处不可能给出不同的名字集。
//
// 注：本 RFC 一度还提供过 pipeline 形态的 `createInventoryStage`，但 pump 始终没有
// pipeline 化，它与下面这个函数是同一语义的两份实现且零调用方——按仓规「删除优于
// deprecate、别为快一点留过渡态」已移除。真做 pipeline 化时按当时的 pump 形态重写
// （届时它已叠了 conversation-reset 状态机，与旧设计未必吻合）。

import {
  INVENTORY_FACES,
  declaredNamesForFace,
  assembleFace,
  inventoryFacesFromSnapshot,
  type InventoryFaces,
  type InventorySnapshot,
  type ObservedInventoryFaces,
  type ObservedInventoryItem,
  type RuntimeInventoryObservation,
} from '@agent-workflow/shared'
import type { DeclaredManifestV1 } from '@/services/execution/agentInjection'
import type { RuntimeDriverCapabilities } from '@/services/runtime/types'

/**
 * RFC-297 T18 —— 结算时从「本轮观测到的东西」构造统一清单观测。
 *
 * 与 `verifyStartup` 共用同一个 `assembleFace`/`missingDeclared`，所以「清单里标
 * 已声明未加载」与「banner 报未加载」不可能分叉。
 */
export function buildRuntimeInventoryObservation(input: {
  capabilities: RuntimeDriverCapabilities
  /** 本轮是否可能产生新观测（false = 复用了既有原生会话）。 */
  freshRun: boolean
  declared: DeclaredManifestV1
  /** claude：流内 init 事件累积出的观测。 */
  claudeInit: ClaudeInitLike | null
  /** opencode：退出后读到的 dump 快照（含失败桩）。 */
  snapshot: SnapshotLike | null
  now: number
}): RuntimeInventoryObservation {
  const { capabilities: caps } = input
  const observed = observedFacesOf(input)
  if (observed !== null) {
    const faces: InventoryFaces = {}
    for (const face of INVENTORY_FACES) {
      const items = observed[face]
      if (items === undefined) continue
      faces[face] = assembleFace(items, declaredNamesForFace(input.declared, face))
    }
    return { state: 'captured', capturedAt: input.now, faces }
  }
  if (caps.startupObservation === 'none') {
    return { state: 'not-produced', reason: 'runtime-has-no-inventory', message: null }
  }
  if (caps.observationRequiresFreshRun && !input.freshRun) {
    // followup 复用了会话，产出观测的东西根本没重跑——正常状态，不是故障。
    return { state: 'not-produced', reason: 'session-reused', message: null }
  }
  // opencode 的失败桩带着自己的 reason（插件没加载 / 文件坏了 / pure 模式…），
  // 原样呈现比笼统一句「没有观测」有用得多。
  if (input.snapshot !== null && input.snapshot.captured === false) {
    return input.snapshot.reason === 'parse-failed'
      ? { state: 'malformed', reason: input.snapshot.reason, message: input.snapshot.message }
      : { state: 'unavailable', reason: input.snapshot.reason, message: input.snapshot.message }
  }
  return { state: 'unavailable', reason: 'no-observation', message: null }
}

interface ClaudeInitLike {
  tools?: readonly string[]
  agents?: readonly string[]
  skills?: readonly string[]
  mcpServers?: readonly { name: string; status: string }[]
}

type SnapshotLike = InventorySnapshot

/** 结构化取数：两个观测源转成同一形状；都没有则 null。 */
function observedFacesOf(input: {
  capabilities: RuntimeDriverCapabilities
  claudeInit: ClaudeInitLike | null
  snapshot: SnapshotLike | null
}): ObservedInventoryFaces | null {
  if (input.snapshot !== null && input.snapshot.captured) {
    return inventoryFacesFromSnapshot(input.snapshot)
  }
  const init = input.claudeInit
  if (init === null) return null
  const named = (names: readonly string[] | undefined): ObservedInventoryItem[] | undefined =>
    names === undefined ? undefined : names.map((name) => ({ key: name, name }))
  const faces: ObservedInventoryFaces = {}
  const tools = named(init.tools)
  const agents = named(init.agents)
  const skills = named(init.skills)
  if (tools !== undefined) faces.tools = tools
  if (agents !== undefined) faces.agents = agents
  if (skills !== undefined) faces.skills = skills
  if (init.mcpServers !== undefined) {
    faces.mcps = init.mcpServers.map((m) => ({ key: m.name, name: m.name, status: m.status }))
  }
  return faces.tools === undefined &&
    faces.agents === undefined &&
    faces.skills === undefined &&
    faces.mcps === undefined
    ? null
    : faces
}

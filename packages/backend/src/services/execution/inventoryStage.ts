// RFC-297 T10 —— 清单组装 stage：**运行时无关**的那一份。
//
// 这是本 RFC 结构收益的落点。旧路上「把运行时报告的东西变成一份可展示的清单」
// 要在每个 driver 里各写一遍（opencode 映射它的 dump 文件、claude 映射它的 init
// 事件）；改走事件流后 driver 只负责把自己的原始形态规范化成事件载荷，
// **对账与组装只有这一份代码**，它既不知道 opencode 有个插件，也不知道 claude
// 有个 init 事件。第三个运行时接入时这里一行都不用改。
//
// 与告警 banner 的关系：本 stage 算出的 `declared-missing` 与 `verifyStartup`
// 报的 missing 共用 shared 的同一个纯函数（RFC-297 T3），所以「清单里标已声明
// 未加载」与「banner 报未加载」不可能给出不同的名字集。

import {
  INVENTORY_FACES,
  INVENTORY_FACE_TO_DECLARED_KEY,
  assembleFace,
  inventoryFacesFromSnapshot,
  type InventoryFaces,
  type InventorySnapshot,
  type ObservedInventoryFaces,
  type ObservedInventoryItem,
  type RuntimeInventoryObservation,
} from '@agent-workflow/shared'
import type { DeclaredManifestV1 } from '@/services/execution/agentInjection'
import type { EventStage } from '@/services/execution/eventPipeline'
import type { RuntimeDriverCapabilities } from '@/services/runtime/types'

export interface InventoryStageOptions {
  /** 平台本轮声明注入了什么——来源对账的另一半。 */
  declared: DeclaredManifestV1
  /** 冻结运行时的静态表态：决定「没观测到」该报 not-produced 还是 unavailable。 */
  capabilities: RuntimeDriverCapabilities
  /**
   * 本轮是否可能产生新观测。false = 复用了既有原生会话（RFC-042 同会话信封
   * 追问），对 `observationRequiresFreshRun` 的运行时来说这不是故障而是常态。
   */
  freshRun: boolean
  /** 由调用方注入，便于测试固定时间戳。 */
  now?: () => number
}

export interface InventoryStage extends EventStage {
  /** 子进程退出后取本轮观测结论。 */
  result(): RuntimeInventoryObservation
}

/**
 * 平台声明清单里某一面的名字集。`tools` 是唯一可能为 null 的面——null 表示
 * 「本轮没有约束工具集」，此时运行时报告的工具全部算 ambient，且不产生任何
 * declared-missing（没声明过的东西谈不上缺失）。
 */
function declaredNamesFor(
  declared: DeclaredManifestV1,
  face: (typeof INVENTORY_FACES)[number],
): readonly string[] | null {
  const key = INVENTORY_FACE_TO_DECLARED_KEY[face]
  const value = declared[key]
  if (value === null) return null
  return Array.isArray(value) ? value : []
}

export function createInventoryStage(opts: InventoryStageOptions): InventoryStage {
  const now = opts.now ?? Date.now
  // 一轮里只认第一份载荷。claude 的 init 是一次性的；opencode 的补发事件也
  // 只有一个。多一份就说明运行时行为变了，此时保留最早那份（与既有
  // 「one-shot startup inventory」语义一致）。
  let payloadFaces: ObservedInventoryFaces | null = null
  let capturedAt = 0

  return {
    name: 'runtime-inventory',
    // 清单是呈现面：它挂了不该把一次本来成功的 run 判失败（design §7.1）。
    errorPolicy: 'isolate',
    onEvent(event) {
      if (payloadFaces !== null) return
      const inventory = event.data?.inventory
      if (inventory === undefined) return
      payloadFaces = inventory.faces
      capturedAt = event.timestamp ?? now()
    },
    result(): RuntimeInventoryObservation {
      if (payloadFaces === null) {
        // 没观测到，分两种情况——混为一谈会复活 RFC-280 P2-E 的告警噪音。
        if (opts.capabilities.startupObservation === 'none') {
          return { state: 'not-produced', reason: 'runtime-has-no-inventory' }
        }
        if (opts.capabilities.observationRequiresFreshRun && !opts.freshRun) {
          return { state: 'not-produced', reason: 'session-reused' }
        }
        return { state: 'unavailable', reason: 'no-observation' }
      }
      const faces: InventoryFaces = {}
      for (const face of INVENTORY_FACES) {
        const observed = payloadFaces[face]
        if (observed === undefined) continue
        faces[face] = assembleFace(observed, declaredNamesFor(opts.declared, face))
      }
      return { state: 'captured', capturedAt, faces }
    },
  }
}

/**
 * RFC-297 T18 —— 结算时从「本轮观测到的东西」构造统一清单观测。
 *
 * 与 `createInventoryStage` 的关系：那个是 pipeline 形态（逐事件喂入），本函数是
 * runner 现状的直接形态（结算时拿两个已捕获的观测源）。二者共用同一套语义与同一
 * 个 `assembleFace`，所以「清单里标已声明未加载」与「banner 报未加载」不可能分叉。
 * pump 完成 pipeline 化之后（T12），本函数由 stage 取代。
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
      faces[face] = assembleFace(items, declaredNamesFor(input.declared, face))
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

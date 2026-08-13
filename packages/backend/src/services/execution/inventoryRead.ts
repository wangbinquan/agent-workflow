// RFC-297 T19/T20 —— 运行时清单的**统一读端**。
//
// 起于用户实证：Claude Code 运行时下节点详情的「运行时清单」恒显示「未生成清单
// 文件（插件可能加载失败）」。那条读面（RFC-029，`opencode/inventory.ts`）从设计
// 上就是 opencode dump 插件专属的——claude 根本没有那个插件，于是它读到 NULL 就
// 照着 opencode 的失败语义把锅甩给了一个不存在的插件。
//
// 本模块把读端从「读某一列」升级为「按运行时的观测源取数」：
//   · opencode —— RFC-029 dump 快照（`inventory_snapshot_json`），富字段齐全；
//   · claude   —— 启动验证记录（`startup_verification_json`）里的 observation，
//                 那是 `system/init` 事件报告的 tools/agents/skills/mcp_servers。
// 两者都转成同一个形状，再与同一份 declared 对账出来源三态，前端因此只认一套
// 数据、按 driver 的静态表态选列，不需要知道运行时叫什么。
//
// 富字段不会因为统一而丢失：opencode 走快照那条路，mode/model/path/description/
// type/hint/plugins 一个不少（AC-2）；claude 本就只按名字报告，其 declaration
// 已把那些字段声明为 unsupported，读端据此让前端整列不渲染，而不是渲染一排空白。

import { eq } from 'drizzle-orm'
import {
  INVENTORY_FACES,
  INVENTORY_FACE_TO_DECLARED_KEY,
  StartupVerificationRecordSchema,
  assembleFace,
  type DeclaredInjectionManifest,
  type InventoryFace,
  type InventoryFaces,
  type InventoryReasonCode,
  type InventorySnapshotCaptured,
  type ObservedInventoryFaces,
  type ObservedInventoryItem,
  type RuntimeInventoryObservation,
  type RuntimeInventoryResponse,
  type StartupObservation,
} from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { nodeRuns, tasks } from '@/db/schema'
// RFC-282 §4.2：per-runtime 模块只能经 `@/services/runtime` 索引访问——本读端
// 是运行时无关层，直接 import opencode 内部会把它重新钉死在一个运行时上。
import {
  getInventorySnapshot,
  getRuntimeDriver,
  isKnownRuntimeKind,
  type RuntimeKind,
} from '@/services/runtime'
import { NotFoundError } from '@/util/errors'

/** RFC-029 快照 → 统一观测形状。字段 1:1 搬运，一个都不许丢（AC-2）。 */
export function facesFromOpencodeSnapshot(snap: InventorySnapshotCaptured): ObservedInventoryFaces {
  return {
    agents: snap.agents.map((a) => ({
      key: a.name,
      name: a.name,
      mode: a.mode,
      modelProviderId: a.modelProviderId,
      modelId: a.modelId,
      source: a.source,
    })),
    skills: snap.skills.map((s) => ({
      key: s.name,
      name: s.name,
      source: s.source,
      path: s.path,
      description: s.description,
    })),
    mcps: snap.mcps.map((m) => ({
      key: m.name,
      name: m.name,
      type: m.type,
      status: m.status,
      hint: m.hint,
    })),
    plugins: snap.plugins.map((p) => ({ key: p.specifier, name: p.specifier, source: p.source })),
    // `tools` 面刻意缺席：dump 插件不枚举工具集。缺席 ≠ 空数组——后者会被读成
    // 「运行时一个工具都没加载」。
  }
}

const named = (names: readonly string[]): ObservedInventoryItem[] =>
  names.map((name) => ({ key: name, name }))

/**
 * 启动验证记录里的 observation → 统一观测形状。
 *
 * 这条路服务 claude：它的 init 事件按名字枚举四个面，`mcp_servers` 额外带状态。
 * observation 本身是为「对账」设计的降维形状，但对一个只按名字报告的运行时来说，
 * 降维之后并没有丢东西——这也正是它的 declaration 把富字段声明成 unsupported 的
 * 原因。opencode 不走这条路（它的富字段只在快照里）。
 */
export function facesFromStartupObservation(
  observation: Extract<StartupObservation, { state: 'verified' }>,
): ObservedInventoryFaces {
  const faces: ObservedInventoryFaces = {}
  if (observation.agents !== undefined) faces.agents = named(observation.agents)
  if (observation.skills !== undefined) faces.skills = named(observation.skills)
  if (observation.tools !== undefined) faces.tools = named(observation.tools)
  faces.mcps = observation.mcpServers.map((s) => ({
    key: s.name,
    name: s.name,
    status: s.status,
    ...(s.hint === undefined ? {} : { hint: s.hint }),
  }))
  return faces
}

function declaredNamesFor(
  declared: DeclaredInjectionManifest,
  face: InventoryFace,
): readonly string[] | null {
  const value = declared[INVENTORY_FACE_TO_DECLARED_KEY[face]]
  if (value === null) return null
  return Array.isArray(value) ? value : []
}

/** 观测 × 声明 → 带来源对账的面集合。declared 缺失（老行）时全部记 ambient。 */
export function assembleFaces(
  observed: ObservedInventoryFaces,
  declared: DeclaredInjectionManifest | null,
): InventoryFaces {
  const faces: InventoryFaces = {}
  for (const face of INVENTORY_FACES) {
    const items = observed[face]
    if (items === undefined) continue
    faces[face] = assembleFace(items, declared === null ? null : declaredNamesFor(declared, face))
  }
  return faces
}

export async function getRuntimeInventory(
  db: DbClient,
  taskId: string,
  nodeRunId: string,
): Promise<RuntimeInventoryResponse> {
  const runRows = await db
    .select({
      taskId: nodeRuns.taskId,
      runtime: nodeRuns.runtime,
      startupVerificationJson: nodeRuns.startupVerificationJson,
    })
    .from(nodeRuns)
    .where(eq(nodeRuns.id, nodeRunId))
    .limit(1)
  const run = runRows[0]
  if (run === undefined || run.taskId !== taskId) {
    // 沿用既有读端的错误契约：task 不存在与 node_run 不属于它，是两个 404。
    const taskRows = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1)
    if (taskRows.length === 0) {
      throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
    }
    throw new NotFoundError(
      'node-run-not-found',
      `node_run '${nodeRunId}' not found under task '${taskId}'`,
    )
  }

  // NULL runtime = 早于 RFC-111 的行，那时只有 opencode（schema 注释同此）。
  const kind: RuntimeKind = isKnownRuntimeKind(run.runtime) ? run.runtime : 'opencode'
  const caps = getRuntimeDriver(kind).capabilities
  const declaration = caps.inventory

  const verification = parseVerification(run.startupVerificationJson)
  const declared = verification?.declared ?? null

  // 观测源按 driver 的**静态表态**分派，不按运行时名字——第三个运行时接入时
  // 只要表明自己属于哪一类，这里一行都不用改。
  switch (caps.startupObservation) {
    case 'inventory-file': {
      // 复用 RFC-029 既有读端：它承载了 RFC-062 的「运行中从 runRoot 实时读」、
      // reason 分类、非 agent kind 的 410 等一整套行为。在这里重写一遍就等于
      // 悄悄丢掉其中几条（本 RFC 实现期实测：重写版本第一稿就丢了 RFC-062）。
      const snapshot = await getInventorySnapshot(db, taskId, nodeRunId)
      if (snapshot.captured) {
        return {
          observation: {
            state: 'captured',
            capturedAt: snapshot.capturedAt,
            faces: assembleFaces(facesFromOpencodeSnapshot(snapshot), declared),
            // 老行没有声明清单可对账，前端据此隐藏来源列而不是显示一整列错值。
            ...(declared === null ? { provenanceUnavailable: true } : {}),
          },
          declaration,
        }
      }
      return {
        observation: observationFromSnapshotReason(snapshot.reason, snapshot.message),
        declaration,
      }
    }
    case 'init-event': {
      if (verification !== null && verification.observation.state === 'verified') {
        return {
          observation: {
            state: 'captured',
            // 验证记录不带自己的时间戳；0 表示「时间未知」，不伪造一个 now()。
            capturedAt: 0,
            faces: assembleFaces(facesFromStartupObservation(verification.observation), declared),
          },
          declaration,
        }
      }
      // 非 agent kind 在这条路上同样要给 410——判据借既有读端（它读 workflow
      // 快照解析 nodeKind）；claude 行的 inventory 列恒 NULL 不影响该判定。
      await getInventorySnapshot(db, taskId, nodeRunId)
      if (verification === null) {
        return {
          observation: { state: 'unavailable', reason: 'no-observation-recorded' },
          declaration,
        }
      }
      const observed = verification.observation
      // verified 已在上面返回；剩下只有 unavailable / malformed 两态带 reason。
      if (observed.state === 'verified') {
        return {
          observation: { state: 'unavailable', reason: 'no-observation-recorded' },
          declaration,
        }
      }
      return {
        observation:
          observed.state === 'malformed'
            ? { state: 'malformed', reason: observed.reason }
            : { state: 'unavailable', reason: observed.reason },
        declaration,
      }
    }
    case 'none':
      return {
        observation: { state: 'not-produced', reason: 'runtime-has-no-inventory' },
        declaration,
      }
  }
}

/**
 * RFC-029 的失败 reason → 统一观测状态。三档语义必须泾渭分明，否则会复活
 * RFC-280 P2-E 治过的噪音：
 *  · in-flight      —— 还在跑，清单尚未生成，不是故障；
 *  · non-agent-kind —— 该节点类型本就不产清单，同样不是故障；
 *  · parse-failed   —— 观测源在但坏了；
 *  · 其余（file-missing / 插件加载失败 / 插件内部错 / pure 模式）—— 观测该有
 *    却没有，原样呈现 reason，由前端给文案。
 *
 * 刻意**不**按 `observationRequiresFreshRun` 把 `file-missing` 降级成「按设计
 * 不产」：那个 capability 说的是「这个运行时的观测依赖 fresh run」，而读端并
 * 不知道**本次** run 是否复用了会话（DB 未存该事实）。据此降级会把一次真实的
 * 插件加载失败说成正常状态——正是 RFC-062 反过来治的那类误导。followup 的噪音
 * 归启动验证层处理（那里有 observationSkippedByDesign 判定）。
 */
function observationFromSnapshotReason(
  reason: InventoryReasonCode,
  message: string | null,
): RuntimeInventoryObservation {
  if (reason === 'in-flight' || reason === 'non-agent-kind') {
    return { state: 'not-produced', reason, message }
  }
  if (reason === 'parse-failed') return { state: 'malformed', reason, message }
  return { state: 'unavailable', reason, message }
}

function parseVerification(raw: string | null) {
  if (raw === null || raw === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const result = StartupVerificationRecordSchema.safeParse(parsed)
  return result.success ? result.data : null
}

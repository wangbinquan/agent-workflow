// RFC-280 T3 — 启动验证层：平台「声明注入清单」× runtime「启动实际报告」的
// 差集判定。设计门 P1-4/P1-5 修订后的三态观测模型：
//   verified    — 观测源存在且解析成功（claude init 事件 / opencode inventory）
//   unavailable — 观测源缺失（无 init 事件 / inventory 插件未产出文件）
//   malformed   — 观测源存在但解析失败
// 「无法观测」绝不投影为「验证通过」：业务节点把非 verified 呈现为「无法验证」
// 告警；MCP 测试台（T6）对 unavailable/malformed 显式 fail。
//
// 消费语义（RFC-280 用户裁决）：业务节点 warn-not-fail —— verifyStartup 是纯
// 函数，绝不改写进程结果；它的输出只进 node_runs.startup_verification_json
// 与 UI 告警面。持久化形状的 zod 权威在 shared/schemas/startupVerification.ts。
//
// Leaf module：除 shared 的纯函数外无运行时依赖（RFC-297 T3 引入 missingDeclared
// 的值导入——shared 不反向依赖 backend，故不成环）。

import type {
  DeclaredInjectionManifest,
  InventorySnapshot,
  ObservedMcpServer,
  StartupObservation,
  StartupVerificationRecord,
  StartupVerificationResult,
} from '@agent-workflow/shared'
// RFC-297 T3：missing 判定单点化——清单面的来源对账（assembleFace）与这里的
// 差集判定必须永远给出同一批名字，否则「清单里标已声明未加载」与「banner 报
// 未加载」会各说各话。
import { missingDeclared } from '@agent-workflow/shared'

export type {
  ObservedMcpServer,
  StartupObservation,
  StartupVerificationRecord,
  StartupVerificationResult,
}

/** declared 是否有任何值得验证/告警的内容 —— 全空则调用方不落库（列保持 NULL）。 */
export function declaredHasContent(declared: DeclaredInjectionManifest): boolean {
  return (
    declared.mcpServers.length > 0 ||
    declared.skills.length > 0 ||
    declared.subagents.length > 0 ||
    declared.plugins.length > 0 ||
    declared.skippedDisabledMcps.length > 0 ||
    declared.droppedParams.length > 0 ||
    declared.unsupported.length > 0
  )
}

/**
 * RFC-297 T3：实现已上提 shared（`missingDeclared`），本地只留一层薄包装。
 * 语义不变——「该面无观测 → 跳过判定（不算通过，也不误报）」。
 *
 * 刻意写成**函数声明**而非 `const missing = missingDeclared` 顶层别名：别名在
 * 模块求值时就要读到导入绑定，一旦将来这条 import 链上出现环，别名会静默取到
 * undefined 并在调用点炸成 "missing is not a function"；函数声明会 hoist 且到
 * 调用时才解引用，同样的环只会退化成延迟解析而不是初始化期崩溃。
 */
function missing(declared: readonly string[], observed: readonly string[] | undefined): string[] {
  return missingDeclared(declared, observed)
}

/**
 * declared × observation → 差集判定。纯函数；observation ≠ verified 时各
 * missing 恒空（「无法观测」由 observation 字段本身承载，绝不伪装为已验证）。
 */
export function verifyStartup(
  declared: DeclaredInjectionManifest,
  observation: StartupObservation,
): StartupVerificationResult {
  if (observation.state !== 'verified') {
    return {
      observation: observation.state,
      observationReason: observation.reason,
      mcpUnusable: [],
      skillsMissing: [],
      subagentsMissing: [],
      toolsMissing: [],
      pluginsMissing: [],
    }
  }
  const observedByName = new Map(observation.mcpServers.map((s) => [s.name, s]))
  const mcpUnusable: ObservedMcpServer[] = []
  for (const name of declared.mcpServers) {
    const seen = observedByName.get(name)
    if (seen === undefined) {
      mcpUnusable.push({ name, status: 'missing' })
    } else if (seen.status !== 'connected') {
      mcpUnusable.push(seen)
    }
  }
  return {
    observation: 'verified',
    mcpUnusable,
    skillsMissing: missing(declared.skills, observation.skills),
    subagentsMissing: missing(declared.subagents, observation.agents),
    toolsMissing: declared.tools === null ? [] : missing(declared.tools, observation.tools),
    // opencode inventory 报 plugin specifier（file:// 路径）而非平台名——键域对
    // 不上，该面经 declared.unobservable 呈现「无法验证」而非在这里误判缺失。
    pluginsMissing: [],
  }
}

/** opencode：RFC-029 inventory 快照 → 观测（run 结束后置判定，design §2.3）。 */
export function observationFromInventory(
  snapshot: InventorySnapshot | null | undefined,
): StartupObservation {
  if (snapshot === null || snapshot === undefined) {
    return { state: 'unavailable', reason: 'inventory-not-read' }
  }
  if (!snapshot.captured) {
    // 读取层的 reason 码（shared/inventory.ts InventoryReasonCodeSchema）里
    // 只有 parse-failed 属「观测源存在但坏了」；其余（file-missing /
    // plugin-load-failed / opencode-pure-mode / in-flight / …）都是缺失。
    return snapshot.reason === 'parse-failed'
      ? { state: 'malformed', reason: snapshot.reason }
      : { state: 'unavailable', reason: snapshot.reason }
  }
  return {
    state: 'verified',
    source: 'opencode-inventory',
    mcpServers: snapshot.mcps.map((m) => ({
      name: m.name,
      status: m.status,
      ...(m.hint === null ? {} : { hint: m.hint }),
    })),
    agents: snapshot.agents.map((a) => a.name),
    skills: snapshot.skills.map((s) => s.name),
  }
}

/** claude：行内捕获的 init 观测（runner 在 stdout pump 里组装）。 */
export interface ClaudeInitObservation {
  mcpServers?: readonly { name: string; status: string }[]
  tools?: readonly string[]
  agents?: readonly string[]
  skills?: readonly string[]
}

export function observationFromClaudeInit(init: ClaudeInitObservation | null): StartupObservation {
  if (init === null) return { state: 'unavailable', reason: 'no-init-event' }
  return {
    state: 'verified',
    source: 'claude-init',
    mcpServers: (init.mcpServers ?? []).map((s) => ({ name: s.name, status: s.status })),
    ...(init.tools === undefined ? {} : { tools: [...init.tools] }),
    ...(init.agents === undefined ? {} : { agents: [...init.agents] }),
    ...(init.skills === undefined ? {} : { skills: [...init.skills] }),
  }
}

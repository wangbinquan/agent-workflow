// RFC-491（RFC-294 §4.7）：声明清单的纯构造，自 `packages/backend/src/services/execution/agentInjection.ts` 原样迁入 shared，
// 与它构造的清单类型（`DeclaredInjectionManifest`）及 RFC-463 迁入的启动核验同包；task-execution 的托管准备与
// runtime-management 的本机材料共用这一份。只依赖 shared 的类型。
//
// 身份语义（RFC-280 设计门 P1-1）：同一 canonical id 的重复引用去重、first-seen 顺序保留；不同 id 共享同一 runtime
// name 且都 enabled → 抛错；disabled 行不参与冲突判定，进入 declared.skippedDisabledMcps。

import type { Mcp } from './schemas/mcp'
import type { DeclaredInjectionManifest } from './schemas/startupVerification'

export class AgentInjectionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'AgentInjectionError'
  }
}

/** 全空 manifest —— 各渲染路径在此之上按面填充。 */
export function emptyDeclaredManifest(): DeclaredInjectionManifest {
  return {
    mcpServers: [],
    skippedDisabledMcps: [],
    skills: [],
    subagents: [],
    plugins: [],
    tools: null,
    droppedParams: [],
    unsupported: [],
    unobservable: [],
  }
}

export interface McpInjectionPartition {
  /** enabled ∩ 同 id 去重后的注入集，first-seen 顺序。 */
  injected: Mcp[]
  declared: DeclaredInjectionManifest
}

/**
 * 分拣一个 MCP 引用集合为「注入集 + 声明清单」。
 *
 * 与被收敛的两处旧循环（inlineConfig.ts / inject.ts 各自的
 * `enabled === false → continue; Object.hasOwn(map, name) → continue`）对合法
 * 输入字节等价；唯一的行为差异是防御分支——不同 id 同 enabled name 从
 * 「静默 first-wins」变为抛错（P1-1，见文件头）。
 */
export function partitionMcpsForInjection(mcps: readonly Mcp[]): McpInjectionPartition {
  const injected: Mcp[] = []
  const skippedDisabledMcps: string[] = []
  // Map keys avoid the Object-prototype trap: `constructor` is a valid MCP name.
  const seenByName = new Map<string, Mcp>()
  for (const m of mcps) {
    if (m.enabled === false) {
      skippedDisabledMcps.push(m.name)
      continue
    }
    const seen = seenByName.get(m.name)
    if (seen !== undefined) {
      if (seen.id === m.id) continue // closure union 的同 id 重复引用
      throw new AgentInjectionError(
        'agent-injection-duplicate-mcp-name',
        `two different MCP resources share the runtime name '${m.name}' ` +
          `(ids: ${String(seen.id)}, ${String(m.id)}); injecting either would ` +
          `silently substitute the other — refusing to spawn`,
      )
    }
    seenByName.set(m.name, m)
    injected.push(m)
  }
  return {
    injected,
    declared: {
      ...emptyDeclaredManifest(),
      mcpServers: injected.map((m) => m.name),
      skippedDisabledMcps,
    },
  }
}

/** 平台实际 stage 的 skill 名单（managed only —— project 由 CLI 自发现）。 */
/** RFC-282 B4 — THE managed-skill predicate (was inlined 4× across drivers). */
export function managedSkillsOf<T extends { sourceKind: string }>(skills: readonly T[]): T[] {
  return skills.filter((s) => s.sourceKind === 'managed')
}

export function declareSkills(skills: readonly { name: string; sourceKind: string }[]): string[] {
  return managedSkillsOf(skills).map((s) => s.name)
}

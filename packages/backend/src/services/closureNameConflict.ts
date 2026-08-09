// 执行闭包内的**同名冲突**检测（纯函数）。
//
// 为什么需要它：DB 层名字是 `(owner, name)` 复合唯一 —— Alice 的 `lint` 与 Bob 的
// `lint` 可以合法共存。但**运行时注入是按名字组织的**：
//
//   · 技能 → `runtime/stageSkills.ts` 把每个技能拷进 `skills/<name>/`
//   · MCP  → `runtime/claudeCode/inject.ts` 写 `{ mcpServers: { <name>: … } }`
//
// 于是同一个执行闭包里出现两个同名资源时，注入结果是**静默**的：技能只剩一份目录、
// MCP 先到先得丢弃第二个。没有告警、没有日志，agent 拿到的是错误的内容。
//
// 导出侧对同一件事有明确判据（`package-duplicate-resource-name` / AC-2b：「包不带
// owner，两个都叫 lint 的条目导入方无从分辨」）。运行时面对的是同一个不可表示性，
// 这个模块把判据补齐成可复用的一份。
//
// ⚠️ **本模块目前没有生产调用点**。接线点与失败语义（启动就绪期拒绝 / 保存期拒绝 /
// 注入期报错）是产品决策，见 `docs/audit-backlog.md` 的对应条目。先落一份**带测试
// 的判据**，让接线只剩「在哪调、抛什么」这一步。

/** 参与注入的最小形状：只要有名字与一个能区分身份的 id。 */
export interface NamedResource {
  id: string
  name: string
}

export interface ClosureNameConflict {
  /** 撞在一起的那个名字。 */
  name: string
  /** 共享该名字的资源 id，**按字典序**排（错误信息要可复现）。 */
  ids: string[]
}

/**
 * 找出闭包内所有同名冲突。
 *
 * ⚠️ **先按 id 去重**：同一个资源经由多条路径进入闭包（A 直接引用 S，又
 * `dependsOn` 一个也引用 S 的 B）是**正常**的 DAG 汇聚，不是冲突。只有**不同 id
 * 共享同一个名字**才是注入期会撞车的那种。漏掉这一步会把每个菱形依赖都误报成冲突。
 */
export function findClosureNameConflicts(
  resources: readonly NamedResource[],
): ClosureNameConflict[] {
  const idsByName = new Map<string, Set<string>>()
  for (const r of resources) {
    const set = idsByName.get(r.name) ?? new Set<string>()
    set.add(r.id)
    idsByName.set(r.name, set)
  }
  const out: ClosureNameConflict[] = []
  for (const [name, ids] of idsByName) {
    if (ids.size < 2) continue
    out.push({ name, ids: [...ids].sort() })
  }
  // 名字字典序：同一份闭包每次报同样的顺序，错误信息才可比对。
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** 给人读的一行摘要，供调用方拼进错误信息。 */
export function describeClosureNameConflicts(
  kind: 'skill' | 'mcp' | 'plugin' | 'agent',
  conflicts: readonly ClosureNameConflict[],
): string {
  return conflicts
    .map(
      (c) =>
        `${kind} '${c.name}' is claimed by ${c.ids.length} distinct rows (${c.ids.join(', ')})`,
    )
    .join('; ')
}

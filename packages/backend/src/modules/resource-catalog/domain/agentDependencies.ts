import { DomainError, ValidationError } from '@/util/errors'
import type { RefCallPolicy } from '@agent-workflow/shared'

export interface AgentDependencyGraphInput {
  readonly candidateId: string
  readonly dependencies: readonly string[]
  readonly roots?: readonly string[]
  readonly load: (id: string) => Promise<readonly string[] | undefined>
  /**
   * `catalog`：写入时的校验（唯一的 agent 写入参与者，RFC-401 A1）；`application`：公共的依赖校验查询（BFS，带 cyclePath）。
   * RFC-401 A1 删除了 `intent`（自依赖报成环、缺失节点当叶子）：Intent 改走写入参与者。
   */
  readonly semantics: 'catalog' | 'application'
  /**
   * RFC-271 调用级三属性标记，由调用点传入（保存期校验传 VALIDATE_CALL_POLICY）。
   * 与 `resolveNodeAgentRef` 相同只作标记：缺失与失败归属的分支仍由 `semantics` 决定。
   */
  readonly call?: RefCallPolicy
}

/** RFC-395 II-a A5：统一判定；RFC-401 A1 起写入只有 `catalog` 一种判据，`application` 是公共校验查询。 */
export async function assertAgentDependencyGraph(input: AgentDependencyGraphInput): Promise<void> {
  const { candidateId, semantics, load } = input
  const roots = input.roots ?? [...new Set(input.dependencies)]
  if (input.dependencies.includes(candidateId)) {
    if (semantics === 'application') {
      throw new DomainError('agent-dependency-self', 'agent cannot depend on itself', 400, {
        id: candidateId,
      })
    }
    throw new ValidationError('agent-dependency-self', 'agent cannot depend on itself')
  }
  if (semantics === 'application') {
    const missing: string[] = []
    for (const id of roots) if ((await load(id)) === undefined) missing.push(id)
    if (missing.length > 0) {
      throw new DomainError(
        'agent-dependency-not-found',
        `agent dependsOn references unknown agent(s): ${missing.join(', ')}`,
        400,
        { notFound: missing },
      )
    }
    if (candidateId.length > 0) await load(candidateId)
    // 原公共查询是 BFS；相遇次序与 cyclePath 属于 API，不能换成 DFS 的第一条环。
    const visited = new Set([candidateId])
    const queue = roots.map((id) => ({ id, path: [candidateId] }))
    while (queue.length > 0) {
      const entry = queue.shift()!
      const cycleIndex = entry.path.indexOf(entry.id)
      if (cycleIndex >= 0) {
        const cyclePath = [...entry.path.slice(cycleIndex), entry.id]
        throw new DomainError(
          'agent-dependency-cycle',
          `agent dependsOn forms a cycle: ${cyclePath.join(' → ')}`,
          400,
          { cyclePath },
        )
      }
      if (visited.has(entry.id)) continue
      const dependencies = await load(entry.id)
      if (dependencies === undefined) {
        throw new DomainError('agent-dependency-not-found', `agent '${entry.id}' not found`, 400, {
          notFound: [entry.id],
        })
      }
      visited.add(entry.id)
      for (const id of dependencies) queue.push({ id, path: [...entry.path, entry.id] })
    }
    return
  }
  const visited = new Set<string>()
  const visiting = new Set<string>()
  async function visit(id: string): Promise<void> {
    if (id === candidateId || visiting.has(id)) {
      throw new ValidationError('agent-dependency-cycle', 'agent dependency graph contains a cycle')
    }
    if (visited.has(id)) return
    visiting.add(id)
    const dependencies = await load(id)
    if (dependencies === undefined) {
      throw new ValidationError(
        'agent-dependency-not-found',
        `agent dependency '${id}' not found`,
        { notFound: [id] },
      )
    }
    for (const child of dependencies) await visit(child)
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of roots) await visit(id)
}

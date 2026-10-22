import type { GraphCapabilityKind } from '@agent-workflow/shared'

export interface GraphViewCapability {
  readonly id: string
  readonly version: number
  readonly label: string
  readonly modelKinds: readonly GraphCapabilityKind[]
  readonly checks: readonly ('references' | 'reachable-states' | 'decision-rules')[]
  readonly limitations: readonly string[]
}

/** A versioned vocabulary of expression, never a requirement-to-diagram routing table. */
export const GRAPH_VIEW_CAPABILITIES: readonly GraphViewCapability[] = [
  {
    id: 'flow',
    version: 1,
    label: '关系与流程',
    modelKinds: ['flow'],
    checks: ['references'],
    limitations: ['流程连通不证明代码行为正确。'],
  },
  {
    id: 'sequence',
    version: 1,
    label: '交互时序',
    modelKinds: ['sequence'],
    checks: ['references'],
    limitations: ['先后与并行片段需要真实执行证据。'],
  },
  {
    id: 'state',
    version: 1,
    label: '状态迁移',
    modelKinds: ['state'],
    checks: ['references', 'reachable-states'],
    limitations: ['仅探索声明的事件、输入域、深度与路径数量。'],
  },
  {
    id: 'data',
    version: 1,
    label: '数据关系',
    modelKinds: ['data'],
    checks: ['references'],
    limitations: ['关系模型不代替真实数据库约束验证。'],
  },
  {
    id: 'decision-table',
    version: 1,
    label: '规则决策表',
    modelKinds: ['decision-table'],
    checks: ['references', 'decision-rules'],
    limitations: ['规则检查仅覆盖明确声明的输入域。'],
  },
  {
    id: 'composite',
    version: 1,
    label: '组合业务视图',
    modelKinds: ['flow', 'sequence', 'state', 'data', 'decision-table'],
    checks: ['references'],
    limitations: ['每个表达面分别声明可验证范围。'],
  },
]

export function graphViewCapability(id: string, version: number): GraphViewCapability | undefined {
  return GRAPH_VIEW_CAPABILITIES.find((item) => item.id === id && item.version === version)
}

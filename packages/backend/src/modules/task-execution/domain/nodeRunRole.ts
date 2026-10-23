/** RFC-395 II-a A3：从旧行事实推导角色；parent 是归属，不是角色。 */
export type NodeRunSyntheticKind =
  | 'repo-prep'
  | 'commit-push'
  | 'commit-session'
  | 'merge-resolve'
  | 'dw-gate'
  | 'wg-gate'
  | 'dw-orchestrator'
  | 'workgroup-host'

export type NodeRunRole = 'node-attempt' | 'container' | 'synthetic'

export type DerivedNodeRunRole =
  | { readonly role: 'node-attempt' | 'container'; readonly syntheticKind: null }
  | { readonly role: 'synthetic'; readonly syntheticKind: NodeRunSyntheticKind }

export interface NodeRunRoleFacts {
  readonly nodeId: string
  readonly rerunCause?: string | null
  readonly wrapperProgressJson?: string | null
  /** 由旧行的 container_run_id 引用得出；不能用 parent_node_run_id 代替。 */
  readonly hasContainerChildren?: boolean
}

export function deriveNodeRunRole(facts: NodeRunRoleFacts): DerivedNodeRunRole {
  let syntheticKind: NodeRunSyntheticKind | null = null
  if (facts.rerunCause === 'commit-push-session') syntheticKind = 'commit-session'
  else if (facts.rerunCause === 'dw-gate') syntheticKind = 'dw-gate'
  else if (facts.rerunCause === 'wg-gate') syntheticKind = 'wg-gate'
  else if (facts.nodeId === '__repo_prep__') syntheticKind = 'repo-prep'
  else if (
    facts.rerunCause === 'commit-push' ||
    facts.nodeId === '__commit_push__' ||
    facts.nodeId.startsWith('__commit_push__:')
  )
    syntheticKind = 'commit-push'
  else if (facts.rerunCause === 'merge-resolve' || facts.nodeId.startsWith('__merge_resolve__:'))
    syntheticKind = 'merge-resolve'
  else if (facts.nodeId === '__dw_orchestrator__' || facts.rerunCause === 'dw-generate')
    syntheticKind = 'dw-orchestrator'
  else if (
    facts.nodeId === '__wg_leader__' ||
    facts.nodeId === '__wg_member__' ||
    facts.nodeId === '__wg_clarify__'
  )
    syntheticKind = 'workgroup-host'
  if (syntheticKind !== null) return { role: 'synthetic', syntheticKind }
  if (
    facts.rerunCause === 'wrapper-init' ||
    facts.wrapperProgressJson != null ||
    facts.hasContainerChildren === true
  )
    return { role: 'container', syntheticKind: null }
  // IO、branch-skip、review、clarify、fanout 子行仍是工作流节点的 attempt。
  return { role: 'node-attempt', syntheticKind: null }
}

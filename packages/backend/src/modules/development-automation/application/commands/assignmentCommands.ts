// RFC-310 T17 —— repository employee assignment 的 application 命令面。
//
// 与 digitalEmployeeCommands 同一形态：store 以 port 注入；授权在 inbound 层。
// resolve 是 admission 的第一步（§3.8）：assignment 是可选上下文——显式员工
// 请求没有 assignment 也能继续；没有显式员工时必须由 assignment 产生唯一结果。

export interface AssignmentView {
  readonly scopeKind: 'repository' | 'repository-group' | 'global-default'
  readonly scopeRef: string | null
  readonly employeeId: string | null
  readonly employeeRevision: number | null
  readonly selectionPolicyId: string | null
  readonly selectionPolicyRevision: number | null
  readonly executionPolicyId: string | null
  readonly executionPolicyRevision: number | null
  readonly defaultRequirementSourceKey: string | null
}

export interface AssignmentStorePort {
  upsert(input: {
    scopeKind: AssignmentView['scopeKind']
    scopeRef: string | null
    employee: { id: string; revision: number } | null
    selectionPolicy: { id: string; revision: number } | null
    executionPolicy: { id: string; revision: number } | null
    defaultRequirementSourceKey: string | null
    updatedBy: string | null
  }): Promise<AssignmentView>
  remove(scopeKind: AssignmentView['scopeKind'], scopeRef: string | null): Promise<void>
  list(): Promise<AssignmentView[]>
  resolve(scope: {
    repositoryId: string
    repositoryGroupId: string | null
  }): Promise<AssignmentView | null>
}

export interface AssignmentCommands {
  upsertAssignment: AssignmentStorePort['upsert']
  removeAssignment: AssignmentStorePort['remove']
  listAssignments: AssignmentStorePort['list']
  resolveAdmissionAssignment: AssignmentStorePort['resolve']
}

export function createAssignmentCommands(deps: { store: AssignmentStorePort }): AssignmentCommands {
  return {
    upsertAssignment: (input) => deps.store.upsert(input),
    removeAssignment: (scopeKind, scopeRef) => deps.store.remove(scopeKind, scopeRef),
    listAssignments: () => deps.store.list(),
    resolveAdmissionAssignment: (scope) => deps.store.resolve(scope),
  }
}

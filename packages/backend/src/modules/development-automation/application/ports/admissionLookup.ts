// RFC-310 PR-2 —— admission 期的配置读取 port。
//
// launchMission 需要读 assignment / published 员工与 policy revision，但
// application 不得直接 import infrastructure（分层锁）；装配点（route/测试）
// 用 db-first 函数绑定本接口。

export interface AdmissionAssignmentView {
  readonly scopeKind: 'repository' | 'repository-group' | 'global-default'
  readonly employeeId: string | null
  readonly employeeRevision: number | null
  readonly selectionPolicyId: string | null
  readonly selectionPolicyRevision: number | null
  readonly executionPolicyId: string | null
  readonly executionPolicyRevision: number | null
  readonly defaultRequirementSourceKey: string | null
}

export interface AdmissionLookup {
  resolveAssignment(scope: {
    readonly repositoryId: string
    readonly repositoryGroupId: string | null
  }): Promise<AdmissionAssignmentView | null>
  /** published revision 的员工内容（digitalEmployeeContentSchema 值）；无则 null。 */
  getEmployeeRevisionContent(id: string, revision: number): Promise<unknown | null>
  /** published revision 的 policy 内容；无则 null。 */
  getPolicyRevisionContent(id: string, revision: number): Promise<unknown | null>
}

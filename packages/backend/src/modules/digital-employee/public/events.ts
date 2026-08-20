export interface EmployeeCaseProjectionInvalidated {
  readonly caseId: string
  readonly revision: number
  readonly reason: 'context' | 'attention' | 'queue' | 'round' | 'channel' | 'terminal'
}

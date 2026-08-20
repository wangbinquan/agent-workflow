import type {
  DigitalEmployeeProjectionDocument,
  DigitalEmployeeProjectionPage,
  EmployeeCaseProjectionDocument,
  EmployeeTypeRef,
  ExactResourceRef,
} from './types'

export type DigitalEmployeeAuthoringQuery =
  | { readonly kind: 'type.list'; readonly cursor: string | null }
  | { readonly kind: 'type.get'; readonly typeRef: EmployeeTypeRef }
  | { readonly kind: 'type.manifest'; readonly typeRef: EmployeeTypeRef }
  | {
      readonly kind: 'tool.list'
      readonly typeRef: EmployeeTypeRef
      readonly workItemRef: string
      readonly cursor: string | null
    }
  | {
      readonly kind: 'job-template.list' | 'employee.list'
      readonly typeRef: EmployeeTypeRef
      readonly cursor: string | null
    }
  | { readonly kind: 'employee.get'; readonly resourceRef: ExactResourceRef }
  | { readonly kind: 'execution-policy.get' }

export type DigitalEmployeeAuthoringQueryResult =
  | { readonly kind: 'page'; readonly page: DigitalEmployeeProjectionPage }
  | { readonly kind: 'document'; readonly document: DigitalEmployeeProjectionDocument }

export interface DigitalEmployeeQueryPort {
  execute(query: DigitalEmployeeAuthoringQuery): Promise<DigitalEmployeeAuthoringQueryResult>
}

export interface EmployeeCaseQueryPort {
  getCase(caseId: string): EmployeeCaseProjectionDocument
  listCases(employeeId: string | null, state: string | null): string
  findCaseByExternalSubject(
    subjectType: string,
    subjectRef: string,
  ): EmployeeCaseProjectionDocument | null
}

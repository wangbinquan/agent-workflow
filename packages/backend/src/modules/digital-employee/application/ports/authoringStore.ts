import type {
  DigitalEmployeeDefinitionContent,
  DigitalEmployeeDefinitionDraft,
  EmployeeJobTemplateContent,
  EmployeeTypePackageDescriptor,
  EmployeeTypeRef,
  ExactResourceRef,
  GlobalExecutionPolicy,
  ToolRegistrationContent,
  ToolValidationReceipt,
} from '../../domain/model'

export interface TypePackageRecord {
  readonly descriptor: EmployeeTypePackageDescriptor
  readonly descriptorDigest: string
  readonly state: 'published' | 'retired'
  readonly registeredAt: number
}

export interface ToolDraftRecord {
  readonly id: string
  readonly typeRef: EmployeeTypeRef
  readonly workItemRef: string
  readonly content: ToolRegistrationContent
  readonly validationReceipt: ToolValidationReceipt
  readonly publishedRevision: number | null
  readonly ownerUserId: string | null
  readonly createdAt: number
  readonly updatedAt: number
  readonly retiredAt: number | null
}

export interface ToolRevisionRecord {
  readonly ref: ExactResourceRef
  readonly content: ToolRegistrationContent
  readonly contentDigest: string
  readonly validationReceipt: ToolValidationReceipt
  readonly state: 'published' | 'retired'
  readonly publishedAt: number
  readonly publishedBy: string | null
}

export interface JobTemplateRecord {
  readonly id: string
  readonly typeRef: EmployeeTypeRef
  readonly name: string
  readonly draft: EmployeeJobTemplateContent
  readonly publishedRevision: number | null
  readonly ownerUserId: string | null
  readonly createdAt: number
  readonly updatedAt: number
  readonly archivedAt: number | null
}

export interface JobTemplateRevisionRecord {
  readonly ref: ExactResourceRef
  readonly content: EmployeeJobTemplateContent
  readonly contentDigest: string
  readonly publishedAt: number
  readonly publishedBy: string | null
}

export interface EmployeeDefinitionRecord {
  readonly id: string
  readonly name: string
  readonly typeRef: EmployeeTypeRef
  readonly draft: DigitalEmployeeDefinitionDraft
  readonly publishedRevision: number | null
  readonly ownerUserId: string | null
  readonly visibility: 'private' | 'public'
  readonly createdAt: number
  readonly updatedAt: number
  readonly archivedAt: number | null
}

export interface EmployeeDefinitionRevisionRecord {
  readonly ref: ExactResourceRef
  readonly content: DigitalEmployeeDefinitionContent
  readonly contentDigest: string
  readonly publishedAt: number
  readonly publishedBy: string | null
}

export interface WorkScopeRevisionRecord {
  readonly ref: ExactResourceRef
  readonly typeRef: EmployeeTypeRef
  readonly encodedScope: unknown
  readonly displaySummary: string
  readonly contentDigest: string
  readonly createdAt: number
  readonly createdBy: string | null
}

export interface ExecutionPolicyRevisionRecord {
  readonly revision: number
  readonly content: GlobalExecutionPolicy
  readonly contentDigest: string
  readonly publishedAt: number
  readonly publishedBy: string | null
}

export interface DigitalEmployeeAuthoringStore {
  ensureTypePackage(input: TypePackageRecord): void
  listTypePackages(): TypePackageRecord[]
  getTypePackage(ref: EmployeeTypeRef): TypePackageRecord | null

  createTool(input: ToolDraftRecord): void
  updateToolValidation(
    id: string,
    content: ToolRegistrationContent,
    receipt: ToolValidationReceipt,
    updatedAt: number,
  ): void
  getTool(id: string): ToolDraftRecord | null
  listTools(typeRef: EmployeeTypeRef, workItemRef: string): ToolDraftRecord[]
  publishTool(input: ToolRevisionRecord): void
  getToolRevision(ref: ExactResourceRef): ToolRevisionRecord | null
  retireTool(id: string, retiredAt: number): void

  createJobTemplate(input: JobTemplateRecord): void
  updateJobTemplate(id: string, name: string, draft: EmployeeJobTemplateContent, now: number): void
  getJobTemplate(id: string): JobTemplateRecord | null
  listJobTemplates(typeRef: EmployeeTypeRef): JobTemplateRecord[]
  publishJobTemplate(input: JobTemplateRevisionRecord): void
  getJobTemplateRevision(ref: ExactResourceRef): JobTemplateRevisionRecord | null

  createEmployeeDefinition(input: EmployeeDefinitionRecord): void
  updateEmployeeDefinition(
    id: string,
    name: string,
    draft: DigitalEmployeeDefinitionDraft,
    now: number,
  ): void
  getEmployeeDefinition(id: string): EmployeeDefinitionRecord | null
  listEmployeeDefinitions(typeRef?: EmployeeTypeRef): EmployeeDefinitionRecord[]
  publishEmployeeDefinition(input: {
    revision: EmployeeDefinitionRevisionRecord
    workScope: WorkScopeRevisionRecord
  }): void
  getEmployeeDefinitionRevision(ref: ExactResourceRef): EmployeeDefinitionRevisionRecord | null
  getWorkScopeRevision(ref: ExactResourceRef): WorkScopeRevisionRecord | null

  getCurrentExecutionPolicy(): ExecutionPolicyRevisionRecord | null
  getExecutionPolicyRevision(revision: number): ExecutionPolicyRevisionRecord | null
  publishExecutionPolicy(input: ExecutionPolicyRevisionRecord): void
}

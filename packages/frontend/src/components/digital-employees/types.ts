export interface LocalizedText {
  'zh-CN': string
  'en-US': string
}

export interface ExactRef {
  id: string
  revision: number
}

export interface EmployeeTypeRef {
  typeId: string
  revision: number
}

export interface ToolSlot {
  slotRef: string
  label: LocalizedText
  description: LocalizedText
  required: boolean
  cardinality: 'exactly-one' | 'zero-or-one'
}

export interface WorkItem {
  workItemRef: string
  regionId: string
  responsibilityLaneId: string | null
  order: number
  label: LocalizedText
  description: LocalizedText
  workContractRef: { contractId: string; version: number }
  materialSummary: LocalizedText
  completionStandard: LocalizedText
  nodeKind: 'business-tool' | 'system' | 'collaboration'
  collaborationContractId: string | null
  toolRoleGroups: Array<{
    roleRef: string
    label: LocalizedText
    description: LocalizedText
    order: number
    bindingSlots: ToolSlot[]
  }>
  nextWorkItemRefs: string[]
}

export interface EmployeeWorkContract {
  contractId: string
  version: number
  inputSchemaId: string
  outputSchemaId: string
  allowedToolKinds: Array<'agent' | 'workflow' | 'program'>
  allowedEffectKinds: string[]
  requiredConnectionPurpose: string | null
  semanticValidatorId: string
}

export interface EmployeeTypePackage {
  schemaVersion: 1
  typeRef: EmployeeTypeRef
  displayName: LocalizedText
  description: LocalizedText
  workScopeAuthoring: {
    schemaVersion: 1
    label: LocalizedText
    description: LocalizedText
    variants: Array<{
      kind: string
      label: LocalizedText
      description: LocalizedText
      fields: Array<{
        fieldRef: string
        label: LocalizedText
        description: LocalizedText
        inputKind: 'text' | 'repository-picker' | 'repository-group-picker'
        required: boolean
        placeholder: LocalizedText | null
      }>
    }>
  }
  workIntakeAuthoring: {
    schemaVersion: 1
    label: LocalizedText
    description: LocalizedText
    targetFields: Array<{
      fieldRef: string
      label: LocalizedText
      description: LocalizedText
      inputKind: 'text' | 'repository-picker' | 'repository-group-picker'
      required: boolean
      placeholder: LocalizedText | null
    }>
    acceptedKinds: Array<'body' | 'files' | 'body-and-files' | 'external-id'>
    body: {
      label: LocalizedText
      description: LocalizedText
      placeholder: LocalizedText
      maxBytes: number
    }
    files: {
      label: LocalizedText
      description: LocalizedText
      maxFiles: number
      maxFileBytes: number
      targetPathRequired: true
    }
    externalId: {
      label: LocalizedText
      description: LocalizedText
      placeholder: LocalizedText
    }
  }
  authoringManifest: {
    schemaVersion: 1
    lifecycleRegions: Array<{
      regionId: string
      label: LocalizedText
      description: LocalizedText
      order: number
      responsibilityLanes: Array<{
        laneId: string
        label: LocalizedText
        description: LocalizedText
        order: number
        kind: 'spine' | 'branch'
      }>
    }>
    workItems: WorkItem[]
  }
  workContracts: EmployeeWorkContract[]
  contextTypes: Array<{
    typeId: string
    schemaVersion: number
    displayName: LocalizedText
    description: LocalizedText
    projectionFields: Array<{
      path: string
      label: LocalizedText
      format: 'text' | 'count' | 'short-hash' | 'boolean' | 'list' | 'timestamp'
    }>
  }>
  eventTypes: Array<{
    eventTypeId: string
    version: number
    displayName: LocalizedText
    description: LocalizedText
    deliveryClass: string
    priority: number
    preemptsContinuation: boolean
  }>
  invocationContracts: Array<{
    contractId: string
    inputSchemaId: string
    resultSchemaId: string
    milestoneEventTypeIds: string[]
  }>
}

export interface ToolRegistration {
  id: string
  typeRef: EmployeeTypeRef
  workItemRef: string
  content: {
    roleRef: string
    displayName: string
    description: string
    implementation:
      | { kind: 'agent'; agentRef: ExactRef }
      | { kind: 'workflow'; workflowRef: ExactRef }
      | {
          kind: 'program'
          runtimeKind: 'bash' | 'node' | 'python'
          executableArtifactRef: string
          executableDigest: string
          parameterValuesRef: string | null
          runtimeProfileRef: ExactRef
        }
  }
  validationReceipt: {
    status: 'valid' | 'invalid'
    checks: Array<{ code: string; ok: boolean; detail: string }>
  }
  publishedRevision: number | null
  state: 'draft' | 'published' | 'retired'
  updatedAt: number
}

export type ToolAuthoringImplementation =
  | { kind: 'agent'; agentRef: ExactRef }
  | { kind: 'workflow'; workflowRef: ExactRef }
  | {
      kind: 'program'
      runtimeKind: 'bash' | 'node' | 'python'
      source: string
      parameterValues?: Record<string, string | number | boolean>
      runtimeProfileRef: ExactRef
    }

export interface ToolAuthoringView extends ToolRegistration {
  body: {
    displayName: string
    description: string
    roleRef: string
    implementation: ToolAuthoringImplementation
    connectionRef?: ExactRef | null
  }
}

export interface JobTemplate {
  id: string
  name: string
  draft: {
    description: string
    defaultToolBindings: Array<{
      workItemRef: string
      slotRef: string
      registrationRef: ExactRef
    }>
    defaultCollaborationBindings: Array<{
      workItemRef: string
      memberRef: string
      targetEmployeeRef: ExactRef
      invocationContractId: string
      joinMode: 'all' | 'any' | 'quorum'
      quorum: number | null
    }>
  }
  publishedRevision: number | null
}

export interface DigitalEmployeeDefinition {
  id: string
  name: string
  typeRef: EmployeeTypeRef
  draft: {
    displayName: string
    enabled: boolean
    jobTemplateRef: ExactRef
    workScope: unknown
    toolOverrides: Array<{
      workItemRef: string
      slotRef: string
      registrationRef: ExactRef
    }>
    collaborationOverrides: Array<{
      workItemRef: string
      memberRef: string
      targetEmployeeRef: ExactRef
      invocationContractId: string
      joinMode: 'all' | 'any' | 'quorum'
      quorum: number | null
    }>
  }
  publishedRevision: number | null
  published: null | {
    displayName: string
    enabled: boolean
    workScopeSummary: string
    exactToolBindings: Array<{
      workItemRef: string
      slotRef: string
      registrationRef: ExactRef
    }>
    exactCollaborationBindings: Array<{
      workItemRef: string
      memberRef: string
      targetEmployeeRef: ExactRef
      invocationContractId: string
      joinMode: 'all' | 'any' | 'quorum'
      quorum: number | null
    }>
  }
}

export function localized(text: LocalizedText, language: string): string {
  return language.startsWith('zh') ? text['zh-CN'] : text['en-US']
}

export function typeRefKey(ref: EmployeeTypeRef): string {
  return `${ref.typeId}@${ref.revision}`
}

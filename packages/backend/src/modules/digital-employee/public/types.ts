// RFC-310 Digital Employee OS cross-context vocabulary.
//
// Rich authoring documents stay owned by this bounded context. Cross-context
// consumers exchange exact refs plus canonical JSON payloads so the public
// surface cannot become a second, structurally open copy of every type-package
// schema. HTTP inbound adapters still expose the decoded business projection.

export interface EmployeeTypeRef {
  readonly typeId: string
  readonly revision: number
}

export interface ExactResourceRef {
  readonly id: string
  readonly revision: number
}

export interface DigitalEmployeeResourceReceipt {
  readonly resourceKind: 'tool' | 'job-template' | 'employee' | 'execution-policy'
  readonly ref: ExactResourceRef
  readonly state: 'draft' | 'published' | 'retired'
  readonly contentDigest: string
  readonly projectionJson: string
}

export interface DigitalEmployeeProjectionPage {
  readonly projectionKind: 'type' | 'tool' | 'job-template' | 'employee'
  readonly itemsJson: string
  readonly nextCursor: string | null
}

export interface DigitalEmployeeProjectionDocument {
  readonly projectionKind: 'type-package' | 'authoring-manifest' | 'employee' | 'execution-policy'
  readonly projectionJson: string
  readonly contentDigest: string
}

/**
 * Code-owned employee types cross the bootstrap boundary as canonical JSON.
 * The owner validates the descriptor and every callback result before it can
 * become runtime state; type packages never gain DB, executor, or token access.
 */
export interface EmployeeTypePackageRegistration {
  readonly descriptorJson: string
  parseWorkScopeJson(inputJson: string): string
  summarizeWorkScopeJson(scopeJson: string, locale: 'zh-CN' | 'en-US'): string
  validateContractFixtureJson(requestJson: string): string
}

/** Case/context half of a runtime-only pure type-package codec. */
export interface EmployeeTypeContextCodec {
  readonly typeId: string
  buildInitialCaseJson(requestJson: string): string
  validateContextJson(contextTypeId: string, stateJson: string): string
  resolveAttentionSubjectsJson(contextTypeId: string, stateJson: string): string
}

/** Reaction half of a runtime-only pure type-package codec. */
export interface EmployeeTypeReactionCodec {
  readonly typeId: string
  /**
   * Type-owned deterministic slot selection. The OS supplies only frozen
   * contexts and the manifest fallback; the type package may narrow that to a
   * business slot (for example pipeline failure kind -> repair tool slot).
   */
  selectReactionToolSlotJson(requestJson: string): string
  assembleReactionInputJson(requestJson: string): string
  validateReactionOutputJson(requestJson: string): string
  resolveReactionSettlementJson(requestJson: string): string
}

/** Collaboration half of a runtime-only pure type-package codec. */
export interface EmployeeTypeCollaborationCodec {
  readonly typeId: string
  buildInvokedCaseJson(requestJson: string): string
  buildInvocationStartedOutputJson(requestJson: string): string
  buildInvocationResultOutputJson(requestJson: string): string
}

export interface EmployeeCaseRef {
  readonly id: string
  readonly revision: number
}

export interface EmployeeContextRef {
  readonly id: string
  readonly revision: number
}

export interface EventSubjectInput {
  readonly typeId: string
  readonly subjectRef: string
}

export interface EmployeeCaseLaunchInput {
  readonly employeeRef: ExactResourceRef
  readonly primaryContextTypeId: string
  readonly primaryContextSchemaVersion: number
  readonly primaryContextState: 'active' | 'waiting' | 'terminal'
  readonly primaryContextJson: string
  readonly artifactRefs: readonly string[]
  readonly workSubject: EventSubjectInput
}

export interface EmployeeCaseProjectionDocument {
  readonly caseRef: EmployeeCaseRef
  readonly state: 'active' | 'waiting' | 'blocked' | 'terminal'
  readonly currentWorkItemRef: string | null
  readonly projectionJson: string
  readonly projectionRevision: number
}

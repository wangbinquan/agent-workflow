// RFC-310 Digital Employee OS cross-context vocabulary.
//
// Rich authoring documents stay owned by this bounded context. Cross-context
// consumers exchange exact refs plus canonical JSON payloads so the public
// surface cannot become a second, structurally open copy of every type-package
// schema. HTTP inbound adapters still expose the decoded business projection.

import { dispatchRouteDefinitionsSchema } from '../domain/model'

export function normalizeDispatchRouteDefinitionsJson(inputJson: string): string | null {
  try {
    const parsed = dispatchRouteDefinitionsSchema.safeParse(JSON.parse(inputJson) as unknown)
    return parsed.success ? JSON.stringify(parsed.data) : null
  } catch {
    return null
  }
}

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

/**
 * Provider-owned catalog of immutable platform tools. Canonical JSON keeps the
 * Digital Employee OS from importing Agent/Workflow storage internals.
 */
export interface DigitalEmployeePlatformToolCatalogParticipant {
  listJson(typeRefJson: string, workItemRef: string): string
  getRevisionJson(refJson: string): string | null
  /**
   * Provider-owned Type Package upgrade mapping. The common employee OS never
   * parses provider-private tool IDs or guesses by display name.
   */
  resolveCompatibleRevisionJson?(
    sourceRefJson: string,
    targetTypeRefJson: string,
    workItemRef: string,
  ): string | null
  isPlatformTool(toolId: string): boolean
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

/**
 * RFC-317 T31（DE-03）—— 一次执行失败的**类别**，决定 OS 的重试落在同场景还是新场景。
 *
 * 在此之前这个判据是一次**前缀嗅探**：`errorCode.startsWith('workspace-boundary-')`。
 * 而那个前缀由 development-automation 用模板拼出来
 * （`workspace-${verdict.kind}-${verdict.code}`），两端之间没有任何类型联系——把
 * `kind: 'boundary'` 改名、或把模板顺序调一下，每一次边界违规都会**静默降级**成同场景
 * 重试：OS 会在一个已经被证明污染的工作区里反复重跑 agent，而且看不出异常（重试照常
 * 发生，只是场景错了）。同一处还有一族 `workspace-${conflictInspection.code}`（没有
 * kind 段），因此从来就触发不了升级。
 *
 * 现在类别是端口上的**闭合字段**，OS 按联合分支，新增一类是编译错误。
 */
export const WORKSPACE_FAILURE_CLASSES = ['boundary', 'semantic', 'infrastructure'] as const

export type WorkspaceFailureClass = (typeof WORKSPACE_FAILURE_CLASSES)[number]

/**
 * RFC-317 T31（DE-05）—— 「这一轮不绑具体工具，走平台工作项」的**保留 slotRef**。
 *
 * 这个值让一个工作项绕过 OS 的两条不变量（「选中的 slot 必须存在」「该 slot 必须有
 * 一个精确发布的工具修订」）。它此前在两个模块里各是一枚裸字面量 `'platform'`，
 * 两侧没有任何共享符号：任一侧改名都不会报错，只会**换一条代码路径**——OS 要么开始
 * 索要一个并不存在的工具绑定，要么不再索要一个本该存在的绑定。
 *
 * 导出成常量后，改名是编译期事件；同时它现在有一个可被 grep / import 图看见的名字，
 * 「谁在使用这条逃生门」不再需要靠搜字符串。
 */
export const PLATFORM_WORK_ITEM_SLOT_REF = 'platform'

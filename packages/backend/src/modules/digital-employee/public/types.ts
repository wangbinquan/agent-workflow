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
  /**
   * Declares which Context owns external identity correlation independently
   * from Attention. Multiple Contexts may watch one subject, but only the
   * provider-designated owner may bind that subject back to the Case.
   */
  resolveExternalSubjectBindingsJson?(contextTypeId: string, stateJson: string): string
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

/**
 * RFC-317 T44（DE-06）—— 终态种类词汇已迁往 `@agent-workflow/shared`。
 *
 * 它有三个消费者：后端任务目录适配器、后端协作 join、以及**前端**的展示分桶
 * （components/digital-employees/outcomes.ts）。前端 import 不到后端模块，词汇留在这里
 * 就必然在前端被再抄一遍——而再抄一遍正是本条 finding 的成因。
 */
export {
  classifyTerminalKind,
  EMPLOYEE_CASE_TERMINAL_KINDS,
  LEGACY_MISSION_TERMINAL_KINDS,
  type EmployeeCaseTerminalKind,
  type LegacyMissionTerminalKind,
  type TerminalKindClassification,
} from '@agent-workflow/shared'

/**
 * RFC-317 T41（findings DE-02）—— 反应轮次的**只读**查询面。
 *
 * 为什么需要它：`employeeReactionRounds` 是 Digital Employee OS 的私表
 * （`infrastructure/sqliteRuntimeStore.ts` 是唯一写者：createRound / retryRound /
 * settleRound）。development-automation 此前从 `@/db/schema` 直接把这张表拿过去查，
 * 一处读它冻结的 `planJson`，另一处按 `state === 'completed'` 过滤——**把 OS 的
 * 内部状态机枚举变成了一条没有声明、没有 schema、没有主人的事实合同**。
 * 而且这种耦合经全局 `@/db/schema` 命名空间发生，本仓所有基于 module import 边的
 * 架构守卫都看不见它（`rfc294-architecture-preflight` 的 crossContextViolations
 * 只认 `@/modules/...` 形态的边）。
 *
 * **落在 `public/types.ts` 而不是 `public/queries.ts`**：RFC-294 的跨界判据只允许
 * `participants / events / types` 走 type-only 边，`commands / queries` 必须是 value 边
 * ——因为后两者是「被调用的行为面」，只借它的类型等于借形状而不认合同。这条是**接口**，
 * 消费方 type-only 引用它，故与 `DigitalEmployeePlatformToolCatalogParticipant` 同放这里。
 *
 * 两个方法各封一处泄漏：
 *   · `frozenPlan` —— 隐藏表与列。**遗留债**：返回的仍是 `planJson` 原文，消费方
 *     用自己那份 zod 视图去 parse。文档本身的形状契约与 `ReactionExecutionPort.launch`
 *     携带的是同一份，但这里没有把它声明成 DTO；收敛它需要 OS 侧提供运行期
 *     schema，留给 RFC-317 B7 的生命周期批次。
 *   · `lastSettledRound` —— 隐藏**状态机枚举**。调用方说的是「最近一次已结算的轮次」，
 *     而不是 `state === 'completed'`；OS 将来把结算态拆成多个值时，改一处即可。
 */
export interface EmployeeReactionRoundQueryPort {
  frozenPlan(roundRef: string): {
    readonly caseId: string
    readonly planJson: string
  } | null
  lastSettledRound(input: {
    readonly caseId: string
    readonly workItemRef: string
  }): { readonly roundRef: string } | null
}

// RFC-368 T7 —— 数字员工执行的 **TaskExecution 自有**核心端口。
//
// `application/adapters/reaction-execution-adapter.ts`（实现数字员工的 `ReactionExecutionPortV1`）
// 只认这个端口；实现是 `composition/digitalEmployeeExecution.ts` 抽出来的 typed core，由组合根
// 注入。应用层不直接依赖 composition / infrastructure（`rfc294-review-module-layer-rules`）。
//
// 这里的类型**全部是 TaskExecution 自己的**，不引数字员工任何东西——跨缝类型只允许出现在
// `application/adapters/*-adapter.ts` 里（账本据此把那条边记成 `required-implementation`）。
// `TaskExecutionFailureClass` 与数字员工的 `WorkspaceFailureClass` 取值相同，由适配器做映射；
// 两边值集漂开时适配器的类型断言会先红。

export type TaskExecutionFailureClass = 'boundary' | 'semantic' | 'infrastructure'

export interface DigitalEmployeeExecutionMeteringV1 {
  readonly sourceRef: string
  readonly durationMs: number
  readonly totalTokens: number
}

export type DigitalEmployeeExecutionCoreSnapshot =
  | { readonly kind: 'pending' }
  | {
      readonly kind: 'completed'
      readonly outputJson: string
      readonly metering: DigitalEmployeeExecutionMeteringV1
    }
  | {
      readonly kind: 'failed'
      readonly errorClass: TaskExecutionFailureClass
      readonly errorCode: string
      readonly errorDetail: string
      /** 用于诊断裁剪的 R2（绝对路径改相对）；任务行不在时为 null。 */
      readonly workspaceRoot: string | null
      readonly metering: DigitalEmployeeExecutionMeteringV1
    }
  /**
   * RFC-368 G7 —— 被取消。今天它被报成 `failed / execution-canceled`，数字员工于是消耗一次
   * 重试预算重新起任务；新合同把它单列出来。旧的字符串 participant 仍把它映射回原失败形状，
   * 行为逐字不变。
   */
  | { readonly kind: 'stopped'; readonly metering: DigitalEmployeeExecutionMeteringV1 }

/**
 * 人审闸门的六态。`not-applicable`（没配闸门）与 `unknown`（执行行不在 / 输入不可解析）
 * 是**两件事**：前者投影成 skipped，后者要保留今天的 round-state 回落（设计门 P2-2）。
 */
export type DigitalEmployeeHumanReviewCoreSnapshot =
  | 'not-applicable'
  | 'unknown'
  | 'planning'
  | 'waiting'
  | 'approved'
  | 'failed'

export interface DigitalEmployeeExecutionCore {
  /**
   * typed 启动：plan / attempt 是对象，不是 JSON 字符串。`taskId` 是 admission 事务里预分配的
   * 执行身份；调用方先用 `executionExists` 判断是否重放，存在就不要再调这里。
   */
  launch(input: {
    readonly plan: Readonly<Record<string, unknown>>
    readonly attempt: {
      readonly ordinal: number
      readonly mode: 'initial' | 'same-scene' | 'fresh-scene'
      readonly previousError: string | null
    }
    readonly taskId: string
  }): Promise<{ readonly executionRef: string }>
  executionExists(executionRef: string): Promise<boolean>
  inspect(executionRef: string): Promise<DigitalEmployeeExecutionCoreSnapshot>
  inspectHumanReview(executionRef: string): Promise<DigitalEmployeeHumanReviewCoreSnapshot>
  cancel(executionRef: string): Promise<void>
}

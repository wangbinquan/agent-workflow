// RFC-368 T6 —— Reaction admission 日志的**应用层端口**（TaskExecution 自己的）。
//
// 适配器（`application/adapters/reaction-admission-adapter.ts`）只认这个端口，不认 drizzle、
// 不认 `@/db/schema`；实现在 `infrastructure/reactionExecutionAdmissions.ts`，由组合根注入。
// 这不是形式主义：`rfc294-review-module-layer-rules` 明确禁止 domain/application/engine 直接
// 依赖 `infrastructure/**` 或 `@/db/schema`，而 `rfc359-w5-t19f` 另有一条禁止模块顶层捕获
// schema 表列——两条一起把「应用层随手拿库」的形状挡死。

export interface ReactionAdmissionRow {
  readonly operationRef: string
  readonly roundRef: string
  readonly claimEpoch: number
  readonly fenceRevision: number
  readonly executionRef: string
  readonly requestHash: string
  readonly state: 'admitted' | 'launched' | 'closed'
}

export interface ReactionAdmissionInsert {
  readonly operationRef: string
  readonly caseId: string
  readonly roundRef: string
  readonly claimEpoch: number
  readonly fenceRevision: number
  readonly requestHash: string
  readonly authoritySubject: string
  readonly authorityRevision: number
  readonly executionRef: string
  readonly now: number
}

export interface ReactionAdmissionStore {
  find(operationRef: string): Promise<ReactionAdmissionRow | null>
  /** 按 claim epoch 升序；调用方取 `.at(-1)` 当当前 fence。 */
  listByRound(roundRef: string): Promise<readonly ReactionAdmissionRow[]>
  insert(input: ReactionAdmissionInsert): Promise<void>
  advanceFence(input: {
    readonly operationRef: string
    readonly claimEpoch: number
    readonly fenceRevision: number
    readonly now: number
  }): Promise<void>
  close(operationRef: string, now: number): Promise<void>
  /** 只推进 `admitted` 行；重复调用无副作用。 */
  markLaunched(operationRef: string, now: number): Promise<void>
}

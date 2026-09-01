// RFC-310 PR-1B —— 配置资源持久化 port（identity + immutable revisions）。
//
// application 只依赖这些接口；sqlite 实现由 infrastructure 提供并在装配点
// 注入（RFC-294 分层）。publish 的业务顺序（读 draft → strict parse →
// publish validator → 追加 revision）在 application command 里；store 只提供
// 持久化原语，其中 `publishRevision` 必须原子完成「插 revision 行 + 推进
// identity.publishedRevision」。revision 行 immutable：没有 update/delete 原语。

export interface ConfigResourceRecord<TExtra> {
  readonly id: string
  readonly name: string
  readonly draftJson: string
  readonly publishedRevision: number | null
  readonly ownerUserId: string | null
  readonly visibility: 'private' | 'public'
  readonly createdAt: number
  readonly updatedAt: number
  readonly archivedAt: number | null
  readonly extra: TExtra
}

export interface ConfigRevisionRecord {
  readonly resourceId: string
  readonly revision: number
  readonly contentJson: string
  readonly contentDigest: string
  readonly publishedAt: number
  readonly publishedBy: string | null
}

export interface ConfigResourceStore<TExtra> {
  /** 建 identity 行（visibility 由调用方给，新建路径统一 'private'）。name 撞唯一索引抛 typed 409。 */
  create(input: {
    readonly id: string
    readonly name: string
    readonly draftJson: string
    readonly ownerUserId: string | null
    readonly now: number
    readonly extra: TExtra
  }): ConfigResourceRecord<TExtra>
  getById(id: string): ConfigResourceRecord<TExtra> | null
  /** 全量列出（可见性过滤在 application 层做；grants 精确过滤随 route 集成补）。 */
  list(): ConfigResourceRecord<TExtra>[]
  /** 改 draft（identity 可变半边）；extra 省略时保持原值。name 撞唯一索引抛 typed 409。 */
  updateDraft(input: {
    readonly id: string
    readonly draftJson: string
    readonly name?: string
    readonly now: number
    readonly extra?: TExtra
  }): void
  /** 原子：插 revision 行 + identity.publishedRevision=revision + updatedAt。 */
  publishRevision(input: {
    readonly resourceId: string
    readonly revision: number
    readonly contentJson: string
    readonly contentDigest: string
    readonly publishedAt: number
    readonly publishedBy: string | null
  }): void
  getRevision(resourceId: string, revision: number): ConfigRevisionRecord | null
  listRevisions(resourceId: string): ConfigRevisionRecord[]
  /** archive 只封存 identity（revision 不删——在途 pin 依赖 FK/restrict）。 */
  archive(id: string, now: number): void
}

export interface ActionTemplateExtra {
  readonly capabilityId: string
}

export type ActionTemplateStore = ConfigResourceStore<ActionTemplateExtra>
export type VerificationProfileStore = ConfigResourceStore<Record<never, never>>

export type ConfigResourcePersistence<TExtra> = {
  readonly [K in keyof ConfigResourceStore<TExtra>]: ConfigResourceStore<TExtra>[K] extends (
    ...args: infer Args
  ) => infer Result
    ? (...args: Args) => Promise<Awaited<Result>>
    : never
}

export type ActionTemplatePersistence = ConfigResourcePersistence<ActionTemplateExtra>
export type VerificationProfilePersistence = ConfigResourcePersistence<Record<never, never>>

// RFC-471（RFC-294 W9-D）—— 开发交付经代码托管的两个窄端口。
//
// 实现归 integration（`composition/codeHostEffects.ts` 的 `composeDevelopmentMrFactsSource`、
// `composeRepositoryCodeHostClaimKeys`），按结构满足、装配根注入；本模块不 import integration。
// MR effects 用 `reconcilerPorts.ts` 的 `MrEffectsPort`（PR-5 T60 起就是结构同形）。

/** 一条线程里的单条消息（integration `MrThreadMessageFact` 的结构同形）。 */
export interface DevelopmentMrThreadMessageFact {
  readonly messageRef: string
  readonly parentMessageRef: string | null
  readonly authorClass: 'human' | 'bot' | 'self'
  readonly body: string
  readonly path: string | null
  readonly createdAt: string | null
}

/** 一条评审线程（integration `MrThreadFact` 的结构同形）。 */
export interface DevelopmentMrThreadFact {
  readonly threadRef: string
  readonly revision: string
  readonly authorClass: 'human' | 'bot' | 'self'
  readonly resolved: boolean
  readonly lastBody: string
  readonly path: string | null
  readonly messages: readonly DevelopmentMrThreadMessageFact[]
}

/**
 * MR 原始事实快照（integration `MrFactsSnapshot` 的结构同形，含本模块不读的字段）。快照对象原样
 * 进 `canonicalDigest`——`snapshotRef` 落库，字段必须一项不差。
 */
export interface DevelopmentMrFactsSnapshot {
  readonly mrRef: string
  readonly headSha: string | null
  readonly targetSha: string | null
  readonly targetBranch: string | null
  readonly state: 'opened' | 'merged' | 'closed'
  readonly draft: boolean
  readonly mergeableState: 'mergeable' | 'conflict' | 'unknown'
  readonly approvalHold: boolean | null
  readonly mergedCommitSha: string | null
  readonly mergedAt: string | null
  readonly threads: readonly DevelopmentMrThreadFact[]
}

/** 按仓库读一个 MR 的原始事实；绑定缺失是 `code-host-connection-missing`。 */
export interface DevelopmentMrFactsSourcePort {
  collect(
    repositoryId: string,
    mrRef: string,
    options: { readonly selfMarker: string },
  ): Promise<
    | { readonly ok: true; readonly snapshot: DevelopmentMrFactsSnapshot }
    | { readonly ok: false; readonly code: string; readonly detail: string }
  >
}

/** 仓库的代码托管认领键；仓库没有可解析的代码托管绑定时为 null。 */
export interface RepositoryCodeHostClaimKeysPort {
  resolve(
    repositoryId: string,
  ): Promise<{ readonly codeHostEndpointRef: string; readonly stableProjectRef: string } | null>
}

// RFC-395 II-a A6 — 场景拥有表和幂等域，机制只读写这个 journal 合同。
export type AtomicApplyState = 'prepared' | 'applying' | 'committed' | 'failed'

export interface AtomicApplyRow {
  readonly id: string
  readonly state: AtomicApplyState
  readonly preparedArtifactsJson: string
  readonly receiptJson: string | null
  readonly error: string | null
  readonly updatedAt: number
}

export interface AtomicApplyPatch {
  readonly state?: AtomicApplyState
  readonly preparedArtifactsJson?: string
  readonly receiptJson?: string | null
  readonly error?: string | null
  readonly updatedAt?: number
}

export interface AtomicApplyJournal<Tx, Key, Insert, Row extends AtomicApplyRow = AtomicApplyRow> {
  transaction<T>(run: (tx: Tx) => Promise<T>): Promise<T>
  find(tx: Tx, key: Key): Promise<Row | undefined>
  /** INSERT ON CONFLICT DO NOTHING；false 后由机制重读同一个幂等键。 */
  insert(
    tx: Tx,
    row: AtomicApplyRow & { readonly createdAt: number },
    data: Insert,
  ): Promise<boolean>
  compareAndSet(
    tx: Tx,
    id: string,
    expected: AtomicApplyState,
    patch: AtomicApplyPatch,
  ): Promise<boolean>
  list(): Promise<readonly Row[]>
}

export interface AtomicApplyErrors<Row extends AtomicApplyRow> {
  failedReplay(row: Row): Error
  unsettledReplay(row: Row): Error
  claimLost(): Error
  /** `lease`：claim 已被别的持有者接管（RFC-401 T4），本持有者的状态写被 fencing 拒绝。 */
  transitionLost(phase: 'claim' | 'commit' | 'artifact' | 'lease'): Error
  failed(error: unknown): string
  compensationIncomplete(error: unknown, errors: readonly unknown[]): string
  readonly committedIncomplete: string
}

export interface AtomicApplyArtifactCodec<Artifact> {
  decode(value: unknown): readonly Artifact[]
  encode(artifacts: readonly Artifact[]): unknown
}

export interface AtomicApplyArtifactRegistry<Artifact> {
  encode(artifacts: readonly Artifact[]): string
  decode(json: string): readonly Artifact[]
}

export interface AtomicApplyConvergenceReceipt {
  readonly failed: number
  readonly rolledForward: number
}

export type AtomicApplyWriteFormat = 'versioned-envelope'

/** Versioned recovery instructions, never an embedded epoch-1 SQL row. */
export type AtomicApplySkillRecovery =
  | {
      readonly kind: 'create'
      readonly operationId: string
      readonly rootDirectory: string
    }
  | {
      readonly kind: 'version'
      readonly operationId: string | null
      readonly publishId: string
      readonly skillName: string
      readonly contentHash: string
      readonly liveDirectory: string
    }

export type AtomicApplyClaim<Value, Receipt> =
  | { readonly kind: 'replay'; readonly receipt: Receipt }
  | { readonly kind: 'claimed'; readonly journalId: string; readonly value: Value }

/**
 * RFC-401 T4（design §10.1）—— 每条 journal 的持久 claim。`token` 是持有者这次 claim 的随机令牌，也是 fencing 依据：每一次
 * journal 状态写所在事务先以令牌续租，0 行即已被接管。`tail` 区分 committed 之后的尾部是否完成。
 */
export type AtomicApplyTailState = 'none' | 'pending' | 'complete'

export interface AtomicApplyClaimRow {
  readonly scene: string
  readonly journalId: string
  readonly claimedBy: string
  readonly leaseEpoch: number
  readonly claimExpiresAt: number
  readonly tailState: AtomicApplyTailState
}

export interface AtomicApplyClaims<Tx> {
  /** 与 journal 行同一事务插入（前台 claim）。 */
  insert(
    tx: Tx,
    claim: { readonly journalId: string; readonly token: string; readonly expiresAt: number },
    now: number,
  ): Promise<void>
  /** 以令牌续租（可同时改 tail）；0 行 = 已被接管。 */
  renew(
    tx: Tx,
    fence: {
      readonly journalId: string
      readonly token: string
      readonly expiresAt: number
      readonly tail?: AtomicApplyTailState
    },
    now: number,
  ): Promise<boolean>
  /** 恢复接管：只接管租约已过期或没有 claim 行（旧版本留下）的记录；成功时 lease_epoch + 1。 */
  takeOver(
    tx: Tx,
    claim: {
      readonly journalId: string
      readonly token: string
      readonly expiresAt: number
      readonly tail: AtomicApplyTailState
    },
    now: number,
  ): Promise<boolean>
  find(tx: Tx, journalId: string): Promise<AtomicApplyClaimRow | undefined>
}

export interface AtomicApplyRecoveryScene<
  Key extends string = string,
  Row extends AtomicApplyRow = AtomicApplyRow,
> {
  readonly key: Key
  readonly now?: () => number
  list(): Promise<readonly Row[]>
  /**
   * RFC-401 T4：恢复先接管 claim 再执行效果。`taken` = 以 `token` 接管成功；`held` = 他人持有未过期的 claim；
   * `complete` = committed 之后的尾部已完成，无事可做。
   */
  claim(
    row: Row,
    claim: { readonly token: string; readonly expiresAt: number; readonly now: number },
  ): Promise<'taken' | 'held' | 'complete'>
  /** 以接管令牌为 fencing 的 journal 写回；`tail` 同时改 claim 的尾部状态，`release` 释放租约。 */
  compareAndSet(
    row: Row,
    patch: AtomicApplyPatch,
    fence: {
      readonly token: string
      readonly now: number
      readonly tail?: AtomicApplyTailState
      readonly release?: boolean
    },
  ): Promise<boolean>
  recover(row: Row, action: 'compensate' | 'roll-forward'): Promise<boolean | void>
  readonly errors: {
    readonly abandoned: string
    readonly committedIncomplete: string
    retryable(error: unknown, action: 'compensate' | 'roll-forward'): string
  }
  warn(error: unknown, row: Row, action: 'compensate' | 'roll-forward'): void
  warnScene(error: unknown): void
}

export interface AtomicApplyRecovery<Key extends string> {
  converge(
    activeByScene: Readonly<Record<Key, readonly string[]>>,
  ): Promise<AtomicApplyConvergenceReceipt>
}

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
  transitionLost(phase: 'claim' | 'commit' | 'artifact'): Error
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

export type AtomicApplyWriteFormat = 'head-array' | 'versioned-envelope'

export type AtomicApplyClaim<Value, Receipt> =
  | { readonly kind: 'replay'; readonly receipt: Receipt }
  | { readonly kind: 'claimed'; readonly journalId: string; readonly value: Value }

export interface AtomicApplyRecoveryScene<
  Key extends string = string,
  Row extends AtomicApplyRow = AtomicApplyRow,
> {
  readonly key: Key
  readonly now?: () => number
  list(): Promise<readonly Row[]>
  compareAndSet(row: Row, patch: AtomicApplyPatch): Promise<boolean>
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

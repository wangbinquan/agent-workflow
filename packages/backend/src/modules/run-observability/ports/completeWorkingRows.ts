/** Derived rows in the original snapshot connection's private TEMP workspace. */
export interface CompleteWorkingRow<T = unknown> {
  readonly key: string
  readonly document: T
}
export interface CompleteWorkingPage<T = unknown> {
  readonly items: readonly CompleteWorkingRow<T>[]
  readonly nextCursor: string | null
}
export interface CompleteWorkingRows {
  insert(namespace: string, rows: readonly CompleteWorkingRow[]): Promise<void>
  put(namespace: string, row: CompleteWorkingRow): Promise<void>
  upsert(namespace: string, rows: readonly CompleteWorkingRow[]): Promise<void>
  get<T>(namespace: string, key: string): Promise<T | undefined>
  getMany<T>(namespace: string, keys: readonly string[]): Promise<ReadonlyMap<string, T>>
  page<T>(
    namespace: string,
    after: string | null,
    size?: number,
  ): Promise<{
    readonly items: readonly CompleteWorkingRow<T>[]
    readonly nextCursor: string | null
  }>
  clear(namespace: string): Promise<void>
}

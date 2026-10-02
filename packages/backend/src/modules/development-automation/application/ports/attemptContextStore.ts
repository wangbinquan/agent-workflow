/** Immutable JSON contexts pinned by opaque references across attempt and pipeline turns. */
export interface AttemptContextStorePort {
  save(json: string): Promise<string>
  load(ref: string): string | null | Promise<string | null>
}

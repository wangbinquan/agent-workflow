type Completion<T> = T | Promise<T>

/** Durable path-named fields are references interpreted only by the selected store. */
export interface ResourcePackageRecoveryEffectsFactory {
  root(skillId: string): string
  live(skillId: string): string
  version(skillId: string, version: number): string
  staged(liveReference: string, publicationId: string): string
  candidate(versionReference: string, publicationId: string): string
  normalize(reference: string): string
  parent(reference: string): string
  storedReference(reference: string): string
  assertManaged(rootReference: string, reference: string): void
  acquire(): Completion<ResourcePackageRecoveryEffects>
}

/** A complete storage lifetime; AW retains receipt, generation and DB decisions. */
export interface ResourcePackageRecoveryEffects {
  exists(reference: string): Completion<boolean>
  createDirectory(reference: string, mode?: number): Completion<void>
  removeDirectory(reference: string): Completion<void>
  move(sourceReference: string, targetReference: string): Completion<void>
  cleanupOperation(liveReference: string, publicationId: string): Completion<void>
  swapStaged(liveReference: string, publicationId: string): Completion<{ hadPrevious: boolean }>
  restoreBackup(liveReference: string, publicationId: string): Completion<boolean>
  directoryChainState(
    rootReference: string,
    reference: string,
  ): Completion<'missing' | 'real-directory'>
  /** The existing AW sorted-relative-name/NUL/content/NUL digest, including native errors. */
  hashRegularTree(reference: string): Completion<string>
  close(): Completion<void>
}

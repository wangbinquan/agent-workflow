type Completion<T> = T | Promise<T>

export interface AutomationWorkspaceFileFacts {
  readonly kind: 'directory' | 'file' | 'symlink' | 'other'
  readonly mode: number
  readonly size: number
  readonly nlink: number
}

export interface AutomationWorkspaceDirectoryEntry {
  readonly name: string
  readonly kind: AutomationWorkspaceFileFacts['kind']
}

/** One complete tree-content lifetime; all references remain owner values. */
export interface AutomationWorkspaceEffects {
  exists(reference: string): Completion<boolean>
  inspect(
    reference: string,
    followLinks: boolean,
  ): Completion<AutomationWorkspaceFileFacts | undefined>
  listNames(reference: string): Completion<readonly string[]>
  listEntries(reference: string): Completion<readonly AutomationWorkspaceDirectoryEntry[]>
  readBytes(reference: string): Completion<Uint8Array>
  readText(reference: string): Completion<string>
  readLink(reference: string): Completion<string>
  createDirectory(reference: string, recursive: boolean): Completion<void>
  copyFile(source: string, target: string, exclusive: boolean): Completion<void>
  setMode(reference: string, mode: number): Completion<void>
  writeText(reference: string, text: string): Completion<void>
  close(): Completion<void>
}

/** RFC-370 §9.2 V3 — whole-tree operations that a selection may execute where
 * the files live. Each one runs the same native function as the in-process
 * walk (named after it); inputs and results are JSON values. */
export type AutomationWorkspaceTreeOperation =
  | 'business-tree-snapshot'
  | 'protected-root-snapshot'
  | 'validate-workspace-outcome'
  | 'action-scene-prepare'
  | 'action-tree-digest'

export interface AutomationWorkspaceTreeOperations {
  run(operation: AutomationWorkspaceTreeOperation, input: unknown): Promise<unknown>
}

/** Pure logical reference projection does not acquire or perform content I/O. */
export interface AutomationWorkspaceEffectsFactory {
  /** Selected owner root for scenes and frozen artifacts; absent for native compatibility. */
  readonly applicationRootReference?: string
  resolve(reference: string, ...relativeSegments: readonly string[]): string
  parent(reference: string): string
  acquire(): Completion<AutomationWorkspaceEffects>
  /** Present when the files live in a remote volume: tree walks then run as
   * one remote operation instead of one round trip per entry. Absent for the
   * native selection, whose callers walk in-process over `acquire`. */
  readonly treeOperations?: AutomationWorkspaceTreeOperations
}

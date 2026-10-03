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

/** Pure logical reference projection does not acquire or perform content I/O. */
export interface AutomationWorkspaceEffectsFactory {
  resolve(reference: string, ...relativeSegments: readonly string[]): string
  parent(reference: string): string
  acquire(): Completion<AutomationWorkspaceEffects>
}

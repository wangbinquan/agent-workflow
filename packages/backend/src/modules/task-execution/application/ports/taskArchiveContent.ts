/** Archive references are interpreted by the selected store; callers never perform physical I/O. */
export interface TaskArchiveContentPort {
  resolve(reference: string, ...segments: readonly string[]): string
  exists(reference: string): boolean | Promise<boolean>
  list(reference: string): readonly string[] | Promise<readonly string[]>
  createDirectory(reference: string): void | Promise<void>
  remove(reference: string, recursive?: boolean): void | Promise<void>
  move(from: string, to: string): void | Promise<void>
  appendText(reference: string, text: string): void | Promise<void>
  writeText(reference: string, text: string): void | Promise<void>
  restoreMovedDirectories(
    temporary: string,
    kind: 'runs' | 'logs',
    root: string,
  ): boolean | Promise<boolean>
}

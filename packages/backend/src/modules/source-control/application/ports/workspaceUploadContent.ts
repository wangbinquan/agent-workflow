/** The selected adapter alone interprets these workspace and content references. */
export interface WorkspaceUploadBinding {
  readonly workspaceRef: string
  readonly generation?: string
  readonly version?: string
}

type Effect<T> = T | Promise<T>

/** A complete receiver for one upload batch; no physical paths or Stats cross it. */
export interface WorkspaceUploadContent {
  prepareTarget(relativeDirectory: string): Effect<{
    readonly directoryRef: string
    readonly packedDirectory: string
  }>
  file(directoryRef: string, filename: string): Effect<string>
  entry(fileRef: string): Effect<'file' | 'directory' | 'other' | 'missing'>
  read(fileRef: string): Effect<Uint8Array>
  remove(fileRef: string): Effect<void>
  write(fileRef: string, bytes: Uint8Array): Effect<void>
}

export interface WorkspaceUploadContentFactory {
  bind(binding: WorkspaceUploadBinding): Effect<WorkspaceUploadContent>
}

/** Native compatibility retains synchronous effects without a second policy. */
export type SynchronousWorkspaceUploadContent = {
  [K in keyof WorkspaceUploadContent]: (
    ...args: Parameters<WorkspaceUploadContent[K]>
  ) => Awaited<ReturnType<WorkspaceUploadContent[K]>>
}

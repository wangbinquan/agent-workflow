/** RFC-370: the selected adapter alone interprets workspace/archive bindings. */
export interface PortArtifactWorkspaceFile {
  readonly workspaceRef: string
  readonly relativePath: string
  readonly generation?: string
  readonly version?: string
}

export interface PortArtifactArchiveNamespace {
  readonly taskId: string
  readonly nodeRunId: string
  readonly portName: string
}

export type PortArtifactLinkTarget =
  | { readonly kind: 'inside'; readonly relativePath: string }
  | { readonly kind: 'outside' }
  | null

type Effect<T> = T | Promise<T>

export interface PortArtifactContentEffects {
  prepareArchive(namespace: PortArtifactArchiveNamespace): Effect<void>
  reference(namespace: PortArtifactArchiveNamespace, index: number, extension: string): string
  size(source: PortArtifactWorkspaceFile): Effect<number>
  copy(source: PortArtifactWorkspaceFile, reference: string): Effect<void>
  readPrefix(source: PortArtifactWorkspaceFile, maxBytes: number): Effect<Uint8Array>
  write(reference: string, bytes: Uint8Array): Effect<void>
  linkTarget(source: PortArtifactWorkspaceFile): Effect<PortArtifactLinkTarget>
  readArchive(taskId: string, reference: string): Effect<Uint8Array | null>
  existsArchive(taskId: string, reference: string): Effect<boolean>
  readWorkspace(source: PortArtifactWorkspaceFile): Effect<Uint8Array | null>
  existsWorkspace(source: PortArtifactWorkspaceFile): Effect<boolean>
}

/** Used exclusively by the native synchronous compatibility composition. */
export type SynchronousPortArtifactContentEffects = {
  [K in keyof PortArtifactContentEffects]: (
    ...args: Parameters<PortArtifactContentEffects[K]>
  ) => Awaited<ReturnType<PortArtifactContentEffects[K]>>
}

export interface PortArchiveItem {
  /** 容器相对源路径。 */
  path: string
  /** appHome 相对归档副本路径；超限二进制不存副本 → null（D12）。 */
  file: string | null
  /** 源文件原始字节数。 */
  size: number
  truncated: boolean
  /**
   * D19（Codex 实现门 P2）：端口值为 symlink 且目标在 worktree 内时，目标的
   * 容器相对路径。必达清单从 archive_json 重建（forcedPortPathsForTask）——
   * 不持久化目标的话，下游 base 快照只 add -f 链接本体、丢掉被 ignore 的
   * 目标，得到悬挂 symlink。
   */
  linkTarget?: string
}

export interface PortArchive {
  v: 1
  items: PortArchiveItem[]
}

export interface ArchivePortArtifactsResult {
  archiveJson: string
  /** repo0 相对源路径清单（T4 必达 merge-back 用）。 */
  portFilePaths: string[]
}

export interface PortArtifactReadItem {
  /** 容器相对源路径；存量行 worktree 回退时 = content 行；missing 时可为 null。 */
  path: string | null
  /** 文本消费面（UTF-8 解码只发生在这里；二进制消费方用 bytes）。 */
  body: string
  /** 原始字节（API 下载面）。missing 时为空 Buffer。 */
  bytes: Uint8Array
  /** 源文件原始字节数（archive_json 透传；worktree 回退 = 实读字节数）。 */
  size: number
  truncated: boolean
  source: 'archive' | 'worktree' | 'missing'
}

export interface PortArtifactArchiveRequest extends PortArtifactArchiveNamespace {
  readonly items: readonly {
    readonly source: PortArtifactWorkspaceFile
    readonly sourcePath: string
  }[]
  readonly worktreeDirName: string
}

export interface PortArtifactReadRequest {
  readonly taskId: string
  readonly archiveJson: string | null
  readonly content: string
  readonly kind: string | null
  readonly fallbackWorkspaceRef: string | null
  readonly legacyRepoDirName?: string
  readonly only?: 'meta' | number
}

export interface PortArtifactReader {
  read(request: PortArtifactReadRequest): Promise<{ items: PortArtifactReadItem[] }>
}

export interface PortArtifactOperations extends PortArtifactReader {
  archive(request: PortArtifactArchiveRequest): Promise<ArchivePortArtifactsResult>
}

export interface NativeArchivePortArtifactsOptions extends PortArtifactArchiveNamespace {
  appHome: string
  items: Array<{ sourceAbs: string; sourcePath: string }>
  worktreeDirName: string
  worktreeRootAbs: string
}

/** The legacy synchronous shape is explicit; its field types retain the async reader contract. */
export interface NativeReadPortArtifactOptions {
  appHome: string
  readonly taskId: string
  readonly archiveJson: string | null
  readonly content: string
  readonly kind: string | null
  fallbackWorktreeRoot: string | null
  readonly legacyRepoDirName?: string
  readonly only?: 'meta' | number
}

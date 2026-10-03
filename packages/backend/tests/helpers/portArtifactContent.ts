// RFC-370: test transport for the complete content contract. No native paths are interpreted.
import type {
  PortArtifactArchiveNamespace,
  PortArtifactContentEffects,
  PortArtifactLinkTarget,
  PortArtifactWorkspaceFile,
} from '@/modules/task-execution/application/ports/portArtifactContent'

export function held<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

export function callablePromise<T>(promise: Promise<T>): Promise<T> {
  return Object.assign(() => {}, {
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
    [Symbol.toStringTag]: 'Promise',
  })
}

type Barrier = () => void | Promise<void>

export class MemoryPortArtifactContent implements PortArtifactContentEffects {
  readonly calls: string[] = []
  readonly archives = new Map<string, Uint8Array>()
  readonly workspace = new Map<string, Uint8Array>()
  readonly links = new Map<string, PortArtifactLinkTarget>()
  readonly sizes = new Map<string, number>()
  readonly sources: PortArtifactWorkspaceFile[] = []
  #barriers: Readonly<{ copy?: Barrier; write?: Barrier; read?: Barrier; meta?: Barrier }>

  constructor(
    barriers: Readonly<{ copy?: Barrier; write?: Barrier; read?: Barrier; meta?: Barrier }> = {},
  ) {
    this.#barriers = barriers
  }
  key(source: PortArtifactWorkspaceFile) {
    return source.workspaceRef + '\0' + source.relativePath
  }
  put(source: PortArtifactWorkspaceFile, bytes: Uint8Array) {
    this.workspace.set(this.key(source), bytes)
  }
  async prepareArchive(namespace: PortArtifactArchiveNamespace) {
    this.calls.push('prepare:' + namespace.portName)
  }
  reference(namespace: PortArtifactArchiveNamespace, index: number, extension: string) {
    this.calls.push('reference:' + index)
    return (
      'object:' +
      namespace.taskId +
      '/' +
      namespace.nodeRunId +
      '/' +
      namespace.portName +
      '/' +
      index +
      extension
    )
  }
  async size(source: PortArtifactWorkspaceFile) {
    this.calls.push('size:' + source.relativePath)
    this.sources.push(source)
    return this.sizes.get(this.key(source)) ?? this.workspace.get(this.key(source))!.byteLength
  }
  async copy(source: PortArtifactWorkspaceFile, reference: string) {
    this.calls.push('copy:' + source.relativePath)
    await this.#barriers.copy?.()
    this.archives.set(reference, Uint8Array.from(this.workspace.get(this.key(source))!))
    this.calls.push('copy-ack')
  }
  async readPrefix(source: PortArtifactWorkspaceFile, maxBytes: number) {
    this.calls.push('prefix:' + maxBytes)
    return this.workspace.get(this.key(source))!.slice(0, maxBytes)
  }
  async write(reference: string, bytes: Uint8Array) {
    this.calls.push('write')
    await this.#barriers.write?.()
    this.archives.set(reference, Uint8Array.from(bytes))
    this.calls.push('write-ack')
  }
  async linkTarget(source: PortArtifactWorkspaceFile) {
    this.calls.push('link:' + source.relativePath)
    return this.links.get(this.key(source)) ?? null
  }
  async readArchive(_taskId: string, reference: string) {
    this.calls.push('read:' + reference)
    await this.#barriers.read?.()
    return this.archives.get(reference) ?? null
  }
  async existsArchive(_taskId: string, reference: string) {
    this.calls.push('exists:' + reference)
    await this.#barriers.meta?.()
    return this.archives.has(reference)
  }
  async readWorkspace(source: PortArtifactWorkspaceFile) {
    this.calls.push('workspace-read:' + source.relativePath)
    this.sources.push(source)
    return this.workspace.get(this.key(source)) ?? null
  }
  async existsWorkspace(source: PortArtifactWorkspaceFile) {
    this.calls.push('workspace-exists:' + source.relativePath)
    this.sources.push(source)
    return this.workspace.has(this.key(source))
  }
}

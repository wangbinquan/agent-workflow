// RFC-370: complete in-memory upload transport with opaque references and real ACK barriers.
import type {
  WorkspaceUploadBinding,
  WorkspaceUploadContent,
  WorkspaceUploadContentFactory,
} from '@/modules/source-control/public/types'

type Entry = { kind: 'file'; bytes: Uint8Array } | { kind: 'directory' | 'other' }
type Barrier = (method: string, reference: string) => void | Promise<void>

export class MemoryWorkspaceUploadContent implements WorkspaceUploadContent {
  readonly calls: string[] = []
  readonly entries = new Map<string, Entry>()
  #barrier: Barrier

  constructor(barrier: Barrier = () => {}) {
    this.#barrier = barrier
  }
  key(directory: string, filename: string): string {
    return 'file:' + JSON.stringify(['directory:' + directory, filename])
  }
  #perform<T>(method: string, reference: string, action: () => T): T | Promise<T> {
    this.calls.push(method + ':' + reference)
    const pending = this.#barrier(method, reference)
    return pending === undefined ? action() : pending.then(action)
  }
  prepareTarget(relativeDirectory: string) {
    return this.#perform('prepare', relativeDirectory, () => ({
      directoryRef: 'directory:' + relativeDirectory,
      packedDirectory: relativeDirectory,
    }))
  }
  file(directoryRef: string, filename: string) {
    return this.#perform('file', filename, () => 'file:' + JSON.stringify([directoryRef, filename]))
  }
  entry(fileRef: string) {
    return this.#perform<Awaited<ReturnType<WorkspaceUploadContent['entry']>>>(
      'entry',
      fileRef,
      () => this.entries.get(fileRef)?.kind ?? 'missing',
    )
  }
  read(fileRef: string) {
    return this.#perform('read', fileRef, () => {
      const value = this.entries.get(fileRef)
      if (value?.kind !== 'file') throw new Error('memory-upload-file-missing')
      return value.bytes
    })
  }
  remove(fileRef: string) {
    return this.#perform('remove', fileRef, () => {
      this.entries.delete(fileRef)
    })
  }
  write(fileRef: string, bytes: Uint8Array) {
    return this.#perform('write', fileRef, () => {
      if (this.entries.has(fileRef)) throw new Error('memory-upload-existing')
      this.entries.set(fileRef, { kind: 'file', bytes: bytes.slice() })
    })
  }
}

export class MemoryWorkspaceUploadFactory implements WorkspaceUploadContentFactory {
  readonly bindings: WorkspaceUploadBinding[] = []
  #content: WorkspaceUploadContent
  #barrier: () => void | Promise<void>

  constructor(content: WorkspaceUploadContent, barrier: () => void | Promise<void> = () => {}) {
    this.#content = content
    this.#barrier = barrier
  }
  bind(binding: WorkspaceUploadBinding) {
    this.bindings.push(binding)
    const pending = this.#barrier()
    return pending === undefined ? this.#content : pending.then(() => this.#content)
  }
}

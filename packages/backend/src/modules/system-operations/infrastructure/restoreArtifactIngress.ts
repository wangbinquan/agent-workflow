// RFC-346 — platform-owned restore artifact ingress. Application contracts see
// only opaque refs; HTTP upload bytes and local filesystem paths stop here.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ulid } from 'ulid'
import type { RestoreArtifactRef } from '../public/types'

export interface RestoreArtifactUpload {
  arrayBuffer(): Promise<ArrayBuffer>
}

export interface RestoreArtifactIngressHandle {
  ingestHttpUpload(upload: RestoreArtifactUpload): Promise<RestoreArtifactRef>
  ingestLocalPath(path: string): RestoreArtifactRef
  release(ref: RestoreArtifactRef): void
}

export interface RestoreArtifactPathResolver {
  pathOf(ref: RestoreArtifactRef): string
}

export interface RestoreArtifactRegistry
  extends RestoreArtifactIngressHandle, RestoreArtifactPathResolver {}

interface ArtifactEntry {
  readonly path: string
  readonly removeOnRelease: boolean
}

export function createRestoreArtifactIngress(deps: {
  readonly uploadRoot: string
  readonly id?: () => string
}): RestoreArtifactRegistry {
  const entries = new WeakMap<RestoreArtifactRef, ArtifactEntry>()
  const nextId = deps.id ?? ulid

  const register = (entry: ArtifactEntry): RestoreArtifactRef => {
    const ref = Object.freeze({}) as RestoreArtifactRef
    entries.set(ref, entry)
    return ref
  }

  const ingress: RestoreArtifactRegistry = {
    async ingestHttpUpload(upload) {
      mkdirSync(deps.uploadRoot, { recursive: true })
      const path = join(deps.uploadRoot, `upload-${nextId()}.tar.gz`)
      try {
        writeFileSync(path, Buffer.from(await upload.arrayBuffer()))
        return register({ path, removeOnRelease: true })
      } catch (error) {
        rmSync(path, { force: true })
        throw error
      }
    },
    ingestLocalPath(path) {
      return register({ path, removeOnRelease: false })
    },
    pathOf(ref) {
      const entry = entries.get(ref)
      if (entry === undefined) throw new Error('restore artifact is no longer available')
      return entry.path
    },
    release(ref) {
      const entry = entries.get(ref)
      if (entry === undefined) return
      entries.delete(ref)
      if (entry.removeOnRelease) rmSync(entry.path, { force: true })
    },
  }
  return Object.freeze(ingress)
}

import {
  copyFileSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { ulid } from 'ulid'

import { createSha256DigestBuilder } from '@/util/hash'
import type { EmployeeInputArtifactPort } from '../composition/required-ports'

async function digestFile(path: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createSha256DigestBuilder()
  let bytes = 0
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path, { highWaterMark: 64 * 1024 })
    stream.on('data', (chunk) => {
      const data = chunk as Buffer
      hash.update(data)
      bytes += data.byteLength
    })
    stream.on('end', resolve)
    stream.on('error', reject)
  })
  return { sha256: hash.digestHex(), bytes }
}

export function createEmployeeInputArtifactStore(root: string): EmployeeInputArtifactPort {
  const blobPath = (ref: string): string => join(root, 'blobs', ref.slice(0, 2), ref)
  return {
    async putFile(absolutePath) {
      const stat = lstatSync(absolutePath)
      if (!stat.isFile()) throw new Error('employee input must be a regular file')
      const { sha256, bytes } = await digestFile(absolutePath)
      const destination = blobPath(sha256)
      if (!existsSync(destination)) {
        mkdirSync(dirname(destination), { recursive: true })
        const temporary = `${destination}.tmp-${ulid()}`
        copyFileSync(absolutePath, temporary)
        renameSync(temporary, destination)
      }
      return { blobRef: sha256, sha256, bytes }
    },
    hasBlob: (blobRef) => existsSync(blobPath(blobRef)),
    copyBlobTo(blobRef, absoluteTargetPath) {
      const source = blobPath(blobRef)
      if (!existsSync(source)) throw new Error(`employee input artifact missing: ${blobRef}`)
      mkdirSync(dirname(absoluteTargetPath), { recursive: true })
      copyFileSync(source, absoluteTargetPath)
    },
  }
}

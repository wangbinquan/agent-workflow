import {
  closeSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { requireWorkPath } from '@/platform/crewstation/workVolumePath'
import { assertTargetDirInsideWorktree } from '@/platform/content/local/uploadPaths'
import { createFileWorkspaceUploadContentFactory } from '../infrastructure/local/fileWorkspaceUploadContent'
import { HOSTED_UPLOAD_CHUNK_BYTES } from '../infrastructure/crewstation/workspaceUploads'
import { createSha256DigestBuilder } from '@/util/hash'

export const TASK_IMAGE_UPLOAD_OPERATIONS = [
  'workspace-upload',
  'upload-begin',
  'upload-chunk',
  'upload-commit',
  'upload-abort',
] as const

interface UploadManifest {
  readonly workspace: string
  readonly file: string
  readonly uploadId: string
  readonly size: number
  readonly sha256: string
  readonly chunks: number
  readonly replace?: boolean
}

export async function executeTaskImageUploadOperation(
  operation: string,
  value: unknown,
  volumeRoot: string,
): Promise<unknown> {
  const workPath = (path: string) => requireWorkPath(path, volumeRoot)
  const target = (workspace: string, file: string) => {
    const root = workPath(workspace)
    const path = workPath(file)
    const rel = relative(root, path)
    if (!rel || rel === '..' || rel.startsWith('..' + sep))
      throw new Error('hosted-upload-target-outside-workspace')
    assertTargetDirInsideWorktree(root, dirname(path))
    return path
  }
  if (operation === 'workspace-upload') {
    const input = value as {
      workspace: string
      method: string
      relativeDirectory?: string
      file?: string
    }
    const scope = await createFileWorkspaceUploadContentFactory().bind({
      workspaceRef: workPath(input.workspace),
    })
    switch (input.method) {
      case 'prepareTarget':
        return scope.prepareTarget(input.relativeDirectory!)
      case 'entry':
        return scope.entry(target(input.workspace, input.file!))
      case 'remove':
        return scope.remove(target(input.workspace, input.file!))
      default:
        throw new Error('hosted-upload-operation-unknown')
    }
  }
  const input = value as UploadManifest & { index?: number; contentBase64?: string }
  if (
    !/^[0-9a-f-]{36}$/.test(input.uploadId) ||
    !/^[0-9a-f]{64}$/.test(input.sha256) ||
    !Number.isSafeInteger(input.size) ||
    input.size < 0 ||
    input.chunks !== Math.ceil(input.size / HOSTED_UPLOAD_CHUNK_BYTES) ||
    (input.replace !== undefined && typeof input.replace !== 'boolean')
  )
    throw new Error('hosted-upload-manifest-invalid')
  const file = target(input.workspace, input.file)
  const stage = workPath(join(volumeRoot, 'tmp', 'uploads', input.uploadId))
  const manifest = JSON.stringify({
    workspace: workPath(input.workspace),
    file,
    uploadId: input.uploadId,
    size: input.size,
    sha256: input.sha256,
    chunks: input.chunks,
    ...(input.replace === true ? { replace: true } : {}),
  })
  const receipt = join(stage, 'manifest.json')
  if (operation === 'upload-abort' && !existsSync(receipt)) return null
  if (operation === 'upload-begin') {
    mkdirSync(stage, { recursive: true })
    if (existsSync(receipt)) {
      if (readFileSync(receipt, 'utf8') !== manifest)
        throw new Error('hosted-upload-manifest-mismatch')
    } else writeFileSync(receipt, manifest, { flag: 'wx' })
    return null
  }
  if (readFileSync(receipt, 'utf8') !== manifest) throw new Error('hosted-upload-manifest-mismatch')
  if (operation === 'upload-abort') {
    rmSync(stage, { recursive: true, force: true })
    return null
  }
  if (operation === 'upload-chunk') {
    if (
      !Number.isSafeInteger(input.index) ||
      input.index! < 0 ||
      input.index! >= input.chunks ||
      typeof input.contentBase64 !== 'string' ||
      input.contentBase64.length > Math.ceil(HOSTED_UPLOAD_CHUNK_BYTES / 3) * 4
    )
      throw new Error('hosted-upload-chunk-invalid')
    const bytes = Buffer.from(input.contentBase64, 'base64')
    const expected = Math.min(
      HOSTED_UPLOAD_CHUNK_BYTES,
      input.size - input.index! * HOSTED_UPLOAD_CHUNK_BYTES,
    )
    if (bytes.length !== expected) throw new Error('hosted-upload-chunk-size-mismatch')
    const path = join(stage, `chunk-${input.index}`)
    if (existsSync(path)) {
      if (!readFileSync(path).equals(bytes)) throw new Error('hosted-upload-chunk-mismatch')
    } else writeFileSync(path, bytes, { flag: 'wx' })
    return null
  }
  if (operation !== 'upload-commit') throw new Error('hosted-upload-operation-unknown')
  const assembled = join(stage, 'assembled')
  // The same platform execution is never concurrently replayed; leftover
  // assembly can only be from an interrupted attempt, before publication.
  const fd = openSync(assembled, 'w')
  const hash = createSha256DigestBuilder()
  let size = 0
  try {
    for (let index = 0; index < input.chunks; index++) {
      const bytes = readFileSync(join(stage, `chunk-${index}`))
      size += bytes.length
      hash.update(bytes)
      let written = 0
      while (written < bytes.length) written += writeSync(fd, bytes, written)
    }
  } finally {
    closeSync(fd)
  }
  if (size !== input.size || hash.digestHex() !== input.sha256)
    throw new Error('hosted-upload-content-mismatch')
  target(input.workspace, input.file)
  if (input.replace === true) {
    const prior = lstatSync(file, { throwIfNoEntry: false })
    if (prior && !prior.isFile()) throw new Error('hosted-upload-replace-target-not-file')
    // A whole-file write creates its parents (checked inside the workspace
    // above), e.g. a tree-operation payload in a fresh scratch directory.
    mkdirSync(dirname(file), { recursive: true })
    renameSync(assembled, file)
  } else {
    // User upload policy retains wx semantics, including dangling symlinks.
    linkSync(assembled, file)
  }
  rmSync(stage, { recursive: true, force: true })
  return null
}

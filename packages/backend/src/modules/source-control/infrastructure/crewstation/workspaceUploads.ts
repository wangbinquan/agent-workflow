import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import type { CrewStationBusinessExecution } from '@/platform/crewstation/businessExecution'
import {
  WORKSPACE_TRANSFER_CHUNK_BYTES,
  WorkspaceCommandStoppedError,
  type WorkspaceHelper,
} from '@/platform/crewstation/workspaceProtocol'
import type { WorkspaceUploadContentFactory } from '../../application/ports/workspaceUploadContent'
import type { HostedTaskWorkspaces } from './taskWorkspace'
import { hostedWorkspaceReference, parseHostedWorkspaceReference } from './workspaceReference'
import { createSha256DigestBuilder, sha256Hex } from '@/util/hash'

/** One command carries one chunk inside its argv; the protocol budget keeps
 * argv + env below the task container's ARG_MAX (§9.2 V2). */
export const HOSTED_UPLOAD_CHUNK_BYTES = WORKSPACE_TRANSFER_CHUNK_BYTES

/** Pull one version-pinned page at a time; callers never buffer a whole artifact. */
export async function openHostedWorkspaceFile(
  input: { readonly api: CrewStationBusinessExecution; readonly workspaces: HostedTaskWorkspaces },
  reference: string,
): Promise<ReadableStream<Uint8Array>> {
  const file = parseHostedWorkspaceReference(reference)
  // A paused parent is resumed: platform file reads need it running (§9.2 V3).
  const task = await input.workspaces.open(file.taskId)
  if (task === null) throw new Error('hosted-workspace-not-found')
  let offset = 0
  let version: string | undefined
  let size: number | undefined
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const page = await input.api.readFile(task.businessTaskId, {
            path: file.relative,
            offset,
            limit: 1024 * 1024,
            ...(version === undefined ? {} : { version }),
          })
          version ??= page.version
          size ??= page.size
          const bytes = Buffer.from(page.contentBase64, 'base64')
          if (
            page.version !== version ||
            page.size !== size ||
            bytes.length > 1024 * 1024 ||
            offset + bytes.length > size ||
            (bytes.length === 0 && offset < size)
          )
            throw new Error('hosted-workspace-stream-receipt-mismatch')
          offset += bytes.length
          if (page.nextOffset !== (offset === size ? null : offset))
            throw new Error('hosted-workspace-stream-cursor-mismatch')
          if (bytes.length > 0) controller.enqueue(bytes)
          if (offset === size) controller.close()
        } catch (error) {
          controller.error(error)
        }
      },
    },
    { highWaterMark: 0 },
  )
}

/** CS versioned reads never combine bytes from distinct workspace versions. */
export async function readHostedWorkspaceFile(
  input: {
    readonly api: CrewStationBusinessExecution
    readonly workspaces: HostedTaskWorkspaces
  },
  reference: string,
): Promise<Uint8Array> {
  const file = parseHostedWorkspaceReference(reference)
  // A paused parent is resumed: platform file reads need it running (§9.2 V3).
  const task = await input.workspaces.open(file.taskId)
  if (task === null) throw new Error('hosted-workspace-not-found')
  const chunks: Uint8Array[] = []
  let offset = 0
  let version: string | undefined
  let size: number | undefined
  do {
    const page = await input.api.readFile(task.businessTaskId, {
      path: file.relative,
      offset,
      limit: 1024 * 1024,
      ...(version === undefined ? {} : { version }),
    })
    version ??= page.version
    size ??= page.size
    if (page.version !== version || page.size !== size)
      throw new Error('hosted-upload-read-version-changed')
    const bytes = Buffer.from(page.contentBase64, 'base64')
    if (bytes.length === 0 && offset < size) throw new Error('hosted-upload-read-incomplete')
    chunks.push(bytes)
    offset += bytes.length
  } while (offset < size)
  if (offset !== size) throw new Error('hosted-upload-read-size-mismatch')
  return Buffer.concat(chunks)
}

/** Upload policy, name collision handling and compensation stay in Task. */
export function createHostedWorkspaceUploads(input: {
  readonly helper: WorkspaceHelper
  readonly api: CrewStationBusinessExecution
  readonly workspaces: HostedTaskWorkspaces
}): WorkspaceUploadContentFactory {
  return {
    bind(binding) {
      const workspace = parseHostedWorkspaceReference(binding.workspaceRef)
      const locate = (reference: string) => {
        const file = parseHostedWorkspaceReference(reference)
        if (
          file.taskId !== workspace.taskId ||
          (file.path !== workspace.path && !file.path.startsWith(workspace.path + '/'))
        )
          throw new Error('hosted-upload-reference-owner-mismatch')
        return file
      }
      const call = <T>(method: string, extra: object) =>
        input.helper.call<T>(workspace.taskId, 'workspace-upload', {
          workspace: workspace.path,
          method,
          ...extra,
        })
      return {
        async prepareTarget(relativeDirectory) {
          const result = await call<{ directoryRef: string; packedDirectory: string }>(
            'prepareTarget',
            { relativeDirectory },
          )
          return {
            ...result,
            directoryRef: hostedWorkspaceReference(workspace.taskId, result.directoryRef),
          }
        },
        file(directoryRef, filename) {
          const directory = locate(directoryRef)
          if (
            !filename ||
            filename.includes('/') ||
            filename.includes('\\') ||
            filename.includes('\0') ||
            filename === '.' ||
            filename === '..'
          )
            throw new Error('upload-path-escape')
          return hostedWorkspaceReference(workspace.taskId, posix.join(directory.path, filename))
        },
        entry: (reference) => call('entry', { file: locate(reference).path }),
        remove: (reference) => call('remove', { file: locate(reference).path }),
        read(reference) {
          locate(reference)
          return readHostedWorkspaceFile(input, reference)
        },
        write(reference, bytes) {
          locate(reference)
          return writeHostedWorkspaceStream(input.helper, {
            workspaceRef: binding.workspaceRef,
            fileRef: reference,
            size: bytes.byteLength,
            sha256: sha256Hex(bytes),
            stream: new Blob([Uint8Array.from(bytes)]).stream(),
          })
        },
      }
    },
  }
}

/** Stream object bytes into the task volume in bounded command payloads. */
export async function writeHostedWorkspaceStream(
  helper: WorkspaceHelper,
  input: {
    readonly workspaceRef: string
    readonly fileRef: string
    readonly size: number
    readonly sha256: string
    readonly stream: ReadableStream<Uint8Array>
    readonly replace?: boolean
  },
): Promise<void> {
  const workspace = parseHostedWorkspaceReference(input.workspaceRef)
  const file = parseHostedWorkspaceReference(input.fileRef)
  if (file.taskId !== workspace.taskId || !file.path.startsWith(workspace.path + '/'))
    throw new Error('hosted-upload-reference-owner-mismatch')
  if (!Number.isSafeInteger(input.size) || input.size < 0 || !/^[a-f0-9]{64}$/.test(input.sha256))
    throw new Error('hosted-upload-manifest-invalid')
  const uploadId = randomUUID()
  const manifest = {
    workspace: workspace.path,
    file: file.path,
    uploadId,
    size: input.size,
    sha256: input.sha256,
    chunks: Math.ceil(input.size / HOSTED_UPLOAD_CHUNK_BYTES),
    ...(input.replace === true ? { replace: true } : {}),
  }
  const transfer = (operation: string, extra: object, stage: string) =>
    helper.call(
      workspace.taskId,
      operation,
      { ...manifest, ...extra },
      { operationId: `upload:${uploadId}:${stage}` },
    )
  const reader = input.stream.getReader()
  let remoteUnknown = false
  let received = 0
  let buffered = 0
  let index = 0
  const buffer = Buffer.alloc(Math.min(HOSTED_UPLOAD_CHUNK_BYTES, input.size))
  const hash = createSha256DigestBuilder()
  const send = async (bytes: Uint8Array) => {
    remoteUnknown = true
    await transfer(
      'upload-chunk',
      { index, contentBase64: Buffer.from(bytes).toString('base64') },
      `chunk:${index}`,
    )
    remoteUnknown = false
    index++
  }
  try {
    remoteUnknown = true
    await transfer('upload-begin', {}, 'begin')
    remoteUnknown = false
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      received += next.value.byteLength
      if (received > input.size) throw new Error('hosted-upload-content-mismatch')
      hash.update(next.value)
      let offset = 0
      while (offset < next.value.byteLength) {
        const count = Math.min(buffer.length - buffered, next.value.byteLength - offset)
        buffer.set(next.value.subarray(offset, offset + count), buffered)
        offset += count
        buffered += count
        if (buffered === buffer.length) {
          await send(buffer)
          buffered = 0
        }
      }
    }
    if (received !== input.size || hash.digestHex() !== input.sha256)
      throw new Error('hosted-upload-content-mismatch')
    if (buffered > 0) await send(buffer.subarray(0, buffered))
    remoteUnknown = true
    await transfer('upload-commit', {}, 'commit')
    remoteUnknown = false
  } catch (error) {
    await reader.cancel(error).catch(() => undefined)
    // A local stream failure or an observed terminal command cannot have a
    // writer in flight. An unknown remote command retains its staging.
    if (!remoteUnknown || error instanceof WorkspaceCommandStoppedError)
      await transfer('upload-abort', {}, 'abort').catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
}

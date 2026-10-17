// RFC-370 v3 V6 — binary skill files of a hosted Agent material. Each distinct
// file body of one execution is a publication of the neutral journal (owner
// `agent-material`, key `<sha256(executionId)>/<sha256>`, scope = task id). The AW pin
// is temporary: once CS acknowledges the material it holds its own references
// and the execution's publications are released. An execution that never
// reaches that acknowledgement is released by the task object sweep when its
// task is gone. Re-staging with changed skill bytes lands on a new key.
import type { CrewStationBusinessExecution } from '@/platform/crewstation/businessExecution'
import type { BusinessMaterialFile } from '@/platform/crewstation/nativeMaterial'
import type {
  HostedObjectPublications,
  HostedObjectReceipt,
} from '@/modules/system-operations/public/participants'
import { sha256Hex } from '@/util/hash'

export const HOSTED_MATERIAL_OWNER = 'agent-material'

export type HostedMaterialSourceFile =
  | BusinessMaterialFile
  | {
      readonly path: string
      readonly bytes: Uint8Array
      readonly mode?: number
    }
export interface HostedMaterialFiles {
  stage(input: {
    readonly executionId: string
    readonly taskId: string
    readonly businessTaskId: string
    readonly files: readonly HostedMaterialSourceFile[]
  }): Promise<readonly BusinessMaterialFile[]>
  published(executionId: string, materialId: string): Promise<void>
}

// The execution id is hashed so a key prefix can never match another execution.
const executionPrefix = (executionId: string) => `${sha256Hex(executionId)}/`
const materialKey = (executionId: string, sha256: string) =>
  `${executionPrefix(executionId)}${sha256}`

function assertMaterialFiles(files: readonly HostedMaterialSourceFile[]): void {
  const names = new Set<string>()
  for (const file of files) {
    if (
      names.has(file.path) ||
      file.path.startsWith('/') ||
      file.path.includes('\\') ||
      Array.from(file.path).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
      file.path
        .split('/')
        .some((part) => !part || part === '.' || part === '..' || part === '.crewstation')
    )
      throw new Error('hosted-material-file-path-invalid')
    if (
      file.mode !== undefined &&
      (!Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777)
    )
      throw new Error('hosted-material-file-mode-invalid')
    names.add(file.path)
  }
}

export function createHostedMaterialObjectUploads(input: {
  readonly api: Pick<CrewStationBusinessExecution, 'getTask'>
  readonly publications: HostedObjectPublications
}): { readonly files: HostedMaterialFiles } {
  const files: HostedMaterialFiles = {
    async stage(request) {
      assertMaterialFiles(request.files)
      if (request.executionId.length === 0) throw new Error('hosted-material-execution-invalid')
      const parent = await input.api.getTask(request.businessTaskId)
      if (parent.state !== 'running') throw new Error('hosted-material-parent-not-running')
      const bodies = new Map<string, Uint8Array>()
      for (const file of request.files)
        if ('bytes' in file) bodies.set(sha256Hex(file.bytes), file.bytes)
      const digests = [...bodies.keys()].sort()
      const receipts = await input.publications.publish(
        digests.map((sha256) => ({
          owner: HOSTED_MATERIAL_OWNER,
          key: materialKey(request.executionId, sha256),
          scope: request.taskId,
          bytes: bodies.get(sha256)!,
        })),
        { concurrency: 4 },
      )
      const byDigest = new Map<string, HostedObjectReceipt>(
        digests.map((sha256, index) => [sha256, receipts[index]!]),
      )
      return request.files.map((file) => {
        if (!('bytes' in file)) return file
        const object = byDigest.get(sha256Hex(file.bytes))!
        return {
          path: file.path,
          ...(file.mode === undefined ? {} : { mode: file.mode }),
          object: { objectId: object.id, sha256: object.sha256, size: object.size },
        }
      })
    },
    async published(executionId) {
      // The acknowledged CS material version now owns independent references.
      await input.publications.release({
        owner: HOSTED_MATERIAL_OWNER,
        keyPrefix: executionPrefix(executionId),
      })
    },
  }
  return { files }
}

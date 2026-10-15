import { eq } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import type { ProviderNeutralDatabase } from '@/db/query'
import { hostedTaskArtifacts } from '@/db/schema'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import type { CrewStationMutationFence } from '@/platform/crewstation/mutationFence'
import type { CrewStationBusinessExecution } from '@/platform/crewstation/businessExecution'
import type { CrewStationObjectStorage } from '@/platform/crewstation/objectStorage'
import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'
import type {
  PortArtifactContentEffects,
  PortArtifactWorkspaceFile,
  PortArtifactLinkTarget,
} from '../../application/ports/portArtifactContent'
import { portArchiveRootRel } from '../../application/portArtifacts'
import { encodePortSegment } from '../../domain/portArtifacts'

export function createHostedPortArtifactContent(input: {
  readonly db: ProviderNeutralDatabase
  readonly fence: CrewStationMutationFence
  readonly api: CrewStationBusinessExecution
  readonly objects: CrewStationObjectStorage
  readonly helper: WorkspaceHelper
  readonly locate: (
    reference: string,
    relative?: string,
  ) => { readonly taskId: string; readonly path: string; readonly relative: string }
  readonly workspace: { find(taskId: string): Promise<{ readonly businessTaskId: string } | null> }
}): PortArtifactContentEffects {
  const session = databaseSessionFor(input.db)
  const find = async (reference: string) =>
    (
      await input.db
        .select()
        .from(hostedTaskArtifacts)
        .where(eq(hostedTaskArtifacts.reference, reference))
        .limit(1)
    )[0]
  const readSource = async (
    source: PortArtifactWorkspaceFile,
    limit?: number,
  ): Promise<Uint8Array> => {
    const location = input.locate(source.workspaceRef, source.relativePath)
    const workspace = await input.workspace.find(location.taskId)
    if (workspace === null) throw new Error('hosted-workspace-not-found')
    const chunks: Buffer[] = []
    let offset = 0
    let version: string | undefined
    let remaining = limit ?? 64 * 1024 * 1024
    while (remaining > 0) {
      const page = await input.api.readFile(workspace.businessTaskId, {
        path: location.relative,
        offset,
        limit: Math.min(remaining, 1024 * 1024),
        ...(version === undefined ? {} : { version }),
      })
      const bytes = Buffer.from(page.contentBase64, 'base64')
      chunks.push(bytes)
      remaining -= bytes.length
      version = page.version
      if (page.nextOffset === null) break
      if (page.nextOffset <= offset || bytes.length === 0)
        throw new Error('hosted-workspace-file-cursor-stalled')
      offset = page.nextOffset
      if (remaining === 0 && limit === undefined)
        throw new Error('hosted-artifact-exceeds-read-limit')
    }
    return Buffer.concat(chunks)
  }
  const write = async (reference: string, bytes: Uint8Array): Promise<void> => {
    const match = /^runs\/([^/]+)\/ports\//.exec(reference)
    if (match === null) throw new Error('hosted-port-artifact-reference-invalid')
    const digest = createHash('sha256').update(bytes).digest('hex')
    const existing = await find(reference)
    if (existing !== undefined) {
      if (existing.digest !== digest) throw new Error('hosted-port-artifact-content-changed')
      return
    }
    const object = await input.objects.put(reference, bytes)
    const lease = input.fence.current()
    await session.transaction(async (tx) => {
      await input.fence.assertHeld(tx, lease)
      await tx
        .insert(hostedTaskArtifacts)
        .values({
          reference,
          taskId: match[1]!,
          objectId: object.id,
          revision: object.revision,
          digest,
          size: bytes.byteLength,
          createdAt: Date.now(),
        })
        .onConflictDoNothing()
      const saved = (
        await tx
          .select()
          .from(hostedTaskArtifacts)
          .where(eq(hostedTaskArtifacts.reference, reference))
          .limit(1)
      )[0]
      if (saved?.digest !== digest) throw new Error('hosted-port-artifact-content-changed')
    })
  }
  const info = (source: PortArtifactWorkspaceFile) => {
    const location = input.locate(source.workspaceRef)
    return input.helper.call<{ size: number; linkTarget: PortArtifactLinkTarget }>(
      location.taskId,
      'file-info',
      {
        workspaceRef: location.path,
        relativePath: source.relativePath,
      },
    )
  }
  return {
    prepareArchive: async () => undefined,
    reference: (namespace, index, extension) =>
      `${portArchiveRootRel(namespace.taskId, namespace.nodeRunId).replace(/\\/g, '/')}/${encodePortSegment(namespace.portName)}/item_${index}${extension}`,
    size: async (source) => (await info(source)).size,
    copy: async (source, reference) => write(reference, await readSource(source)),
    readPrefix: readSource,
    write,
    linkTarget: async (source) => (await info(source)).linkTarget,
    async readArchive(taskId, reference) {
      const row = await find(reference)
      if (row === undefined || row.taskId !== taskId) return null
      const bytes = await input.objects.read(row.objectId)
      if (
        bytes.byteLength !== row.size ||
        createHash('sha256').update(bytes).digest('hex') !== row.digest
      )
        throw new Error('hosted-port-artifact-digest-mismatch')
      return bytes
    },
    async existsArchive(taskId, reference) {
      return (await find(reference))?.taskId === taskId
    },
    readWorkspace: (source) => readSource(source),
    async existsWorkspace(source) {
      const location = input.locate(source.workspaceRef, source.relativePath)
      return input.helper.call(location.taskId, 'exists', { path: location.path })
    },
  }
}

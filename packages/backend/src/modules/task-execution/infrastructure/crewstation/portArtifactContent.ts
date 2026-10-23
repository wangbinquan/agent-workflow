import {
  legacyHostedPortArchivePath,
  legacyPortArchiveTask,
  decodeLegacyPortArchiveFile,
} from '@/platform/content/legacyPortArchive'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { eq } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { HostedObjectPublications } from '@/modules/system-operations/public/participants'
import type { CrewStationMutationFence } from '@/platform/crewstation/mutationFence'
import type { CrewStationBusinessExecution } from '@/platform/crewstation/businessExecution'
import type { CrewStationObjectStorage } from '@/platform/crewstation/objectStorage'
import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'
import type {
  PortArtifactContentEffects,
  PortArtifactWorkspaceFile,
  PortArtifactLinkTarget,
} from '../../application/ports/portArtifactContent'
import { HOSTED_TASK_ARTIFACT_OWNER, retainHostedTaskArtifactInTx } from './taskArtifacts'
import { sha256Hex } from '@/util/hash'

export function createHostedPortArtifactContent(input: {
  readonly db: PersistenceDb
  readonly fence: CrewStationMutationFence
  readonly api: CrewStationBusinessExecution
  readonly objects: CrewStationObjectStorage
  /** Port bytes are `task-artifact` publications (scope = task id). */
  readonly publications: HostedObjectPublications
  readonly helper: WorkspaceHelper
  readonly locate: (
    reference: string,
    relative?: string,
  ) => { readonly taskId: string; readonly path: string; readonly relative: string }
  /** `open` resumes a paused parent: platform file reads need it running. */
  readonly workspace: { open(taskId: string): Promise<{ readonly businessTaskId: string } | null> }
}): PortArtifactContentEffects {
  const find = async (reference: string) => {
    const { hostedTaskArtifacts } = tablesOf(input.db)
    return (
      await input.db
        .select()
        .from(hostedTaskArtifacts)
        .where(
          eq(
            hostedTaskArtifacts.reference,
            decodeLegacyPortArchiveFile(reference, 'object').location.value,
          ),
        )
        .limit(1)
    )[0]
  }
  const readSource = async (
    source: PortArtifactWorkspaceFile,
    limit?: number,
  ): Promise<Uint8Array> => {
    const location = input.locate(source.workspaceRef, source.relativePath)
    const workspace = await input.workspace.open(location.taskId)
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
    const taskId = legacyPortArchiveTask(reference)
    if (taskId === null) throw new Error('hosted-port-artifact-reference-invalid')
    const digest = sha256Hex(bytes)
    const existing = await find(reference)
    if (existing !== undefined) {
      if (existing.digest !== digest) throw new Error('hosted-port-artifact-content-changed')
      return
    }
    await input.publications.publish(
      [{ owner: HOSTED_TASK_ARTIFACT_OWNER, key: reference, scope: taskId, bytes }],
      {
        async commit(tx, [object]) {
          await retainHostedTaskArtifactInTx(tx, { reference, taskId: taskId, object: object! })
        },
      },
    )
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
      legacyHostedPortArchivePath(
        namespace.taskId,
        namespace.nodeRunId,
        namespace.portName,
        index,
        extension,
      ),
    size: async (source) => (await info(source)).size,
    copy: async (source, reference) => write(reference, await readSource(source)),
    readPrefix: readSource,
    write,
    linkTarget: async (source) => (await info(source)).linkTarget,
    async readArchive(taskId, reference) {
      const row = await find(reference)
      if (row === undefined || row.taskId !== taskId) return null
      const bytes = await input.objects.read(row.objectId)
      if (bytes.byteLength !== row.size || sha256Hex(bytes) !== row.digest)
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

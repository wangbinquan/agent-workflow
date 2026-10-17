// RFC-370 v3 V6 — what a hosted task archive move captures for `runs/<task>`
// and `logs/<task>`: object-backed task artifacts, review documents and node
// event chunks (linked by object id), plus the task's work-volume files
// (enumerated in the task image, uploaded once).
import { eq } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { hostedTaskArtifacts, tasks } from '@/db/schema'
import type {
  CrewStationStreamObjectStorage,
  HostedStoredObject,
} from '@/platform/crewstation/objectStorage'
import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'
import type { HostedArchiveFile, HostedArchiveSources } from './taskArchiveContent'

export function createHostedTaskArchiveSources(input: {
  readonly db: ProviderNeutralDatabase
  readonly objects: Pick<CrewStationStreamObjectStorage, 'open'>
  readonly helper: WorkspaceHelper
  readonly locate: (reference: string) => { taskId: string }
  readonly reference: (taskId: string, path: string) => string
  readonly workspaces: { find(taskId: string): Promise<unknown | null> }
  readonly openFile: (reference: string) => Promise<ReadableStream<Uint8Array>>
  readonly reviewFiles: (
    taskId: string,
  ) => Promise<readonly { reference: string; object: HostedStoredObject }[]>
  readonly eventFiles?: (
    taskId: string,
  ) => Promise<readonly { path: string; object: HostedStoredObject }[]>
}): HostedArchiveSources {
  const sources = async (kind: 'runs' | 'logs', taskId: string) => {
    const files = new Map<string, HostedArchiveFile>()
    const prefix = `${kind}/${taskId}/`
    const addObject = (reference: string, object: HostedStoredObject) => {
      if (!reference.startsWith(prefix)) throw new Error('hosted-archive-object-owner-mismatch')
      const path = reference.slice(prefix.length)
      files.set(path, {
        path,
        sha256: object.sha256,
        size: object.size,
        object,
        open: () => input.objects.open(object),
      })
    }
    if (kind === 'runs') {
      for (const row of await input.db
        .select()
        .from(hostedTaskArtifacts)
        .where(eq(hostedTaskArtifacts.taskId, taskId)))
        addObject(row.reference, { id: row.objectId, sha256: row.digest, size: row.size })
      for (const file of await input.reviewFiles(taskId)) addObject(file.reference, file.object)
    }
    if (kind === 'logs')
      for (const file of (await input.eventFiles?.(taskId)) ?? [])
        addObject(`${prefix}${file.path}`, file.object)
    const task = (
      await input.db
        .select({ workspace: tasks.worktreePath })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .limit(1)
    )[0]
    const owner = task?.workspace ? input.locate(task.workspace).taskId : taskId
    const workspace = await input.workspaces.find(owner)
    if (task?.workspace && !workspace) throw new Error('hosted-archive-source-volume-unavailable')
    let exists = files.size > 0
    if (workspace) {
      const snapshot = await input.helper.call<{
        exists: boolean
        files: { path: string; size: number; sha256: string }[]
      }>(owner, 'archive-task-files', { kind, taskId })
      exists ||= snapshot.exists
      for (const file of snapshot.files) {
        const prior = files.get(file.path)
        if (prior) {
          // The same bytes already exist as an object: link that object.
          if (prior.sha256 !== file.sha256 || prior.size !== file.size)
            throw new Error('hosted-archive-source-collision')
          continue
        }
        const reference = input.reference(owner, `/work/${kind}/${taskId}/${file.path}`)
        files.set(file.path, { ...file, open: () => input.openFile(reference) })
      }
    }
    return { exists, files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)) }
  }
  return {
    exists: async (kind, taskId) => (await sources(kind, taskId)).exists,
    snapshot: async (kind, taskId) => (await sources(kind, taskId)).files,
  }
}

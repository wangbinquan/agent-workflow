import type { RepositoryWorkspaceTaskPorts } from '../../composition/required-ports'
import type { SecretBox } from '@/auth/secretBox'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import {
  WorkspaceCommandStoppedError,
  type WorkspaceHelper,
} from '@/platform/crewstation/workspaceProtocol'
import { randomUUID } from 'node:crypto'
import { unsealRepoUrl } from '@/services/repoCredentials'
import { composeRepositoryWorkspaceStore } from '../repositoryWorkspaceStore'
import { hostedWorkspaceReference } from './workspaceReference'
import { assertHostedRepositoryUrl } from './repositoryUrl'

/** Canonical development baselines and employee scenes share an owner volume;
 * task runs still materialize their own task-scoped repository copies. */
export function createHostedDevelopmentRepositoryPreparation(input: {
  readonly taskPorts: RepositoryWorkspaceTaskPorts
  readonly db: PersistenceDb
  readonly helper: WorkspaceHelper
  readonly secretBox: SecretBox
  readonly taskId: string
}) {
  const store = composeRepositoryWorkspaceStore(input.db, input.taskPorts)
  const writers = new Map<string, Promise<unknown>>()
  const pending = new Map<
    string,
    {
      readonly operationId: string
      readonly urlHash: string
      readonly request: { readonly id: string; readonly url: string; readonly ref?: string }
    }
  >()
  return {
    prepare(request: { readonly repositoryId: string }) {
      const previous = writers.get(request.repositoryId)
      const operation = Promise.resolve(previous)
        .catch(() => undefined)
        .then(async () => {
          const row = await store.findCachedRepoById(request.repositoryId)
          if (row === null) throw new Error('cached-repo-not-found')
          const url = unsealRepoUrl(row, input.secretBox, store)
          if (url === null) throw new Error('cached-repo-credential-unavailable')
          assertHostedRepositoryUrl(url)
          const frozen = pending.get(row.id) ?? {
            operationId: `development-repository:${row.id}:${randomUUID()}`,
            urlHash: row.urlHash,
            request: { id: row.id, url, ref: row.defaultBranch ?? undefined },
          }
          pending.set(row.id, frozen)
          let resolved: { path: string; defaultBranch: string }
          try {
            resolved = await input.helper.call(
              input.taskId,
              'prepare-development-repository',
              frozen.request,
              { operationId: frozen.operationId },
            )
            pending.delete(row.id)
          } catch (error) {
            if (error instanceof WorkspaceCommandStoppedError) pending.delete(row.id)
            throw error
          }
          if (row.urlHash !== frozen.urlHash) throw new Error('cached-repo-identity-mismatch')
          const localPath = hostedWorkspaceReference(input.taskId, resolved.path)
          if (
            !(await store.updateCachedRepo(
              row.id,
              { localPath, defaultBranch: resolved.defaultBranch, lastFetchedAt: Date.now() },
              row.urlHash,
            ))
          )
            throw new Error('cached-repo-identity-mismatch')
          return { id: row.id, localPath, defaultBranch: resolved.defaultBranch }
        })
      writers.set(request.repositoryId, operation)
      const release = () => {
        if (writers.get(request.repositoryId) === operation) writers.delete(request.repositoryId)
      }
      void operation.then(release, release)
      return operation
    },
  }
}

// RFC-370 §10 V17 — repository remote reads as one task-image command each,
// in the scratch volume of hosted system work. It follows the running release,
// so its helper always knows the command (as the MCP probe does), and it
// receives the deployment's Git credentials bound to exact remote URLs.
import { ulid } from 'ulid'
import { z } from 'zod'
import { RepoFilesResponseSchema, RepoRefsResponseSchema } from '@agent-workflow/shared'
import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'
import type { RepositoryRemoteEffects } from '../../application/ports/repositoryMirrors'

const OWNER = 'system:shared'
export const REPOSITORY_REMOTE_OPERATION = 'repository-remote'
/** Two bounded Git network steps plus admission and helper start. */
export const HOSTED_REPOSITORY_REMOTE_TIMEOUT_MS = 300_000

const Facts = z.object({ defaultBranch: z.string().nullable() })

export function createHostedRepositoryRemote(input: {
  readonly helper: WorkspaceHelper
}): RepositoryRemoteEffects {
  const call = (method: 'refs' | 'files' | 'verify', url: string) =>
    input.helper.call<unknown>(
      OWNER,
      REPOSITORY_REMOTE_OPERATION,
      { method, url },
      {
        operationId: `${REPOSITORY_REMOTE_OPERATION}:${method}:${ulid()}`,
        timeoutMs: HOSTED_REPOSITORY_REMOTE_TIMEOUT_MS,
      },
    )
  return {
    refs: async (url) => RepoRefsResponseSchema.parse(await call('refs', url)),
    files: async (url) => RepoFilesResponseSchema.parse(await call('files', url)),
    verify: async (url) => Facts.parse(await call('verify', url)),
  }
}

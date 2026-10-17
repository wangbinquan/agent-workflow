// RFC-370 §9.2 V3 — repository publication on a hosted volume. The task's
// worktree lives in a CrewStation task volume, so a publication's network Git
// (push / fetch / ls-remote of the commit-and-push runner) runs there through
// the task-image `git` command, which receives the deployment's Git
// credentials (AW_GIT_CREDENTIAL_BINDINGS) as platform Secret references. The
// control plane never runs Git against a `cs-workspace:` reference itself.
import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'
import { credentialFreeHttpUrl } from '@/util/gitCredentialLease'
import type {
  RepositoryPublicationGitResult,
  RepositoryPublicationSession,
  RepositoryPublicationTransport,
} from '../../public/types'
import { parseHostedWorkspaceReference } from './workspaceReference'

export function createHostedRepositoryPublicationTransport(input: {
  readonly helper: WorkspaceHelper
}): RepositoryPublicationTransport {
  return {
    async open({ remoteUrl }) {
      let closed = false
      const session: RepositoryPublicationSession = {
        endpointUrl: credentialFreeHttpUrl(remoteUrl) ?? remoteUrl,
        receipt: {
          credentialSource: 'global',
          credentialRevision: null,
          endpointSource: 'legacy-remote',
          endpointBindingDigest: null,
        },
        async runNetwork(repoPath, args, options) {
          if (closed) throw new Error('repository publication session is closed')
          const location = parseHostedWorkspaceReference(repoPath)
          return input.helper.call<RepositoryPublicationGitResult>(
            location.taskId,
            'git',
            {
              path: location.path,
              args: [...args],
              options: {
                ...(options?.env === undefined ? {} : { env: options.env }),
                ...(options?.stdin === undefined ? {} : { stdin: options.stdin }),
                ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
              },
            },
            {
              ...(options?.signal === undefined ? {} : { signal: options.signal }),
              ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
            },
          )
        },
        close() {
          closed = true
        },
      }
      return { ok: true, session }
    },
  }
}

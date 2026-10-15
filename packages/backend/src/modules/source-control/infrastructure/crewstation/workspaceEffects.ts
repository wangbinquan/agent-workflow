import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'
import type { CrewStationBusinessExecution } from '@/platform/crewstation/businessExecution'
import type {
  RepositoryGitWorkspaceFactory,
  RepositoryGitWorkspaceScope,
} from '../../application/ports/repositoryGitWorkspace'
import type { RepositoryWorkspaceReadQueries } from '../../application/ports/repositoryWorkspaceReadQueries'
import type { WorkspaceContentEffectsFactory } from '../../application/ports/workspaceContentEffects'
import { WORKTREE_FILE_MAX_BYTES } from '@agent-workflow/shared'
import type { HostedTaskWorkspaces } from './taskWorkspace'
import {
  hostedWorkspaceReference,
  parseHostedWorkspaceReference,
  joinHostedWorkspaceReference,
} from './workspaceReference'

export function createHostedWorkspaceEffects(input: {
  readonly helper: WorkspaceHelper
  readonly workspaces: HostedTaskWorkspaces
  readonly api: CrewStationBusinessExecution
}) {
  const call = <T>(reference: string, operation: string, extra: object = {}) => {
    const workspace = parseHostedWorkspaceReference(reference)
    return input.helper.call<T>(workspace.taskId, operation, { path: workspace.path, ...extra })
  }
  const bind: RepositoryGitWorkspaceFactory['bind'] = (binding): RepositoryGitWorkspaceScope => {
    const workspace = parseHostedWorkspaceReference(binding.workspaceRef)
    return {
      workspaceRef: binding.workspaceRef,
      run(args, options) {
        const { signal, ...serializable } = options ?? {}
        return input.helper.call(
          workspace.taskId,
          'git',
          { path: workspace.path, args, options: serializable },
          {
            ...(signal === undefined ? {} : { signal }),
            ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          },
        )
      },
      hasSubmodules: () => call(binding.workspaceRef, 'has-submodules'),
      effectiveSubmodules: () => call(binding.workspaceRef, 'submodules'),
      async withPreviewIndex(operation, options) {
        const indexPath = await input.helper.call<string>(
          workspace.taskId,
          'preview-index-create',
          {},
        )
        try {
          return await operation({
            run: (args, literal) =>
              this.run(args, {
                ...options,
                env: {
                  ...options?.env,
                  GIT_INDEX_FILE: indexPath,
                  ...(literal?.literalPathspecs === true ? { GIT_LITERAL_PATHSPECS: '1' } : {}),
                },
              }),
          })
        } finally {
          await input.helper.call(workspace.taskId, 'preview-index-remove', { path: indexPath })
        }
      },
      subrepository: (relative) =>
        bind({
          ...binding,
          workspaceRef: joinHostedWorkspaceReference(binding.workspaceRef, relative),
        }),
    }
  }
  const workspaceReads: RepositoryWorkspaceReadQueries = {
    exists: (reference) => call(reference, 'exists'),
    isGitWorkTree: (reference) => call(reference, 'is-git'),
    gitDiffSnapshot: (reference, from) => call(reference, 'git-diff', { from }),
    worktreeDiff: (reference, from) => call(reference, 'worktree-diff', { from }),
    isolationRoot: (request) =>
      request.persistedWorkspaceRef ??
      hostedWorkspaceReference(request.taskId, `/work/iso/${request.taskId}/${request.nodeRunId}`),
  }
  const workspaceContent: WorkspaceContentEffectsFactory = {
    bind(reference) {
      const root = parseHostedWorkspaceReference(reference)
      const pathFor = (relative: string) =>
        parseHostedWorkspaceReference(joinHostedWorkspaceReference(reference, relative)).relative
      return {
        async list(request) {
          const workspace = await input.workspaces.find(root.taskId)
          if (workspace === null) throw new Error('hosted-workspace-not-found')
          let after: string | undefined
          const entries: Array<{ name: string; kind: 'file' | 'directory'; size: number | null }> =
            []
          do {
            const page = await input.api.listFiles(workspace.businessTaskId, {
              path: pathFor(request.relativeDirectory) || '.',
              ...(after === undefined ? {} : { after }),
              limit: 1000,
            })
            for (const entry of page.entries) {
              if (entry.name === '.git' || entry.kind === 'symlink') continue
              entries.push({
                name: entry.name,
                kind: entry.kind === 'dir' ? 'directory' : 'file',
                size: entry.kind === 'dir' ? null : entry.size,
              })
            }
            after = page.nextCursor ?? undefined
          } while (after !== undefined)
          entries.sort((a, b) =>
            a.kind !== b.kind
              ? a.kind === 'directory'
                ? -1
                : 1
              : a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) ||
                (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
          )
          const next = request.page.offset + request.maxEntries
          return {
            entries: entries.slice(request.page.offset, next),
            nextOffset: next < entries.length ? next : null,
            truncated: false,
          }
        },
        async read(request) {
          const workspace = await input.workspaces.find(root.taskId)
          if (workspace === null) throw new Error('hosted-workspace-not-found')
          const path = pathFor(request.relativeFile)
          // Acquire a version before resuming a bounded read: CS rejects a
          // continuation that could combine bytes from two file versions.
          const first = await input.api.readFile(workspace.businessTaskId, {
            path,
            offset: 0,
            limit: Math.max(1, Math.min(1024 * 1024, request.maxBytes)),
          })
          const page =
            request.offset === 0
              ? first
              : await input.api.readFile(workspace.businessTaskId, {
                  path,
                  offset: request.offset,
                  limit: Math.max(1, Math.min(1024 * 1024, request.maxBytes)),
                  version: first.version,
                })
          const bytes = Buffer.from(page.contentBase64, 'base64').subarray(0, request.maxBytes)
          return {
            encoding: 'base64',
            content: bytes.toString('base64'),
            size: page.size,
            offset: request.offset,
            nextOffset:
              request.offset + bytes.length < page.size ? request.offset + bytes.length : null,
            oversized: page.size > WORKTREE_FILE_MAX_BYTES,
          }
        },
      }
    },
  }
  return {
    repositoryGitWorkspaces: { bind } satisfies RepositoryGitWorkspaceFactory,
    workspaceReads,
    workspaceContent,
  }
}

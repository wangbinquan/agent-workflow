// RFC-370 §10 V16 — hosted revision content. Git questions run as ONE
// task-image operation (`code-review`) in the task volume; worktree file reads
// use the platform file API directly. Reads never allocate a parent: the
// registration is looked up first (`find`) and file reads resume an existing
// parent only (`open`). A volume created by a release that predates this
// operation answers a typed 410 instead of falling back to per-file commands.
import { DomainError } from '@/util/errors'
import type { CrewStationBusinessExecution } from '@/platform/crewstation/businessExecution'
import { isCrewStationApiError } from '@/platform/crewstation/platformApi'
import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'
import type {
  RepositoryClassIndex,
  RepositoryPresence,
  RepositoryRevisionContent,
  RepositoryRevisionContentFactory,
  RevisionChanges,
  RevisionChangesRequest,
  RevisionFileRead,
  RevisionReadRequest,
  WorktreeFileRead,
  WorktreeReadRequest,
} from '../../application/ports/repositoryRevisionContent'
import type { HostedTaskWorkspaces } from './taskWorkspace'
import { parseHostedWorkspaceReference } from './workspaceReference'
import {
  CODE_REVIEW_OPERATION,
  type CodeReviewOutcome,
  type CodeReviewVolumeRequest,
  type CodeReviewVolumeResults,
} from './codeReviewProtocol'

/** Platform file pages are at most 1 MiB. */
const FILE_PAGE_BYTES = 1024 * 1024
const NUL_PROBE_BYTES = 8192
/** Revision paths per command: keeps one request well inside the argv budget. */
const READ_REVISION_BATCH = 400
/** A burst of reads of one live view shares one volume answer. */
const DEFAULT_MEMO_MS = 5_000
const MEMO_LIMIT = 256

/** The task's volume was created by an image that cannot answer code-review reads. */
export class WorkspacePredatesCodeReviewError extends DomainError {
  constructor() {
    super(
      'workspace-predates-code-review',
      'this task workspace was created by an earlier release that cannot serve code review reads',
      410,
    )
    this.name = 'WorkspacePredatesCodeReviewError'
  }
}

function predatesCodeReview(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith(`workspace-helper-operation-unknown: ${CODE_REVIEW_OPERATION}`)
  )
}

function workspaceMissing(reference: string): DomainError {
  return new DomainError(
    'task-worktree-missing',
    `worktree '${reference}' is unavailable; cannot read its changes`,
    410,
  )
}

function locate(reference: string): { taskId: string; path: string; relative: string } | null {
  try {
    return parseHostedWorkspaceReference(reference)
  } catch {
    return null
  }
}

/** Platform-relative file path below the workspace, or null when the path
 * leaves it (the same refusal a standalone contained read answers). */
function relativeFileOf(root: string, path: string): string | null {
  if (path === '' || path.startsWith('/') || path.includes('\\') || path.includes('\0')) return null
  const segments = path.split('/').filter((segment) => segment !== '' && segment !== '.')
  if (segments.length === 0 || segments.some((segment) => segment === '..')) return null
  return root === '' ? segments.join('/') : `${root}/${segments.join('/')}`
}

function decodeFile(bytes: Buffer): WorktreeFileRead {
  if (bytes.subarray(0, NUL_PROBE_BYTES).includes(0)) return { kind: 'binary' }
  return {
    kind: 'text',
    content: new TextDecoder('utf-8', { fatal: false }).decode(bytes),
    size: bytes.length,
  }
}

export function createHostedRepositoryRevisionContent(input: {
  readonly helper: WorkspaceHelper
  readonly workspaces: Pick<HostedTaskWorkspaces, 'find' | 'open'>
  readonly api: Pick<CrewStationBusinessExecution, 'readFile'>
  readonly now?: () => number
  readonly memoMs?: number
}): RepositoryRevisionContentFactory {
  const now = input.now ?? Date.now
  const memoMs = input.memoMs ?? DEFAULT_MEMO_MS
  const memo = new Map<string, { readonly at: number; readonly value: Promise<unknown> }>()
  const remembered = <T>(key: string, load: () => Promise<T>): Promise<T> => {
    const at = now()
    const hit = memo.get(key)
    if (hit !== undefined && at - hit.at < memoMs) return hit.value as Promise<T>
    if (memo.size >= MEMO_LIMIT)
      for (const [stale, entry] of memo) if (at - entry.at >= memoMs) memo.delete(stale)
    if (memo.size >= MEMO_LIMIT) memo.clear()
    const value = load()
    memo.set(key, { at, value })
    // A failure is not an answer: the next read asks again.
    value.catch(() => {
      if (memo.get(key)?.value === value) memo.delete(key)
    })
    return value
  }

  /** Every page of one volume file, pinned to the version of the first page. */
  const readPages = async (
    businessTaskId: string,
    path: string,
    maxBytes: number,
  ): Promise<{ readonly size: number; readonly bytes: Buffer | null } | null> => {
    const page = (offset: number, version?: string) =>
      input.api
        .readFile(businessTaskId, {
          path,
          offset,
          limit: FILE_PAGE_BYTES,
          ...(version === undefined ? {} : { version }),
        })
        .catch((error: unknown) => {
          if (isCrewStationApiError(error) && error.status === 404) return null
          throw error
        })
    const first = await page(0)
    if (first === null) return null
    if (first.size > maxBytes) return { size: first.size, bytes: null }
    const chunks = [Buffer.from(first.contentBase64, 'base64')]
    let offset = chunks[0]!.length
    while (offset < first.size) {
      const next = await page(offset, first.version)
      if (next === null) return null
      if (next.version !== first.version || next.size !== first.size)
        throw new Error('hosted-code-review-read-version-changed')
      const bytes = Buffer.from(next.contentBase64, 'base64')
      if (bytes.length === 0) throw new Error('hosted-code-review-read-incomplete')
      chunks.push(bytes)
      offset += bytes.length
    }
    return { size: first.size, bytes: Buffer.concat(chunks) }
  }

  const bind = (workspaceRef: string): RepositoryRevisionContent => {
    const workspace = locate(workspaceRef)
    const call = async <T>(request: CodeReviewVolumeRequest): Promise<T> => {
      if (workspace === null || (await input.workspaces.find(workspace.taskId)) === null)
        throw workspaceMissing(workspaceRef)
      let outcome: CodeReviewOutcome
      try {
        outcome = await input.helper.call<CodeReviewOutcome>(
          workspace.taskId,
          CODE_REVIEW_OPERATION,
          request,
        )
      } catch (error) {
        if (predatesCodeReview(error)) throw new WorkspacePredatesCodeReviewError()
        throw error
      }
      if (outcome.resultFile === undefined) return outcome.value as T
      const resultFile = outcome.resultFile
      try {
        const parent = await input.workspaces.open(workspace.taskId)
        if (parent === null) throw workspaceMissing(workspaceRef)
        const file = await readPages(
          parent.businessTaskId,
          resultFile.replace(/^\/work\/?/, ''),
          Number.MAX_SAFE_INTEGER,
        )
        if (file === null || file.bytes === null)
          throw new Error('hosted-code-review-result-missing')
        return JSON.parse(file.bytes.toString('utf8')) as T
      } finally {
        // Best effort: a leftover result file is pruned by a later command.
        await input.helper
          .call(workspace.taskId, CODE_REVIEW_OPERATION, { method: 'release', file: resultFile })
          .catch(() => undefined)
      }
    }
    const volumeAnswer = <M extends keyof CodeReviewVolumeResults>(
      request: Extract<CodeReviewVolumeRequest, { method: M }>,
    ): Promise<CodeReviewVolumeResults[M]> =>
      remembered(`${workspaceRef}\0${JSON.stringify(request)}`, () =>
        call<CodeReviewVolumeResults[M]>(request),
      )
    const path = workspace?.path ?? ''
    return Object.freeze<RepositoryRevisionContent>({
      capabilities: Object.freeze({ indexing: false as const }),
      async presence(): Promise<RepositoryPresence> {
        if (workspace === null || (await input.workspaces.find(workspace.taskId)) === null)
          return 'absent'
        return volumeAnswer({ method: 'presence', path })
      },
      async changes(request: RevisionChangesRequest): Promise<RevisionChanges> {
        const answer = await volumeAnswer({
          method: 'changes',
          path,
          from: request.from,
          ...(request.to === undefined ? {} : { to: request.to }),
          ...(request.lineStats === true ? { lineStats: true } : {}),
        })
        return {
          entries: answer.entries,
          ...(answer.lineStats === undefined
            ? {}
            : {
                lineStats: new Map(
                  answer.lineStats.map(([file, added, removed]) => [file, { added, removed }]),
                ),
              }),
        }
      },
      async readRevision(request: RevisionReadRequest) {
        const paths = [...new Set(request.paths)]
        const reads = new Map<string, RevisionFileRead>()
        for (let start = 0; start < paths.length; start += READ_REVISION_BATCH) {
          const batch = await volumeAnswer({
            method: 'read-revision',
            path,
            rev: request.rev,
            paths: paths.slice(start, start + READ_REVISION_BATCH),
            maxBytes: request.maxBytes,
          })
          for (const [file, read] of batch) reads.set(file, read)
        }
        return reads
      },
      readWorktree(request: WorktreeReadRequest): Promise<WorktreeFileRead> {
        const key = `${workspaceRef}\0worktree\0${request.maxBytes}\0${request.path}`
        return remembered<WorktreeFileRead>(key, async () => {
          if (workspace === null) return { kind: 'absent' }
          const file = relativeFileOf(workspace.relative, request.path)
          if (file === null) return { kind: 'outside' }
          // A paused parent is resumed: platform file reads need it running.
          const parent = await input.workspaces.open(workspace.taskId)
          if (parent === null) return { kind: 'absent' }
          const read = await readPages(parent.businessTaskId, file, request.maxBytes)
          if (read === null) return { kind: 'absent' }
          if (read.bytes === null) return { kind: 'oversized', size: read.size }
          return decodeFile(read.bytes)
        })
      },
      async grep(patterns) {
        if (patterns.length === 0) return []
        return volumeAnswer({ method: 'grep', path, patterns: [...patterns] })
      },
      async classIndex(): Promise<RepositoryClassIndex> {
        return new Map(await volumeAnswer({ method: 'class-index', path }))
      },
      snapshotDigest: () => volumeAnswer({ method: 'snapshot-digest', path }),
    })
  }
  return Object.freeze({ bind })
}

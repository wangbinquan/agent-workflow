import { describe, expect, test } from 'bun:test'
import { composeTaskWorkspaceInsight } from '@/modules/workspace-insight/composition'
import { FILE_CONTENT_MAX_BYTES } from '@/modules/workspace-insight/application/fileContent'
import type {
  RepositoryRevisionContent,
  RevisionFileRead,
} from '@/modules/source-control/public/participants'
import type { TaskWorktreeLocation } from '@/modules/task-execution/public/queries'

type RevisionReadRequest = Parameters<RepositoryRevisionContent['readRevision']>[0]
type WorktreeReadRequest = Parameters<RepositoryRevisionContent['readWorktree']>[0]

function setup() {
  let location: TaskWorktreeLocation | null = {
    taskId: 'task',
    worktreePath: 'task-workspace',
    baseCommit: 'outer-base',
    repos: [
      { ordinal: 0, mountPath: '', worktreePath: 'root-workspace', baseCommit: 'root-base' },
      { ordinal: 1, mountPath: 'app', worktreePath: 'app-workspace', baseCommit: 'app-base' },
    ],
  }
  let file: RevisionFileRead | undefined = { kind: 'text', content: 'hello', size: 5 }
  const requests: {
    workspace: string
    revision?: RevisionReadRequest
    worktree?: WorktreeReadRequest
  }[] = []
  const bound: string[] = []
  let lookups = 0
  const unused = (): never => {
    throw new Error('file content must not invoke another insight capability')
  }
  const insight = composeTaskWorkspaceInsight({
    workspace: { findTask: unused, listNodeRuns: unused, findNodeRun: unused },
    artifacts: {
      readStructuralDiff: unused,
      writeStructuralDiff: unused,
      readNarrative: unused,
      writeNarrative: unused,
      removeTask: unused,
    },
    worktrees: {
      async find() {
        lookups++
        return location
      },
    },
    callGraphWorkspace: { find: unused },
    narrative: {
      resolveRuntime: unused,
      systemAgents: {
        workspaces: { capture: unused, withName: unused },
        run: unused,
        retainedContents: { forget: unused, release: unused },
      },
    },
    content: {
      bind(workspace): RepositoryRevisionContent {
        bound.push(workspace)
        return {
          capabilities: { indexing: false },
          presence: unused,
          changes: unused,
          grep: unused,
          classIndex: unused,
          snapshotDigest: unused,
          async readRevision(revision) {
            requests.push({ workspace, revision })
            return new Map(file === undefined ? [] : [[revision.paths[0]!, file]])
          },
          async readWorktree(worktree) {
            requests.push({ workspace, worktree })
            return file ?? { kind: 'absent' }
          },
        }
      },
    },
  })
  return {
    insight,
    requests,
    bound,
    lookups: () => lookups,
    setLocation(next: TaskWorktreeLocation | null) {
      location = next
    },
    setFile(next: RevisionFileRead | undefined) {
      file = next
    },
  }
}

describe('workspace-insight composed file query contract', () => {
  test('each read resolves the current mount and requests one bounded document with its own base revision', async () => {
    const h = setup()
    expect(
      await h.insight.fileContent('task', {
        path: 'new.md',
        basePath: 'old.md',
        side: 'base',
        repo: 'app',
      }),
    ).toEqual({ exists: true, content: 'hello', size: 5 })
    expect(h.requests).toEqual([
      {
        workspace: 'app-workspace',
        revision: { rev: 'app-base', paths: ['old.md'], maxBytes: FILE_CONTENT_MAX_BYTES },
      },
    ])
    h.setLocation({
      taskId: 'task',
      worktreePath: 'moved-task',
      baseCommit: 'new-base',
      repos: [
        { ordinal: 0, mountPath: '', worktreePath: 'moved-root', baseCommit: 'root-v2' },
        { ordinal: 1, mountPath: 'app', worktreePath: 'moved-app', baseCommit: 'app-v2' },
      ],
    })
    await h.insight.fileContent('task', { path: 'root.md', side: 'worktree', repo: '.' })
    expect(h.requests[1]).toEqual({
      workspace: 'moved-root',
      worktree: { path: 'root.md', maxBytes: FILE_CONTENT_MAX_BYTES },
    })
    expect(h.lookups()).toBe(2)
    expect(h.bound).toEqual(['app-workspace', 'moved-root'])
    expect(h.requests).toHaveLength(2)
  })

  test('partial content responses represent missing files and preserve typed binary/oversize errors without extra reads', async () => {
    const h = setup()
    h.setFile(undefined)
    expect(
      await h.insight.fileContent('task', { path: 'missing.md', side: 'base', repo: 'app' }),
    ).toEqual({ exists: false })
    for (const [file, code, status] of [
      [{ kind: 'binary' }, 'file-content-binary', 415],
      [{ kind: 'oversized', size: FILE_CONTENT_MAX_BYTES + 1 }, 'file-content-oversized', 413],
    ] as const) {
      h.setFile(file)
      for (const side of ['base', 'worktree'] as const) {
        const before = h.requests.length
        await expect(
          h.insight.fileContent('task', { path: 'file.md', side, repo: 'app' }),
        ).rejects.toMatchObject({ code, status })
        expect(h.requests.length - before).toBe(1)
      }
    }
  })

  test('unresolved task or repository and missing query path fail before any content read', async () => {
    const h = setup()
    await expect(
      h.insight.fileContent('task', { path: '', side: 'base', repo: 'app' }),
    ).rejects.toMatchObject({ code: 'file-content-missing-path' })
    expect(h.lookups()).toBe(0)
    await expect(
      h.insight.fileContent('task', { path: 'file.md', side: 'base' }),
    ).rejects.toMatchObject({ code: 'file-content-repo-required' })
    await expect(
      h.insight.fileContent('task', { path: 'file.md', side: 'base', repo: 'missing' }),
    ).rejects.toMatchObject({ code: 'file-content-repo-not-found' })
    h.setLocation(null)
    await expect(
      h.insight.fileContent('task', { path: 'file.md', side: 'base', repo: 'app' }),
    ).rejects.toMatchObject({ code: 'task-not-found' })
    expect(h.bound).toEqual([])
    expect(h.requests).toEqual([])
  })
})

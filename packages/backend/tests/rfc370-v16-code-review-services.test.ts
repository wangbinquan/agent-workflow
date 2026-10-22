// RFC-370 §10 V16 — the task "Changes" services read through the injected
// revision content and persist through the injected artifact store.
//
// Why these tests exist: RFC-370 hosted sweep (2026-10-19). The structural
// diff, file content, call-chain and narrative services ran `git` / `fs` on the
// daemon host, so a hosted task (a `cs-workspace:` volume) answered 410. A
// hosted-shaped fake content (no indexing, every read recorded) locks:
//   - a terminal generation is served from the store first — no content read,
//     so no volume wake — and a computed terminal diff is stored for it;
//   - a live diff reads each side once and in batches;
//   - deep mode degrades to the baseline with `indexing-unavailable`;
//   - file content, call targets and the narrative status use the selections.
import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { mountTaskRoutes } from '@/routes/tasks'
import { computeSummary, type ChangeNarrative, type StructuralDiff } from '@agent-workflow/shared'
import type {
  CodeWorkspaceRead,
  CodeWorkspaceTask,
} from '@/modules/code-capability/application/ports/codeWorkspaceRead'
import type {
  CodeReviewArtifactStore,
  StructuralDiffArtifactKey,
} from '@/modules/code-capability/public/participants'
import type {
  RepositoryPresence,
  RepositoryRevisionContentFactory,
  RevisionFileRead,
  WorktreeFileRead,
} from '@/modules/source-control/public/participants'
import { getTaskStructuralDiff } from '@/services/structuralDiff/service'
import { getTaskFileContent } from '@/services/worktreeFileContent'
import { getCallTargets } from '@/services/structuralDiff/callGraph/expandService'
import { getChangeNarrativeStatus } from '@/services/changeNarrative'

const TASK = '01V16CODEREVIEWSERVICES000'
const REF = `cs-workspace:${TASK}/worktrees/${TASK}`

function workspace(task: Partial<CodeWorkspaceTask> = {}): CodeWorkspaceRead {
  const row: CodeWorkspaceTask = {
    id: TASK,
    status: 'running',
    spaceKind: 'repo',
    worktreePath: REF,
    baseCommit: 'base',
    repos: [{ mountPath: '', worktreeDirName: '', worktreePath: REF, baseCommit: 'base' }],
    finishedAt: null,
    ...task,
  }
  return {
    findTask: async (id) => (id === TASK ? row : null),
    listNodeRuns: async () => [],
    findNodeRun: async () => null,
  }
}

function hostedContent(options: {
  readonly presence?: RepositoryPresence
  readonly revision?: Readonly<Record<string, RevisionFileRead>>
  readonly worktree?: Readonly<Record<string, WorktreeFileRead>>
}) {
  const calls: string[] = []
  const factory: RepositoryRevisionContentFactory = {
    bind(workspaceRef) {
      expect(workspaceRef).toBe(REF)
      return {
        capabilities: { indexing: false },
        async presence() {
          calls.push('presence')
          return options.presence ?? 'git'
        },
        async changes(request) {
          calls.push(`changes:${request.from}`)
          return { entries: [{ path: 'src/a.ts', status: 'M' }] }
        },
        async readRevision(request) {
          calls.push(`revision:${request.rev}:${request.paths.join(',')}`)
          return new Map(
            request.paths.map((path) => [path, options.revision?.[path] ?? { kind: 'absent' }]),
          )
        },
        async readWorktree(request) {
          calls.push(`worktree:${request.path}`)
          return options.worktree?.[request.path] ?? { kind: 'absent' }
        },
        async grep(patterns) {
          calls.push(`grep:${patterns.join(',')}`)
          return []
        },
        async classIndex() {
          calls.push('class-index')
          return new Map([['Greeter', ['src/a.ts']]])
        },
        async snapshotDigest() {
          calls.push('snapshot')
          return 'digest'
        },
      }
    },
  }
  return { factory, calls }
}

function artifactStore(stored: StructuralDiff | null = null) {
  const writes: Array<{ key: StructuralDiffArtifactKey; diff: StructuralDiff }> = []
  const reads: StructuralDiffArtifactKey[] = []
  const store: CodeReviewArtifactStore = {
    async readStructuralDiff(key) {
      reads.push(key)
      return key.generation === '1700' ? stored : null
    },
    async writeStructuralDiff(key, diff) {
      writes.push({ key, diff })
    },
    readNarrative: async () => null,
    writeNarrative: async () => undefined,
    removeTask: async () => undefined,
  }
  return { store, writes, reads }
}

function storedDiff(): StructuralDiff {
  return {
    scope: 'task',
    taskId: TASK,
    fromRef: 'base',
    toRef: 'WORKTREE',
    engine: 'baseline',
    status: 'ok',
    files: [],
    dependencyChanges: [],
    impact: [],
    classEdges: [],
    summary: computeSummary([], []),
  }
}

const OLD = 'export function alphaValue() {\n  return 1\n}\n'
const NEW =
  'export function alphaValue() {\n  return 2\n}\nexport function betaValue() {\n  return alphaValue()\n}\n'

describe('RFC-370 §10 V16 structural diff through the selected content', () => {
  test('a terminal generation is served from the store without reading the content', async () => {
    const content = hostedContent({})
    const artifacts = artifactStore(storedDiff())
    const diff = await getTaskStructuralDiff(
      {
        workspace: workspace({ status: 'done', finishedAt: 1700 }),
        content: content.factory,
        artifacts: artifacts.store,
      },
      TASK,
      'task',
    )
    expect(diff.contentDigest).toBeDefined()
    expect(content.calls).toEqual([])
    expect(artifacts.reads).toEqual([{ taskId: TASK, scope: 'task', generation: '1700' }])
  })

  test('a live diff reads each side once and in one batch, and is not stored while running', async () => {
    const content = hostedContent({
      revision: { 'src/a.ts': { kind: 'text', content: OLD, size: OLD.length } },
      worktree: { 'src/a.ts': { kind: 'text', content: NEW, size: NEW.length } },
    })
    const artifacts = artifactStore()
    const diff = await getTaskStructuralDiff(
      { workspace: workspace(), content: content.factory, artifacts: artifacts.store },
      TASK,
    )
    expect(diff.files.map((file) => file.filePath)).toEqual(['src/a.ts'])
    expect(diff.files[0]!.changes.length).toBeGreaterThan(0)
    expect(content.calls.filter((call) => call.startsWith('revision:'))).toEqual([
      'revision:base:src/a.ts',
    ])
    expect(content.calls.filter((call) => call === 'worktree:src/a.ts')).toHaveLength(1)
    expect(content.calls[0]).toBe('presence')
    expect(artifacts.writes).toEqual([])
  })

  test('a computed terminal diff is stored for its generation', async () => {
    const content = hostedContent({
      revision: { 'src/a.ts': { kind: 'text', content: OLD, size: OLD.length } },
      worktree: { 'src/a.ts': { kind: 'oversized', size: 9_000_000 } },
    })
    const artifacts = artifactStore()
    const diff = await getTaskStructuralDiff(
      {
        workspace: workspace({ status: 'failed', finishedAt: 1800 }),
        content: content.factory,
        artifacts: artifacts.store,
      },
      TASK,
    )
    // An oversized side classifies the file exactly as its text would have.
    expect(diff.files[0]?.status).toBe('skipped-oversized')
    await Promise.resolve()
    expect(artifacts.writes.map((write) => write.key)).toEqual([
      { taskId: TASK, scope: 'task', generation: '1800' },
    ])
  })

  test('deep mode on content without an indexer degrades to the baseline', async () => {
    const content = hostedContent({
      revision: { 'src/a.ts': { kind: 'text', content: OLD, size: OLD.length } },
      worktree: { 'src/a.ts': { kind: 'text', content: NEW, size: NEW.length } },
    })
    const reads = {
      workspace: workspace(),
      content: content.factory,
      artifacts: artifactStore().store,
    }
    const live = await getTaskStructuralDiff(reads, TASK, 'task', undefined, { mode: 'deep' })
    expect(live).toMatchObject({ engine: 'baseline', degradedReason: 'indexing-unavailable' })
    const stored = await getTaskStructuralDiff(
      {
        workspace: workspace({ status: 'done', finishedAt: 1700 }),
        content: hostedContent({}).factory,
        artifacts: artifactStore(storedDiff()).store,
      },
      TASK,
      'task',
      undefined,
      { mode: 'deep' },
    )
    expect(stored).toMatchObject({ engine: 'baseline', degradedReason: 'indexing-unavailable' })
  })

  test('a workspace that is not a Git work tree, with nothing stored, is a 410', async () => {
    const content = hostedContent({ presence: 'directory' })
    await expect(
      getTaskStructuralDiff(
        { workspace: workspace(), content: content.factory, artifacts: artifactStore().store },
        TASK,
      ),
    ).rejects.toMatchObject({ code: 'task-worktree-missing', status: 410 })
  })
})

describe('RFC-370 §10 V16 file content, call targets and narrative through the selections', () => {
  const store = {
    findWorktreeTask: async (id: string) =>
      id === TASK ? { id, worktreePath: REF, baseCommit: 'base', repos: [] } : null,
  } as unknown as Parameters<typeof getTaskFileContent>[0]

  test('both file-content sides map the tagged reads onto the view answers', async () => {
    const content = hostedContent({
      revision: {
        'doc.md': { kind: 'text', content: 'before\n', size: 7 },
        'big.md': { kind: 'oversized', size: 9_000_000 },
      },
      worktree: {
        'doc.md': { kind: 'text', content: 'after\n', size: 6 },
        'bin.md': { kind: 'binary' },
        'link.md': { kind: 'outside' },
      },
    })
    const read = (path: string, side: 'base' | 'worktree') =>
      getTaskFileContent(store, TASK, { path, side }, { content: content.factory })
    expect(await read('doc.md', 'base')).toEqual({ exists: true, content: 'before\n', size: 7 })
    expect(await read('doc.md', 'worktree')).toEqual({ exists: true, content: 'after\n', size: 6 })
    expect(await read('gone.md', 'worktree')).toEqual({ exists: false })
    await expect(read('big.md', 'base')).rejects.toMatchObject({ status: 413 })
    await expect(read('bin.md', 'worktree')).rejects.toMatchObject({ status: 415 })
    await expect(read('link.md', 'worktree')).rejects.toMatchObject({
      code: 'file-content-path-escapes',
    })
  })

  test('call targets need a Git work tree and build the class index once', async () => {
    const readModel = {
      find: async () => ({ taskId: TASK, worktreePath: REF, repos: [] }),
    }
    const absent = hostedContent({ presence: 'absent' })
    await expect(
      getCallTargets(readModel, TASK, 'src/a.ts#alphaValue', absent.factory),
    ).rejects.toMatchObject({ code: 'task-worktree-missing', status: 410 })
    const content = hostedContent({
      worktree: { 'src/a.ts': { kind: 'text', content: NEW, size: NEW.length } },
    })
    await getCallTargets(readModel, TASK, 'src/a.ts#betaValue', content.factory)
    await getCallTargets(readModel, TASK, 'src/a.ts#betaValue', content.factory)
    expect(content.calls.filter((call) => call === 'class-index')).toHaveLength(1)
    expect(content.calls).toContain('worktree:src/a.ts')
  })

  test('the narrative status reads the selected artifact store', async () => {
    const narrative: ChangeNarrative = {
      version: 1,
      overview: 'hosted narrative',
      groups: [],
      readingOrder: [],
      generatedAt: 1,
      inputDigest: 'digest',
    }
    const status = await getChangeNarrativeStatus(TASK, {
      ...artifactStore().store,
      readNarrative: async (taskId) => (taskId === TASK ? narrative : null),
    })
    expect(status).toEqual({ status: 'ready', narrative })
  })
})

describe('RFC-370 §10 V16 task routes require the selected code-review reads', () => {
  test('mounting without them fails at composition, naming the missing dependency', () => {
    // Every other dependency is present (an empty stand-in); only `codeReview`
    // is missing, so the route refuses to mount instead of falling back to the
    // daemon's own filesystem.
    const deps = new Proxy(
      {},
      { get: (_target, key) => (key === 'codeReview' ? undefined : {}) },
    ) as Parameters<typeof mountTaskRoutes>[1]
    expect(() => mountTaskRoutes(new Hono(), deps)).toThrow('task-code-review-not-composed')
  })
})

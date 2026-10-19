// RFC-370 §10 V16 — hosted code-review reads (the task "Changes" views).
//
// Why these tests exist: RFC-370 hosted sweep (2026-10-19). The structural
// diff, change narrative, file content, file symbols, code intelligence and
// call-chain views ran `git` and read files on the daemon host, so every hosted
// task — whose worktree is a `cs-workspace:` volume reference — answered 410.
// They now read through Source Control's `RepositoryRevisionContent`; the
// hosted adapter runs Git questions as ONE task-image operation (`code-review`)
// and reads worktree files with the platform file API. These cases lock:
//   - reads never allocate a parent: an unregistered volume answers `absent` /
//     410 without a helper command (`find` first, never `ensure`);
//   - worktree reads page through the platform file API, pinned to one version,
//     with the standalone tags (absent / outside / oversized / binary);
//   - a result above the inline bound travels as a volume file, read back and
//     released;
//   - a volume created by an older image answers a typed 410, no per-file fallback;
//   - the task-image handler answers through the ONE dispatch line.
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHostedRepositoryRevisionContent } from '@/modules/source-control/infrastructure/crewstation/repositoryRevisionContent'
import { executeCodeReviewVolumeOperation } from '@/modules/source-control/infrastructure/crewstation/codeReviewVolumeOperation'
import { executeWorkspaceTaskImageOperation } from '@/bootstrap/workspaceTaskImage'
import { CrewStationApiError } from '@/platform/crewstation/platformApi'
import { WorkspaceCommandFailedError } from '@/platform/crewstation/workspaceProtocol'
import { runGit } from '@/util/git'

const TASK = '01V16HOSTEDREVISIONCONTENT'
const REF = `cs-workspace:${TASK}/worktrees/${TASK}`

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

interface HelperCall {
  readonly taskId: string
  readonly operation: string
  readonly value: { readonly method: string; readonly [key: string]: unknown }
}

function hosted(options: {
  readonly registered?: boolean
  readonly answer?: (call: HelperCall) => unknown
  readonly files?: ReadonlyMap<string, Buffer>
  readonly now?: () => number
}) {
  const calls: HelperCall[] = []
  const reads: { path: string; offset: number; version?: string }[] = []
  const registered = options.registered ?? true
  const content = createHostedRepositoryRevisionContent({
    helper: {
      async call<T>(taskId: string, operation: string, value: unknown): Promise<T> {
        const call = { taskId, operation, value: value as HelperCall['value'] }
        calls.push(call)
        return (await options.answer?.(call)) as T
      },
    },
    workspaces: {
      find: async (taskId) => (registered ? { taskId, businessTaskId: 'cs-parent' } : null),
      open: async (taskId) => (registered ? { taskId, businessTaskId: 'cs-parent' } : null),
    },
    api: {
      async readFile(_businessTaskId, query) {
        reads.push({
          path: query.path,
          offset: query.offset ?? 0,
          ...(query.version === undefined ? {} : { version: query.version }),
        })
        const bytes = options.files?.get(query.path)
        if (bytes === undefined) throw new CrewStationApiError(404, 'not_found', 'no file', {})
        const offset = query.offset ?? 0
        const end = Math.min(bytes.length, offset + Math.min(query.limit ?? bytes.length, 4))
        return {
          path: query.path,
          version: 'v1',
          size: bytes.length,
          offset,
          contentBase64: bytes.subarray(offset, end).toString('base64'),
          nextOffset: end < bytes.length ? end : null,
        }
      },
    },
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  return { content: content.bind(REF), calls, reads }
}

describe('RFC-370 §10 V16 hosted revision content', () => {
  test('an unregistered volume is absent and never reaches a helper command', async () => {
    const { content, calls, reads } = hosted({ registered: false })
    expect(content.capabilities.indexing).toBe(false)
    expect(await content.presence()).toBe('absent')
    await expect(content.changes({ from: 'base' })).rejects.toMatchObject({
      code: 'task-worktree-missing',
      status: 410,
    })
    expect(await content.readWorktree({ path: 'a.ts', maxBytes: 100 })).toEqual({ kind: 'absent' })
    expect(calls).toEqual([])
    expect(reads).toEqual([])
  })

  test('Git questions are one code-review command on the owning volume, briefly remembered', async () => {
    let at = 1_000
    const { content, calls } = hosted({
      now: () => at,
      // The helper answers the command's outcome envelope (inline `value`).
      answer: (call) =>
        call.value.method === 'presence'
          ? { value: 'git' }
          : { value: { entries: [{ path: 'a.ts', status: 'M' }], lineStats: [['a.ts', 2, 1]] } },
    })
    expect(await content.presence()).toBe('git')
    expect(await content.presence()).toBe('git')
    const changes = await content.changes({ from: 'base', lineStats: true })
    expect(changes.entries).toEqual([{ path: 'a.ts', status: 'M' }])
    expect(changes.lineStats?.get('a.ts')).toEqual({ added: 2, removed: 1 })
    expect(calls.map((call) => [call.taskId, call.operation, call.value])).toEqual([
      [TASK, 'code-review', { method: 'presence', path: `/work/worktrees/${TASK}` }],
      [
        TASK,
        'code-review',
        { method: 'changes', path: `/work/worktrees/${TASK}`, from: 'base', lineStats: true },
      ],
    ])
    at += 60_000
    await content.presence()
    expect(calls.filter((call) => call.value.method === 'presence')).toHaveLength(2)
  })

  test('worktree files page through the platform file API with the standalone tags', async () => {
    const files = new Map([
      [`worktrees/${TASK}/src/a.ts`, Buffer.from('export const a = 1\n')],
      [`worktrees/${TASK}/bin.dat`, Buffer.from([0x68, 0x69, 0x00, 0x21, 0x22])],
      [`worktrees/${TASK}/big.ts`, Buffer.from('x'.repeat(64))],
    ])
    const { content, reads, calls } = hosted({ files })
    expect(await content.readWorktree({ path: 'src/a.ts', maxBytes: 1024 })).toEqual({
      kind: 'text',
      content: 'export const a = 1\n',
      size: 19,
    })
    // Every continuation page is pinned to the version of the first one.
    const pages = reads.filter((read) => read.path === `worktrees/${TASK}/src/a.ts`)
    expect(pages[0]).toEqual({ path: `worktrees/${TASK}/src/a.ts`, offset: 0 })
    expect(pages.slice(1).every((page) => page.version === 'v1')).toBe(true)
    expect(await content.readWorktree({ path: 'bin.dat', maxBytes: 1024 })).toEqual({
      kind: 'binary',
    })
    expect(await content.readWorktree({ path: 'big.ts', maxBytes: 16 })).toEqual({
      kind: 'oversized',
      size: 64,
    })
    expect(reads.filter((read) => read.path.endsWith('big.ts'))).toHaveLength(1)
    expect(await content.readWorktree({ path: 'missing.ts', maxBytes: 16 })).toEqual({
      kind: 'absent',
    })
    const before = reads.length
    expect(await content.readWorktree({ path: '../escape.ts', maxBytes: 16 })).toEqual({
      kind: 'outside',
    })
    expect(reads).toHaveLength(before)
    expect(calls).toEqual([])
  })

  test('a large result is read back from the volume file and released', async () => {
    const resultFile = '/work/tmp/code-review/result.json'
    const index: [string, string[]][] = [['Greeter', ['src/a.ts']]]
    const files = new Map([['tmp/code-review/result.json', Buffer.from(JSON.stringify(index))]])
    const { content, calls } = hosted({
      files,
      answer: (call) => (call.value.method === 'class-index' ? { resultFile } : null),
    })
    expect([...(await content.classIndex())]).toEqual(index)
    expect(calls.map((call) => call.value)).toEqual([
      { method: 'class-index', path: `/work/worktrees/${TASK}` },
      { method: 'release', file: resultFile },
    ])
  })

  test('a volume of an older image answers a typed 410, with no per-file fallback', async () => {
    const { content, calls } = hosted({
      answer: () => {
        throw new WorkspaceCommandFailedError(
          'Error',
          'workspace-helper-operation-unknown: code-review',
        )
      },
    })
    await expect(content.presence()).rejects.toMatchObject({
      code: 'workspace-predates-code-review',
      status: 410,
    })
    await expect(
      content.readRevision({ rev: 'base', paths: ['a.ts', 'b.ts'], maxBytes: 100 }),
    ).rejects.toMatchObject({ code: 'workspace-predates-code-review' })
    expect(calls.map((call) => call.value.method)).toEqual(['presence', 'read-revision'])
  })
})

async function volumeWithRepository(): Promise<{ root: string; worktree: string; base: string }> {
  const root = mkdtempSync(join(tmpdir(), 'aw-v16-volume-'))
  dirs.push(root)
  const worktree = join(root, 'worktrees', TASK)
  mkdirSync(worktree, { recursive: true })
  await runGit(worktree, ['init', '-q', '-b', 'main'])
  await runGit(worktree, ['config', 'user.email', 't@t.test'])
  await runGit(worktree, ['config', 'user.name', 't'])
  writeFileSync(join(worktree, 'a.ts'), 'export class Greeter {}\n')
  await runGit(worktree, ['add', '.'])
  await runGit(worktree, ['commit', '-q', '-m', 'init'])
  const base = (await runGit(worktree, ['rev-parse', 'HEAD'])).stdout.trim()
  writeFileSync(join(worktree, 'a.ts'), 'export class Greeter {}\nexport class Host {}\n')
  writeFileSync(join(worktree, 'b.ts'), 'export const b = 1\n')
  return { root, worktree, base }
}

describe('RFC-370 §10 V16 code-review task-image operation', () => {
  test('answers Git questions of the volume through the one dispatch line', async () => {
    const { root, worktree, base } = await volumeWithRepository()
    expect(
      await executeWorkspaceTaskImageOperation(
        'code-review',
        { method: 'presence', path: worktree },
        undefined,
        root,
      ),
    ).toEqual({ value: 'git' })
    const changes = (await executeCodeReviewVolumeOperation(
      { method: 'changes', path: worktree, from: base, lineStats: true },
      root,
    )) as { value: { entries: unknown[]; lineStats: unknown[] } }
    expect(changes.value.entries).toEqual([
      { path: 'a.ts', status: 'M' },
      { path: 'b.ts', status: 'A' },
    ])
    expect(changes.value.lineStats).toContainEqual(['a.ts', 1, 0])
    const blobs = (await executeCodeReviewVolumeOperation(
      { method: 'read-revision', path: worktree, rev: base, paths: ['a.ts', 'b.ts'], maxBytes: 64 },
      root,
    )) as { value: unknown[] }
    expect(blobs.value).toEqual([
      ['a.ts', { kind: 'text', content: 'export class Greeter {}\n', size: 24 }],
      ['b.ts', { kind: 'absent' }],
    ])
  })

  test('a result above the inline bound is a scratch file the release removes', async () => {
    const { root, worktree } = await volumeWithRepository()
    // ~6000 index entries of ~70 bytes: well above the 256 KiB inline bound.
    for (let i = 0; i < 6000; i += 1)
      writeFileSync(
        join(worktree, `C${i}.ts`),
        `export class AVeryLongGeneratedClassNameForTheIndex${i} {}\n`,
      )
    const outcome = (await executeCodeReviewVolumeOperation(
      { method: 'class-index', path: worktree },
      root,
    )) as { resultFile?: string }
    expect(outcome.resultFile).toBeDefined()
    const scratch = join(root, 'tmp', 'code-review')
    expect(readdirSync(scratch)).toHaveLength(1)
    await expect(
      executeCodeReviewVolumeOperation({ method: 'release', file: join(worktree, 'a.ts') }, root),
    ).rejects.toThrow('hosted-code-review-file-invalid')
    expect(
      await executeCodeReviewVolumeOperation(
        { method: 'release', file: outcome.resultFile! },
        root,
      ),
    ).toBeNull()
    expect(existsSync(outcome.resultFile!)).toBe(false)
  })

  test('a path outside the volume is refused', async () => {
    const { root } = await volumeWithRepository()
    await expect(
      executeCodeReviewVolumeOperation({ method: 'presence', path: tmpdir() }, root),
    ).rejects.toThrow('workspace-helper-path-outside-work-volume')
  })
})

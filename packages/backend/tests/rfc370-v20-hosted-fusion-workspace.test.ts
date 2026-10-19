// RFC-370 §10 V20 — a hosted fusion engine task's working copy lives in its own
// task volume and is seeded / collected by ONE task-image command each.
//
// Why these tests exist: the fusion engine workspace used to be a local Git
// repository under the control plane's app home, which a hosted control plane
// does not have. The hosted adapter must run the standalone steps inside the
// volume (`fusion-workspace`), move whole skill trees above the command budget
// as volume files (written with the upload commands, read back with the
// platform file API, then removed), and give the engine task's parent back on
// release or after a failed preparation. The fake helper below runs the real
// task-image dispatch against a fixture volume, translating `/work`, exactly as
// the CS task container would.
import { afterEach, expect, test } from 'bun:test'
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ulid } from 'ulid'
import { executeWorkspaceTaskImageOperation } from '@/bootstrap/workspaceTaskImage'
import { createFileFusionWorkspaceEffects } from '@/modules/source-control/composition'
import { createHostedFusionWorkspaces } from '@/modules/source-control/infrastructure/crewstation/fusionWorkspace'
import type { FusionWorkspaceFile } from '@/modules/source-control/public/participants'
import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'
import { runGit } from '@/util/git'

const enc = (text: string) => new TextEncoder().encode(text)
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const translate = (value: unknown, from: string, to: string): unknown => {
  if (typeof value === 'string' && (value === from || value.startsWith(from + '/')))
    return to + value.slice(from.length)
  if (Array.isArray(value)) return value.map((item) => translate(item, from, to))
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, translate(item, from, to)]),
    )
  return value
}

function volume() {
  const root = mkdtempSync(join(tmpdir(), 'aw-v20-volume-'))
  roots.push(root)
  const taskId = ulid()
  const operations: string[] = []
  const abandoned: string[] = []
  const reads: string[] = []
  const helper: WorkspaceHelper = {
    async call<T>(owner: string, operation: string, value: unknown): Promise<T> {
      expect(owner).toBe(taskId)
      operations.push(
        operation === 'fusion-workspace'
          ? `fusion-workspace:${(value as { operation: string }).operation}`
          : operation,
      )
      const result = await executeWorkspaceTaskImageOperation(
        operation,
        translate(value, '/work', root),
        undefined,
        root,
      )
      return translate(result, root, '/work') as T
    },
  }
  const workspaces = {
    open: async () => ({ businessTaskId: 'cs-parent' }),
    abandon: async (owner: string) => {
      abandoned.push(owner)
    },
  }
  const api = {
    async readFile(
      businessTaskId: string,
      query: { path: string; offset?: number; limit?: number },
    ) {
      expect(businessTaskId).toBe('cs-parent')
      reads.push(query.path)
      const bytes = readFileSync(join(root, query.path))
      const offset = query.offset ?? 0
      const end = Math.min(bytes.length, offset + (query.limit ?? bytes.length))
      return {
        path: query.path,
        version: `v-${statSync(join(root, query.path)).mtimeMs}`,
        size: bytes.length,
        offset,
        nextOffset: end < bytes.length ? end : null,
        contentBase64: bytes.subarray(offset, end).toString('base64'),
      }
    },
  }
  const effects = createHostedFusionWorkspaces({
    helper,
    workspaces: workspaces as never,
    api: api as never,
  })
  return { root, taskId, operations, abandoned, reads, effects }
}

function seed(extra: readonly FusionWorkspaceFile[] = []): FusionWorkspaceFile[] {
  return [
    { path: 'SKILL.md', content: enc('---\nname: lint\ndescription: d\n---\nbody v1\n') },
    { path: 'scripts/run.sh', content: enc('echo hi\n') },
    ...extra,
  ]
}

function payloadFiles(root: string): string[] {
  const directory = join(root, 'tmp', 'fusion-workspace')
  try {
    return readdirSync(directory)
  } catch {
    return []
  }
}

test('one command seeds the volume working copy; one command collects diff, manifest and exact tree', async () => {
  const v = volume()
  const prepared = await v.effects.prepare({
    fusionId: ulid(),
    iteration: 1,
    taskId: v.taskId,
    base: seed(),
    overlay: null,
  })
  expect(prepared.worktreePath).toBe(`cs-workspace:${v.taskId}/fusion`)
  expect(prepared.baseCommit).toMatch(/^[0-9a-f]{40}$/)
  expect(v.operations).toEqual(['fusion-workspace:prepare'])
  const work = join(v.root, 'fusion')
  const log = await runGit(work, ['log', '--format=%s', '-1'])
  expect(log.stdout.trim()).toBe('fusion baseline')

  writeFileSync(join(work, 'SKILL.md'), '---\nname: lint\ndescription: d\n---\nfused body\n')
  mkdirSync(join(work, '.agent-workflow', 'fusion'), { recursive: true })
  writeFileSync(join(work, '.agent-workflow', 'fusion', 'result.json'), '{"x":1}')
  const result = await v.effects.collect({
    taskId: v.taskId,
    worktreePath: prepared.worktreePath,
    baseCommit: prepared.baseCommit,
  })
  expect(result.diff).toContain('diff --git a/SKILL.md b/SKILL.md')
  expect(result.diff).toContain('fused body')
  expect(result.diff).not.toContain('.agent-workflow')
  expect(result.manifest).toEqual({ kind: 'file', text: '{"x":1}' })
  expect(result.files.map((file) => file.path)).toEqual(['SKILL.md', 'scripts/run.sh'])
  expect(new TextDecoder().decode(result.files[0]!.content)).toContain('fused body')
  expect(v.operations).toEqual(['fusion-workspace:prepare', 'fusion-workspace:collect'])
})

test('a re-run overlay replaces the working copy as uncommitted changes over the baseline', async () => {
  const v = volume()
  const prepared = await v.effects.prepare({
    fusionId: ulid(),
    iteration: 2,
    taskId: v.taskId,
    base: seed(),
    overlay: [{ path: 'SKILL.md', content: enc('---\nname: lint\ndescription: d\n---\nprior\n') }],
  })
  const result = await v.effects.collect({ taskId: v.taskId, ...prepared })
  expect(result.manifest).toEqual({ kind: 'missing' })
  expect(result.files.map((file) => file.path)).toEqual(['SKILL.md'])
  expect(result.diff).toContain('prior')
  expect(result.diff).toContain('scripts/run.sh')
})

test('trees above the command budget travel as volume files that are removed afterwards', async () => {
  const v = volume()
  const large = new Uint8Array(400 * 1024)
  for (let index = 0; index < large.length; index++) large[index] = (index * 31) % 251
  const prepared = await v.effects.prepare({
    fusionId: ulid(),
    iteration: 1,
    taskId: v.taskId,
    base: seed([{ path: 'assets/large.bin', content: large }]),
    overlay: null,
  })
  expect(v.operations).toContain('upload-begin')
  expect(v.operations).toContain('fusion-workspace:release-file')
  const result = await v.effects.collect({ taskId: v.taskId, ...prepared })
  expect(v.reads.some((path) => path.startsWith('tmp/fusion-workspace/'))).toBe(true)
  expect(
    Buffer.from(result.files.find((file) => file.path === 'assets/large.bin')!.content).equals(
      Buffer.from(large),
    ),
  ).toBe(true)
  expect(payloadFiles(v.root)).toEqual([])
})

test('a failed preparation and every release give the engine task parent back', async () => {
  const v = volume()
  await expect(
    v.effects.prepare({
      fusionId: ulid(),
      iteration: 1,
      taskId: v.taskId,
      base: [{ path: '../escape', content: enc('x') }],
      overlay: null,
    }),
  ).rejects.toThrow()
  expect(v.abandoned).toEqual([v.taskId])
  await v.effects.release({
    taskId: v.taskId,
    worktreePath: `cs-workspace:${v.taskId}/fusion`,
    mode: 'finished',
  })
  expect(v.abandoned).toEqual([v.taskId, v.taskId])
})

test('the standalone adapter builds the same working copy under the app home and keeps it once finished', async () => {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-v20-local-'))
  roots.push(appHome)
  const local = createFileFusionWorkspaceEffects({ appHome })
  const fusionId = ulid()
  const prepared = await local.prepare({
    fusionId,
    iteration: 1,
    taskId: ulid(),
    base: seed(),
    overlay: null,
  })
  expect(prepared.worktreePath).toBe(join(appHome, 'fusions', fusionId, 'iter1', 'work'))
  writeFileSync(join(prepared.worktreePath, 'SKILL.md'), 'edited\n')
  const result = await local.collect({ taskId: 'task', ...prepared })
  expect(result.diff).toContain('edited')
  expect(result.files.map((file) => file.path)).toEqual(['SKILL.md', 'scripts/run.sh'])
  await local.release({ taskId: 'task', worktreePath: prepared.worktreePath, mode: 'finished' })
  expect(statSync(prepared.worktreePath).isDirectory()).toBe(true)
  await local.release({ taskId: 'task', worktreePath: prepared.worktreePath, mode: 'abandon' })
  expect(() => statSync(prepared.worktreePath)).toThrow()
  expect(statSync(dirname(prepared.worktreePath)).isDirectory()).toBe(true)
})

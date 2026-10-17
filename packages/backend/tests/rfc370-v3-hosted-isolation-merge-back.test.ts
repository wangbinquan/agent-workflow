// RFC-370 v3 — a hosted agent node's isolation snapshot and merge-back cross
// the task-volume command channel as JSON.
//
// WHY THIS FILE EXISTS (regression intent): the first hosted M1 run whose agent
// changed files failed its git wrapper with `merge-back-failed: null is not an
// object (evaluating 'e.length')`. The control plane sent the snapshot's
// optional forced-path list as a positional `undefined`, the JSON command
// request carried it as `null`, and the task image handed that `null` to the
// standalone snapshot, which only treats `undefined` as "no extra paths".
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeWorkspaceTaskImageOperation } from '@/bootstrap/workspaceTaskImage'
import type { IsolationWorkspace } from '@/modules/source-control/application/ports/isolationWorkspace'
import { createHostedIsolationWorkspaces } from '@/modules/source-control/infrastructure/crewstation/isolationWorkspace'
import {
  hostedWorkspaceReference,
  parseHostedWorkspaceReference,
} from '@/modules/source-control/infrastructure/crewstation/workspaceReference'
import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'
import { runGit } from '@/util/git'

const volume = mkdtempSync(join(tmpdir(), 'aw-hosted-iso-'))
afterAll(() => rmSync(volume, { recursive: true, force: true }))

const git = async (cwd: string, args: string[]) => {
  const result = await runGit(cwd, args)
  if (result.exitCode !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}

/** Strings naming `from` or a path below it are moved under `to`. */
const relocate = (value: unknown, from: string, to: string): unknown => {
  if (typeof value === 'string')
    return value === from || value.startsWith(`${from}/`) ? to + value.slice(from.length) : value
  if (Array.isArray(value)) return value.map((item) => relocate(item, from, to))
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, relocate(item, from, to)]),
    )
  return value
}

// The task container mounts the volume at /work and reads each request from a
// JSON file; the outcome comes back as JSON as well.
const helper: WorkspaceHelper = {
  async call<T>(_taskId: string, operation: string, input: unknown): Promise<T> {
    const request = relocate(JSON.parse(JSON.stringify(input)), '/work', volume)
    const result = await executeWorkspaceTaskImageOperation(operation, request, undefined, volume)
    return (
      result === undefined
        ? undefined
        : JSON.parse(JSON.stringify(relocate(result, volume, '/work')))
    ) as T
  },
}

const onVolume = (reference: string) =>
  join(volume, parseHostedWorkspaceReference(reference).relative)

async function canonicalWorkspace(name: string) {
  const repo = join(volume, 'repos', name)
  mkdirSync(join(repo, 'src'), { recursive: true })
  await git(repo, ['init', '-b', 'main'])
  await git(repo, ['config', 'user.name', 'Fixture'])
  await git(repo, ['config', 'user.email', 'fixture@example.test'])
  writeFileSync(join(repo, 'NOTES.md'), '# notes\n')
  writeFileSync(join(repo, 'src', 'greeting.js'), 'export const greeting = (n) => `hi, ${n}`\n')
  await git(repo, ['add', '--', 'NOTES.md', 'src/greeting.js'])
  await git(repo, ['commit', '-m', 'fixture'])
  const worktree = join(volume, 'worktrees', name)
  await git(repo, ['worktree', 'add', '-b', `aw/${name}`, worktree])
  return { repo, worktree }
}

test('an agent change is snapshotted and merged back through the hosted command channel', async () => {
  const { worktree } = await canonicalWorkspace('task')
  const scope = await createHostedIsolationWorkspaces(helper).bind({
    taskId: 'task',
    storageRootRef: 'unused-native-root',
    repositories: [
      {
        repositoryRef: hostedWorkspaceReference('task', '/work/repos/task'),
        workspaceRef: hostedWorkspaceReference('task', '/work/worktrees/task'),
        mount: '',
        baseBranch: 'main',
      },
    ],
  })
  const workspace = await scope.create({ key: 'writer', dbNodeRunId: 'writer' })
  expect(workspace.passthrough).toBe(false)
  const iso = onVolume(workspace.workspaceRef)
  writeFileSync(join(iso, 'NOTES.md'), '# notes\n- hosted run\n')
  writeFileSync(join(iso, 'src', 'farewell.js'), 'export const farewell = (n) => `bye, ${n}`\n')
  expect(readFileSync(join(worktree, 'NOTES.md'), 'utf8')).toBe('# notes\n')

  // The merge-back assembly snapshots without extra forced paths.
  const captured = await scope.snapshot(workspace)
  expect(Object.keys(captured.trees)).toEqual([''])
  const merged = await scope.merge(captured.workspace, captured.trees, undefined, async () => ({
    resolved: false,
  }))
  expect(merged.clean).toBe(true)
  expect(merged.conflicts).toEqual([])
  expect(readFileSync(join(worktree, 'NOTES.md'), 'utf8')).toBe('# notes\n- hosted run\n')
  expect(readFileSync(join(worktree, 'src', 'farewell.js'), 'utf8')).toContain('bye')
  await scope.discard(merged.workspace)
})

test('the task image reads a forced-path list sent as null as no extra paths', async () => {
  // A control plane released before the fix still sends `[workspace, null, null]`.
  const { repo, worktree } = await canonicalWorkspace('older')
  const binding = {
    taskId: 'older',
    storageRootRef: volume,
    repositories: [{ repositoryRef: repo, workspaceRef: worktree, mount: '', baseBranch: 'main' }],
  }
  const workspace = (await executeWorkspaceTaskImageOperation(
    'isolation',
    { binding, method: 'create', args: [{ key: 'writer', dbNodeRunId: 'writer' }] },
    undefined,
    volume,
  )) as IsolationWorkspace
  writeFileSync(join(workspace.workspaceRef, 'NOTES.md'), '# notes\n- older sender\n')
  const captured = (await executeWorkspaceTaskImageOperation(
    'isolation',
    { binding, method: 'snapshot', args: JSON.parse(JSON.stringify([workspace, null, undefined])) },
    undefined,
    volume,
  )) as { trees: Record<string, string>; workspace: IsolationWorkspace }
  expect(captured.trees['']).toMatch(/^[0-9a-f]{40}$/)
})

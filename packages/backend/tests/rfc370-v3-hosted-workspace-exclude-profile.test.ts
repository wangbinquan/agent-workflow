// RFC-370 v3 — a hosted task's RFC-308 workspace exclude profile is written on
// the task volume, where its worktree lives.
//
// WHY THIS FILE EXISTS (regression intent): the first hosted M1 task cloned the
// acceptance repository into its task volume and then failed before any node ran
// with `workspace-exclude-profile-failed: Executable not found in $PATH: "git"`.
// The hosted deployment never selected a workspace exclude profile owner, so the
// task engine fell back to the standalone manager and ran Git in the service
// container, which has neither Git nor the worktree.
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeWorkspaceTaskImageOperation } from '@/bootstrap/workspaceTaskImage'
import type { WorkspaceExcludeProfileReceipt } from '@/modules/source-control/public/types'
import { runGit } from '@/util/git'

const volume = mkdtempSync(join(tmpdir(), 'aw-hosted-exclude-'))
afterAll(() => rmSync(volume, { recursive: true, force: true }))

const git = async (cwd: string, args: string[]) => {
  const result = await runGit(cwd, args)
  if (result.exitCode !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}

test('the task image writes the profile on the volume worktree and Git honours it', async () => {
  const repo = join(volume, 'repos', 'acceptance')
  mkdirSync(repo, { recursive: true })
  await git(repo, ['init', '-b', 'main'])
  await git(repo, ['config', 'user.name', 'Fixture'])
  await git(repo, ['config', 'user.email', 'fixture@example.test'])
  writeFileSync(join(repo, 'NOTES.md'), 'notes\n')
  await git(repo, ['add', '--', 'NOTES.md'])
  await git(repo, ['commit', '-m', 'fixture'])
  const worktree = join(volume, 'worktrees', 'task')
  await git(repo, ['worktree', 'add', '-b', 'aw/task', worktree])

  const receipt = (await executeWorkspaceTaskImageOperation(
    'workspace-exclude-profile',
    { path: worktree, directChildMounts: ['vendor'] },
    undefined,
    volume,
  )) as WorkspaceExcludeProfileReceipt
  expect(receipt).toMatchObject({ version: 1, directChildMounts: ['vendor'] })
  expect(receipt.digest).toMatch(/^[0-9a-f]{64}$/)
  for (const probe of ['.agent-workflow/probe', 'vendor/probe'])
    expect(
      (await runGit(worktree, ['check-ignore', '-q', '--no-index', '--', probe])).exitCode,
    ).toBe(0)
  expect(
    (await runGit(worktree, ['check-ignore', '-q', '--no-index', '--', 'NOTES.md'])).exitCode,
  ).toBe(1)

  // Rebuilding the same profile is stable (resume / retry ensure it again).
  expect(
    await executeWorkspaceTaskImageOperation(
      'workspace-exclude-profile',
      { path: worktree, directChildMounts: ['vendor'] },
      undefined,
      volume,
    ),
  ).toEqual(receipt)
})

test('paths outside the volume and escaping mounts are refused before any Git', async () => {
  await expect(
    executeWorkspaceTaskImageOperation(
      'workspace-exclude-profile',
      { path: tmpdir(), directChildMounts: [] },
      undefined,
      volume,
    ),
  ).rejects.toThrow()
  await expect(
    executeWorkspaceTaskImageOperation(
      'workspace-exclude-profile',
      { path: join(volume, 'worktrees', 'task'), directChildMounts: ['../outside'] },
      undefined,
      volume,
    ),
  ).rejects.toThrow('hosted-repository-relative-path-invalid')
})

test('the hosted workspace owner binds the profile to that task-volume operation', () => {
  // The owner composes a full platform session; this source lock keeps the
  // selection from silently falling back to the service-local Git manager.
  const source = readFileSync(
    new URL('../src/modules/source-control/composition/crewstationWorkspace.ts', import.meta.url),
    'utf8',
  )
  expect(source).toMatch(
    /workspaceExcludeProfiles: \{\s*bind: \(\{ workspaceRef \}[\s\S]*?parseHostedWorkspaceReference\(workspaceRef\)[\s\S]*?'workspace-exclude-profile'/,
  )
})

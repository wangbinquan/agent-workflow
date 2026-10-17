// RFC-370 §9.2 V3 — task commit use cases are coarse hosted operations.
//
// Why these tests exist: on a hosted volume every Git step of a task commit
// (add, policy config read, staged inventory, excluded-path resets, commit,
// HEAD resolution, the preview index's create / read-tree / diff / remove)
// was its own command subtask. A hosted Git scope now runs prepare /
// commitPrepared / preview as ONE task-image command each, calling the same
// application function against the volume. These tests run the real handler
// over a fixture volume, next to a twin repository driven by the standalone
// scope, and lock one command per use case with identical outcomes.
import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeWorkspaceTaskImageOperation } from '@/bootstrap/workspaceTaskImage'
import { bindRepositoryCommitParticipant } from '@/modules/source-control/composition'
import { createHostedWorkspaceEffects } from '@/modules/source-control/infrastructure/crewstation/workspaceEffects'
import type { CrewStationBusinessExecution } from '@/platform/crewstation/businessExecution'
import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'
import { runGit } from '@/util/git'

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

async function git(path: string, args: string[]): Promise<string> {
  const result = await runGit(path, args)
  if (result.exitCode !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}

async function repository(path: string) {
  mkdirSync(path, { recursive: true })
  await git(path, ['init', '-b', 'main'])
  await git(path, ['config', 'user.name', 'Fixture'])
  await git(path, ['config', 'user.email', 'fixture@example.test'])
  writeFileSync(join(path, 'app.ts'), 'export const a = 1\n')
  await git(path, ['add', '.'])
  await git(path, ['commit', '-m', 'baseline'])
  writeFileSync(join(path, 'app.ts'), 'export const a = 2\n')
  writeFileSync(join(path, 'new.ts'), 'export {}\n')
  writeFileSync(join(path, 'debug.log'), 'noise\n')
}

test('prepare, commit and preview are one volume command each with native outcomes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-v3-commit-'))
  try {
    await repository(join(root, 'repo'))
    const twin = join(root, 'twin')
    await repository(twin)
    const operations: string[] = []
    const helper: WorkspaceHelper = {
      async call<T>(taskId: string, operation: string, value: unknown): Promise<T> {
        expect(taskId).toBe('task')
        operations.push(`${operation}:${(value as { method?: string }).method ?? ''}`)
        const result = await executeWorkspaceTaskImageOperation(
          operation,
          translate(value, '/work', root),
          undefined,
          root,
        )
        return translate(result, root, '/work') as T
      },
    }
    const scope = createHostedWorkspaceEffects({
      helper,
      workspaces: {
        open: async () => {
          throw new Error('commit operations never read through the file API')
        },
      },
      api: {} as CrewStationBusinessExecution,
    }).repositoryGitWorkspaces.bind({
      taskId: 'task',
      workspaceRef: 'cs-workspace:task/repo',
      repositoryRef: 'cs-workspace:task/repo',
    })
    const hosted = bindRepositoryCommitParticipant({
      repoPath: 'cs-workspace:task/repo',
      gitWorkspace: scope,
      configuredPatterns: ['*.log'],
      gitOptions: { timeoutMs: 60_000, signal: new AbortController().signal },
    })
    const native = bindRepositoryCommitParticipant({
      repoPath: twin,
      configuredPatterns: ['*.log'],
    })
    const preview = await hosted.preview()
    expect(preview).toEqual(await native.preview())
    if (!preview.ok) throw new Error(preview.error)
    expect(preview.diff).toContain('+export const a = 2')
    expect(preview.receipt.excludedPaths).toEqual(['debug.log'])
    const prepared = await hosted.prepare()
    expect(prepared).toEqual(await native.prepare())
    const commit = { message: 'Task result', verification: 'artifact' as const }
    const committed = await hosted.commitPrepared(commit)
    const nativeCommitted = await native.commitPrepared(commit)
    if (!committed.ok || !nativeCommitted.ok) throw new Error('commit failed')
    expect(await git(join(root, 'repo'), ['rev-parse', `${committed.commitSha}^{tree}`])).toBe(
      await git(twin, ['rev-parse', `${nativeCommitted.commitSha}^{tree}`]),
    )
    expect(await git(join(root, 'repo'), ['status', '--porcelain'])).toBe('?? debug.log')
    expect(await hosted.commitPrepared(commit)).toEqual({ ok: false, reason: 'no-changes' })
    // The abort signal never crosses into the volume; one command per use case.
    expect(operations).toEqual([
      'repository-commit:preview',
      'repository-commit:prepare',
      'repository-commit:commitPrepared',
      'repository-commit:commitPrepared',
    ])
    // A subrepository scope carries its own whole-volume operations.
    expect(scope.subrepository('vendor').commitOperations).toBeDefined()
    await expect(
      executeWorkspaceTaskImageOperation(
        'repository-commit',
        { method: 'unknown', path: join(root, 'repo'), input: {} },
        undefined,
        root,
      ),
    ).rejects.toThrow('repository-commit-operation-unknown')
    await expect(
      executeWorkspaceTaskImageOperation(
        'repository-commit',
        { method: 'prepare', path: join(root, '..'), input: {} },
        undefined,
        root,
      ),
    ).rejects.toThrow('outside-work-volume')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)

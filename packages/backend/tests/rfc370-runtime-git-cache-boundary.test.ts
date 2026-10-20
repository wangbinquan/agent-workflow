// RFC-370 hosted acceptance (2026-10-19): a development employee Case blocked at
// analyze-implement with "workspace-boundary-protected-root-write: added git-meta/opencode".
// OpenCode caches its project id in the Git common directory on every start, and an Agent
// node's RFC-130 linked worktree shares the action workspace's `.git`, so the first real
// OpenCode round of any action workspace tripped the protected `git-meta` root, in
// standalone and hosted mode alike. The cache is the runtime's own file, not Git state:
// the comparison leaves exactly it out and still reports every other write into `.git`.
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createWorkspaceValidationAdapter,
  GIT_METADATA_SKIP_PREFIXES,
  PLATFORM_OWNED_GIT_METADATA_PREFIXES,
} from '@/modules/development-automation/infrastructure/attemptSupport'
import { runGit } from '@/util/git'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function git(path: string, args: string[]): Promise<string> {
  const result = await runGit(path, args)
  if (result.exitCode !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}

async function actionWorkspace(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'aw-runtime-git-cache-'))
  roots.push(root)
  await git(root, ['init', '-b', 'main'])
  await git(root, ['config', 'user.name', 'Fixture'])
  await git(root, ['config', 'user.email', 'fixture@example.test'])
  writeFileSync(join(root, 'README.md'), '# fixture\n')
  await git(root, ['add', '.'])
  await git(root, ['commit', '-m', 'baseline'])
  return root
}

function request(workspacePath: string, preStateJson: string) {
  return {
    workspacePath,
    preStateJson,
    outcome: 'no-change' as const,
    workspaceMode: 'edit-business-files',
    writablePrefixes: [],
    preservePaths: [],
    editablePaths: [],
    budget: { maxChangedFiles: 10, maxTotalBytes: 1_000_000 },
  }
}

test('the runtime project-id cache in .git is not an Agent write, written or rewritten', async () => {
  const workspace = await actionWorkspace()
  const adapter = createWorkspaceValidationAdapter()
  const pre = await adapter.capturePreState(workspace)
  const rootCommit = await git(workspace, ['rev-list', '--max-parents=0', 'HEAD'])
  writeFileSync(join(workspace, '.git', 'opencode'), rootCommit)
  expect(await adapter.validate(request(workspace, pre))).toEqual({ ok: true, kind: 'clean' })
  writeFileSync(join(workspace, '.git', 'opencode'), 'another-project-id')
  expect(await adapter.validate(request(workspace, pre))).toEqual({ ok: true, kind: 'clean' })
})

test('every other write into .git still fails the boundary', async () => {
  const writes: readonly ((workspace: string) => void)[] = [
    (workspace) => writeFileSync(join(workspace, '.git', 'opencode-x'), 'lookalike'),
    (workspace) => writeFileSync(join(workspace, '.git', 'HEAD'), 'ref: refs/heads/other\n'),
    (workspace) => writeFileSync(join(workspace, '.git', 'description'), 'changed\n'),
  ]
  for (const write of writes) {
    const workspace = await actionWorkspace()
    const adapter = createWorkspaceValidationAdapter()
    const pre = await adapter.capturePreState(workspace)
    write(workspace)
    expect(await adapter.validate(request(workspace, pre))).toMatchObject({
      ok: false,
      kind: 'boundary',
      code: 'protected-root-write',
    })
  }
})

test('the runtime cache joins, and does not replace, the TaskEngine-owned Git paths', () => {
  expect(GIT_METADATA_SKIP_PREFIXES).toEqual([...PLATFORM_OWNED_GIT_METADATA_PREFIXES, 'opencode'])
})

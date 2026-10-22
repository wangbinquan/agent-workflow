import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { executeTaskImageRepositoryOperation } from '@/modules/source-control/composition/taskImageRepositoryEffects'
import { createHostedEmployeeCaseWorkspaceOperations } from '@/modules/source-control/infrastructure/crewstation/employeeCaseWorkspace'
import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'
import { bindEmployeeCaseWorkspaceParticipant } from '@/modules/source-control/composition'
import {
  bindChangeCandidateParticipant,
  bindCandidateDeliveryParticipant,
} from '@/modules/source-control/composition/repositoryCandidate'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function directory() {
  const root = mkdtempSync(join(tmpdir(), 'rfc396-empty-fixture-'))
  roots.push(root)
  return root
}
function git(cwd: string, ...args: string[]) {
  const process = Bun.spawnSync(['git', ...args], { cwd })
  if (process.exitCode !== 0) throw new Error(process.stderr.toString())
  return process.stdout.toString().trim()
}

test('unborn content baseline is deterministic, leaves branches untouched and produces a parentless business commit', async () => {
  const baseline = directory(),
    overlay = directory(),
    remote = directory()
  git(baseline, 'init', '-q', '-b', 'main')
  git(remote, 'init', '--bare', '-q', '-b', 'main')
  const workspace = bindEmployeeCaseWorkspaceParticipant()
  const request = {
    baselineRepoPath: baseline,
    preferredBranch: 'main',
    sourceBranch: null,
    allowUnborn: true,
  }
  const first = await workspace.resolveBaseline(request),
    second = await workspace.resolveBaseline(request)
  expect(second).toEqual(first)
  expect(first.contentBaseline?.kind).toBe('unborn')
  expect(git(baseline, 'for-each-ref', '--format=%(refname)').length).toBe(0)
  const materialized = await workspace.materialize({
    caseRoot: join(directory(), 'case'),
    baselineRepoPath: baseline,
    baselineSha: first.baselineSha,
  })
  expect(git(materialized.workspacePath, 'rev-parse', 'HEAD')).toBe(first.baselineSha)
  mkdirSync(join(overlay, 'src'))
  writeFileSync(join(overlay, 'src', 'hello.ts'), 'export const hello = "world"\n')
  const derived = await bindChangeCandidateParticipant().derive({
    baselineRepoPath: baseline,
    baselineSha: first.baselineSha,
    repositoryBaseline: first.contentBaseline,
    overlayRoot: overlay,
    excludePolicyDigest: 'a'.repeat(64),
    agentOutcomeRef: 'actual-execution',
  })
  if (!derived.ok) throw new Error(derived.detail)
  expect(derived.receipt.repositoryBaseline?.kind).toBe('unborn')
  const delivery = bindCandidateDeliveryParticipant()
  const input = {
    baselineRepoPath: baseline,
    baselineSha: first.baselineSha,
    repositoryBaseline: first.contentBaseline,
    overlayRoot: overlay,
    expectedTreeOid: derived.receipt.treeOid,
    missionId: 'graph-first-commit',
    summarySource: 'Initial implementation',
  }
  const committed = await delivery.commit(input)
  if (!committed.ok) throw new Error(committed.detail)
  expect(git(baseline, 'rev-list', '--parents', '-n', '1', committed.commitSha)).toBe(
    committed.commitSha,
  )
  expect(git(baseline, 'show', `${committed.commitSha}:src/hello.ts`)).toContain('world')
  const replay = await delivery.commit(input)
  expect(replay.ok && replay.reused).toBe(true)
  const pushed = await delivery.push({
    ...input,
    commitSha: committed.commitSha,
    remoteUrl: remote,
    branch: 'main',
    expectedRemoteSha: null,
  })
  expect(pushed.ok).toBe(true)
  expect(git(remote, 'rev-parse', 'main')).toBe(committed.commitSha)
  const changed = await delivery.push({
    ...input,
    commitSha: committed.commitSha,
    remoteUrl: remote,
    branch: 'main',
    expectedRemoteSha: committed.commitSha,
  })
  expect(changed).toMatchObject({ ok: false, code: 'remote-head-changed' })
  if (!changed.ok) expect(changed.detail).toContain('rebaselined')
})

test('ordinary committed repositories keep commit parent semantics; unresolved repositories are not silently treated as empty', async () => {
  const root = directory()
  git(root, 'init', '-q', '-b', 'main')
  writeFileSync(join(root, 'README.md'), '# existing\n')
  git(root, 'add', 'README.md')
  git(
    root,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '-qm',
    'baseline',
  )
  const resolved = await bindEmployeeCaseWorkspaceParticipant().resolveBaseline({
    baselineRepoPath: root,
    preferredBranch: 'main',
    sourceBranch: null,
    allowUnborn: true,
  })
  expect(resolved.contentBaseline?.kind).toBe('commit')
  expect(resolved.baselineSha).toBe(git(root, 'rev-parse', 'HEAD'))
  const legacy = await bindEmployeeCaseWorkspaceParticipant().resolveBaseline({
    baselineRepoPath: root,
    preferredBranch: 'main',
    sourceBranch: null,
  })
  expect(legacy).not.toHaveProperty('contentBaseline')
  await expect(
    bindEmployeeCaseWorkspaceParticipant().resolveBaseline({
      baselineRepoPath: directory(),
      preferredBranch: 'main',
      sourceBranch: null,
      allowUnborn: true,
    }),
  ).rejects.toThrow('cannot resolve repository baseline')
})

// The hosted boundary must forward allowUnborn to the actual task-image use case.
test('hosted empty repository resolves the same content baseline through the actual command handler', async () => {
  const root = directory()
  git(root, 'init', '-q', '-b', 'main')
  const helper: WorkspaceHelper = {
    async call<T>(_owner: string, operation: string, value: unknown) {
      const request = value as { method: string; input: Record<string, unknown> }
      return (await executeTaskImageRepositoryOperation(
        operation,
        { ...request, input: { ...request.input, baselineRepoPath: root } },
        root,
      )) as T
    },
  }
  const actual = await createHostedEmployeeCaseWorkspaceOperations({
    helper,
  }).operations.resolveBaseline({
    baselineRepoPath: 'cs-workspace:task/repo',
    preferredBranch: 'main',
    sourceBranch: null,
    allowUnborn: true,
  })
  expect(actual.contentBaseline?.kind).toBe('unborn')
  expect(git(root, 'for-each-ref')).toBe('')
})

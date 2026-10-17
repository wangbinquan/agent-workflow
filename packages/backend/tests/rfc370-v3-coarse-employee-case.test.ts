// RFC-370 §9.2 V3 — employee Case workspace use cases are coarse hosted
// operations.
//
// Why these tests exist: the hosted Case adapter used to issue one command
// subtask per file (stat / copy / chmod / mkdir for every entry of a
// checkpoint or scene). Each Case use case is now ONE task-image command
// (`employee-case`) whose handler runs the same application function with
// native effects against the volume. These tests run the real handlers over a
// fixture volume: one command per use case, translated scene paths, the
// standalone semantics (platform overlay preserved, checkpoint digests,
// baseline resolution, commit import, remote-head fetch with the platform's
// credentials), the refusals, and the binder's selection of the host.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeWorkspaceTaskImageOperation } from '@/bootstrap/workspaceTaskImage'
import { bindEmployeeCaseWorkspaceParticipant } from '@/modules/source-control/composition'
import type { EmployeeCaseWorkspaceEffectsFactory } from '@/modules/source-control/composition'
import { createHostedEmployeeCaseWorkspaceOperations } from '@/modules/source-control/infrastructure/crewstation/employeeCaseWorkspace'
import {
  workspaceHelperArguments,
  workspaceResultPath,
  type WorkspaceHelper,
} from '@/platform/crewstation/workspaceProtocol'
import { runGit } from '@/util/git'
import { remoteUrlFor, startGitHttpRemote, stopGitHttpRemote } from './helpers/gitHttpRemote'

beforeAll(startGitHttpRemote)
afterAll(stopGitHttpRemote)

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

async function init(path: string) {
  mkdirSync(path, { recursive: true })
  await git(path, ['init', '-b', 'main'])
  await git(path, ['config', 'user.name', 'Fixture'])
  await git(path, ['config', 'user.email', 'fixture@example.test'])
}

async function volume() {
  const root = mkdtempSync(join(tmpdir(), 'aw-v3-case-'))
  const baseline = join(root, 'baseline')
  await init(baseline)
  writeFileSync(join(baseline, 'app.txt'), 'baseline\n')
  await git(baseline, ['add', '.'])
  await git(baseline, ['commit', '-m', 'baseline'])
  const baselineSha = await git(baseline, ['rev-parse', 'HEAD'])
  const calls: { operation: string; method: string }[] = []
  const helper: WorkspaceHelper = {
    async call<T>(taskId: string, operation: string, value: unknown): Promise<T> {
      expect(taskId).toBe('task')
      calls.push({ operation, method: (value as { method: string }).method })
      workspaceHelperArguments(operation, value, workspaceResultPath('framing-check'))
      const result = await executeWorkspaceTaskImageOperation(
        operation,
        translate(value, '/work', root),
        undefined,
        root,
      )
      return translate(result, root, '/work') as T
    },
  }
  return {
    root,
    baseline,
    baselineSha,
    calls,
    host: createHostedEmployeeCaseWorkspaceOperations({ helper }),
    close: () => rmSync(root, { recursive: true, force: true }),
  }
}

const caseRoot = 'cs-workspace:task/cases/one'
const baselineRepoPath = 'cs-workspace:task/baseline'

test('scene lifecycle runs as one command per use case with standalone semantics', async () => {
  const v = await volume()
  try {
    const { operations } = v.host
    const scene = await operations.materialize({
      caseRoot,
      baselineRepoPath,
      baselineSha: v.baselineSha,
    })
    expect(scene).toEqual({ workspacePath: 'cs-workspace:task/cases/one/workspace' })
    const workspace = join(v.root, 'cases', 'one', 'workspace')
    expect(readFileSync(join(workspace, 'app.txt'), 'utf8')).toBe('baseline\n')
    expect(await git(workspace, ['remote'])).toBe('')
    mkdirSync(join(workspace, '.agent-workflow'), { recursive: true })
    writeFileSync(join(workspace, '.agent-workflow', 'kept.json'), 'kept')
    writeFileSync(join(workspace, 'draft.txt'), 'draft')
    expect(
      await operations.rematerialize({
        caseRoot,
        baselineRepoPath,
        baselineSha: v.baselineSha,
        currentWorkspacePath: scene.workspacePath,
      }),
    ).toEqual(scene)
    expect(readFileSync(join(workspace, '.agent-workflow', 'kept.json'), 'utf8')).toBe('kept')
    expect(existsSync(join(workspace, 'draft.txt'))).toBe(false)
    writeFileSync(join(workspace, 'app.txt'), 'edited\n')
    // As in the employee runtime, checkpoints live beside the scene root
    // (`<case>/checkpoints/<round>`): materialize and restore replace the
    // whole scene root.
    const checkpointRoot = 'cs-workspace:task/cases/one-checkpoints/round-1'
    const { checkpointDigest } = await operations.checkpoint({
      workspacePath: scene.workspacePath,
      checkpointRoot,
    })
    expect(checkpointDigest).toMatch(/^[a-f0-9]{64}$/)
    writeFileSync(join(workspace, 'app.txt'), 'lost\n')
    expect(
      await operations.restore({
        caseRoot,
        baselineRepoPath,
        baselineSha: v.baselineSha,
        checkpointRoot,
        expectedCheckpointDigest: checkpointDigest,
      }),
    ).toEqual(scene)
    expect(readFileSync(join(workspace, 'app.txt'), 'utf8')).toBe('edited\n')
    await expect(
      operations.restore({
        caseRoot,
        baselineRepoPath,
        baselineSha: v.baselineSha,
        checkpointRoot,
        expectedCheckpointDigest: '0'.repeat(64),
      }),
    ).rejects.toThrow('checkpoint digest mismatch')
    expect(
      await operations.resolveBaseline({
        baselineRepoPath,
        preferredBranch: 'main',
        sourceBranch: null,
      }),
    ).toEqual({ baselineSha: v.baselineSha, targetBranch: 'main', remoteHeadSha: null })
    const source = join(v.root, 'source')
    await git(v.root, ['clone', '--quiet', v.baseline, source])
    await git(source, ['config', 'user.name', 'Fixture'])
    await git(source, ['config', 'user.email', 'fixture@example.test'])
    writeFileSync(join(source, 'merge.txt'), 'merge\n')
    await git(source, ['add', '.'])
    await git(source, ['commit', '-m', 'merge'])
    const commitSha = await git(source, ['rev-parse', 'HEAD'])
    await operations.importCommit({
      baselineRepoPath,
      sourceRepoPath: 'cs-workspace:task/source',
      commitSha,
    })
    expect(await git(v.baseline, ['cat-file', '-t', commitSha])).toBe('commit')
    await operations.discard(caseRoot)
    expect(existsSync(join(v.root, 'cases', 'one'))).toBe(false)
    expect(v.calls).toEqual(
      [
        'materialize',
        'rematerialize',
        'checkpoint',
        'restore',
        'restore',
        'resolveBaseline',
        'importCommit',
        'discard',
      ].map((method) => ({ operation: 'employee-case', method })),
    )
  } finally {
    v.close()
  }
}, 90_000)

test('the remote head is fetched in the volume with its own credentials', async () => {
  const v = await volume()
  const remote = mkdtempSync(join(tmpdir(), 'aw-v3-case-remote-'))
  try {
    await git(remote, ['init', '--bare', '-b', 'main'])
    await git(v.baseline, ['push', '--quiet', remote, 'HEAD:refs/heads/feature'])
    const request = {
      baselineRepoPath,
      remoteUrl: remoteUrlFor(remote),
      branch: 'feature',
      publicationSubject: { kind: 'user' as const, userId: 'owner' },
    }
    expect(
      await v.host.operations.fetchRemoteHead({ ...request, expectedHeadSha: v.baselineSha }),
    ).toEqual({ ok: true, headSha: v.baselineSha })
    expect(
      await v.host.operations.fetchRemoteHead({ ...request, expectedHeadSha: '1'.repeat(40) }),
    ).toEqual({
      ok: false,
      code: 'remote-head-moved',
      expectedHeadSha: '1'.repeat(40),
      actualHeadSha: v.baselineSha,
    })
    // A credential must never be persisted in a command request.
    expect(() =>
      v.host.operations.fetchRemoteHead({
        ...request,
        remoteUrl: 'https://user:secret@git.example.test/repo',
        expectedHeadSha: v.baselineSha,
      }),
    ).toThrow('platform-credentials')
    expect(v.calls.map((call) => call.method)).toEqual(['fetchRemoteHead', 'fetchRemoteHead'])
  } finally {
    v.close()
    rmSync(remote, { recursive: true, force: true })
  }
}, 60_000)

test('scene references stay on one volume and the volume root is never discarded', async () => {
  const v = await volume()
  try {
    expect(() =>
      v.host.operations.materialize({
        caseRoot: 'cs-workspace:other/cases/one',
        baselineRepoPath,
        baselineSha: v.baselineSha,
      }),
    ).toThrow('volume-mismatch')
    expect(v.calls).toEqual([])
    await expect(v.host.operations.discard('cs-workspace:task/')).rejects.toThrow(
      'root-removal-refused',
    )
    expect(existsSync(v.baseline)).toBe(true)
    await expect(
      executeWorkspaceTaskImageOperation(
        'employee-case',
        { method: 'unknown', input: {} },
        undefined,
        v.root,
      ),
    ).rejects.toThrow('employee-case-operation-unknown')
    await expect(
      executeWorkspaceTaskImageOperation(
        'employee-case',
        { method: 'discard', input: { caseRoot: join(v.root, '..') } },
        undefined,
        v.root,
      ),
    ).rejects.toThrow('outside-work-volume')
  } finally {
    v.close()
  }
})

test('the participant binder selects a complete host and rejects an incomplete one', async () => {
  const v = await volume()
  try {
    const bound = bindEmployeeCaseWorkspaceParticipant({ effects: v.host })
    expect(bound).toBe(v.host.operations)
    for (const incomplete of [
      { operations: null },
      { operations: {} },
      { operations: { ...v.host.operations, importCommit: undefined } },
    ])
      expect(() =>
        bindEmployeeCaseWorkspaceParticipant({
          effects: incomplete as unknown as EmployeeCaseWorkspaceEffectsFactory,
        }),
      ).toThrow('employee-case-workspace-effects-incomplete')
  } finally {
    v.close()
  }
})

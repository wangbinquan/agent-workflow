// RFC-370 §9.2 V3 — candidate use cases are coarse hosted operations.
//
// Why these tests exist: the hosted candidate adapter used to turn every step
// of a use case into its own command subtask (stat / list / copy / chmod per
// overlay file, one git call per step): thousands of subtasks per candidate at
// real repository sizes. Now derive / stage / commit / push are ONE task-image
// command each, whose handler runs the same application function with native
// effects against the volume. These tests run the real task-image handlers
// over a fixture volume and lock: one command per use case, results identical
// to the standalone function, the staged tree living in the volume until its
// discard (refused while a writer holds it), hosted reference translation and
// its volume check, platform-credential publication, and binder selection.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeWorkspaceTaskImageOperation } from '@/bootstrap/workspaceTaskImage'
import { deriveChangeCandidate } from '@/modules/source-control/application/changeCandidate'
import {
  bindCandidateDeliveryParticipant,
  bindChangeCandidateParticipant,
} from '@/modules/source-control/composition/repositoryCandidate'
import { createHostedRepositoryCandidateOperations } from '@/modules/source-control/infrastructure/crewstation/repositoryCandidate'
import { createFileRepositoryCandidateEffectsFactory } from '@/modules/source-control/infrastructure/local/fileRepositoryCandidateEffects'
import type { RepositoryCandidateEffectsFactory } from '@/modules/source-control/composition'
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

async function volume() {
  const root = mkdtempSync(join(tmpdir(), 'aw-v3-candidate-'))
  const baseline = join(root, 'baseline')
  const overlay = join(root, 'overlay')
  mkdirSync(baseline)
  mkdirSync(join(overlay, 'src'), { recursive: true })
  await git(baseline, ['init', '-b', 'main'])
  await git(baseline, ['config', 'user.name', 'Fixture'])
  await git(baseline, ['config', 'user.email', 'fixture@example.test'])
  writeFileSync(join(baseline, 'keep.txt'), 'keep\n')
  writeFileSync(join(baseline, 'old.txt'), 'old\n')
  await git(baseline, ['add', '.'])
  await git(baseline, ['commit', '-m', 'baseline'])
  const baselineSha = await git(baseline, ['rev-parse', 'HEAD'])
  // The overlay is the whole business tree: old.txt deleted, one new file.
  writeFileSync(join(overlay, 'keep.txt'), 'keep\n')
  writeFileSync(join(overlay, 'src', 'new.ts'), 'export {}\n')
  const operations: string[] = []
  const helper: WorkspaceHelper = {
    async call<T>(taskId: string, operation: string, value: unknown): Promise<T> {
      expect(taskId).toBe('task')
      operations.push(operation)
      // Every request must fit the real platform argv framing.
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
    overlay,
    baselineSha,
    helper,
    operations,
    close: () => rmSync(root, { recursive: true, force: true }),
  }
}

const hosted = {
  baselineRepoPath: 'cs-workspace:task/baseline',
  overlayRoot: 'cs-workspace:task/overlay',
}

test('derive is one volume command and equals the standalone derivation', async () => {
  const v = await volume()
  try {
    const host = createHostedRepositoryCandidateOperations({ helper: v.helper })
    const request = {
      baselineSha: v.baselineSha,
      excludePolicyDigest: 'policy',
      agentOutcomeRef: 'outcome',
      protectedRoots: [],
    }
    const remote = await host.operations.derive({ ...request, ...hosted })
    expect(v.operations).toEqual(['candidate-derive'])
    const native = await deriveChangeCandidate(
      { ...request, baselineRepoPath: v.baseline, overlayRoot: v.overlay },
      createFileRepositoryCandidateEffectsFactory(),
    )
    expect(remote).toEqual(native)
    if (!remote.ok) throw new Error(remote.detail)
    expect(remote.receipt.changed).toEqual({
      added: ['src/new.ts'],
      modified: [],
      deleted: ['old.txt'],
    })
    // The temporary clone lived in the volume and is gone.
    expect(existsSync(join(v.root, 'tmp', 'candidates'))).toBe(true)
    expect(readdirSync(join(v.root, 'tmp', 'candidates'))).toEqual([])
  } finally {
    v.close()
  }
}, 60_000)

test('a staged tree stays in the volume until its discard, which a held writer blocks', async () => {
  const v = await volume()
  try {
    const held = new Set<string>()
    const host = createHostedRepositoryCandidateOperations({
      helper: v.helper,
      writerHeld: (reference) => held.has(reference),
    })
    const staged = await host.operations.stage({ ...hosted, baselineSha: v.baselineSha })
    if (!staged.ok) throw new Error(staged.detail)
    expect(staged.ws).toStartWith('cs-workspace:task/tmp/candidates/candidate-')
    const physical = join(v.root, staged.ws.slice('cs-workspace:task/'.length))
    expect(existsSync(join(physical, 'src', 'new.ts'))).toBe(true)
    expect(existsSync(join(physical, 'old.txt'))).toBe(false)
    const derived = await host.operations.derive({
      ...hosted,
      baselineSha: v.baselineSha,
      excludePolicyDigest: 'policy',
      agentOutcomeRef: 'outcome',
    })
    if (!derived.ok) throw new Error(derived.detail)
    expect(staged.treeOid).toBe(derived.receipt.treeOid)
    held.add(staged.ws)
    await expect(staged.cleanup()).rejects.toThrow('writer-not-settled')
    expect(existsSync(physical)).toBe(true)
    held.delete(staged.ws)
    await staged.cleanup()
    await staged.cleanup()
    expect(existsSync(physical)).toBe(false)
    expect(v.operations).toEqual(['candidate-stage', 'candidate-derive', 'candidate-discard'])
  } finally {
    v.close()
  }
}, 60_000)

test('commit and push are one command each and publish with the platform credentials', async () => {
  const v = await volume()
  const remote = mkdtempSync(join(tmpdir(), 'aw-v3-candidate-remote-'))
  try {
    await git(remote, ['init', '--bare', '-b', 'main'])
    const host = createHostedRepositoryCandidateOperations({ helper: v.helper })
    const derived = await host.operations.derive({
      ...hosted,
      baselineSha: v.baselineSha,
      excludePolicyDigest: 'policy',
      agentOutcomeRef: 'outcome',
    })
    if (!derived.ok) throw new Error(derived.detail)
    const commitInput = {
      ...hosted,
      baselineSha: v.baselineSha,
      expectedTreeOid: derived.receipt.treeOid,
      missionId: 'mission-1',
      summarySource: 'Add the module',
    }
    const committed = await host.operations.commit(commitInput)
    if (!committed.ok) throw new Error(committed.detail)
    expect(committed.reused).toBe(false)
    expect(await git(v.baseline, ['rev-parse', committed.localRef])).toBe(committed.commitSha)
    expect(await host.operations.commit(commitInput)).toEqual({ ...committed, reused: true })
    const pushed = await host.operations.push({
      baselineRepoPath: hosted.baselineRepoPath,
      commitSha: committed.commitSha,
      remoteUrl: remoteUrlFor(remote),
      branch: 'aw/mission-1',
      expectedRemoteSha: null,
      expectedTreeOid: derived.receipt.treeOid,
      baselineSha: v.baselineSha,
      publicationSubject: { kind: 'user', userId: 'owner' },
    })
    if (!pushed.ok) throw new Error(pushed.detail)
    expect(pushed.receipt).toMatchObject({
      remoteRef: 'refs/heads/aw/mission-1',
      newSha: committed.commitSha,
      reused: false,
      publication: {
        credentialSource: 'global',
        credentialRevision: null,
        endpointSource: 'legacy-remote',
        endpointBindingDigest: null,
      },
    })
    expect(await git(remote, ['rev-parse', 'refs/heads/aw/mission-1'])).toBe(committed.commitSha)
    expect(v.operations).toEqual([
      'candidate-derive',
      'candidate-commit',
      'candidate-commit',
      'candidate-push',
    ])
  } finally {
    v.close()
    rmSync(remote, { recursive: true, force: true })
  }
}, 90_000)

test('references are translated per volume and refused before any command', async () => {
  const v = await volume()
  try {
    const host = createHostedRepositoryCandidateOperations({ helper: v.helper })
    expect(() =>
      host.operations.derive({
        baselineRepoPath: 'cs-workspace:task/baseline',
        overlayRoot: 'cs-workspace:other/overlay',
        baselineSha: v.baselineSha,
        excludePolicyDigest: 'policy',
        agentOutcomeRef: 'outcome',
      }),
    ).toThrow('volume-mismatch')
    await expect(
      host.operations.stage({
        baselineRepoPath: '/work/baseline',
        overlayRoot: 'cs-workspace:task/overlay',
        baselineSha: v.baselineSha,
      }),
    ).rejects.toThrow('reference-required')
    const push = {
      baselineRepoPath: hosted.baselineRepoPath,
      commitSha: v.baselineSha,
      branch: 'main',
      expectedRemoteSha: null,
      expectedTreeOid: 'tree',
      baselineSha: v.baselineSha,
    }
    // A credential must never be persisted in a command request.
    expect(() =>
      host.operations.push({ ...push, remoteUrl: 'https://user:secret@git.example.test/repo' }),
    ).toThrow('platform-credentials')
    expect(() => host.operations.push({ ...push, remoteUrl: v.root })).toThrow(
      'remote-url-required',
    )
    expect(v.operations).toEqual([])
    // The task image contains every path to its own volume.
    await expect(
      executeWorkspaceTaskImageOperation(
        'candidate-derive',
        {
          baselineRepoPath: join(v.root, '..', 'elsewhere'),
          overlayRoot: v.overlay,
          baselineSha: v.baselineSha,
          excludePolicyDigest: 'policy',
          agentOutcomeRef: 'outcome',
        },
        undefined,
        v.root,
      ),
    ).rejects.toThrow('outside-work-volume')
  } finally {
    v.close()
  }
})

test('the binders route a hosted selection to its operations and validate it whole', async () => {
  const calls: string[] = []
  const transportOpens: string[] = []
  const host = {
    operations: {
      derive: async () => {
        calls.push('derive')
        return { ok: false as const, code: 'candidate-empty' as const, detail: 'none' }
      },
      stage: async () => {
        calls.push('stage')
        return { ok: false as const, code: 'overlay-symlink' as const, detail: 'link' }
      },
      commit: async () => {
        calls.push('commit')
        return { ok: false as const, code: 'commit-failed' as const, detail: 'no' }
      },
      push: async () => {
        calls.push('push')
        return { ok: false as const, code: 'push-failed' as const, detail: 'no' }
      },
    },
  }
  const change = bindChangeCandidateParticipant({ candidateEffects: host })
  const delivery = bindCandidateDeliveryParticipant({
    candidateEffects: host,
    publicationTransport: {
      async open() {
        transportOpens.push('open')
        throw new Error('the hosted volume never uses the in-process transport')
      },
    },
  })
  const base = {
    baselineRepoPath: 'cs-workspace:t/b',
    baselineSha: 'sha',
    overlayRoot: 'cs-workspace:t/o',
  }
  await change.derive({ ...base, excludePolicyDigest: 'p', agentOutcomeRef: 'o' })
  await delivery.stage(base)
  await delivery.commit({ ...base, expectedTreeOid: 't', missionId: 'm', summarySource: 's' })
  await delivery.push({
    baselineRepoPath: base.baselineRepoPath,
    commitSha: 'c',
    remoteUrl: 'https://git.example.test/repo',
    branch: 'b',
    expectedRemoteSha: null,
    expectedTreeOid: 't',
    baselineSha: 'sha',
    publicationSubject: { kind: 'system' },
  })
  expect(calls).toEqual(['derive', 'stage', 'commit', 'push'])
  expect(transportOpens).toEqual([])
  for (const incomplete of [
    { operations: null },
    { operations: {} },
    { operations: { ...host.operations, push: undefined } },
  ]) {
    expect(() =>
      bindCandidateDeliveryParticipant({
        candidateEffects: incomplete as unknown as RepositoryCandidateEffectsFactory,
      }),
    ).toThrow('repository-candidate-effects-incomplete')
    expect(() =>
      bindChangeCandidateParticipant({
        candidateEffects: incomplete as unknown as RepositoryCandidateEffectsFactory,
      }),
    ).toThrow('repository-candidate-effects-incomplete')
  }
})

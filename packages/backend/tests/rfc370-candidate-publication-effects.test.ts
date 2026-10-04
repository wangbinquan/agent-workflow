// RFC-370: push reads its selected baseline and waits for both owners to close.
// All tree/parent, CAS and publication receipts come from the actual native Git.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runGit } from '@/util/git'
import {
  bindCandidateDeliveryParticipant,
  bindChangeCandidateParticipant,
} from '@/modules/source-control/composition/repositoryCandidate'
import { createFileRepositoryCandidateEffectsFactory } from '@/modules/source-control/infrastructure/local/fileRepositoryCandidateEffects'
import type { RepositoryCandidateEffectsFactory } from '@/modules/source-control/application/ports/repositoryCandidateEffects'
import type { RepositoryPublicationTransport } from '@/modules/source-control/public/types'
import { bindEmployeeCaseWorkspaceParticipant } from '@/modules/source-control/composition'
import {
  CandidatePublicationStore,
  MappedCandidateFactory,
  MappedCandidatePublicationTransport,
  completionBarrier,
  enteredBeforeOutcome,
} from './helpers/repositoryCandidatePublication'

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rfc370-candidate-publication-'))
  const baseline = join(root, 'baseline'),
    remote = join(root, 'remote'),
    overlay = join(root, 'overlay')
  for (const dir of [baseline, remote, overlay]) mkdirSync(dir)
  const git = async (cwd: string, args: string[]) => {
    const result = await runGit(cwd, args)
    if (result.exitCode !== 0) throw new Error(result.stderr)
    return result.stdout.trim()
  }
  await git(baseline, ['init', '-q', '-b', 'main'])
  await git(baseline, ['config', 'user.name', 'Candidate fixture'])
  await git(baseline, ['config', 'user.email', 'candidate@test'])
  writeFileSync(join(baseline, 'a.txt'), 'baseline\n')
  await git(baseline, ['add', '.'])
  await git(baseline, ['commit', '-q', '-m', 'baseline'])
  const baselineSha = await git(baseline, ['rev-parse', 'HEAD'])
  await git(remote, ['init', '-q', '--bare'])
  writeFileSync(join(overlay, 'a.txt'), 'candidate\n')
  const store = new CandidatePublicationStore()
  const baselineRef = store.reference(baseline),
    overlayRef = store.reference(overlay),
    remoteRef = store.reference(remote)
  const factory = Object.freeze(new MappedCandidateFactory(store))
  const transport = Object.freeze(new MappedCandidatePublicationTransport(store))
  const delivery = bindCandidateDeliveryParticipant({
    candidateEffects: factory,
    publicationTransport: transport,
  })
  const change = await bindChangeCandidateParticipant({ candidateEffects: factory }).derive(
    store.poisonLegacy({
      baselineRepoPath: baselineRef,
      overlayRoot: overlayRef,
      baselineSha,
      excludePolicyDigest: 'a'.repeat(64),
      agentOutcomeRef: 'candidate-attempt',
    }),
  )
  if (!change.ok) throw new Error(change.code)
  const committed = await delivery.commit(
    store.poisonLegacy({
      baselineRepoPath: baselineRef,
      overlayRoot: overlayRef,
      baselineSha,
      expectedTreeOid: change.receipt.treeOid,
      missionId: 'rfc370-publication',
      summarySource: 'selected publication',
    }),
  )
  if (!committed.ok) throw new Error(committed.code)
  return {
    root,
    baseline,
    remote,
    overlay,
    store,
    factory,
    delivery,
    git,
    input: {
      baselineRepoPath: baselineRef,
      remoteUrl: remoteRef,
      branch: 'candidate',
      baselineSha,
      commitSha: committed.commitSha,
      expectedTreeOid: change.receipt.treeOid,
      expectedRemoteSha: null,
      publicationSubject: { kind: 'system' as const },
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

describe('RFC-370 selected candidate publication', () => {
  test('actual push and replay wait for selected baseline identity and both close ACKs', async () => {
    const f = await fixture()
    const identity = completionBarrier(),
      publicationClose = completionBarrier(),
      baselineClose = completionBarrier()
    try {
      const createdBefore = f.store.workspacesCreated
      const pushed = await f.delivery.push(f.store.poisonLegacy({ ...f.input }))
      expect(pushed.ok).toBe(true)
      expect(await f.git(f.remote, ['rev-parse', 'refs/heads/candidate'])).toBe(f.input.commitSha)
      expect(f.store.acquisitions.at(-1)).toEqual({ baselineReference: f.input.baselineRepoPath })
      expect(f.store.workspacesCreated).toBe(createdBefore)
      f.store.hooks.set(
        'candidate:baseline:rev-parse --verify ' + f.input.commitSha + '^{tree}',
        identity.before,
      )
      f.store.hooks.set('publication:close', publicationClose.before)
      f.store.hooks.set('candidate:close', baselineClose.before)
      const before = f.store.baselineCommands.length
      const pending = f.delivery.push(f.store.poisonLegacy({ ...f.input }))
      let settled = false
      void pending.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        },
      )
      try {
        await enteredBeforeOutcome(identity.entered, pending)
        expect(settled).toBe(false)
        expect(f.store.baselineCommands.slice(before).map((call) => call.args)).toEqual([
          ['rev-parse', '--verify', f.input.commitSha + '^{tree}'],
        ])
        identity.release()
        await enteredBeforeOutcome(publicationClose.entered, pending)
        expect(settled).toBe(false)
        expect(f.store.trace.at(-1)).toBe('publication:close')
        publicationClose.release()
        await enteredBeforeOutcome(baselineClose.entered, pending)
        expect(settled).toBe(false)
        baselineClose.release()
        const replay = await pending
        expect(replay.ok).toBe(true)
        if (replay.ok)
          expect(replay.receipt).toMatchObject({ newSha: f.input.commitSha, reused: true })
        expect(f.store.baselineCommands.slice(before).map((call) => call.args)).toEqual([
          ['rev-parse', '--verify', f.input.commitSha + '^{tree}'],
          ['rev-parse', '--verify', f.input.commitSha + '^1'],
        ])
        expect(f.store.legacyReads).toBe(0)
        expect(f.store.workspacesCreated).toBe(createdBefore)
        expect(f.store.publicationOpens).toBe(2)
        expect(f.store.publicationCloses).toBe(2)
      } finally {
        identity.release()
        publicationClose.release()
        baselineClose.release()
        await pending.catch(() => undefined)
      }
    } finally {
      f.cleanup()
    }
  }, 120_000)

  test('baseline acquisition rejection closes the opened publication and preserves error identity', async () => {
    const f = await fixture(),
      failure = new Error('selected baseline acquire rejected')
    try {
      f.store.hooks.set('candidate:acquire', () => {
        throw failure
      })
      const before = f.store.networkCommands.length
      const result = await f.delivery
        .push(f.store.poisonLegacy({ ...f.input }))
        .catch((error) => error)
      expect<unknown>(result).toBe(failure)
      expect(f.store.networkCommands).toHaveLength(before)
      expect(f.store.publicationOpens).toBe(1)
      expect(f.store.publicationCloses).toBe(1)
      expect(f.store.legacyReads).toBe(0)
    } finally {
      f.cleanup()
    }
  }, 120_000)

  test('publication close rejection still releases baseline after a real push', async () => {
    const f = await fixture(),
      failure = new Error('selected publication close rejected')
    try {
      const closeCount = f.store.baselineCloses
      f.store.hooks.set('publication:close', () => {
        throw failure
      })
      const result = await f.delivery
        .push(f.store.poisonLegacy({ ...f.input }))
        .catch((error) => error)
      expect<unknown>(result).toBe(failure)
      expect(await f.git(f.remote, ['rev-parse', 'refs/heads/candidate'])).toBe(f.input.commitSha)
      expect(f.store.baselineCloses).toBe(closeCount + 1)
      expect(f.store.trace.slice(-2)).toEqual(['publication:close', 'candidate:close'])
      expect(f.store.legacyReads).toBe(0)
    } finally {
      f.cleanup()
    }
  }, 120_000)

  test('baseline close rejection propagates only after publication close completed', async () => {
    const f = await fixture(),
      failure = new Error('selected baseline close rejected')
    try {
      f.store.hooks.set('candidate:close', () => {
        throw failure
      })
      const result = await f.delivery
        .push(f.store.poisonLegacy({ ...f.input }))
        .catch((error) => error)
      expect<unknown>(result).toBe(failure)
      expect(f.store.trace.slice(-2)).toEqual(['publication:close', 'candidate:close'])
      expect(await f.git(f.remote, ['rev-parse', 'refs/heads/candidate'])).toBe(f.input.commitSha)
    } finally {
      f.cleanup()
    }
  }, 120_000)

  test('transport refusal does not acquire the baseline or fall back to the native fixture', async () => {
    const store = new CandidatePublicationStore()
    const factory = Object.freeze(new MappedCandidateFactory(store))
    const transport: RepositoryPublicationTransport = Object.freeze({
      async open() {
        return {
          ok: false as const,
          code: 'code-host-push-credential-unavailable' as const,
          detail: 'not available',
        }
      },
    })
    const result = await bindCandidateDeliveryParticipant({
      candidateEffects: factory,
      publicationTransport: transport,
    }).push(
      store.poisonLegacy({
        baselineRepoPath: 'opaque:baseline',
        remoteUrl: 'opaque:remote',
        branch: 'candidate',
        baselineSha: 'a'.repeat(40),
        commitSha: 'b'.repeat(40),
        expectedTreeOid: 'c'.repeat(40),
        expectedRemoteSha: null,
        publicationSubject: { kind: 'system' as const },
      }),
    )
    expect(result).toEqual({
      ok: false,
      code: 'publication-transport-unavailable',
      detail: 'code-host-push-credential-unavailable',
    })
    expect(store.acquisitions).toEqual([])
    expect(store.legacyReads).toBe(0)
  })

  test('explicit incomplete factories reject at binding before any operation', () => {
    for (const incomplete of [null, {}]) {
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

  test('native baseline-only sessions admit reads and reject workspace creation without an overlay', async () => {
    const f = await fixture()
    try {
      const factory = createFileRepositoryCandidateEffectsFactory()
      const session = await factory.acquire({ baselineReference: f.baseline })
      try {
        const tree = await session.runBaseline([
          'rev-parse',
          '--verify',
          f.input.commitSha + '^{tree}',
        ])
        expect(tree.exitCode).toBe(0)
        expect(tree.stdout.trim()).toBe(f.input.expectedTreeOid)
        expect(() => session.createWorkspace()).toThrow('candidate-overlay-reference-required')
      } finally {
        await session.close()
      }
    } finally {
      f.cleanup()
    }
  }, 120_000)

  test.each([false, true])(
    'employee remote-head fetch waits for close ACK (reject=%s)',
    async (rejectClose) => {
      const f = await fixture(),
        barrier = completionBarrier()
      const failure = new Error('employee publication close rejected')
      let pending: Promise<unknown> | undefined
      try {
        expect((await f.delivery.push(f.store.poisonLegacy({ ...f.input }))).ok).toBe(true)
        f.store.locations.set(f.baseline, f.baseline)
        f.store.hooks.set('publication:close', async () => {
          await barrier.before()
          if (rejectClose) throw failure
        })
        const employee = bindEmployeeCaseWorkspaceParticipant({
          publicationTransport: Object.freeze(new MappedCandidatePublicationTransport(f.store)),
        })
        pending = employee.fetchRemoteHead({
          baselineRepoPath: f.baseline,
          remoteUrl: f.input.remoteUrl,
          branch: f.input.branch,
          expectedHeadSha: f.input.commitSha,
          publicationSubject: { kind: 'system' },
        })
        let settled = false
        void pending.then(
          () => {
            settled = true
          },
          () => {
            settled = true
          },
        )
        await enteredBeforeOutcome(barrier.entered, pending)
        expect(settled).toBe(false)
        expect(await f.git(f.baseline, ['rev-parse', 'FETCH_HEAD^{commit}'])).toBe(
          f.input.commitSha,
        )
        expect(f.store.publicationOpens).toBe(2)
        expect(f.store.publicationCloses).toBe(2)
        barrier.release()
        if (rejectClose) expect<unknown>(await pending.catch((error) => error)).toBe(failure)
        else expect(await pending).toEqual({ ok: true, headSha: f.input.commitSha })
        expect(await f.git(f.baseline, ['rev-parse', 'FETCH_HEAD^{commit}'])).toBe(
          f.input.commitSha,
        )
        expect(f.store.legacyReads).toBe(0)
      } finally {
        barrier.release()
        await pending?.catch(() => undefined)
        f.cleanup()
      }
    },
    120_000,
  )

  test('native derive, stage, commit and publication each capture the original Git hook once', async () => {
    const f = await fixture()
    const reads: number[] = []
    const hook = <T extends object>(request: T): T & { readonly runGit: typeof runGit } => {
      const index = reads.push(0) - 1
      return Object.defineProperty(request, 'runGit', {
        enumerable: true,
        get() {
          reads[index]! += 1
          if (reads[index] !== 1) throw new Error('native Git hook captured twice')
          return runGit
        },
      }) as T & { readonly runGit: typeof runGit }
    }
    try {
      const request = {
        baselineRepoPath: f.baseline,
        overlayRoot: f.overlay,
        baselineSha: f.input.baselineSha,
        excludePolicyDigest: 'a'.repeat(64),
        agentOutcomeRef: 'native-once',
      }
      const derived = await bindChangeCandidateParticipant().derive(hook({ ...request }))
      expect(derived.ok).toBe(true)
      if (!derived.ok) throw new Error(derived.code)
      const delivery = bindCandidateDeliveryParticipant()
      const staged = await delivery.stage(hook({ ...request }))
      expect(staged.ok).toBe(true)
      if (!staged.ok) throw new Error(staged.code)
      try {
        expect(staged.treeOid).toBe(derived.receipt.treeOid)
      } finally {
        await staged.cleanup()
      }
      const committed = await delivery.commit(
        hook({
          ...request,
          expectedTreeOid: derived.receipt.treeOid,
          missionId: 'rfc370-native-once',
          summarySource: 'native getter once',
        }),
      )
      expect(committed.ok).toBe(true)
      if (!committed.ok) throw new Error(committed.code)
      const pushed = await delivery.push(
        hook({
          ...f.input,
          baselineRepoPath: f.baseline,
          remoteUrl: f.remote,
          commitSha: committed.commitSha,
          expectedTreeOid: derived.receipt.treeOid,
        }),
      )
      expect(pushed.ok).toBe(true)
      expect(await f.git(f.remote, ['rev-parse', 'refs/heads/candidate'])).toBe(committed.commitSha)
      expect(reads).toEqual([1, 1, 1, 1])
    } finally {
      f.cleanup()
    }
  }, 120_000)

  test('selected replay rejects a same-tree head with a different parent and preserves the actual remote', async () => {
    const f = await fixture()
    try {
      writeFileSync(join(f.baseline, 'parent.txt'), 'foreign parent\n')
      await f.git(f.baseline, ['add', '.'])
      await f.git(f.baseline, ['commit', '-q', '-m', 'foreign parent'])
      const parent = await f.git(f.baseline, ['rev-parse', 'HEAD'])
      const foreign = await f.git(f.baseline, [
        'commit-tree',
        f.input.expectedTreeOid,
        '-p',
        parent,
        '-m',
        'same tree different parent',
      ])
      await f.git(f.baseline, ['push', '-q', f.remote, `${foreign}:refs/heads/candidate`])
      const createdBefore = f.store.workspacesCreated
      const result = await f.delivery.push(f.store.poisonLegacy({ ...f.input }))
      expect(result).toEqual({
        ok: false,
        code: 'remote-head-changed',
        detail: `remote refs/heads/candidate is ${foreign}, expected absent`,
      })
      expect(await f.git(f.remote, ['rev-parse', 'refs/heads/candidate'])).toBe(foreign)
      expect(f.store.baselineCommands.at(-2)?.args).toEqual([
        'rev-parse',
        '--verify',
        `${foreign}^{tree}`,
      ])
      expect(f.store.baselineCommands.at(-1)?.args).toEqual([
        'rev-parse',
        '--verify',
        `${foreign}^1`,
      ])
      expect(f.store.workspacesCreated).toBe(createdBefore)
      expect(f.store.trace.slice(-2)).toEqual(['publication:close', 'candidate:close'])
      expect(f.store.legacyReads).toBe(0)
    } finally {
      f.cleanup()
    }
  }, 120_000)
})

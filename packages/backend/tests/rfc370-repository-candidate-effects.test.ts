// RFC-370 A4 — selected asynchronous candidate content, Git and cleanup.
// Existing RFC-310 PR4/PR5 tests retain the real Git/default-file assertions.
import { describe, expect, test } from 'bun:test'

import {
  bindCandidateDeliveryParticipant,
  bindChangeCandidateParticipant,
} from '../src/modules/source-control/composition/repositoryCandidate'
import type {
  RepositoryCandidateEffectsFactory,
  RepositoryCandidateFileFacts,
  RepositoryCandidateGitOptions,
  RepositoryCandidateGitOutcome,
  RepositoryCandidateSession,
  RepositoryCandidateWorkspace,
} from '../src/modules/source-control/application/ports/repositoryCandidateEffects'
import { missionCandidateRef } from '../src/modules/source-control/application/deliverCandidate'
import { AW_INTERNAL_GIT_IDENTITY } from '../src/util/git'

const BASE = {
  baselineRepoPath: 'artifact:baseline',
  overlayRoot: 'artifact:overlay',
  baselineSha: 'baseline-1',
  excludePolicyDigest: 'policy-1',
  agentOutcomeRef: 'outcome-1',
} as const
const MISSION = '01M09PUBLISHULID0000000000'
const OK: RepositoryCandidateGitOutcome = { exitCode: 0, stdout: '', stderr: '' }
const A = 'a'.repeat(64)
const B = 'b'.repeat(64)

function held() {
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    entered,
    release,
    async before() {
      enter()
      await released
    },
  }
}

async function enteredBeforeCompletion(entered: Promise<void>, pending: Promise<unknown>) {
  await Promise.race([
    entered,
    pending.then(() => {
      throw new Error('candidate completed before the selected effect')
    }),
  ])
}

class CandidateFixture {
  readonly trace: string[] = []
  readonly hooks = new Map<string, () => void | Promise<void>>()
  readonly commands: { args: readonly string[]; options?: RepositoryCandidateGitOptions }[] = []
  readonly copies: string[] = []
  readonly modes: { path: string; mode: number }[] = []
  readonly removed: string[] = []
  readonly digestReads: string[] = []
  readonly baselineCommands: string[][] = []
  readonly digests = new Map<string, string | null>([
    ['a.txt', A],
    ['b.txt', B],
  ])
  readonly workspace = new SelectedWorkspace(this)
  readonly session = new SelectedSession(this)
  readonly factory = new SelectedFactory(this)
  tree = 'tree-1'
  diff = 'A\0a.txt\0A\0b.txt\0'
  reusedCommit: string | null = null
  cloneOutcome: RepositoryCandidateGitOutcome = OK
  transferOutcome: RepositoryCandidateGitOutcome = OK
  nativeCalls = 0
  poisonGit = async (): Promise<never> => {
    this.nativeCalls++
    throw new Error('selected candidate effects must not call request/native Git')
  }

  async enter(name: string) {
    this.trace.push(name)
    await this.hooks.get(name)?.()
  }

  deriveInput() {
    return { ...BASE, runGit: this.poisonGit }
  }

  commitInput() {
    return {
      ...BASE,
      runGit: this.poisonGit,
      missionId: MISSION,
      expectedTreeOid: this.tree,
      summarySource: 'selected candidate',
    }
  }
}

class SelectedFactory implements RepositoryCandidateEffectsFactory {
  constructor(readonly fixture: CandidateFixture) {}
  async acquire(input: { readonly baselineReference: string; readonly overlayReference: string }) {
    expect(this).toBe(this.fixture.factory)
    expect(input).toEqual({
      baselineReference: BASE.baselineRepoPath,
      overlayReference: BASE.overlayRoot,
    })
    await this.fixture.enter('factory:acquire')
    return this.fixture.session
  }
}

class SelectedSession implements RepositoryCandidateSession {
  constructor(readonly fixture: CandidateFixture) {}
  async runBaseline(args: readonly string[]) {
    expect(this).toBe(this.fixture.session)
    this.fixture.baselineCommands.push([...args])
    await this.fixture.enter('baseline:' + args.join(' '))
    if (this.fixture.reusedCommit === null) return { ...OK, exitCode: 1 }
    if (args[2]?.endsWith('^{commit}')) return { ...OK, stdout: this.fixture.reusedCommit + '\n' }
    if (args[2]?.endsWith('^{tree}')) return { ...OK, stdout: this.fixture.tree + '\n' }
    return { ...OK, stdout: BASE.baselineSha + '\n' }
  }
  async createWorkspace() {
    expect(this).toBe(this.fixture.session)
    await this.fixture.enter('workspace:create')
    return this.fixture.workspace
  }
  async close() {
    expect(this).toBe(this.fixture.session)
    await this.fixture.enter('session:close')
  }
}

class SelectedWorkspace implements RepositoryCandidateWorkspace {
  readonly reference = 'artifact:temporary-candidate'
  constructor(readonly fixture: CandidateFixture) {}
  private check() {
    expect(this).toBe(this.fixture.workspace)
  }
  async cloneBaseline() {
    this.check()
    await this.fixture.enter('workspace:clone')
    return this.fixture.cloneOutcome
  }
  async run(args: readonly string[], options?: RepositoryCandidateGitOptions) {
    this.check()
    this.fixture.commands.push({ args: [...args], options })
    await this.fixture.enter('git:' + args[0])
    if (args[0] === 'write-tree') return { ...OK, stdout: this.fixture.tree + '\n' }
    if (args[0] === 'diff') return { ...OK, stdout: this.fixture.diff }
    if (args[0] === 'commit-tree') return { ...OK, stdout: 'commit-1\n' }
    return OK
  }
  async listCandidateRoot() {
    this.check()
    await this.fixture.enter('candidate:list')
    return ['old.txt', '.git', 'old-directory']
  }
  async removeCandidateEntry(path: string) {
    this.check()
    await this.fixture.enter('candidate:remove:' + path)
    this.fixture.removed.push(path)
  }
  async statOverlay(path: string): Promise<RepositoryCandidateFileFacts> {
    this.check()
    await this.fixture.enter('overlay:stat:' + path)
    return {
      kind: path === '' || path === 'src' ? 'directory' : 'file',
      mode: path === 'b.txt' ? 0o100755 : 0o100640,
    }
  }
  async listOverlay(path: string) {
    this.check()
    await this.fixture.enter('overlay:list:' + path)
    return path === '' ? ['src', 'b.txt', '.git', '.agent-workflow', 'a.txt'] : ['c.txt']
  }
  async copyOverlayFile(path: string) {
    this.check()
    await this.fixture.enter('overlay:copy:' + path)
    this.fixture.copies.push(path)
  }
  async statCandidate(path: string): Promise<RepositoryCandidateFileFacts | null> {
    this.check()
    await this.fixture.enter('candidate:stat:' + path)
    return this.fixture.digests.has(path) ? { kind: 'file', mode: 0o100644 } : null
  }
  async setCandidateMode(path: string, mode: number) {
    this.check()
    await this.fixture.enter('candidate:mode:' + path)
    this.fixture.modes.push({ path, mode })
  }
  async readCandidateDigest(path: string) {
    this.check()
    this.fixture.digestReads.push(path)
    await this.fixture.enter('candidate:digest:' + path)
    return this.fixture.digests.get(path) ?? null
  }
  async importCommitToBaseline(input: { readonly commitSha: string; readonly localRef: string }) {
    this.check()
    expect(input).toEqual({ commitSha: 'commit-1', localRef: missionCandidateRef(MISSION) })
    await this.fixture.enter('candidate:import')
    return this.fixture.transferOutcome
  }
  async close() {
    this.check()
    await this.fixture.enter('workspace:close')
  }
}

function plan() {
  return {
    planDigest: 'upload-plan-1',
    entries: [
      {
        targetPath: 'b.txt',
        disposition: 'create' as const,
        fileMode: 'executable' as const,
        contentPolicy: 'agent-editable' as const,
        uploadSha256: null,
      },
      {
        targetPath: 'a.txt',
        disposition: 'replace' as const,
        fileMode: 'regular' as const,
        contentPolicy: 'preserve-upload' as const,
        uploadSha256: A,
      },
    ],
  }
}

describe('RFC-370 selected repository candidate effects', () => {
  test('acquisition and both cleanup ACKs precede completion, with prototype receivers and opaque references', async () => {
    const fx = new CandidateFixture()
    const acquisition = held(),
      workspaceClose = held(),
      sessionClose = held()
    fx.hooks.set('factory:acquire', acquisition.before)
    fx.hooks.set('workspace:close', workspaceClose.before)
    fx.hooks.set('session:close', sessionClose.before)
    const pending = bindChangeCandidateParticipant({ candidateEffects: fx.factory }).derive(
      fx.deriveInput(),
    )
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
      await enteredBeforeCompletion(acquisition.entered, pending)
      expect(fx.trace).toEqual(['factory:acquire'])
      expect(settled).toBe(false)
      acquisition.release()
      await enteredBeforeCompletion(workspaceClose.entered, pending)
      expect(settled).toBe(false)
      expect(fx.trace).not.toContain('session:close')
      workspaceClose.release()
      await enteredBeforeCompletion(sessionClose.entered, pending)
      expect(settled).toBe(false)
      sessionClose.release()
      expect((await pending).ok).toBe(true)
      expect(fx.nativeCalls).toBe(0)
      expect(fx.removed).toEqual(['old.txt', 'old-directory'])
      expect(fx.copies).toEqual(['a.txt', 'b.txt', 'src/c.txt'])
      expect(fx.modes).toEqual([
        { path: 'a.txt', mode: 0o640 },
        { path: 'b.txt', mode: 0o755 },
        { path: 'src/c.txt', mode: 0o640 },
      ])
      expect(fx.trace.filter((x) => x === 'workspace:close')).toHaveLength(1)
      expect(fx.trace.filter((x) => x === 'session:close')).toHaveLength(1)
    } finally {
      acquisition.release()
      workspaceClose.release()
      sessionClose.release()
      await pending.catch(() => undefined)
    }
  })

  test('upload staging retains input order and explicit modes while lineage reads lazily in target order', async () => {
    const fx = new CandidateFixture()
    const readA = held()
    fx.hooks.set('candidate:digest:a.txt', readA.before)
    const pending = bindChangeCandidateParticipant({ candidateEffects: fx.factory }).derive({
      ...fx.deriveInput(),
      uploadPlan: plan(),
    })
    try {
      await enteredBeforeCompletion(readA.entered, pending)
      expect(fx.digestReads).toEqual(['a.txt'])
      readA.release()
      const result = await pending
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.receipt.uploadLineage).toEqual({
        planDigest: 'upload-plan-1',
        finalDigests: [
          { targetPath: 'a.txt', sha256: A },
          { targetPath: 'b.txt', sha256: B },
        ],
      })
      expect(fx.commands.filter((c) => c.args[0] === 'add').map((c) => c.args)).toEqual([
        ['add', '-A', '.'],
        ['add', '-f', '--', 'b.txt'],
        ['add', '-f', '--', 'a.txt'],
      ])
      expect(fx.commands.filter((c) => c.args[0] === 'update-index').map((c) => c.args)).toEqual([
        ['update-index', '--chmod=+x', '--', 'b.txt'],
        ['update-index', '--chmod=-x', '--', 'a.txt'],
      ])
      expect(fx.digestReads).toEqual(['a.txt', 'b.txt'])
    } finally {
      readA.release()
      await pending.catch(() => undefined)
    }
  })

  test('the first digest mismatch does not read later entries', async () => {
    const fx = new CandidateFixture()
    fx.digests.set('a.txt', B)
    const result = await bindChangeCandidateParticipant({ candidateEffects: fx.factory }).derive({
      ...fx.deriveInput(),
      uploadPlan: plan(),
    })
    expect(result).toEqual({ ok: false, code: 'upload-preserve-digest-mismatch', detail: 'a.txt' })
    expect(fx.digestReads).toEqual(['a.txt'])
    expect(fx.nativeCalls).toBe(0)
  })

  test('a missing diff entry short-circuits before any content read', async () => {
    const fx = new CandidateFixture()
    fx.diff = 'A\0b.txt\0'
    const result = await bindChangeCandidateParticipant({ candidateEffects: fx.factory }).derive({
      ...fx.deriveInput(),
      uploadPlan: plan(),
    })
    expect(result).toEqual({ ok: false, code: 'upload-entry-missing-from-diff', detail: 'a.txt' })
    expect(fx.digestReads).toEqual([])
  })

  test('same-identity commit reuse needs no workspace and awaits session release', async () => {
    const fx = new CandidateFixture()
    fx.reusedCommit = 'already-committed'
    const close = held()
    fx.hooks.set('session:close', close.before)
    const pending = bindCandidateDeliveryParticipant({ candidateEffects: fx.factory }).commit(
      fx.commitInput(),
    )
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
      await enteredBeforeCompletion(close.entered, pending)
      expect(settled).toBe(false)
      expect(fx.trace).not.toContain('workspace:create')
      expect(fx.baselineCommands).toEqual([
        ['rev-parse', '--verify', `${missionCandidateRef(MISSION)}^{commit}`],
        ['rev-parse', '--verify', 'already-committed^{tree}'],
        ['rev-parse', '--verify', 'already-committed^1'],
      ])
      close.release()
      expect(await pending).toEqual({
        ok: true,
        commitSha: 'already-committed',
        localRef: missionCandidateRef(MISSION),
        reused: true,
      })
    } finally {
      close.release()
      await pending.catch(() => undefined)
    }
  })

  test('commit transfer ACK precedes cleanup and durable success', async () => {
    const fx = new CandidateFixture()
    const transfer = held()
    fx.hooks.set('candidate:import', transfer.before)
    const pending = bindCandidateDeliveryParticipant({ candidateEffects: fx.factory }).commit(
      fx.commitInput(),
    )
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
      await enteredBeforeCompletion(transfer.entered, pending)
      expect(settled).toBe(false)
      expect(fx.trace).not.toContain('workspace:close')
      expect(fx.trace).not.toContain('session:close')
      expect(fx.commands.find((c) => c.args[0] === 'commit-tree')?.options).toEqual({
        env: { ...AW_INTERNAL_GIT_IDENTITY },
      })
      transfer.release()
      expect(await pending).toEqual({
        ok: true,
        commitSha: 'commit-1',
        localRef: missionCandidateRef(MISSION),
        reused: false,
      })
      expect(fx.trace.slice(-2)).toEqual(['workspace:close', 'session:close'])
      expect(fx.nativeCalls).toBe(0)
    } finally {
      transfer.release()
      await pending.catch(() => undefined)
    }
  })

  test('stage returns the selected opaque workspace and releases both leases once', async () => {
    const fx = new CandidateFixture()
    const staged = await bindCandidateDeliveryParticipant({ candidateEffects: fx.factory }).stage(
      fx.deriveInput(),
    )
    expect(staged.ok).toBe(true)
    if (!staged.ok) return
    const close = held()
    fx.hooks.set('workspace:close', close.before)
    const pending = Promise.resolve(staged.cleanup())
    try {
      await enteredBeforeCompletion(close.entered, pending)
      expect(staged.ws).toBe('artifact:temporary-candidate')
      expect(fx.trace).not.toContain('session:close')
      close.release()
      await pending
      await staged.cleanup()
      expect(fx.trace.filter((x) => x === 'workspace:close')).toHaveLength(1)
      expect(fx.trace.filter((x) => x === 'session:close')).toHaveLength(1)
    } finally {
      close.release()
      await pending.catch(() => undefined)
    }
  })

  test('failed clone preserves its typed result and waits for cleanup', async () => {
    const fx = new CandidateFixture()
    fx.cloneOutcome = { exitCode: 1, stdout: '', stderr: 'clone rejected' }
    const close = held()
    fx.hooks.set('workspace:close', close.before)
    const pending = bindChangeCandidateParticipant({ candidateEffects: fx.factory }).derive(
      fx.deriveInput(),
    )
    try {
      await enteredBeforeCompletion(close.entered, pending)
      expect(fx.trace).not.toContain('session:close')
      close.release()
      expect(await pending).toEqual({
        ok: false,
        code: 'candidate-workspace-failed',
        detail: 'clone rejected',
      })
    } finally {
      close.release()
      await pending.catch(() => undefined)
    }
  })

  test('a rejected selected operation releases the workspace and session without fallback', async () => {
    const fx = new CandidateFixture()
    const failure = new Error('selected copy failed')
    fx.hooks.set('overlay:copy:a.txt', () => {
      throw failure
    })
    const result = await bindChangeCandidateParticipant({ candidateEffects: fx.factory })
      .derive(fx.deriveInput())
      .catch((error) => error)
    expect(result).toBe(failure)
    expect(fx.trace.slice(-2)).toEqual(['workspace:close', 'session:close'])
    expect(fx.nativeCalls).toBe(0)
  })

  test('factory rejection never creates or substitutes a local workspace', async () => {
    const fx = new CandidateFixture()
    const failure = new Error('selected acquire failed')
    fx.hooks.set('factory:acquire', () => {
      throw failure
    })
    const result = await bindCandidateDeliveryParticipant({ candidateEffects: fx.factory })
      .commit(fx.commitInput())
      .catch((error) => error)
    expect(result).toBe(failure)
    expect(fx.trace).toEqual(['factory:acquire'])
    expect(fx.nativeCalls).toBe(0)
  })
})

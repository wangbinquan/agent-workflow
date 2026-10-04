// RFC-370 A4: complete selected conflict/action owners, actual Git/bytes, and completion ACKs.
// Existing RFC-310 native cases remain unchanged; these cases use non-path references.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_WORKSPACE_DIR } from '@agent-workflow/shared'
import { runGit as defaultRunGit } from '../src/util/git'
import type { RepositoryGit } from '../src/modules/source-control/application/repositoryCommit'
import { bindConflictMergeParticipant } from '../src/modules/source-control/composition'
import type { ConflictMergeWorkspaceEffects } from '../src/modules/source-control/public/types'
import {
  adoptActionWorkspace,
  materializeActionWorkspace,
} from '../src/modules/development-automation/application/actionWorkspace'
import { businessTreeDigestOf } from '../src/modules/development-automation/infrastructure/actionWorkspace'
import {
  selectActionWorkspaceEffects,
  selectDevelopmentWorkspaceEffectBinding,
} from '../src/modules/development-automation/infrastructure/actionWorkspaceEffects'
import type { ActionWorkspaceEffects } from '../src/modules/development-automation/application/ports/actionWorkspaceEffects'
import type { AutomationWorkspaceEffectsFactory } from '../src/modules/development-automation/application/ports/automationWorkspaceEffects'
import {
  heldEffect,
  enteredBeforeOutcome,
  OpaqueActionEffects,
  OpaqueConflictEffects,
  OpaqueContentFactory,
  OpaqueEvidenceArtifacts,
  WorkspaceReferenceCodec,
} from './helpers/rfc370ConflictWorkspaceEffects'

let home: string
let repo: string
let sourceSha: string
let targetSha: string
const codec = new WorkspaceReferenceCodec()
const budget = { maxFiles: 10, maxFileBytes: 4096, maxTotalBytes: 8192 }

function git(cwd: string, ...args: string[]) {
  const proc = Bun.spawnSync({
    cmd: ['git', ...args],
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'rfc370',
      GIT_AUTHOR_EMAIL: 'rfc370@test',
      GIT_COMMITTER_NAME: 'rfc370',
      GIT_COMMITTER_EMAIL: 'rfc370@test',
    },
  })
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString())
  return proc.stdout.toString().trim()
}
function prepareInput() {
  return {
    baselineRepoPath: codec.reference(repo),
    sourceSha,
    targetSha,
    workspacesRoot: codec.reference(join(home, 'workspaces')),
  }
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'rfc370-conflict-effects-'))
  repo = join(home, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'X.txt'), 'base\n')
  writeFileSync(join(repo, 'other.txt'), 'unchanged\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'base')
  git(repo, 'checkout', '-q', '-b', 'source')
  writeFileSync(join(repo, 'X.txt'), 'source\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'source')
  sourceSha = git(repo, 'rev-parse', 'HEAD')
  git(repo, 'checkout', '-q', 'main')
  writeFileSync(join(repo, 'X.txt'), 'target\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'target')
  targetSha = git(repo, 'rev-parse', 'HEAD')
})
afterAll(() => rmSync(home, { recursive: true, force: true }))

describe('complete SC conflict workspace owner', () => {
  test('native prepare, inspect and finish capture one original Git hook; discard never reads it', async () => {
    const participant = bindConflictMergeParticipant()
    let reads = 0
    let calls = 0
    const nativeGit: RepositoryGit = (cwd, args, options) => {
      calls += 1
      return defaultRunGit(cwd, args, options)
    }
    const withHook = <T extends object>(input: T): T & { readonly runGit: RepositoryGit } => {
      reads = 0
      calls = 0
      return Object.defineProperty({ ...input }, 'runGit', {
        get(): RepositoryGit {
          reads += 1
          if (reads !== 1) throw new Error('native operation reread its original Git hook')
          return nativeGit
        },
      }) as T & { readonly runGit: RepositoryGit }
    }
    const prepared = await participant.prepare(
      withHook({
        baselineRepoPath: repo,
        sourceSha,
        targetSha,
        workspacesRoot: join(home, 'native-hook-workspaces'),
      }),
    )
    expect(reads).toBe(1)
    expect(calls).toBeGreaterThan(0)
    if (!prepared.ok) throw new Error(prepared.detail)
    try {
      writeFileSync(join(prepared.workspacePath, 'X.txt'), 'resolved\n')
      expect(await participant.inspect(withHook(prepared))).toEqual({ ok: true })
      expect(reads).toBe(1)
      expect(calls).toBeGreaterThan(0)
      const finished = await participant.finish(
        withHook({
          ...prepared,
          sourceSha,
          targetSha,
          missionId: 'native-hook-conflict',
        }),
      )
      expect(reads).toBe(1)
      expect(calls).toBeGreaterThan(0)
      expect(finished.ok).toBe(true)
      if (!finished.ok) throw new Error(finished.detail)
      expect(
        git(prepared.workspacePath, 'rev-list', '--parents', '-n', '1', finished.mergeCommitSha)
          .split(' ')
          .slice(1),
      ).toEqual([sourceSha, targetSha])
      let cleanupReads = 0
      await participant.discard(
        Object.defineProperty({ workspacePath: prepared.workspacePath }, 'runGit', {
          get(): RepositoryGit {
            cleanupReads += 1
            throw new Error('native cleanup must not read a Git hook')
          },
        }),
      )
      expect(cleanupReads).toBe(0)
      expect(existsSync(prepared.workspacePath)).toBe(false)
    } finally {
      if (existsSync(prepared.workspacePath)) await prepared.cleanup()
    }
  }, 120_000)

  test('selected prepare, inspect, finish and discard never read the legacy Git getter', async () => {
    const effects = new OpaqueConflictEffects(codec)
    const participant = bindConflictMergeParticipant({ effects })
    let reads = 0
    const withHook = <T extends object>(input: T): T & { readonly runGit: RepositoryGit } =>
      Object.defineProperty({ ...input }, 'runGit', {
        get(): RepositoryGit {
          reads += 1
          throw new Error('selected owner must not read a legacy native Git hook')
        },
      }) as T & { readonly runGit: RepositoryGit }
    const prepared = await participant.prepare(withHook(prepareInput()))
    if (!prepared.ok) throw new Error(prepared.detail)
    const physical = codec.physical(prepared.workspacePath)
    try {
      writeFileSync(join(physical, 'X.txt'), 'resolved\n')
      expect(await participant.inspect(withHook(prepared))).toEqual({ ok: true })
      const finished = await participant.finish(
        withHook({
          ...prepared,
          sourceSha,
          targetSha,
          missionId: 'selected-hook-conflict',
        }),
      )
      expect(finished.ok).toBe(true)
      if (!finished.ok) throw new Error(finished.detail)
      expect(
        git(physical, 'rev-list', '--parents', '-n', '1', finished.mergeCommitSha)
          .split(' ')
          .slice(1),
      ).toEqual([sourceSha, targetSha])
      await participant.discard(withHook({ workspacePath: prepared.workspacePath }))
      expect(reads).toBe(0)
      expect(effects.discards).toEqual([prepared.workspacePath])
      expect(existsSync(physical)).toBe(false)
    } finally {
      if (existsSync(physical)) await prepared.cleanup()
    }
  }, 120_000)

  test.each(['allocate', 'cloneBaseline', 'run', 'installPlatformExclude'])(
    'prepare awaits selected %s and ignores the native per-operation Git override',
    async (method) => {
      const held = heldEffect()
      let heldOnce = false
      const effects = new OpaqueConflictEffects(codec, async (effect) => {
        if (effect === method && !heldOnce) {
          heldOnce = true
          await held.wait()
        }
      })
      let overrideCalls = 0
      let returned = false
      const participant = bindConflictMergeParticipant({ effects })
      const preparing = participant
        .prepare({
          ...prepareInput(),
          runGit: async () => {
            overrideCalls += 1
            throw new Error('native fixture must not replace selected effects')
          },
        })
        .then((value) => {
          returned = true
          return value
        })
      await enteredBeforeOutcome(held, preparing)
      try {
        expect(returned).toBe(false)
        expect(overrideCalls).toBe(0)
      } finally {
        held.release()
      }
      const prepared = await preparing
      expect(prepared.ok).toBe(true)
      if (!prepared.ok) throw new Error(prepared.detail)
      expect(prepared.workspacePath).toBe(effects.allocations[0]!)
      expect(prepared.conflictPaths).toEqual(['X.txt'])
      expect(readFileSync(join(codec.physical(prepared.workspacePath), 'X.txt'), 'utf8')).toContain(
        '<<<<<<<',
      )
      expect(git(codec.physical(prepared.workspacePath), 'remote')).toBe('')
      await prepared.cleanup()
      expect(effects.discards).toEqual([prepared.workspacePath])
      expect(existsSync(codec.physical(prepared.workspacePath))).toBe(false)
    },
    120_000,
  )

  test('inspect awaits file read, finish awaits MERGE_HEAD, and the two-parent receipt is idempotent', async () => {
    const read = heldEffect()
    const probe = heldEffect()
    const discard = heldEffect()
    let phase = ''
    const effects = new OpaqueConflictEffects(codec, async (effect) => {
      if (phase === 'read' && effect === 'readConflictFile') await read.wait()
      if (phase === 'probe' && effect === 'mergeHeadExists') await probe.wait()
      if (phase === 'discard' && effect === 'discard') await discard.wait()
    })
    const participant = bindConflictMergeParticipant({ effects })
    const prepared = await participant.prepare(prepareInput())
    if (!prepared.ok) throw new Error(prepared.detail)
    const physical = codec.physical(prepared.workspacePath)
    let readReturned = false
    phase = 'read'
    const inspecting = participant.inspect(prepared).then((value) => {
      readReturned = true
      return value
    })
    await enteredBeforeOutcome(read, inspecting)
    try {
      expect(readReturned).toBe(false)
    } finally {
      read.release()
    }
    expect(await inspecting).toMatchObject({ ok: false, code: 'conflict-unresolved' })
    writeFileSync(join(physical, 'X.txt'), 'resolved\n')
    phase = 'probe'
    let finishReturned = false
    const input = { ...prepared, sourceSha, targetSha, missionId: 'selected-conflict' }
    const finishing = participant.finish(input).then((value) => {
      finishReturned = true
      return value
    })
    await enteredBeforeOutcome(probe, finishing)
    try {
      expect(finishReturned).toBe(false)
      expect(git(physical, 'rev-parse', 'HEAD')).toBe(sourceSha)
    } finally {
      probe.release()
    }
    const finished = await finishing
    expect(finished.ok).toBe(true)
    if (!finished.ok) throw new Error(finished.detail)
    phase = ''
    expect(
      git(physical, 'rev-list', '--parents', '-n', '1', finished.mergeCommitSha)
        .split(' ')
        .slice(1),
    ).toEqual([sourceSha, targetSha])
    expect(await participant.finish(input)).toEqual(finished)
    phase = 'discard'
    let cleanupReturned = false
    const cleaning = Promise.resolve(prepared.cleanup()).then(() => {
      cleanupReturned = true
    })
    await enteredBeforeOutcome(discard, cleaning)
    try {
      expect(cleanupReturned).toBe(false)
      expect(existsSync(physical)).toBe(true)
    } finally {
      discard.release()
    }
    await cleaning
    expect(effects.discards).toEqual([prepared.workspacePath])
    expect(existsSync(physical)).toBe(false)
  }, 120_000)

  test('typed no-conflict is returned only after the creating owner cleanup ACK', async () => {
    const held = heldEffect()
    const effects = new OpaqueConflictEffects(codec, async (effect) => {
      if (effect === 'discard') await held.wait()
    })
    let returned = false
    const pending = bindConflictMergeParticipant({ effects })
      .prepare({ ...prepareInput(), targetSha: sourceSha })
      .then((value) => {
        returned = true
        return value
      })
    await enteredBeforeOutcome(held, pending)
    const reference = effects.allocations[0]!
    try {
      expect(returned).toBe(false)
      expect(existsSync(codec.physical(reference))).toBe(true)
    } finally {
      held.release()
    }
    expect(await pending).toMatchObject({ ok: false, code: 'no-conflict' })
    expect(effects.discards).toEqual([reference])
    expect(existsSync(codec.physical(reference))).toBe(false)
  }, 120_000)

  test('selected read rejection keeps its original identity without a native fallback', async () => {
    const failure = new Error('selected-read-failure')
    const effects = new OpaqueConflictEffects(codec, async (effect) => {
      if (effect === 'readConflictFile') throw failure
    })
    const participant = bindConflictMergeParticipant({ effects })
    const prepared = await participant.prepare(prepareInput())
    if (!prepared.ok) throw new Error(prepared.detail)
    try {
      const error: unknown = await participant.inspect(prepared).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect<unknown>(error).toBe(failure)
      expect(effects.calls.filter((name) => name === 'readConflictFile')).toHaveLength(1)
    } finally {
      await prepared.cleanup()
    }
  }, 120_000)

  test.each([
    'allocate',
    'cloneBaseline',
    'run',
    'installPlatformExclude',
    'readConflictFile',
    'mergeHeadExists',
    'discard',
  ])('a missing %s rejects the complete selection before any effect', (method) => {
    const effects = new OpaqueConflictEffects(codec)
    const incomplete = Object.freeze(
      Object.create(effects, { [method]: { value: undefined } }),
    ) as ConflictMergeWorkspaceEffects
    expect(() => bindConflictMergeParticipant({ effects: incomplete })).toThrow(
      'conflict-merge-workspace-effects-incomplete',
    )
    expect(effects.calls).toEqual([])
  })
})

describe('DA action workspace keeps the selected reference interpreter and original digest', () => {
  test('binary seed, bundle and close ACK precede return; adopt preserves the same real conflict scene', async () => {
    const seedRoot = join(home, 'seeds')
    mkdirSync(join(seedRoot, 'seed-1', 'nested'), { recursive: true })
    const bytes = new Uint8Array([0, 255, 13, 10, 128, 65])
    writeFileSync(join(seedRoot, 'seed-1', 'nested', 'seed.bin'), bytes)
    chmodSync(join(seedRoot, 'seed-1', 'nested', 'seed.bin'), 0o755)
    const staged = join(home, 'staged')
    mkdirSync(staged)
    writeFileSync(join(staged, 'body.bin'), bytes)
    const bundleHeld = heldEffect()
    const closeHeld = heldEffect()
    let closeGate = true
    const contents = new OpaqueContentFactory(codec, async (effect) => {
      if (closeGate && effect === 'close') await closeHeld.wait()
    })
    const effects = new OpaqueActionEffects(codec, contents)
    const evidence = new OpaqueEvidenceArtifacts(codec, join(home, 'evidence'), async (effect) => {
      if (effect === 'materialize-bundle') await bundleHeld.wait()
    })
    const bundle = await evidence.importStagedTree(staged, budget)
    const deps = {
      evidence,
      seedsRoot: codec.reference(seedRoot),
      workspacesRoot: codec.reference(join(home, 'actions')),
    }
    const mountPath = `${PLATFORM_WORKSPACE_DIR}/inputs/bundle`
    let returned = false
    const pending = materializeActionWorkspace(
      deps,
      {
        baselineRepoPath: codec.reference(repo),
        baselineSha: sourceSha,
        seedRef: 'seed-1',
        bundles: [{ bundleId: bundle.bundleId, mountPath }],
      },
      effects,
    ).then((value) => {
      returned = true
      return value
    })
    await enteredBeforeOutcome(bundleHeld, pending)
    try {
      expect(returned).toBe(false)
      expect(contents.calls).not.toContain('close')
    } finally {
      bundleHeld.release()
    }
    await enteredBeforeOutcome(closeHeld, pending)
    try {
      expect(returned).toBe(false)
    } finally {
      closeHeld.release()
    }
    const materialized = await pending
    const physical = codec.physical(materialized.workspacePath)
    try {
      expect(materialized.businessTreeDigest).toBe(businessTreeDigestOf(physical))
      expect(new Uint8Array(readFileSync(join(physical, 'nested', 'seed.bin')))).toEqual(bytes)
      expect(new Uint8Array(readFileSync(join(physical, mountPath, 'body.bin')))).toEqual(bytes)
      expect(git(physical, 'remote')).toBe('')
      expect(
        await effects.requireEntry(contents.resolve(materialized.workspacePath, 'nested/seed.bin')),
      ).toMatchObject({ kind: 'file' })
      expect(contents.calls).toContain('copyFile')
      expect(contents.calls).toContain('setMode')
    } finally {
      await effects.discard(materialized.workspacePath)
    }
    closeGate = false
    const conflict = new OpaqueConflictEffects(codec)
    const prepared = await bindConflictMergeParticipant({ effects: conflict }).prepare(
      prepareInput(),
    )
    if (!prepared.ok) throw new Error(prepared.detail)
    try {
      const before = readFileSync(join(codec.physical(prepared.workspacePath), 'X.txt'))
      const allocationCount = effects.allocations.length
      const adopted = await adoptActionWorkspace(
        { evidence },
        { workspacePath: prepared.workspacePath, bundles: [] },
        effects,
      )
      expect(adopted.workspacePath).toBe(prepared.workspacePath)
      expect(adopted.businessTreeDigest).toBe(
        businessTreeDigestOf(codec.physical(prepared.workspacePath)),
      )
      expect(readFileSync(join(codec.physical(prepared.workspacePath), 'X.txt'))).toEqual(before)
      expect(effects.allocations).toHaveLength(allocationCount)
      expect(effects.discards).toEqual([materialized.workspacePath])
    } finally {
      await prepared.cleanup()
    }
  }, 120_000)

  test('adopt body and close rejections preserve both original error identities', async () => {
    const bodyError = new Error('body')
    const closeError = new Error('close')
    const contents = new OpaqueContentFactory(codec, async (effect) => {
      if (effect === 'close') throw closeError
    })
    const effects = new OpaqueActionEffects(codec, contents, async (effect) => {
      if (effect === 'requireEntry') throw bodyError
    })
    const evidence = new OpaqueEvidenceArtifacts(codec, join(home, 'evidence-errors'))
    const error: unknown = await adoptActionWorkspace(
      { evidence },
      { workspacePath: codec.reference(repo), bundles: [] },
      effects,
    ).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toEqual([bodyError, closeError])
    expect<unknown>((error as AggregateError).errors[0]).toBe(bodyError)
    expect<unknown>((error as AggregateError).errors[1]).toBe(closeError)
    expect(effects.allocations).toEqual([])
    expect(effects.discards).toEqual([])
  })

  test.each([
    'allocate',
    'cloneBaseline',
    'run',
    'installPlatformExclude',
    'requireEntry',
    'discard',
    'contents',
  ])('a missing DA %s rejects before allocation', (method) => {
    const effects = new OpaqueActionEffects(codec, new OpaqueContentFactory(codec))
    const incomplete = Object.freeze(
      Object.create(effects, { [method]: { value: undefined } }),
    ) as ActionWorkspaceEffects
    expect(() => selectActionWorkspaceEffects(incomplete)).toThrow(
      'action-workspace-effects-incomplete',
    )
    expect(effects.calls).toEqual([])
  })
  test('paired bootstrap rejects missing DA and explicit null factory before SC allocation', () => {
    const conflict = new OpaqueConflictEffects(codec)
    const contents = new OpaqueContentFactory(codec)
    const action = new OpaqueActionEffects(codec, contents)
    expect(() =>
      selectDevelopmentWorkspaceEffectBinding({ conflictWorkspaceSelected: true }),
    ).toThrow('conflict-workspace-action-effects-required')
    expect(() =>
      selectDevelopmentWorkspaceEffectBinding({
        conflictWorkspaceSelected: true,
        actionWorkspaceEffects: action,
        automationWorkspaceEffects: null as unknown as AutomationWorkspaceEffectsFactory,
      }),
    ).toThrow('automation-workspace-effects-factory-incomplete')
    const binding = selectDevelopmentWorkspaceEffectBinding({
      conflictWorkspaceSelected: true,
      actionWorkspaceEffects: action,
    })
    expect(binding.actionWorkspaceEffects).toBe(action)
    expect(binding.automationWorkspaceEffects).toBe(contents)
    expect(conflict.calls).toEqual([])
    expect(action.calls).toEqual([])
    expect(contents.calls).toEqual([])
  })
})

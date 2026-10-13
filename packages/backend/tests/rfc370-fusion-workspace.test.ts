// RFC-370: the complete Fusion workspace port preserves native snapshots,
// baseline Git, excluded scaffolding, result reads and speculative cleanup.
// Contract selection tests do not claim remote execution or CS acceptance.
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_FUSION_MANIFEST, PLATFORM_WORKSPACE_DIR } from '@agent-workflow/shared'
import { composeLocalFusionWorkspaces } from '@/modules/system-operations/composition/localFusionWorkspace'
import { selectFusionWorkspaceFactory } from '@/modules/knowledge-evolution/composition/fusionWorkspace'
import type {
  FusionWorkspace,
  FusionWorkspaceFactory,
} from '@/modules/knowledge-evolution/public/participants'

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})
function fixture() {
  const appHome = mkdtempSync(join(tmpdir(), 'rfc370-fusion-workspace-'))
  homes.push(appHome)
  const workspace = selectFusionWorkspaceFactory(composeLocalFusionWorkspaces()).create({ appHome })
  return { appHome, workspace }
}

test('native baseline, proposal capture and overlay retain the same content while excluding Git and platform metadata', async () => {
  const { workspace } = fixture()
  const version = workspace.versionFiles('skill', 3)
  mkdirSync(join(version, PLATFORM_WORKSPACE_DIR), { recursive: true })
  mkdirSync(join(version, '.git'), { recursive: true })
  writeFileSync(join(version, 'SKILL.md'), 'original skill\n')
  writeFileSync(join(version, PLATFORM_WORKSPACE_DIR, 'not-skill'), 'platform metadata')
  const first = workspace.directory('fusion', 1)
  await workspace.ensure(first)
  await workspace.copyContent(version, first)
  expect(existsSync(join(first, '.git'))).toBe(false)
  expect(existsSync(join(first, PLATFORM_WORKSPACE_DIR))).toBe(false)
  expect(await workspace.seedBaseline(first)).toMatch(/^[a-f0-9]{40,64}$/)
  expect((await workspace.captureResult(first)).manifest.kind).toBe('missing')
  writeFileSync(join(first, 'SKILL.md'), 'proposed skill\n')
  const manifestPath = join(first, PLATFORM_FUSION_MANIFEST)
  const manifest = JSON.stringify({
    incorporatedMemoryIds: ['memory'],
    skipped: [],
    changelog: 'proposal',
  })
  writeFileSync(manifestPath, manifest)
  const captured = await workspace.captureResult(first)
  expect(captured.manifest).toEqual({ kind: 'found', text: manifest })
  expect(captured.diff).toContain('+proposed skill')
  expect(captured.diff).not.toContain('result.json')
  const second = workspace.directory('fusion', 2)
  await workspace.ensure(second)
  await workspace.copyContent(version, second)
  await workspace.seedBaseline(second)
  await workspace.overlayProposal(first, second)
  expect(readFileSync(join(second, 'SKILL.md'), 'utf8')).toBe('proposed skill\n')
  const overlaid = await workspace.captureResult(second)
  expect(overlaid.diff).toContain('+proposed skill')
  expect(overlaid.manifest.kind).toBe('missing')
  await workspace.remove(second)
  expect(await workspace.exists(second)).toBe(false)
  expect(await workspace.exists(first)).toBe(true)
})

test('native result reads preserve the original distinction between missing and non-file manifests', async () => {
  const { workspace } = fixture()
  const ref = workspace.directory('fusion', 1)
  await workspace.ensure(ref)
  await workspace.seedBaseline(ref)
  expect((await workspace.captureResult(ref)).manifest.kind).toBe('missing')
  mkdirSync(join(ref, PLATFORM_FUSION_MANIFEST))
  expect((await workspace.captureResult(ref)).manifest.kind).toBe('not-plain-file')
})

test('the native seed failure retains the exact original stage and does not fabricate a baseline', async () => {
  const { appHome } = fixture()
  const workspace = selectFusionWorkspaceFactory(composeLocalFusionWorkspaces()).create({
    appHome,
    seedGit: async (_ref, args) => {
      expect(args).toEqual(['init', '-b', 'fusion'])
      return { exitCode: 1, stdout: '', stderr: 'original git failure' }
    },
  })
  const ref = workspace.directory('fusion', 1)
  await workspace.ensure(ref)
  await expect(workspace.seedBaseline(ref)).rejects.toThrow(
    'failed to initialize fusion worktree: original git failure',
  )
  await workspace.remove(ref)
  expect(await workspace.exists(ref)).toBe(false)
})

test('selection captures the complete original factory and every workspace method with its receiver', async () => {
  let reads = 0
  const scope: FusionWorkspace = {
    directory(id, iteration) {
      expect(this).toBe(scope)
      return `workspace:${id}:${iteration}`
    },
    versionFiles(id, version) {
      expect(this).toBe(scope)
      return `version:${id}:${version}`
    },
    async ensure() {
      expect(this).toBe(scope)
    },
    async exists() {
      expect(this).toBe(scope)
      reads += 1
      return true
    },
    async copyContent() {
      expect(this).toBe(scope)
    },
    async seedBaseline() {
      expect(this).toBe(scope)
      return 'original-baseline'
    },
    async captureResult() {
      expect(this).toBe(scope)
      return { diff: 'original-diff', manifest: { kind: 'missing' } }
    },
    async overlayProposal() {
      expect(this).toBe(scope)
    },
    async remove() {
      expect(this).toBe(scope)
    },
  }
  const factory: FusionWorkspaceFactory = {
    create() {
      expect(this).toBe(factory)
      return scope
    },
  }
  const selected = selectFusionWorkspaceFactory(factory)
  factory.create = () => {
    throw new Error('replacement factory')
  }
  const captured = selected.create({ appHome: 'logical-root' })
  scope.exists = async () => {
    throw new Error('replacement method')
  }
  expect(captured.directory('fusion', 2)).toBe('workspace:fusion:2')
  expect(captured.versionFiles('skill', 1)).toBe('version:skill:1')
  await captured.ensure('workspace')
  expect(await captured.exists('workspace')).toBe(true)
  await captured.copyContent('version', 'workspace')
  expect(await captured.seedBaseline('workspace')).toBe('original-baseline')
  expect(await captured.captureResult('workspace')).toEqual({
    diff: 'original-diff',
    manifest: { kind: 'missing' },
  })
  await captured.overlayProposal('proposal', 'workspace')
  await captured.remove('workspace')
  expect(reads).toBe(1)
})

test('partial factories and scopes fail at selection before any workspace effect', () => {
  expect(() => selectFusionWorkspaceFactory({} as never)).toThrow(
    'fusion-workspace-factory-incomplete',
  )
  const selected = selectFusionWorkspaceFactory({
    create: () => ({ exists: async () => true }),
  } as never)
  expect(() => selected.create({ appHome: 'logical-root' })).toThrow(
    'fusion-workspace-binding-incomplete',
  )
})

test('factory and method getters are read once, so a later lookup cannot replace the selected workspace binding', async () => {
  const { appHome, workspace } = fixture()
  const target = { ...workspace }
  const reads = new Map<keyof FusionWorkspace, number>()
  for (const method of Object.keys(target) as Array<keyof FusionWorkspace>) {
    const original = target[method]
    Object.defineProperty(target, method, {
      get() {
        const count = (reads.get(method) ?? 0) + 1
        reads.set(method, count)
        if (count > 1) throw new Error('workspace getter reread after selection')
        return original
      },
    })
  }
  let factoryReads = 0
  const factory: FusionWorkspaceFactory = {
    get create() {
      factoryReads += 1
      if (factoryReads > 1) throw new Error('factory getter reread after selection')
      return () => target
    },
  }
  const captured = selectFusionWorkspaceFactory(factory).create({ appHome })
  expect(await captured.exists(captured.directory('uncreated-fusion', 1))).toBe(false)
  expect(factoryReads).toBe(1)
  expect(reads.size).toBe(9)
  expect([...reads.values()]).toEqual(Array(9).fill(1))
})

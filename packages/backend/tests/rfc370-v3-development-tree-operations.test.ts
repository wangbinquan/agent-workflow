// RFC-370 §9.2 V3 — development tree walks are coarse hosted operations.
//
// Why these tests exist: the hosted development scene selection used to run
// every step of a tree walk as its own command subtask (inspect + list + read
// per entry for the business tree snapshot, the protected-root snapshot, the
// outcome validation and the scene digest; stat + copy + chmod per seed file):
// tens of thousands of subtasks per Agent action on a real repository. Each
// walk and the scene preparation are now ONE task-image command running the
// same native function against the volume. These tests run the real handlers
// over a fixture volume and lock: one command per phase, results identical to
// the standalone walk, payloads above the argv/outcome budgets travelling as
// released volume files, the per-volume reference check, and the removal of
// the per-step scene effects.
import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeWorkspaceTaskImageOperation } from '@/bootstrap/workspaceTaskImage'
import {
  adoptActionWorkspace,
  materializeActionWorkspace,
} from '@/modules/development-automation/application/actionWorkspace'
import type { EvidenceArtifactPort } from '@/modules/development-automation/application/ports/evidenceArtifacts'
import { composeCrewStationDevelopmentWorkspaces } from '@/modules/development-automation/composition/crewstationWorkspace'
import { createWorkspaceValidationAdapter } from '@/modules/development-automation/infrastructure/attemptSupport'
import { snapshotProtectedRoots } from '@/modules/development-automation/infrastructure/protectedSnapshot'
import {
  businessTreeSnapshot,
  validateWorkspaceOutcome,
} from '@/modules/development-automation/infrastructure/workspaceValidator'
import { businessTreeDigestOf } from '@/modules/development-automation/infrastructure/local/fileActionWorkspaceEffects'
import {
  hostedWorkspaceReference,
  parseHostedWorkspaceReference,
} from '@/modules/source-control/infrastructure/crewstation/workspaceReference'
import { writeHostedWorkspaceStream } from '@/modules/source-control/infrastructure/crewstation/workspaceUploads'
import {
  workspaceHelperArguments,
  workspaceResultPath,
  type WorkspaceHelper,
} from '@/platform/crewstation/workspaceProtocol'
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

const noEvidence = new Proxy({} as EvidenceArtifactPort, {
  get() {
    throw new Error('no evidence should be consulted without bundles')
  },
})

async function volume(files = 3) {
  const root = mkdtempSync(join(tmpdir(), 'aw-v3-tree-'))
  const baseline = join(root, 'baseline')
  mkdirSync(join(baseline, 'src'), { recursive: true })
  await git(baseline, ['init', '-b', 'main'])
  await git(baseline, ['config', 'user.name', 'Fixture'])
  await git(baseline, ['config', 'user.email', 'fixture@example.test'])
  for (let index = 0; index < files; index++)
    writeFileSync(
      join(baseline, 'src', `module-${String(index).padStart(5, '0')}.ts`),
      `${index}\n`,
    )
  await git(baseline, ['add', '.'])
  await git(baseline, ['commit', '-m', 'baseline'])
  const baselineSha = await git(baseline, ['rev-parse', 'HEAD'])
  mkdirSync(join(root, 'seeds', 'seed-1', 'nested'), { recursive: true })
  writeFileSync(join(root, 'seeds', 'seed-1', 'nested', 'upload.bin'), Buffer.from([0, 1, 2]))
  const operations: string[] = []
  const reads: string[] = []
  const writes: string[] = []
  const physical = (reference: string) =>
    translate(parseHostedWorkspaceReference(reference).path, '/work', root) as string
  const helper: WorkspaceHelper = {
    async call<T>(taskId: string, operation: string, value: unknown): Promise<T> {
      expect(taskId).toBe('task')
      operations.push(`${operation}:${(value as { operation?: string }).operation ?? ''}`)
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
  const selected = composeCrewStationDevelopmentWorkspaces({
    helper,
    locate: parseHostedWorkspaceReference,
    reference: hostedWorkspaceReference,
    readFile: async (reference) => {
      reads.push(reference)
      return readFileSync(physical(reference))
    },
    // The real chunked volume write (the bootstrap passes Source Control's).
    writeFile: async (reference, bytes) => {
      writes.push(reference)
      // The task image mounts the volume at /work while this harness runs the
      // handler on a temporary root, so a JSON payload file's /work paths are
      // rebased exactly like the argv payloads above.
      const content = reference.endsWith('.json')
        ? Buffer.from(
            JSON.stringify(
              translate(JSON.parse(Buffer.from(bytes).toString('utf8')), '/work', root),
            ),
          )
        : Buffer.from(bytes)
      await writeHostedWorkspaceStream(helper, {
        workspaceRef: hostedWorkspaceReference('task', '/work'),
        fileRef: reference,
        stream: new Blob([Uint8Array.from(content)]).stream(),
        size: content.byteLength,
        sha256: createHash('sha256').update(content).digest('hex'),
        replace: true,
      })
    },
  })
  return {
    root,
    baseline,
    baselineSha,
    selected,
    operations,
    reads,
    writes,
    physical,
    close: () => rmSync(root, { recursive: true, force: true }),
  }
}

test('scene preparation and digest are one command each and match the native scene', async () => {
  const v = await volume()
  try {
    const materialized = await materializeActionWorkspace(
      { evidence: noEvidence, seedsRoot: 'cs-workspace:task/seeds' },
      {
        baselineRepoPath: 'cs-workspace:task/baseline',
        baselineSha: v.baselineSha,
        seedRef: 'seed-1',
        bundles: [],
      },
      v.selected.actionWorkspaceEffects,
    )
    expect(materialized.workspacePath).toMatch(
      /^cs-workspace:task\/tmp\/actions\/action-[^/]+\/ws$/,
    )
    const scene = v.physical(materialized.workspacePath)
    expect(readFileSync(join(scene, 'nested', 'upload.bin'))).toEqual(Buffer.from([0, 1, 2]))
    expect(await git(scene, ['remote'])).toBe('')
    expect(readFileSync(join(scene, '.git', 'info', 'exclude'), 'utf8')).toContain(
      '.agent-workflow',
    )
    expect(materialized.businessTreeDigest).toBe(businessTreeDigestOf(scene))
    expect(v.operations).toEqual([
      'development-tree:action-scene-prepare',
      'development-tree:action-tree-digest',
    ])
    const adopted = await adoptActionWorkspace(
      { evidence: noEvidence },
      { workspacePath: materialized.workspacePath, bundles: [] },
      v.selected.actionWorkspaceEffects,
    )
    expect(adopted).toEqual(materialized)
    expect(v.operations).toHaveLength(3)
    await v.selected.actionWorkspaceEffects.discard(materialized.workspacePath)
    expect(readdirSync(join(v.root, 'tmp', 'actions'))).toEqual([])
    // Per-step scene effects no longer exist for the hosted selection.
    expect(() => v.selected.actionWorkspaceEffects.allocate()).toThrow('runs-in-volume')
    expect(() =>
      v.selected.actionWorkspaceEffects.cloneBaseline(materialized.workspacePath, 'x'),
    ).toThrow('runs-in-volume')
  } finally {
    v.close()
  }
}, 60_000)

test('snapshots and validation are one command each and equal the standalone walks', async () => {
  const v = await volume()
  try {
    const factory = v.selected.automationWorkspaceEffects
    const scene = 'cs-workspace:task/baseline'
    const roots = {
      'git-meta': 'cs-workspace:task/baseline/.git',
      evidence: 'cs-workspace:task/baseline/.agent-workflow',
    }
    const nativeRoots = {
      'git-meta': join(v.baseline, '.git'),
      evidence: join(v.baseline, '.agent-workflow'),
    }
    const opts = { skipPrefixesByRoot: { 'git-meta': ['objects', 'logs', 'index'] } }
    expect(await businessTreeSnapshot(scene, factory)).toEqual(
      await businessTreeSnapshot(v.baseline),
    )
    const protectedSnapshot = await snapshotProtectedRoots(roots, opts, factory)
    expect(protectedSnapshot).toEqual(await snapshotProtectedRoots(nativeRoots, opts))
    expect(v.operations).toEqual([
      'development-tree:business-tree-snapshot',
      'development-tree:protected-root-snapshot',
    ])
    const adapter = createWorkspaceValidationAdapter(factory)
    const native = createWorkspaceValidationAdapter()
    const preStateJson = await adapter.capturePreState(scene)
    expect(v.operations).toHaveLength(4)
    const nativePreStateJson = await native.capturePreState(v.baseline)
    expect(JSON.parse(preStateJson)).toEqual(JSON.parse(nativePreStateJson))
    writeFileSync(join(v.baseline, 'src', 'module-00000.ts'), 'changed\n')
    writeFileSync(join(v.baseline, 'added.ts'), 'added\n')
    const request = {
      workspacePath: scene,
      preStateJson,
      outcome: 'changed' as const,
      workspaceMode: 'edit-business-files',
      writablePrefixes: [],
      preservePaths: [],
      editablePaths: [],
      budget: { maxChangedFiles: 10, maxTotalBytes: 1_000_000 },
    }
    expect(await adapter.validate(request)).toEqual({
      ok: true,
      kind: 'changed',
      changedPaths: ['added.ts', 'src/module-00000.ts'],
    })
    expect(v.operations.at(-1)).toBe('development-tree:validate-workspace-outcome')
    // The standalone adapter decides identically on the same tree.
    expect(
      await native.validate({
        ...request,
        workspacePath: v.baseline,
        preStateJson: nativePreStateJson,
      }),
    ).toEqual({ ok: true, kind: 'changed', changedPaths: ['added.ts', 'src/module-00000.ts'] })
    const outcome = await validateWorkspaceOutcome(
      {
        workspacePath: scene,
        preProtected: protectedSnapshot,
        protectedRoots: roots,
        protectedSkipPrefixesByRoot: opts.skipPrefixesByRoot,
        preBusinessTree: new Map(),
        outcome: 'no-change',
        workspaceMode: 'read-only',
        writablePrefixes: [],
        preservePaths: [],
        editablePaths: [],
        budget: { maxChangedFiles: 100, maxTotalBytes: 1_000_000 },
      },
      factory,
    )
    expect(outcome).toMatchObject({
      ok: false,
      kind: 'boundary',
      code: 'read-only-workspace-write',
    })
    // Small payloads never needed a volume file.
    expect(v.writes).toEqual([])
    expect(v.reads).toEqual([])
  } finally {
    v.close()
  }
}, 60_000)

test('payloads beyond the command budget travel as released volume files', async () => {
  // Enough entries that a tree snapshot exceeds the inline budget.
  const v = await volume(3_000)
  try {
    const factory = v.selected.automationWorkspaceEffects
    const scene = 'cs-workspace:task/baseline'
    const snapshot = await businessTreeSnapshot(scene, factory)
    expect(snapshot.size).toBe(3_000)
    expect(snapshot).toEqual(await businessTreeSnapshot(v.baseline))
    // The result came back through a file read with the platform file API.
    expect(v.reads).toHaveLength(1)
    expect(v.reads[0]).toMatch(/^cs-workspace:task\/tmp\/development-tree\/[^/]+\.json$/)
    const adapter = createWorkspaceValidationAdapter(factory)
    const preStateJson = await adapter.capturePreState(scene)
    const verdict = await adapter.validate({
      workspacePath: scene,
      preStateJson,
      outcome: 'no-change',
      workspaceMode: 'edit-business-files',
      writablePrefixes: [],
      preservePaths: [],
      editablePaths: [],
      budget: { maxChangedFiles: 10, maxTotalBytes: 1_000_000 },
    })
    expect(verdict).toEqual({ ok: true, kind: 'clean' })
    // The validation input exceeded the argv budget and went in as a file.
    expect(v.writes).toHaveLength(1)
    expect(v.writes[0]).toMatch(/^cs-workspace:task\/tmp\/development-tree\/[^/]+\.json$/)
    expect(v.operations.filter((name) => name === 'development-tree:release')).toHaveLength(
      v.reads.length + v.writes.length,
    )
    // Every payload file was released.
    expect(readdirSync(join(v.root, 'tmp', 'development-tree'))).toEqual([])
  } finally {
    v.close()
  }
}, 120_000)

test('a large input reaches a volume whose payload directory does not exist yet', async () => {
  const v = await volume()
  try {
    const factory = v.selected.automationWorkspaceEffects
    expect(existsSync(join(v.root, 'tmp', 'development-tree'))).toBe(false)
    // A recorded pre-state far larger than one command's argv.
    const preBusinessTree = new Map<string, string>()
    for (let index = 0; index < 4_000; index++)
      preBusinessTree.set(`gone/file-${index}.ts`, `f:r:${'0'.repeat(64)}`)
    const outcome = await validateWorkspaceOutcome(
      {
        workspacePath: 'cs-workspace:task/baseline',
        preProtected: await snapshotProtectedRoots(
          {
            'git-meta': 'cs-workspace:task/baseline/.git',
            evidence: 'cs-workspace:task/baseline/.agent-workflow',
          },
          {},
          factory,
        ),
        protectedRoots: {
          'git-meta': 'cs-workspace:task/baseline/.git',
          evidence: 'cs-workspace:task/baseline/.agent-workflow',
        },
        preBusinessTree,
        outcome: 'changed',
        workspaceMode: 'edit-business-files',
        writablePrefixes: [],
        preservePaths: [],
        editablePaths: [],
        budget: { maxChangedFiles: 100_000, maxTotalBytes: 100_000_000 },
      },
      factory,
    )
    expect(outcome).toMatchObject({ ok: true, kind: 'changed' })
    expect(v.writes).toHaveLength(1)
    // The whole-file write created its scratch directory, then was released.
    expect(readdirSync(join(v.root, 'tmp', 'development-tree'))).toEqual([])
    expect(v.operations).toContain('upload-commit:')
  } finally {
    v.close()
  }
}, 60_000)

test('tree operations stay on one volume and the handler contains its payload files', async () => {
  const v = await volume()
  try {
    const factory = v.selected.automationWorkspaceEffects
    await expect(
      snapshotProtectedRoots(
        { 'git-meta': 'cs-workspace:task/baseline/.git', evidence: 'cs-workspace:other/x' },
        {},
        factory,
      ),
    ).rejects.toThrow('volume-mismatch')
    await expect(
      validateWorkspaceOutcome(
        {
          workspacePath: 'cs-workspace:other/baseline',
          preProtected: { entries: new Map(), digest: 'd' },
          protectedRoots: { evidence: 'cs-workspace:task/baseline/.agent-workflow' },
          preBusinessTree: new Map(),
          outcome: 'no-change',
          workspaceMode: 'read-only',
          writablePrefixes: [],
          preservePaths: [],
          editablePaths: [],
          budget: { maxChangedFiles: 1, maxTotalBytes: 1 },
        },
        factory,
      ),
    ).rejects.toThrow('volume-mismatch')
    expect(v.operations).toEqual([])
    await expect(
      executeWorkspaceTaskImageOperation(
        'development-tree',
        { operation: 'unknown', input: {} },
        undefined,
        v.root,
      ),
    ).rejects.toThrow('tree-operation-unknown')
    for (const file of [
      join(v.root, 'baseline', 'x.json'),
      join(v.root, 'tmp', 'development-tree', 'x.txt'),
    ])
      await expect(
        executeWorkspaceTaskImageOperation(
          'development-tree',
          { operation: 'release', file },
          undefined,
          v.root,
        ),
      ).rejects.toThrow('tree-file-invalid')
    expect(existsSync(v.baseline)).toBe(true)
  } finally {
    v.close()
  }
})

import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeWorkspaceTaskImageOperation } from '@/bootstrap/workspaceTaskImage'
import {
  WorkspaceCommandStoppedError,
  workspaceHelperArguments,
  type WorkspaceHelper,
  workspaceResultPath,
} from '@/platform/crewstation/workspaceProtocol'
import type { CrewStationBusinessExecution } from '@/platform/crewstation/businessExecution'
import {
  createHostedWorkspaceUploads,
  HOSTED_UPLOAD_CHUNK_BYTES,
} from '@/modules/source-control/infrastructure/crewstation/workspaceUploads'
import { createHostedConflictMergeEffects } from '@/modules/source-control/infrastructure/crewstation/conflictMerge'
import type { HostedTaskWorkspaces } from '@/modules/source-control/infrastructure/crewstation/taskWorkspace'
import {
  workspaceUploadPolicy,
  runWorkspaceUploadPolicy,
} from '@/modules/task-execution/application/workspaceUploads'
import {
  prepareConflictMerge,
  finishConflictMerge,
} from '@/modules/source-control/application/conflictMerge'
import { runGit } from '@/util/git'
import {
  createHostedIsolationWorkspaces,
  mapHostedWorkspacePaths,
} from '@/modules/source-control/infrastructure/crewstation/isolationWorkspace'
import { mergeLocalIsolationWorkspace } from '@/modules/source-control/infrastructure/local/localIsolationWorkspace'
import { parseHostedWorkspaceReference } from '@/modules/source-control/infrastructure/crewstation/workspaceReference'
import { MergeAgentChildUnreapedError } from '@/platform/workspace/local/isolation'
import { composeCrewStationDevelopmentWorkspaces } from '@/modules/development-automation/composition/crewstationWorkspace'
import { materializeActionWorkspace } from '@/modules/development-automation/application/actionWorkspace'
import type { EvidenceArtifactPort } from '@/modules/development-automation/application/ports/evidenceArtifacts'
import { createHostedEmployeeCaseWorkspaceOperations } from '@/modules/source-control/infrastructure/crewstation/employeeCaseWorkspace'
import { hostedWorkspaceReference } from '@/modules/source-control/infrastructure/crewstation/workspaceReference'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'aw-hosted-content-'))
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
  const calls: string[] = []
  const helper: WorkspaceHelper = {
    async call<T>(taskId: string, operation: string, value: unknown): Promise<T> {
      expect(taskId).toBe('task')
      calls.push(operation)
      // Every binary transfer must fit the actual platform argv framing.
      workspaceHelperArguments(operation, value, workspaceResultPath('framing-check'))
      try {
        const result = await executeWorkspaceTaskImageOperation(
          operation,
          translate(value, '/work', root),
          undefined,
          root,
        )
        return translate(result, root, '/work') as T
      } catch (error) {
        throw new WorkspaceCommandStoppedError('exited', 1, '', String(error), false)
      }
    },
  }
  const versions: (string | undefined)[] = []
  const api = {
    async readFile(_task: string, query: Parameters<CrewStationBusinessExecution['readFile']>[1]) {
      const bytes = readFileSync(join(root, query.path))
      const version = createHash('sha256').update(bytes).digest('hex')
      versions.push(query.version)
      if (query.version !== undefined && query.version !== version)
        throw new Error('version-changed')
      const offset = query.offset ?? 0
      return {
        path: query.path,
        version,
        size: bytes.length,
        offset,
        contentBase64: bytes
          .subarray(offset, offset + (query.limit ?? bytes.length))
          .toString('base64'),
      }
    },
  } as CrewStationBusinessExecution
  const workspaces: HostedTaskWorkspaces = {
    find: async () => ({ taskId: 'task', businessTaskId: 'business-task' }),
    open: async () => ({ taskId: 'task', businessTaskId: 'business-task' }),
    ensure: async () => ({ taskId: 'task', businessTaskId: 'business-task' }),
    probe: async () => 'running',
    list: async () => [],
    listRunning: async () => [],
    close: async () => true,
    superseded: async () => false,
  }
  const uploads = createHostedWorkspaceUploads({ helper, api, workspaces })
  return {
    root,
    helper,
    uploads,
    calls,
    versions,
    native: <T>(value: T): T => translate(value, '/work', root) as T,
    close: () => rmSync(root, { recursive: true, force: true }),
  }
}

test('hosted uploads preserve binary contents, rename collisions and recovery across command size limits', async () => {
  const f = fixture()
  try {
    mkdirSync(join(f.root, 'workspace', 'inputs'), { recursive: true })
    writeFileSync(join(f.root, 'workspace', 'inputs', 'binary.dat'), 'original')
    const bytes = Buffer.alloc(HOSTED_UPLOAD_CHUNK_BYTES * 2 + 17)
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251
    const plan = {
      workspace: { workspaceRef: 'cs-workspace:task/workspace' },
      defs: new Map([['input', { key: 'input', targetDir: 'inputs' }]]),
      files: [{ inputKey: 'input', filename: 'binary.dat', declaredMime: '', bytes }],
      limits: { perFile: bytes.length, perRequest: bytes.length, perCount: 1 },
    }
    const result = await runWorkspaceUploadPolicy(workspaceUploadPolicy(plan, f.uploads))
    expect(result.packedByKey.get('input')).toEqual(['inputs/binary (1).dat'])
    expect(readFileSync(join(f.root, 'workspace', 'inputs', 'binary.dat'), 'utf8')).toBe('original')
    expect(readFileSync(join(f.root, 'workspace', 'inputs', 'binary (1).dat')).equals(bytes)).toBe(
      true,
    )
    expect(f.calls.filter((name) => name === 'upload-chunk')).toHaveLength(3)
    expect(readdirSync(join(f.root, 'tmp', 'uploads'))).toEqual([])
    const replay = await runWorkspaceUploadPolicy(
      workspaceUploadPolicy(
        {
          ...plan,
          recovery: {
            placement: () => 'binary (1).dat',
            reserve: async () => {
              throw new Error('unexpected reserve')
            },
          },
        },
        f.uploads,
      ),
    )
    expect(replay.packedByKey.get('input')).toEqual(['inputs/binary (1).dat'])
    expect(f.calls.filter((name) => name === 'upload-commit')).toHaveLength(1)
    expect(f.versions.length).toBeGreaterThan(1)
    expect(f.versions[0]).toBeUndefined()
    expect(f.versions.slice(1).every((version) => version === f.versions[1])).toBe(true)
  } finally {
    f.close()
  }
})

test('hosted uploads keep exclusive creation, reject symlink escapes and compensate a failed batch', async () => {
  const f = fixture()
  try {
    mkdirSync(join(f.root, 'workspace', 'inputs'), { recursive: true })
    mkdirSync(join(f.root, 'outside'))
    symlinkSync(join(f.root, 'outside'), join(f.root, 'workspace', 'escape'), 'dir')
    const scope = await f.uploads.bind({ workspaceRef: 'cs-workspace:task/workspace' })
    await expect(Promise.resolve(scope.prepareTarget('escape'))).rejects.toThrow()
    const existing = 'cs-workspace:task/workspace/inputs/existing.txt'
    writeFileSync(join(f.root, 'workspace', 'inputs', 'existing.txt'), 'retained')
    await expect(
      Promise.resolve(scope.write(existing, Buffer.from('replacement'))),
    ).rejects.toThrow('EEXIST')
    expect(readFileSync(join(f.root, 'workspace', 'inputs', 'existing.txt'), 'utf8')).toBe(
      'retained',
    )
    expect(readdirSync(join(f.root, 'tmp', 'uploads'))).toEqual([])
    mkdirSync(join(f.root, 'workspace', 'inputs', 'bad.txt'))
    await expect(
      runWorkspaceUploadPolicy(
        workspaceUploadPolicy(
          {
            workspace: { workspaceRef: 'cs-workspace:task/workspace' },
            defs: new Map([
              ['input', { key: 'input', targetDir: 'inputs', onConflict: 'overwrite' as const }],
            ]),
            files: ['first.txt', 'bad.txt'].map((filename) => ({
              inputKey: 'input',
              filename,
              declaredMime: '',
              bytes: Buffer.from('data'),
            })),
            limits: { perFile: 100, perRequest: 200, perCount: 2 },
          },
          f.uploads,
        ),
      ),
    ).rejects.toThrow('directory already exists')
    expect(existsSync(join(f.root, 'workspace', 'inputs', 'first.txt'))).toBe(false)
    expect(existsSync(join(f.root, 'workspace', 'inputs', 'bad.txt'))).toBe(true)
    expect(() => scope.file('cs-workspace:other/workspace/inputs', 'x')).toThrow('owner-mismatch')
  } finally {
    f.close()
  }
})

test('remote conflict scenes preserve markers and the shared finish policy rejects unresolved work', async () => {
  const f = fixture()
  const git = async (path: string, args: string[]) => {
    const result = await runGit(path, args)
    if (result.exitCode !== 0) throw new Error(result.stderr)
    return result.stdout.trim()
  }
  try {
    const baseline = join(f.root, 'baseline')
    mkdirSync(baseline)
    await git(baseline, ['init', '-b', 'main'])
    await git(baseline, ['config', 'user.name', 'Fixture'])
    await git(baseline, ['config', 'user.email', 'fixture@example.test'])
    writeFileSync(join(baseline, 'file.txt'), 'base\n')
    await git(baseline, ['add', '.'])
    await git(baseline, ['commit', '-m', 'base'])
    const base = await git(baseline, ['rev-parse', 'HEAD'])
    writeFileSync(join(baseline, 'file.txt'), 'source\n')
    await git(baseline, ['commit', '-am', 'source'])
    const sourceSha = await git(baseline, ['rev-parse', 'HEAD'])
    await git(baseline, ['checkout', '--detach', base])
    writeFileSync(join(baseline, 'file.txt'), 'target\n')
    await git(baseline, ['commit', '-am', 'target'])
    const targetSha = await git(baseline, ['rev-parse', 'HEAD'])
    const effects = createHostedConflictMergeEffects(f.helper)
    const scene = await prepareConflictMerge(
      { baselineRepoPath: 'cs-workspace:task/baseline', sourceSha, targetSha },
      effects,
    )
    // The whole result, so a CI failure names its code and Git detail (this
    // step failed once on ubuntu, CI 39110401954, and never locally).
    expect(scene).toMatchObject({ ok: true })
    if (!scene.ok) return
    expect(scene.conflictPaths).toEqual(['file.txt'])
    expect(await effects.mergeHeadExists(scene.workspacePath)).toBe(true)
    expect(await effects.readConflictFile(scene.workspacePath, 'file.txt')).toContain('<<<<<<<')
    expect(
      await finishConflictMerge(
        {
          workspacePath: scene.workspacePath,
          conflictPaths: scene.conflictPaths,
          sourceSha,
          targetSha,
          missionId: 'mission',
        },
        effects,
      ),
    ).toMatchObject({ ok: false, code: 'conflict-unresolved' })
    await scene.cleanup()
    expect(readdirSync(join(f.root, 'tmp', 'conflicts'))).toEqual([])
    expect(readFileSync(join(baseline, 'file.txt'), 'utf8')).toBe('target\n')
  } finally {
    f.close()
  }
}, 30_000)

test('remote merge Agent resolution uses task-volume references and preserves an unreaped writer', async () => {
  const f = fixture()
  const git = async (path: string, args: string[]) => {
    const result = await runGit(path, args)
    if (result.exitCode !== 0) throw new Error(result.stderr)
    return result.stdout.trim()
  }
  try {
    const baseline = join(f.root, 'baseline')
    mkdirSync(baseline)
    await git(baseline, ['init', '-b', 'main'])
    await git(baseline, ['config', 'user.name', 'Fixture'])
    await git(baseline, ['config', 'user.email', 'fixture@example.test'])
    writeFileSync(join(baseline, 'file.txt'), 'base\n')
    await git(baseline, ['add', '.'])
    await git(baseline, ['commit', '-m', 'base'])
    const scope = await createHostedIsolationWorkspaces(f.helper).bind({
      taskId: 'task',
      storageRootRef: 'cs-workspace:task/',
      repositories: [
        {
          repositoryRef: 'cs-workspace:task/baseline',
          workspaceRef: 'cs-workspace:task/baseline',
          mount: '',
          baseBranch: 'main',
        },
      ],
    })
    const workspace = await scope.create({ key: 'node', dbNodeRunId: 'node' })
    const isolated = parseHostedWorkspaceReference(workspace.workspaceRef)
    await f.helper.call('task', 'write-seeds', {
      path: isolated.path,
      files: [{ path: 'file.txt', content: 'node\n' }],
    })
    const snapshot = await scope.snapshot(workspace)
    writeFileSync(join(baseline, 'file.txt'), 'canonical\n')
    const merge = await scope.merge(snapshot.workspace, snapshot.trees)
    expect(merge.clean).toBe(false)
    expect(merge.conflicts).toHaveLength(1)
    const conflict = merge.conflicts[0]!
    let preserved: string | undefined
    const completedBefore = f.calls.filter((name) => name === 'isolation-conflict-finish').length
    await expect(
      Promise.resolve(
        scope.resolveConflict(conflict, {
          containerRef: workspace.workspaceRef,
          runAgent: async (_prompt, reference) => {
            preserved = reference
            throw new MergeAgentChildUnreapedError()
          },
        }),
      ),
    ).rejects.toBeInstanceOf(MergeAgentChildUnreapedError)
    expect(f.calls.filter((name) => name === 'isolation-conflict-finish')).toHaveLength(
      completedBefore,
    )
    expect(preserved).toStartWith('cs-workspace:task/')
    expect(existsSync(join(f.root, parseHostedWorkspaceReference(preserved!).relative))).toBe(true)
    expect(readFileSync(join(baseline, 'file.txt'), 'utf8')).toBe('canonical\n')
    // Simulate the old writer's confirmed terminal result before a fresh attempt.
    const resolved = await scope.resolveConflict(conflict, {
      containerRef: workspace.workspaceRef,
      runAgent: async (prompt, reference, manifest) => {
        expect(prompt).toContain('file.txt')
        expect(manifest.some((entry) => entry.path === 'file.txt')).toBe(true)
        expect(readFileSync(join(baseline, 'file.txt'), 'utf8')).toBe('canonical\n')
        const target = parseHostedWorkspaceReference(reference)
        await f.helper.call('task', 'write-seeds', {
          path: target.path,
          files: [{ path: 'file.txt', content: 'resolved\n' }],
        })
      },
    })
    expect(resolved).toEqual({ resolved: true, unresolved: [], resolveWorkspaceRef: null })
    expect(readFileSync(join(baseline, 'file.txt'), 'utf8')).toBe('resolved\n')
    expect(existsSync(join(f.root, parseHostedWorkspaceReference(preserved!).relative))).toBe(false)
    await scope.discard(merge.workspace)
  } finally {
    f.close()
  }
}, 30_000)

for (const decision of ['resolved', 'unresolved', 'unreaped'] as const) {
  test(`remote submodule merge preserves native settlement when Agent is ${decision}`, async () => {
    const f = fixture()
    const previousConfig = process.env.GIT_CONFIG_GLOBAL
    const config = join(f.root, 'gitconfig')
    writeFileSync(
      config,
      '[protocol "file"]\n\tallow = always\n[user]\n\tname = Fixture\n\temail = fixture@example.test\n',
    )
    process.env.GIT_CONFIG_GLOBAL = config
    const git = async (path: string, args: string[]) => {
      const result = await runGit(path, args)
      if (result.exitCode !== 0) throw new Error(result.stderr)
      return result.stdout.trim()
    }
    try {
      const baseline = join(f.root, 'baseline')
      mkdirSync(baseline)
      await git(baseline, ['init', '-b', 'main'])
      writeFileSync(join(baseline, 'README.md'), 'root\n')
      for (const name of ['first', 'second']) {
        const source = join(f.root, `source-${name}`)
        mkdirSync(source)
        await git(source, ['init', '-b', 'main'])
        writeFileSync(join(source, 'file.txt'), 'base\n')
        await git(source, ['add', '.'])
        await git(source, ['commit', '-m', 'base'])
        await git(baseline, ['submodule', 'add', source, name])
      }
      await git(baseline, ['add', '.'])
      await git(baseline, ['commit', '-m', 'base with submodules'])
      const scope = await createHostedIsolationWorkspaces(f.helper).bind({
        taskId: 'task',
        storageRootRef: 'unused',
        repositories: [
          {
            repositoryRef: 'cs-workspace:task/baseline',
            workspaceRef: 'cs-workspace:task/baseline',
            mount: '',
            baseBranch: 'main',
          },
        ],
      })
      const workspace = await scope.create({ key: 'node', dbNodeRunId: 'node' })
      const isolated = join(f.root, parseHostedWorkspaceReference(workspace.workspaceRef).relative)
      for (const name of ['first', 'second']) {
        writeFileSync(join(isolated, name, 'file.txt'), 'node\n')
        await git(join(isolated, name), ['commit', '-am', 'node'])
      }
      const snapshot = await scope.snapshot(workspace)
      for (const name of ['first', 'second']) {
        writeFileSync(join(baseline, name, 'file.txt'), 'canonical\n')
        await git(join(baseline, name), ['commit', '-am', 'canonical'])
      }
      const invoked: string[] = []
      if (decision === 'unreaped') {
        await expect(
          mergeLocalIsolationWorkspace(
            f.native(mapHostedWorkspacePaths(snapshot.workspace, 'native', 'task')),
            snapshot.trees,
            undefined,
            async () => {
              throw new MergeAgentChildUnreapedError()
            },
          ),
        ).rejects.toBeInstanceOf(MergeAgentChildUnreapedError)
      }
      const merging = Promise.resolve(
        scope.merge(snapshot.workspace, snapshot.trees, undefined, async (conflict) => {
          expect(conflict.canonicalRef).toStartWith('cs-workspace:task/baseline/')
          expect(conflict.paths).toEqual(['file.txt'])
          invoked.push(conflict.canonicalRef)
          if (decision === 'unresolved') return { resolved: false }
          return scope.resolveConflict(conflict, {
            containerRef: workspace.workspaceRef,
            runAgent: async (_prompt, reference) => {
              if (decision === 'unreaped') throw new MergeAgentChildUnreapedError()
              await f.helper.call('task', 'write-seeds', {
                path: parseHostedWorkspaceReference(reference).path,
                files: [{ path: 'file.txt', content: 'merged\n' }],
              })
            },
          })
        }),
      )
      if (decision === 'unreaped') {
        await expect(merging).rejects.toBeInstanceOf(MergeAgentChildUnreapedError)
        expect(invoked).toHaveLength(1)
        expect(existsSync(isolated)).toBe(true)
        expect(f.calls).not.toContain('isolation-conflict-finish')
      } else {
        const merged = await merging
        expect(merged.clean).toBe(decision === 'resolved')
        expect(new Set(invoked).size).toBe(2)
        expect(invoked).toHaveLength(2)
        if (decision === 'resolved') {
          expect(merged.conflicts).toEqual([])
          // Reclaim the node's refs; canonical must still own reachable commits.
          await scope.discard(merged.workspace)
          for (const name of ['first', 'second']) {
            expect(readFileSync(join(baseline, name, 'file.txt'), 'utf8')).toBe('merged\n')
            expect(await git(join(baseline, name), ['show', 'HEAD:file.txt'])).toBe('merged')
          }
        } else {
          expect(merged.conflicts[0]!.paths).toEqual(
            expect.arrayContaining(['first (submodule)', 'second (submodule)']),
          )
        }
      }
      if (decision !== 'resolved')
        for (const name of ['first', 'second'])
          expect(readFileSync(join(baseline, name, 'file.txt'), 'utf8')).toBe('canonical\n')
    } finally {
      if (previousConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = previousConfig
      f.close()
    }
  }, 90_000)
}

test('development action, baseline and employee case owners use the same remote volume without local fallbacks', async () => {
  const f = fixture()
  const git = async (path: string, args: string[]) => {
    const result = await runGit(path, args)
    if (result.exitCode !== 0) throw new Error(result.stderr)
    return result.stdout.trim()
  }
  try {
    const baseline = join(f.root, 'baseline')
    mkdirSync(baseline)
    await git(baseline, ['init', '-b', 'main'])
    await git(baseline, ['config', 'user.name', 'Fixture'])
    await git(baseline, ['config', 'user.email', 'fixture@example.test'])
    const binary = Buffer.from([0, 255, 10, 128])
    writeFileSync(join(baseline, 'binary.dat'), binary)
    await git(baseline, ['add', '.'])
    await git(baseline, ['commit', '-m', 'baseline'])
    const baselineSha = await git(baseline, ['rev-parse', 'HEAD'])
    const readFile = async (reference: string) => {
      const root = await f.uploads.bind({ workspaceRef: 'cs-workspace:task/' })
      return root.read(reference)
    }
    const selected = composeCrewStationDevelopmentWorkspaces({
      helper: f.helper,
      locate: parseHostedWorkspaceReference,
      reference: hostedWorkspaceReference,
      readFile,
    })
    const nativeForbidden = new Proxy({} as EvidenceArtifactPort, {
      get() {
        throw new Error('no evidence should be consulted without bundles')
      },
    })
    const materialized = await materializeActionWorkspace(
      { evidence: nativeForbidden, seedsRoot: 'cs-workspace:task/seeds' },
      {
        baselineRepoPath: 'cs-workspace:task/baseline',
        baselineSha,
        seedRef: null,
        bundles: [],
      },
      selected.actionWorkspaceEffects,
    )
    expect(materialized.workspacePath).toStartWith('cs-workspace:task/tmp/actions/')
    expect(materialized.businessTreeDigest).toMatch(/^[0-9a-f]{64}$/)
    // RFC-370 §9.2 V3: preparing and digesting the scene are one command each.
    expect(f.calls.filter((operation) => operation === 'development-tree')).toHaveLength(2)
    const contents = await selected.automationWorkspaceEffects.acquire()
    const file = selected.automationWorkspaceEffects.resolve(
      materialized.workspacePath,
      'binary.dat',
    )
    expect(Buffer.from(await contents.readBytes(file)).equals(binary)).toBe(true)
    expect(await contents.inspect(file, false)).toMatchObject({ kind: 'file', size: 4 })
    await contents.writeText(
      selected.automationWorkspaceEffects.resolve(materialized.workspacePath, 'new.txt'),
      'action',
    )
    expect(await contents.listNames(materialized.workspacePath)).toContain('new.txt')
    const baselines = await selected.repositoryBaselines.acquire()
    const reader = await baselines.bindFileReader('cs-workspace:task/baseline', baselineSha)
    expect(await reader.stat('binary.dat')).toEqual({
      kind: 'file',
      sha256: createHash('sha256').update(binary).digest('hex'),
      mode: 'regular',
    })
    expect(await reader.stat('absent')).toBe('missing')
    await baselines.close()
    await contents.close()
    await selected.actionWorkspaceEffects.discard(materialized.workspacePath)
    expect(readdirSync(join(f.root, 'tmp', 'actions'))).toEqual([])
    // RFC-370 §9.2 V3: each Case use case is one command in the same volume.
    const employee = createHostedEmployeeCaseWorkspaceOperations({ helper: f.helper }).operations
    const input = {
      caseRoot: 'cs-workspace:task/cases/one',
      baselineRepoPath: 'cs-workspace:task/baseline',
      baselineSha,
    }
    const caseWorkspace = await employee.materialize(input)
    expect(caseWorkspace.workspacePath).toBe('cs-workspace:task/cases/one/workspace')
    mkdirSync(join(f.root, 'cases', 'one', 'workspace', '.agent-workflow'), { recursive: true })
    writeFileSync(
      join(f.root, 'cases', 'one', 'workspace', '.agent-workflow', 'retained.json'),
      'retained',
    )
    writeFileSync(join(f.root, 'cases', 'one', 'workspace', 'uncommitted.txt'), 'old candidate')
    await employee.rematerialize({ ...input, currentWorkspacePath: caseWorkspace.workspacePath })
    expect(
      readFileSync(
        join(f.root, 'cases', 'one', 'workspace', '.agent-workflow', 'retained.json'),
        'utf8',
      ),
    ).toBe('retained')
    expect(existsSync(join(f.root, 'cases', 'one', 'workspace', 'uncommitted.txt'))).toBe(false)
    expect(readFileSync(join(baseline, 'binary.dat')).equals(binary)).toBe(true)
  } finally {
    f.close()
  }
}, 30_000)

import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { posix } from 'node:path'

import { bindEmployeeCaseWorkspaceParticipant } from '@/modules/source-control/composition'
import type {
  EmployeeCaseGitOperand,
  EmployeeCaseWorkspaceEffects,
  EmployeeCaseWorkspaceEffectsFactory,
} from '@/modules/source-control/application/ports/employeeCaseWorkspaceEffects'
import type {
  RepositoryCandidateFileFacts,
  RepositoryCandidateGitOutcome,
} from '@/modules/source-control/application/ports/repositoryCandidateEffects'

const SHA = 'a'.repeat(40)
const OK: RepositoryCandidateGitOutcome = { exitCode: 0, stdout: '', stderr: '' }
const utf8 = (text: string) => new TextEncoder().encode(text)

interface Entry {
  kind: RepositoryCandidateFileFacts['kind']
  mode: number
  bytes?: Uint8Array
}

class Fixture {
  readonly entries = new Map<string, Entry>()
  readonly references = new Map<string, string>()
  readonly paths = new Map<string, string>()
  readonly hooks = new Map<string, () => Promise<void>>()
  readonly trace: string[] = []
  readonly commands: Array<{
    cwd: string
    operands: readonly EmployeeCaseGitOperand[]
    argv: readonly string[]
  }> = []
  readonly scopes: SelectedScope[] = []
  readonly factory = new SelectedFactory(this)
  gitResult: (argv: readonly string[]) => RepositoryCandidateGitOutcome = (argv) =>
    argv[0] === 'rev-parse' ? { ...OK, stdout: `${SHA}\n` } : OK

  reference(path: string): string {
    const normalized = posix.normalize(path)
    const known = this.references.get(normalized)
    if (known !== undefined) return known
    const reference = `artifact:employee-case:${this.references.size}`
    this.references.set(normalized, reference)
    this.paths.set(reference, normalized)
    return reference
  }

  path(reference: string): string {
    const path = this.paths.get(reference)
    if (path === undefined) throw new Error(`fixture received an unbound reference: ${reference}`)
    return path
  }

  directory(path: string) {
    this.entries.set(path, { kind: 'directory', mode: 0o755 })
  }

  file(path: string, bytes: Uint8Array, mode = 0o644) {
    let parent = posix.dirname(path)
    while (parent !== '.' && !this.entries.has(parent)) {
      this.directory(parent)
      parent = posix.dirname(parent)
    }
    this.entries.set(path, { kind: 'file', mode, bytes })
  }

  async enter(method: string, detail = '') {
    this.trace.push(detail === '' ? method : `${method}:${detail}`)
    await this.hooks.get(method)?.()
  }

  hold(method: string) {
    const entered = Promise.withResolvers<void>()
    const released = Promise.withResolvers<void>()
    this.hooks.set(method, async () => {
      entered.resolve()
      await released.promise
    })
    return { entered: entered.promise, release: () => released.resolve() }
  }

  sourceTree(root = 'case/workspace') {
    this.directory(root)
    this.file(`${root}/b.bin`, new Uint8Array([0, 255, 128, 10]), 0o100751)
    this.file(`${root}/a.txt`, utf8('中😀\n'), 0o100640)
    this.file(`${root}/sub/c.txt`, utf8('nested\n'), 0o100600)
    this.file(`${root}/.agent-workflow/receipt.json`, utf8('{}'), 0o100644)
    this.file(`${root}/.git/HEAD`, utf8('ignored git metadata'), 0o100644)
    return this.reference(root)
  }

  expectedCheckpointDigest() {
    const hash = createHash('sha256')
    for (const [name, bytes, mode] of [
      ['.agent-workflow/receipt.json', utf8('{}'), 0o644],
      ['a.txt', utf8('中😀\n'), 0o640],
      ['b.bin', new Uint8Array([0, 255, 128, 10]), 0o751],
      ['sub/c.txt', utf8('nested\n'), 0o600],
    ] as const) {
      hash.update(`${name}\u0000${mode}\u0000`)
      hash.update(bytes)
      hash.update('\u0000')
    }
    return hash.digest('hex')
  }

  participant() {
    return bindEmployeeCaseWorkspaceParticipant({ effects: this.factory })
  }
}

class SelectedFactory implements EmployeeCaseWorkspaceEffectsFactory {
  readonly #fixture: Fixture
  constructor(fixture: Fixture) {
    this.#fixture = fixture
    Object.freeze(this)
  }
  async acquire() {
    await this.#fixture.enter('acquire')
    const scope = new SelectedScope(this.#fixture)
    this.#fixture.scopes.push(scope)
    return scope
  }
}

class SelectedScope implements EmployeeCaseWorkspaceEffects {
  readonly #fixture: Fixture
  constructor(fixture: Fixture) {
    this.#fixture = fixture
    Object.freeze(this)
  }
  resolve(reference: string, ...segments: readonly string[]) {
    return this.#fixture.reference(posix.join(this.#fixture.path(reference), ...segments))
  }
  sibling(reference: string, suffix: string) {
    return this.#fixture.reference(this.#fixture.path(reference) + suffix)
  }
  async exists(reference: string) {
    await this.#fixture.enter('exists', this.#fixture.path(reference))
    return this.#fixture.entries.has(this.#fixture.path(reference))
  }
  async stat(reference: string): Promise<RepositoryCandidateFileFacts | null> {
    await this.#fixture.enter('stat', this.#fixture.path(reference))
    const entry = this.#fixture.entries.get(this.#fixture.path(reference))
    return entry === undefined ? null : { kind: entry.kind, mode: entry.mode }
  }
  async list(reference: string) {
    const root = this.#fixture.path(reference)
    await this.#fixture.enter('list', root)
    return Object.freeze(
      [...this.#fixture.entries.keys()]
        .filter((path) => posix.dirname(path) === root && path !== root)
        .map((path) => posix.basename(path))
        .reverse(),
    )
  }
  async createDirectory(reference: string) {
    const path = this.#fixture.path(reference)
    await this.#fixture.enter('createDirectory', path)
    this.#fixture.directory(path)
  }
  async copyFile(source: string, target: string) {
    const from = this.#fixture.path(source)
    const to = this.#fixture.path(target)
    await this.#fixture.enter('copyFile', `${from}->${to}`)
    const entry = this.#fixture.entries.get(from)
    if (entry?.bytes === undefined) throw new Error('fixture source file is missing')
    this.#fixture.entries.set(to, { ...entry, bytes: entry.bytes.slice() })
  }
  async setMode(reference: string, mode: number) {
    const path = this.#fixture.path(reference)
    await this.#fixture.enter('setMode', path)
    this.#fixture.entries.get(path)!.mode = mode
  }
  async readBytes(reference: string) {
    const path = this.#fixture.path(reference)
    await this.#fixture.enter('readBytes', path)
    return this.#fixture.entries.get(path)!.bytes!.slice()
  }
  async writeText(reference: string, text: string) {
    const path = this.#fixture.path(reference)
    await this.#fixture.enter('writeText', path)
    this.#fixture.file(path, utf8(text))
  }
  async remove(reference: string) {
    const root = this.#fixture.path(reference)
    await this.#fixture.enter('remove', root)
    for (const path of this.#fixture.entries.keys()) {
      if (path === root || path.startsWith(root + '/')) this.#fixture.entries.delete(path)
    }
  }
  async move(source: string, target: string) {
    const from = this.#fixture.path(source)
    const to = this.#fixture.path(target)
    await this.#fixture.enter('move', `${from}->${to}`)
    for (const [path, entry] of [...this.#fixture.entries]) {
      if (path === from || path.startsWith(from + '/')) {
        this.#fixture.entries.delete(path)
        this.#fixture.entries.set(to + path.slice(from.length), entry)
      }
    }
  }
  async runGit(cwd: string, operands: readonly EmployeeCaseGitOperand[]) {
    const argv = operands.map((operand) =>
      operand.kind === 'literal'
        ? operand.value
        : `materialized(${this.#fixture.path(operand.reference)})`,
    )
    this.#fixture.commands.push({ cwd, operands, argv })
    await this.#fixture.enter('runGit', argv.join(' '))
    if (argv[0] === 'clone') {
      const target = operands.at(-1)!
      if (target.kind !== 'reference') throw new Error('clone target must be an explicit reference')
      const root = this.#fixture.path(target.reference)
      this.#fixture.directory(root)
      this.#fixture.directory(`${root}/.git`)
    }
    return this.#fixture.gitResult(argv)
  }
  async close() {
    await this.#fixture.enter('close')
  }
}

async function awaitEffect(entered: Promise<void>, pending: Promise<unknown>) {
  await Promise.race([
    entered,
    pending.then(() => {
      throw new Error('operation completed before the selected effect ACK')
    }),
  ])
}

describe('RFC-370 complete selected EmployeeCase content and Git scope', () => {
  for (const method of ['copyFile', 'readBytes', 'move', 'close'] as const) {
    test(`checkpoint waits for ${method} ACK and retains binary/mode/tree digest`, async () => {
      const fixture = new Fixture()
      const workspacePath = fixture.sourceTree()
      const checkpointRoot = fixture.reference('checkpoints/round-1')
      const held = fixture.hold(method)
      let settled = false
      const pending = fixture
        .participant()
        .checkpoint({ workspacePath, checkpointRoot })
        .then((receipt) => {
          settled = true
          return receipt
        })
      await awaitEffect(held.entered, pending)
      expect(settled).toBe(false)
      expect(Object.hasOwn(fixture.factory, 'acquire')).toBe(false)
      expect(Object.hasOwn(fixture.scopes[0]!, 'copyFile')).toBe(false)
      held.release()
      expect(await pending).toEqual({ checkpointDigest: fixture.expectedCheckpointDigest() })
      expect(fixture.entries.get('checkpoints/round-1/b.bin')).toEqual({
        kind: 'file',
        mode: 0o751,
        bytes: new Uint8Array([0, 255, 128, 10]),
      })
      expect(fixture.entries.has('checkpoints/round-1/.git')).toBe(false)
      expect(fixture.entries.has('checkpoints/round-1/.agent-workflow/receipt.json')).toBe(true)
      expect(fixture.trace.at(-1)).toBe('close')
      expect(fixture.scopes).toHaveLength(1)
      expect(existsSync(checkpointRoot)).toBe(false)
    })
  }

  test('clone maps only tagged operands, preserves literal values and publishes after move ACK', async () => {
    const fixture = new Fixture()
    const caseRoot = fixture.reference('cases/one')
    const baselineRepoPath = fixture.reference('baselines/one')
    const baselineSha = baselineRepoPath
    const held = fixture.hold('move')
    const pending = fixture.participant().materialize({ caseRoot, baselineRepoPath, baselineSha })
    await awaitEffect(held.entered, pending)
    expect(fixture.trace).not.toContain('close')
    expect(fixture.commands[0]!.operands.map((operand) => operand.kind)).toEqual([
      'literal',
      'literal',
      'literal',
      'reference',
      'reference',
    ])
    expect(fixture.commands[0]!.argv.slice(0, 4)).toEqual([
      'clone',
      '--no-hardlinks',
      '--quiet',
      'materialized(baselines/one)',
    ])
    expect(fixture.commands[1]!.argv).toEqual(['checkout', '--quiet', '--detach', baselineSha])
    expect(fixture.commands[2]!.argv).toEqual(['remote', 'remove', 'origin'])
    held.release()
    expect(await pending).toEqual({ workspacePath: fixture.reference('cases/one/workspace') })
    expect(fixture.entries.get('cases/one/workspace/.git/info/exclude')!.bytes).toEqual(
      utf8('.agent-workflow/\n'),
    )
    expect(fixture.scopes).toHaveLength(1)
    expect(fixture.trace.at(-1)).toBe('close')
  })

  test('rematerialize retains the current platform overlay and closes one shared scope', async () => {
    const fixture = new Fixture()
    fixture.file('cases/one/workspace/.agent-workflow/run.json', utf8('original platform receipt'))
    const caseRoot = fixture.reference('cases/one')
    const result = await fixture.participant().rematerialize({
      caseRoot,
      baselineRepoPath: fixture.reference('baselines/one'),
      baselineSha: SHA,
      currentWorkspacePath: fixture.reference('cases/one/workspace'),
    })
    expect(result.workspacePath).toBe(fixture.reference('cases/one/workspace'))
    expect(fixture.entries.get('cases/one/workspace/.agent-workflow/run.json')!.bytes).toEqual(
      utf8('original platform receipt'),
    )
    expect([...fixture.entries.keys()].some((path) => path.includes('.platform-'))).toBe(false)
    expect(fixture.trace.filter((entry) => entry.startsWith('exists:'))).toHaveLength(2)
    expect(fixture.scopes).toHaveLength(1)
  })

  test('a held clone failure preserves the old Case and closes after staging cleanup', async () => {
    const fixture = new Fixture()
    fixture.file('cases/one/workspace/old.txt', utf8('original Case'))
    const held = fixture.hold('runGit')
    fixture.gitResult = () => ({ ...OK, exitCode: 1, stderr: 'selected-clone-failed' })
    const pending = fixture.participant().materialize({
      caseRoot: fixture.reference('cases/one'),
      baselineRepoPath: fixture.reference('baselines/one'),
      baselineSha: SHA,
    })
    await awaitEffect(held.entered, pending)
    expect(fixture.trace).not.toContain('close')
    expect(fixture.trace.some((entry) => entry.startsWith('move:'))).toBe(false)
    held.release()
    await expect(pending).rejects.toThrow('materialization failed: selected-clone-failed')
    expect(fixture.entries.get('cases/one/workspace/old.txt')!.bytes).toEqual(utf8('original Case'))
    expect([...fixture.entries.keys()].some((path) => path.includes('.tmp-'))).toBe(false)
    expect(fixture.commands).toHaveLength(1)
    expect(fixture.trace.at(-1)).toBe('close')
  })

  test('restore verifies the checkpoint before clone and reuses the same scope for the overlay', async () => {
    const fixture = new Fixture()
    const checkpointRoot = fixture.sourceTree('checkpoint')
    fixture.entries.delete('checkpoint/.git/HEAD')
    fixture.entries.delete('checkpoint/.git')
    const input = {
      caseRoot: fixture.reference('cases/restored'),
      baselineRepoPath: fixture.reference('baselines/one'),
      baselineSha: SHA,
      checkpointRoot,
      expectedCheckpointDigest: 'wrong-digest',
    }
    await expect(fixture.participant().restore(input)).rejects.toThrow('checkpoint digest mismatch')
    expect(fixture.commands).toHaveLength(0)
    expect(fixture.trace.at(-1)).toBe('close')
    fixture.trace.length = 0
    const restored = await fixture.participant().restore({
      ...input,
      expectedCheckpointDigest: fixture.expectedCheckpointDigest(),
    })
    expect(restored.workspacePath).toBe(fixture.reference('cases/restored/workspace'))
    expect(fixture.entries.get('cases/restored/workspace/b.bin')!.bytes).toEqual(
      new Uint8Array([0, 255, 128, 10]),
    )
    expect(fixture.trace.filter((entry) => entry === 'acquire')).toHaveLength(1)
    expect(fixture.trace.filter((entry) => entry === 'close')).toHaveLength(1)
    expect(fixture.trace[1]).toBe('exists:checkpoint')
  })

  test('remote head, baseline selection and commit import retain exact Git outcome decisions', async () => {
    const fixture = new Fixture()
    const baselineRepoPath = fixture.reference('baselines/one')
    const participant = fixture.participant()
    expect(
      await participant.fetchRemoteHead({
        baselineRepoPath,
        remoteUrl: './remote-fixture',
        branch: 'topic',
        expectedHeadSha: 'b'.repeat(40),
      }),
    ).toEqual({
      ok: false,
      code: 'remote-head-moved',
      expectedHeadSha: 'b'.repeat(40),
      actualHeadSha: SHA,
    })
    expect(fixture.commands[0]!.operands.every((operand) => operand.kind === 'literal')).toBe(true)
    expect(fixture.commands[0]!.argv).toEqual([
      'fetch',
      '--quiet',
      '--no-tags',
      './remote-fixture',
      'refs/heads/topic',
    ])
    expect(
      await participant.resolveBaseline({
        baselineRepoPath,
        preferredBranch: null,
        sourceBranch: 'source-topic',
      }),
    ).toEqual({ baselineSha: SHA, targetBranch: 'main', remoteHeadSha: SHA })
    const sourceRepoPath = fixture.reference('cases/source/workspace')
    await participant.importCommit({ baselineRepoPath, sourceRepoPath, commitSha: SHA })
    expect(fixture.commands.at(-2)!.argv).toEqual([
      'fetch',
      '--quiet',
      '--no-tags',
      'materialized(cases/source/workspace)',
      SHA,
    ])
    expect(fixture.commands.at(-2)!.operands[3]).toEqual({
      kind: 'reference',
      reference: sourceRepoPath,
    })
    fixture.gitResult = (argv) => (argv[0] === 'rev-parse' ? { ...OK, stdout: 'different\n' } : OK)
    await expect(
      participant.importCommit({ baselineRepoPath, sourceRepoPath, commitSha: SHA }),
    ).rejects.toThrow('imported commit identity mismatch')
    expect(fixture.scopes).toHaveLength(4)
    expect(fixture.trace.filter((entry) => entry === 'close')).toHaveLength(4)
  })

  test('selected operation and close failures preserve both identities and never use native paths', async () => {
    const fixture = new Fixture()
    const operationFailure = new Error('selected-copy-failed')
    const closeFailure = new Error('selected-close-failed')
    fixture.hooks.set('copyFile', async () => {
      throw operationFailure
    })
    fixture.hooks.set('close', async () => {
      throw closeFailure
    })
    const result = await fixture
      .participant()
      .checkpoint({
        workspacePath: fixture.sourceTree(),
        checkpointRoot: fixture.reference('checkpoints/failure'),
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      )
    expect(result).toBeInstanceOf(AggregateError)
    expect((result as AggregateError).errors).toEqual([operationFailure, closeFailure])
    expect([...fixture.entries.keys()].some((path) => path.startsWith('checkpoints/failure'))).toBe(
      false,
    )
    expect(fixture.trace.at(-1)).toBe('close')
    expect(fixture.commands).toHaveLength(0)
  })

  test('baseline fallback retains all four original candidates in order', async () => {
    const fixture = new Fixture()
    fixture.gitResult = (argv) =>
      argv[2] === 'HEAD^{commit}' ? { ...OK, stdout: `${SHA}\n` } : { ...OK, exitCode: 1 }
    expect(
      await fixture.participant().resolveBaseline({
        baselineRepoPath: fixture.reference('baselines/one'),
        preferredBranch: 'feature',
        sourceBranch: null,
      }),
    ).toEqual({ baselineSha: SHA, targetBranch: 'feature', remoteHeadSha: null })
    expect(fixture.commands.map((command) => command.argv)).toEqual([
      ['rev-parse', '--verify', 'refs/remotes/origin/feature^{commit}'],
      ['rev-parse', '--verify', 'refs/heads/feature^{commit}'],
      ['rev-parse', '--verify', 'feature^{commit}'],
      ['rev-parse', '--verify', 'HEAD^{commit}'],
    ])
    expect(fixture.trace.at(-1)).toBe('close')
  })

  test('discard waits for selected release and an incomplete selected scope never falls back', async () => {
    const fixture = new Fixture()
    const caseRoot = fixture.sourceTree('case')
    const held = fixture.hold('close')
    const pending = fixture.participant().discard(caseRoot)
    await awaitEffect(held.entered, pending)
    expect(fixture.entries.size).toBe(0)
    held.release()
    await pending
    let closed = 0
    const incomplete = bindEmployeeCaseWorkspaceParticipant({
      effects: {
        acquire: () =>
          ({
            close() {
              closed++
            },
          }) as EmployeeCaseWorkspaceEffects,
      },
    })
    await expect(incomplete.discard('artifact:incomplete')).rejects.toThrow(
      'employee-case-workspace-effects-incomplete',
    )
    expect(closed).toBe(1)
    expect(existsSync('artifact:incomplete')).toBe(false)
  })
})

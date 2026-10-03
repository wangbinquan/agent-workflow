import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  RepositoryBaselineEffects,
  RepositoryBaselineEffectsFactory,
} from '@/modules/development-automation/application/ports/repositoryBaselineEffects'
import type { RepositoryLocationRead } from '@/modules/development-automation/application/ports/repositoryLocationRead'
import type {
  BaselineFileReader,
  BaselineStat,
} from '@/modules/development-automation/application/uploadPlan'
import {
  createActionBaselineResolver,
  createGitBaselineReader,
  createRepositoryBaselineResolverFromLocations,
} from '@/modules/development-automation/infrastructure/gitBaselineReader'
import { runGit } from '@/util/git'

const REFERENCE = 'cs:repository/opaque#baseline-input'
const SHA = 'c'.repeat(40)
const FILE: BaselineStat = { kind: 'file', sha256: 'd'.repeat(64), mode: 'regular' }
type Phase = 'acquire' | 'head' | 'bind' | 'stat' | 'close'
type Head = Awaited<ReturnType<RepositoryBaselineEffects['readHead']>>
type Gate = { readonly promise: Promise<void>; resolve(): void }
function gate(): Gate {
  let resolve!: () => void
  return {
    promise: new Promise<void>((ack) => {
      resolve = ack
    }),
    resolve: () => resolve(),
  }
}
interface Controls {
  readonly trace: string[]
  readonly closed: Set<number>
  readonly entered: Partial<Record<Phase, Gate>>
  readonly holds: Partial<Record<Phase, Gate>>
  readonly facts: ReadonlyMap<string, BaselineStat>
  readonly head: Head
  readonly errors: Partial<Record<Phase, Error>>
}
async function acknowledge(controls: Controls, phase: Phase): Promise<void> {
  controls.entered[phase]?.resolve()
  await controls.holds[phase]?.promise
  const error = controls.errors[phase]
  if (error !== undefined) throw error
}
class PrototypeReader implements BaselineFileReader {
  #controls: Controls
  #scope: number
  constructor(controls: Controls, scope: number) {
    this.#controls = controls
    this.#scope = scope
    Object.freeze(this)
  }
  async stat(path: string): Promise<BaselineStat> {
    if (this.#controls.closed.has(this.#scope)) throw new Error('expired-selected-reader')
    this.#controls.trace.push(`stat:${this.#scope}:${path}`)
    await acknowledge(this.#controls, 'stat')
    const fact = this.#controls.facts.get(path)
    if (fact === undefined) throw new Error(`unrequested-selected-path:${path}`)
    return fact
  }
}
class PrototypeScope implements RepositoryBaselineEffects {
  #controls: Controls
  #id: number
  constructor(controls: Controls, id: number) {
    this.#controls = controls
    this.#id = id
    Object.freeze(this)
  }
  async readHead(reference: string): Promise<Head> {
    this.#controls.trace.push(`head:${this.#id}:${reference}`)
    await acknowledge(this.#controls, 'head')
    return this.#controls.head
  }
  async bindFileReader(reference: string, sha: string): Promise<BaselineFileReader> {
    this.#controls.trace.push(`bind:${this.#id}:${reference}:${sha}`)
    await acknowledge(this.#controls, 'bind')
    return new PrototypeReader(this.#controls, this.#id)
  }
  async close(): Promise<void> {
    this.#controls.trace.push(`close-enter:${this.#id}`)
    await acknowledge(this.#controls, 'close')
    this.#controls.closed.add(this.#id)
    this.#controls.trace.push(`closed:${this.#id}`)
  }
}
class PrototypeFactory implements RepositoryBaselineEffectsFactory {
  #controls: Controls
  #next = 0
  constructor(controls: Controls) {
    this.#controls = controls
    Object.freeze(this)
  }
  async acquire(): Promise<RepositoryBaselineEffects> {
    const id = ++this.#next
    this.#controls.trace.push(`acquire:${id}`)
    await acknowledge(this.#controls, 'acquire')
    return new PrototypeScope(this.#controls, id)
  }
}
function fixture(options: Partial<Controls> = {}) {
  const controls: Controls = {
    trace: [],
    closed: new Set(),
    entered: {},
    holds: {},
    facts: new Map([['binary.bin', FILE]]),
    head: { exitCode: 0, stdout: ` ${SHA}\n`, stderr: '' },
    errors: {},
    ...options,
  }
  return { controls, factory: new PrototypeFactory(controls) }
}
function locations(reference: string | null = REFERENCE): RepositoryLocationRead {
  return Object.freeze({
    async localPath(id: string) {
      expect(id).toBe('repository-id')
      return reference
    },
  })
}
async function failed(pending: Promise<unknown>): Promise<unknown> {
  try {
    await pending
  } catch (error) {
    return error
  }
  throw new Error('expected-selected-baseline-failure')
}

test('selected acquisition settles before a head scope is used', async () => {
  const acquire = gate(),
    entered = gate()
  const selected = fixture({ holds: { acquire }, entered: { acquire: entered } })
  const pending = createActionBaselineResolver(locations(), selected.factory)('repository-id')
  try {
    await entered.promise
    expect(selected.controls.trace).toEqual(['acquire:1'])
    acquire.resolve()
    expect(await pending).toEqual({ repoPath: REFERENCE, headSha: SHA })
  } finally {
    acquire.resolve()
    await pending.catch(() => undefined)
  }
})

test('complete synchronous scope methods retain the original receiver while the existing reader stays asynchronous', async () => {
  const trace: string[] = []
  class Scope implements RepositoryBaselineEffects {
    #reference = REFERENCE
    readHead(reference: string): Head {
      expect(reference).toBe(this.#reference)
      trace.push('head')
      return { exitCode: 0, stdout: SHA, stderr: '' }
    }
    bindFileReader(reference: string, sha: string): BaselineFileReader {
      expect(reference).toBe(this.#reference)
      expect(sha).toBe(SHA)
      trace.push('bind')
      return Object.freeze({
        async stat(path: string) {
          expect(path).toBe('binary.bin')
          return FILE
        },
      })
    }
    close() {
      trace.push('close')
    }
  }
  class Factory implements RepositoryBaselineEffectsFactory {
    #scope = Object.freeze(new Scope())
    acquire() {
      trace.push('acquire')
      return this.#scope
    }
  }
  const factory = Object.freeze(new Factory())
  expect(await createActionBaselineResolver(locations(), factory)('repository-id')).toEqual({
    repoPath: REFERENCE,
    headSha: SHA,
  })
  expect(await createGitBaselineReader(REFERENCE, SHA, factory).stat('binary.bin')).toEqual(FILE)
  expect(trace).toEqual(['acquire', 'head', 'close', 'acquire', 'bind', 'close'])
})

test('action head resolution waits for the selected read and close ACK on complete frozen receivers', async () => {
  const head = gate(),
    close = gate(),
    headEntered = gate(),
    closeEntered = gate()
  const selected = fixture({
    holds: { head, close },
    entered: { head: headEntered, close: closeEntered },
  })
  let settled = false
  const pending = createActionBaselineResolver(
    locations(),
    selected.factory,
  )('repository-id').then((result) => {
    settled = true
    return result
  })
  try {
    await headEntered.promise
    expect(settled).toBe(false)
    expect(selected.controls.trace).toEqual(['acquire:1', `head:1:${REFERENCE}`])
    head.resolve()
    await closeEntered.promise
    expect(settled).toBe(false)
    expect(selected.controls.closed.size).toBe(0)
    close.resolve()
    expect(await pending).toEqual({ repoPath: REFERENCE, headSha: SHA })
    expect(selected.controls.trace).toEqual([
      'acquire:1',
      `head:1:${REFERENCE}`,
      'close-enter:1',
      'closed:1',
    ])
  } finally {
    head.resolve()
    close.resolve()
    await pending.catch(() => undefined)
  }
})

test('an upload context closes its head scope and reacquires a fresh selected reader for every later stat', async () => {
  const facts = new Map<string, BaselineStat>([
    ['binary.bin', FILE],
    ['program', { kind: 'file', sha256: 'e'.repeat(64), mode: 'executable' }],
    ['absent', 'missing'],
    ['folder', 'directory'],
    ['link', 'unsupported'],
  ])
  const selected = fixture({ facts })
  const context = await createRepositoryBaselineResolverFromLocations(
    locations(),
    selected.factory,
  )('repository-id')
  if (context === null) throw new Error('selected-upload-context-missing')
  expect(context).toMatchObject({
    repositoryRef: 'repository-id',
    baselineSnapshotRef: `git:${SHA}`,
    baselineSha: SHA,
  })
  expect(selected.controls.closed).toEqual(new Set([1]))
  expect(selected.controls.trace).toEqual([
    'acquire:1',
    `head:1:${REFERENCE}`,
    'close-enter:1',
    'closed:1',
  ])
  let id = 1
  for (const [path, fact] of facts) {
    id += 1
    expect(await context.reader.stat(path)).toEqual(fact)
    expect(selected.controls.trace.slice(-5)).toEqual([
      `acquire:${id}`,
      `bind:${id}:${REFERENCE}:${SHA}`,
      `stat:${id}:${path}`,
      `close-enter:${id}`,
      `closed:${id}`,
    ])
  }
  expect(selected.controls.closed).toEqual(new Set([1, 2, 3, 4, 5, 6]))
})

test('a stat waits for bind, actual reader stat and close without detaching private prototype state', async () => {
  const bind = gate(),
    stat = gate(),
    close = gate()
  const bindEntered = gate(),
    statEntered = gate(),
    closeEntered = gate()
  const selected = fixture({
    holds: { bind, stat, close },
    entered: { bind: bindEntered, stat: statEntered, close: closeEntered },
  })
  let settled = false
  const pending = createGitBaselineReader(REFERENCE, SHA, selected.factory)
    .stat('binary.bin')
    .then((result) => {
      settled = true
      return result
    })
  try {
    await bindEntered.promise
    expect(settled).toBe(false)
    expect(selected.controls.trace).toEqual(['acquire:1', `bind:1:${REFERENCE}:${SHA}`])
    bind.resolve()
    await statEntered.promise
    expect(settled).toBe(false)
    stat.resolve()
    await closeEntered.promise
    expect(settled).toBe(false)
    close.resolve()
    expect(await pending).toEqual(FILE)
    expect(selected.controls.trace).toEqual([
      'acquire:1',
      `bind:1:${REFERENCE}:${SHA}`,
      'stat:1:binary.bin',
      'close-enter:1',
      'closed:1',
    ])
  } finally {
    bind.resolve()
    stat.resolve()
    close.resolve()
    await pending.catch(() => undefined)
  }
})

test('missing repositories do not acquire; original nonzero and malformed head outcomes remain null after close', async () => {
  const absent = fixture()
  expect(
    await createActionBaselineResolver(locations(null), absent.factory)('repository-id'),
  ).toBeNull()
  expect(
    await createRepositoryBaselineResolverFromLocations(
      locations(null),
      absent.factory,
    )('repository-id'),
  ).toBeNull()
  expect(absent.controls.trace).toEqual([])
  for (const head of [
    { exitCode: 1, stdout: SHA, stderr: 'unreadable' },
    { exitCode: 0, stdout: 'not-a-frozen-head', stderr: '' },
  ]) {
    const selected = fixture({ head })
    expect(
      await createActionBaselineResolver(locations(), selected.factory)('repository-id'),
    ).toBeNull()
    expect(
      await createRepositoryBaselineResolverFromLocations(
        locations(),
        selected.factory,
      )('repository-id'),
    ).toBeNull()
    expect(selected.controls.closed).toEqual(new Set([1, 2]))
    expect(selected.controls.trace.some((value) => value.startsWith('bind:'))).toBe(false)
  }
})

test('selected acquire, head, bind and stat failures preserve the original error and never use native references', async () => {
  for (const phase of ['acquire', 'head', 'bind', 'stat'] as const) {
    const error = new Error(`selected-${phase}-failure`)
    const selected = fixture({ errors: { [phase]: error } })
    const pending =
      phase === 'head'
        ? createActionBaselineResolver(locations(), selected.factory)('repository-id')
        : createGitBaselineReader(REFERENCE, SHA, selected.factory).stat('binary.bin')
    expect(await failed(pending)).toBe(error)
    expect(
      selected.controls.trace.filter((value) => value.startsWith('close-enter:')),
    ).toHaveLength(phase === 'acquire' ? 0 : 1)
    if (phase !== 'acquire') expect(selected.controls.closed).toEqual(new Set([1]))
  }
})

test('close failure is preserved, and simultaneous selected body and close failures retain both identities in order', async () => {
  const close = new Error('selected-close-failure')
  const closeOnly = fixture({ errors: { close } })
  expect(
    await failed(createGitBaselineReader(REFERENCE, SHA, closeOnly.factory).stat('binary.bin')),
  ).toBe(close)
  for (const phase of ['head', 'bind', 'stat'] as const) {
    const body = new Error(`selected-${phase}-failure`)
    const selected = fixture({ errors: { [phase]: body, close } })
    const pending =
      phase === 'head'
        ? createActionBaselineResolver(locations(), selected.factory)('repository-id')
        : createGitBaselineReader(REFERENCE, SHA, selected.factory).stat('binary.bin')
    const failure = await failed(pending)
    expect(failure).toBeInstanceOf(AggregateError)
    if (!(failure instanceof AggregateError)) throw failure
    expect(failure.errors).toEqual([body, close])
    expect(
      selected.controls.trace.filter((value) => value.startsWith('close-enter:')),
    ).toHaveLength(1)
  }
})

test('incomplete selected factories, scopes and readers fail and still close every available acquired lifetime', async () => {
  for (const factory of [null, Object.freeze({})]) {
    const selected = factory as unknown as RepositoryBaselineEffectsFactory
    const error = await failed(createGitBaselineReader(REFERENCE, SHA, selected).stat('binary.bin'))
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('repository-baseline-effects-factory-incomplete')
  }
  let closes = 0
  const missingHead = Object.freeze({
    bindFileReader() {
      throw new Error('incomplete-scope-was-used')
    },
    close() {
      closes += 1
    },
  })
  const missingReader = Object.freeze({
    readHead() {
      return { exitCode: 0, stdout: SHA, stderr: '' }
    },
    bindFileReader() {
      return Object.freeze({})
    },
    close() {
      closes += 1
    },
  })
  for (const [scope, message] of [
    [null, 'repository-baseline-effects-scope-incomplete'],
    [missingHead, 'repository-baseline-effects-scope-incomplete'],
    [missingReader, 'repository-baseline-file-reader-incomplete'],
  ] as const) {
    const factory = Object.freeze({
      acquire: () => scope,
    }) as unknown as RepositoryBaselineEffectsFactory
    const error = await failed(createGitBaselineReader(REFERENCE, SHA, factory).stat('binary.bin'))
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe(message)
  }
  expect(closes).toBe(2)
})

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test('the native selected default retains exact binary Git bytes, index modes and original baseline facts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rfc370-baseline-native-'))
  roots.push(root)
  const binary = Buffer.from([0, 255, 128, 10, 0, 13, 239, 191, 189, 250])
  const digest = createHash('sha256').update(binary).digest('hex')
  async function git(args: string[]): Promise<string> {
    const outcome = await runGit(root, args)
    expect(outcome.exitCode).toBe(0)
    return outcome.stdout.trim()
  }
  await git(['init', '-q'])
  writeFileSync(join(root, 'binary.bin'), binary)
  writeFileSync(join(root, 'executable.bin'), binary)
  mkdirSync(join(root, 'folder'))
  writeFileSync(join(root, 'folder', 'nested.txt'), 'nested\n')
  writeFileSync(join(root, 'link-target.txt'), 'binary.bin')
  await git(['add', 'binary.bin', 'executable.bin', 'folder/nested.txt'])
  await git(['update-index', '--chmod=+x', 'executable.bin'])
  const linkSha = await git(['hash-object', '-w', 'link-target.txt'])
  await git(['update-index', '--add', '--cacheinfo', `120000,${linkSha},link`])
  await git([
    '-c',
    'user.name=RFC370',
    '-c',
    'user.email=rfc370@example.test',
    'commit',
    '-q',
    '-m',
    'binary baseline',
  ])
  const head = await git(['rev-parse', 'HEAD'])
  const context = await createRepositoryBaselineResolverFromLocations(locations(root))(
    'repository-id',
  )
  if (context === null) throw new Error('native-baseline-context-missing')
  expect(context).toMatchObject({ baselineSha: head, baselineSnapshotRef: `git:${head}` })
  expect(await context.reader.stat('binary.bin')).toEqual({
    kind: 'file',
    sha256: digest,
    mode: 'regular',
  })
  expect(await context.reader.stat('executable.bin')).toEqual({
    kind: 'file',
    sha256: digest,
    mode: 'executable',
  })
  expect(await context.reader.stat('folder')).toBe('directory')
  expect(await context.reader.stat('link')).toBe('unsupported')
  expect(await context.reader.stat('absent')).toBe('missing')
  expect(await createActionBaselineResolver(locations(root))('repository-id')).toEqual({
    repoPath: root,
    headSha: head,
  })
}, 15_000)

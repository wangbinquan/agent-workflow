// RFC-359 W42: W40 macOS reported a common Git config lock failure.
// These pure controls prove same-process, shared-key overlap; they do not replay the historical PID.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import type { DomainError } from '../src/util/errors'

interface GitResult {
  exitCode: number
  stdout: string
  stderr: string
}

interface Protocol {
  write(input: { worktreePath: string }, profilePath: string): Promise<void>
  chain(commonDirectory: string): Promise<unknown> | undefined
  DomainError: typeof DomainError
}

function loadProtocol(runGit: (path: string, args: string[]) => Promise<GitResult>): Protocol {
  const parse = (relative: string) => {
    const text = readFileSync(new URL(relative, import.meta.url), 'utf8')
    return ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true)
  }
  const owner = parse('../src/modules/source-control/infrastructure/workspaceExcludeManager.ts')
  const git = parse('../src/util/git.ts')
  const errors = parse('../src/util/errors.ts')
  const named = (source: ts.SourceFile, name: string) => {
    const nodes = source.statements.filter(
      (node) =>
        ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
          node.name?.text === name) ||
        (ts.isVariableStatement(node) &&
          node.declarationList.declarations.some(
            (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name,
          )),
    )
    if (nodes.length !== 1) throw new Error(`expected one source declaration: ${name}`)
    const node = nodes[0]
    if (node === undefined) throw new Error(`missing source declaration: ${name}`)
    return node.getText(source).replace(/^export /, '')
  }
  const calls: ts.CallExpression[] = []
  const visit = (node: ts.Node): void => {
    const stage = ts.isCallExpression(node) ? node.arguments[2] : undefined
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'gitOutput' &&
      node.arguments.length === 3 &&
      stage !== undefined &&
      ts.isStringLiteral(stage) &&
      stage.text === 'enable worktree config'
    ) {
      calls.push(node)
    }
    ts.forEachChild(node, (child) => {
      visit(child)
    })
  }
  visit(owner)
  if (calls.length !== 1) throw new Error('expected one enable-worktree-config call')
  let statement: ts.Node | undefined = calls[0]
  while (statement !== undefined && !ts.isExpressionStatement(statement)) {
    statement = statement.parent
  }
  if (
    statement === undefined ||
    !ts.isExpressionStatement(statement) ||
    !ts.isBlock(statement.parent)
  ) {
    throw new Error('missing original awaited owner statement')
  }
  const next = statement.parent.statements[statement.parent.statements.indexOf(statement) + 1]
  if (
    next === undefined ||
    !ts.isExpressionStatement(next) ||
    !ts.isAwaitExpression(next.expression) ||
    !ts.isCallExpression(next.expression.expression) ||
    next.expression.expression.arguments[2]?.getText(owner) !== "'bind worktree excludes'"
  ) {
    throw new Error('missing immediately following per-worktree write')
  }
  // Execute only these real declarations and the two original command statements.
  // runGit is the sole controlled port; no owner initialization or Git process runs.
  const source = [
    named(errors, 'DomainError'),
    named(git, 'worktreeRegistryLocks'),
    named(git, 'commonGitDirCache'),
    named(git, 'resolveCommonGitDirKey'),
    named(git, 'withWorktreeRegistryLock'),
    named(owner, 'gitOutput'),
    `async function write(input, profilePath) { ${statement.getText(owner)}\n${next.getText(owner)} }`,
  ].join('\n\n')
  const emitted = new Bun.Transpiler({ loader: 'ts' }).transformSync(source)
  return new Function(
    'runGit',
    `${emitted}\nreturn { write, DomainError, chain: (key) => worktreeRegistryLocks.get(key)?.chain };`,
  )(runGit) as Protocol
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

type Kind = 'lookup' | 'enable' | 'bind'
interface Call {
  path: string
  args: string[]
  kind: Kind
  entered: number
  settled?: number
  result?: GitResult
  error?: unknown
  returned: Promise<GitResult>
}

function scenario(commonDirectories: Record<string, string>) {
  const calls: Call[] = []
  const held = new Map<string, ReturnType<typeof deferred<GitResult>>>()
  const entered = new Map<string, ReturnType<typeof deferred<Call>>>()
  let sequence = 0
  let activeEnable = 0
  let maximumEnable = 0
  const key = (path: string, kind: Kind) => `${path}:${kind}`
  const entry = (path: string, kind: Kind) => {
    const id = key(path, kind)
    let value = entered.get(id)
    if (value === undefined) {
      value = deferred<Call>()
      entered.set(id, value)
    }
    return value
  }
  const success: GitResult = { exitCode: 0, stdout: 'ok\n', stderr: '' }
  const protocol = loadProtocol((path, args) => {
    const kind: Kind =
      JSON.stringify(args) ===
      JSON.stringify(['rev-parse', '--path-format=absolute', '--git-common-dir'])
        ? 'lookup'
        : JSON.stringify(args) === JSON.stringify(['config', 'extensions.worktreeConfig', 'true'])
          ? 'enable'
          : args[0] === 'config' && args[1] === '--worktree' && args[2] === 'core.excludesFile'
            ? 'bind'
            : (() => {
                throw new Error('unexpected Git command in extracted protocol')
              })()
    if (commonDirectories[path] === undefined) throw new Error('unexpected worktree path')
    if (kind === 'enable') maximumEnable = Math.max(maximumEnable, ++activeEnable)
    const pending =
      held.get(key(path, kind))?.promise ??
      Promise.resolve(
        kind === 'lookup' ? { ...success, stdout: `${commonDirectories[path]}\n` } : success,
      )
    const call: Call = { path, args: [...args], kind, entered: ++sequence, returned: pending }
    call.returned = pending.then(
      (result) => {
        call.result = result
        call.settled = ++sequence
        if (kind === 'enable') activeEnable--
        return result
      },
      (error: unknown) => {
        call.error = error
        call.settled = ++sequence
        if (kind === 'enable') activeEnable--
        throw error
      },
    )
    calls.push(call)
    entry(path, kind).resolve(call)
    return call.returned
  })
  return {
    protocol,
    calls,
    success,
    hold(path: string, kind: Kind) {
      const value = deferred<GitResult>()
      held.set(key(path, kind), value)
      return value
    },
    entered: (path: string, kind: Kind) => entry(path, kind).promise,
    async secondBoundary(path: string) {
      const boundary = await Promise.race([
        entry(path, 'lookup').promise,
        entry(path, 'enable').promise,
      ])
      if (boundary.kind === 'lookup') {
        await boundary.returned
        // The resolver resumes from this same promise, then the lock resumes from
        // its key. Observe that chain assignment after the next Promise job.
        await Promise.resolve()
      }
    },
    releaseAll() {
      for (const value of held.values()) value.resolve(success)
    },
    maximumEnable: () => maximumEnable,
  }
}

function completion(promise: Promise<void>) {
  const state = { done: false }
  void promise.then(
    () => {
      state.done = true
    },
    () => {
      state.done = true
    },
  )
  return state
}

async function overlap(differentRepositories: boolean) {
  const firstKey = '/repo-one/.git'
  const secondKey = differentRepositories ? '/repo-two/.git' : firstKey
  const s = scenario({ '/worktree-a': firstKey, '/worktree-b': secondKey })
  s.hold('/worktree-a', 'enable')
  s.hold('/worktree-b', 'enable')
  const first = s.protocol.write({ worktreePath: '/worktree-a' }, '/profile-a')
  const firstState = completion(first)
  await s.entered('/worktree-a', 'enable')
  const firstTail = s.protocol.chain(firstKey)
  const second = s.protocol.write({ worktreePath: '/worktree-b' }, '/profile-b')
  const secondState = completion(second)
  await s.secondBoundary('/worktree-b')
  const beforeRelease = {
    enableStarts: s.calls.filter((call) => call.kind === 'enable').length,
    firstDone: firstState.done,
    secondDone: secondState.done,
    firstTailExists: firstTail !== undefined,
    secondTailExists: s.protocol.chain(secondKey) !== undefined,
    sameKeyTailChanged: s.protocol.chain(firstKey) !== firstTail,
  }
  s.releaseAll()
  const settled = await Promise.allSettled([first, second])
  return { beforeRelease, settled, maximumEnable: s.maximumEnable(), calls: s.calls }
}

async function rejection(throwOriginalError: boolean) {
  const s = scenario({ '/worktree-a': '/repo/.git', '/worktree-b': '/repo/.git' })
  const blocked = s.hold('/worktree-a', 'enable')
  const originalError = new Error('controlled Git rejection')
  const first = s.protocol.write({ worktreePath: '/worktree-a' }, '/profile-a')
  completion(first)
  await s.entered('/worktree-a', 'enable')
  const second = s.protocol.write({ worktreePath: '/worktree-b' }, '/profile-b')
  await s.secondBoundary('/worktree-b')
  const startsBeforeRejection = s.calls.filter((call) => call.kind === 'enable').length
  if (throwOriginalError) blocked.reject(originalError)
  else
    blocked.resolve({ exitCode: 1, stdout: 'unused stdout\n', stderr: '  config write failed\n' })
  const settled = await Promise.allSettled([first, second])
  return {
    startsBeforeRejection,
    settled,
    originalError,
    DomainError: s.protocol.DomainError,
    calls: s.calls,
  }
}

describe('RFC-359 W42 common worktree config serialization', () => {
  test('sibling worktrees queue the original common config writes', async () => {
    const result = await overlap(false)
    expect(result.beforeRelease.enableStarts).toBe(1)
    expect(result.beforeRelease).toEqual({
      enableStarts: 1,
      firstDone: false,
      secondDone: false,
      firstTailExists: true,
      secondTailExists: true,
      sameKeyTailChanged: true,
    })
    expect(result.maximumEnable).toBe(1)
    expect(result.settled).toEqual([
      { status: 'fulfilled', value: undefined },
      { status: 'fulfilled', value: undefined },
    ])
    expect(result.calls.map((call) => [call.path, call.args])).toEqual([
      ['/worktree-a', ['rev-parse', '--path-format=absolute', '--git-common-dir']],
      ['/worktree-a', ['config', 'extensions.worktreeConfig', 'true']],
      ['/worktree-b', ['rev-parse', '--path-format=absolute', '--git-common-dir']],
      ['/worktree-b', ['config', 'extensions.worktreeConfig', 'true']],
      ['/worktree-a', ['config', '--worktree', 'core.excludesFile', '/profile-a']],
      ['/worktree-b', ['config', '--worktree', 'core.excludesFile', '/profile-b']],
    ])
  })

  test('different common directories keep independent writes concurrent', async () => {
    const result = await overlap(true)
    expect(result.beforeRelease.enableStarts).toBe(2)
    expect(result.beforeRelease.firstDone).toBe(false)
    expect(result.beforeRelease.secondDone).toBe(false)
    expect(result.maximumEnable).toBe(2)
    expect(result.settled.every((item) => item.status === 'fulfilled')).toBe(true)
  })

  test('a nonzero original result keeps the original DomainError and releases the queue', async () => {
    const result = await rejection(false)
    expect(result.startsBeforeRejection).toBe(1)
    const first = result.settled[0]
    if (first?.status !== 'rejected') throw new Error('first config write did not reject')
    expect(first.reason).toBeInstanceOf(result.DomainError)
    const error: unknown = first.reason
    if (!(error instanceof result.DomainError)) throw new Error('unexpected error instance')
    expect(error.toPayload()).toEqual({
      ok: false,
      code: 'workspace-exclude-config-failed',
      message: 'enable worktree config: config write failed',
    })
    expect(error.status).toBe(500)
    expect(result.settled[1]).toEqual({ status: 'fulfilled', value: undefined })
    expect(result.calls.filter((call) => call.kind === 'enable').map((call) => call.path)).toEqual([
      '/worktree-a',
      '/worktree-b',
    ])
    expect(result.calls.filter((call) => call.kind === 'bind').map((call) => call.path)).toEqual([
      '/worktree-b',
    ])
  })

  test('an original Git rejection propagates without retry and the next queued write runs', async () => {
    const result = await rejection(true)
    expect(result.startsBeforeRejection).toBe(1)
    expect(result.settled[0]).toEqual({ status: 'rejected', reason: result.originalError })
    if (result.settled[0]?.status !== 'rejected') throw new Error('missing original rejection')
    expect(result.settled[0].reason).toBe(result.originalError)
    expect(result.settled[1]).toEqual({ status: 'fulfilled', value: undefined })
    expect(result.calls.filter((call) => call.kind === 'enable')).toHaveLength(2)
    expect(result.calls.filter((call) => call.kind === 'bind').map((call) => call.path)).toEqual([
      '/worktree-b',
    ])
  })

  test('both original awaits finish before the extracted owner continuation', async () => {
    const s = scenario({ '/worktree-a': '/repo/.git' })
    const enable = s.hold('/worktree-a', 'enable')
    const bind = s.hold('/worktree-a', 'bind')
    const write = s.protocol.write({ worktreePath: '/worktree-a' }, '/profile-a')
    const state = completion(write)
    try {
      await s.entered('/worktree-a', 'enable')
      expect(s.calls.filter((call) => call.kind === 'bind')).toHaveLength(0)
      expect(state.done).toBe(false)
      enable.resolve(s.success)
      await s.entered('/worktree-a', 'bind')
      expect(state.done).toBe(false)
      bind.resolve(s.success)
      await write
      expect(state.done).toBe(true)
    } finally {
      s.releaseAll()
      await write
    }
  })

  test('the actual common-directory cache adds one lookup for repeated worktree writes', async () => {
    const s = scenario({ '/worktree-a': '/repo/.git' })
    await s.protocol.write({ worktreePath: '/worktree-a' }, '/profile-a')
    await s.protocol.write({ worktreePath: '/worktree-a' }, '/profile-a')
    expect(s.calls.filter((call) => call.kind === 'lookup')).toHaveLength(1)
    expect(s.calls.filter((call) => call.kind === 'enable')).toHaveLength(2)
    expect(s.calls.filter((call) => call.kind === 'bind')).toHaveLength(2)
  })
})

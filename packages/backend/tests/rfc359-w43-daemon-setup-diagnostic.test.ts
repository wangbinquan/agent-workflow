import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

// W41 macOS reported a 5002.62 ms hook timeout. These controls check diagnostic
// placement in the real startup prefix; they do not run or reproduce daemon startup.
interface Protocol {
  setup(): Promise<void>
  cleanup(): Promise<void>
}

function loadStartupPrefix(ports: Record<string, unknown>): Protocol {
  const source = readFileSync(new URL('./daemon-start.test.ts', import.meta.url), 'utf8')
  const file = ts.createSourceFile('daemon-start.test.ts', source, ts.ScriptTarget.Latest, true)
  const namedCall = (
    node: ts.Statement,
    name: string,
  ): node is ts.ExpressionStatement & { expression: ts.CallExpression } =>
    ts.isExpressionStatement(node) &&
    ts.isCallExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === name
  const group = file.statements.find((node) => namedCall(node, 'describe'))
  if (group === undefined || !namedCall(group, 'describe'))
    throw new Error('missing original group')
  const groupCallback = group.expression.arguments[1]
  if (
    groupCallback === undefined ||
    !ts.isArrowFunction(groupCallback) ||
    !ts.isBlock(groupCallback.body)
  ) {
    throw new Error('missing original group body')
  }
  const groupBody = groupCallback.body
  const hook = (name: string) => {
    const statement = groupBody.statements.find((node) => namedCall(node, name))
    if (statement === undefined || !namedCall(statement, name))
      throw new Error('missing original hook')
    const callback = statement.expression.arguments[0]
    if (callback === undefined || !ts.isArrowFunction(callback) || !ts.isBlock(callback.body)) {
      throw new Error('missing original hook callback')
    }
    return { callback, body: callback.body }
  }
  const before = hook('beforeAll')
  const after = hook('afterAll')
  const calls: ts.CallExpression[] = []
  const walk = (node: ts.Node, visit: (node: ts.Node) => void): void => {
    visit(node)
    ts.forEachChild(node, (child) => {
      walk(child, visit)
    })
  }
  walk(before.body, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'waitForReady'
    ) {
      calls.push(node)
    }
  })
  if (calls.length !== 1 || calls[0] === undefined) throw new Error('ambiguous startup read')
  let statement: ts.Node | undefined = calls[0]
  while (statement !== undefined && !ts.isExpressionStatement(statement))
    statement = statement.parent
  if (statement === undefined || !ts.isExpressionStatement(statement))
    throw new Error('missing read statement')
  const following = before.body.statements[before.body.statements.indexOf(statement) + 1]
  const includesCompletion =
    following !== undefined &&
    namedCall(following, 'reportSetupStage') &&
    following.expression.arguments[0]?.getText(file) === "'operation-04-complete'"
  const end = includesCompletion ? following.end : statement.end
  let prefix = source.slice(before.body.getStart(file) + 1, end)

  // Erase only type syntax in the exact prefix, without loading the original
  // module or using its later setup. This leaves every executed expression intact.
  const fragment = ts.createSourceFile('prefix.ts', prefix, ts.ScriptTarget.Latest, true)
  const edits: { start: number; end: number }[] = []
  walk(fragment, (node) => {
    if (ts.isAsExpression(node)) edits.push({ start: node.expression.end, end: node.end })
    if (ts.isParameter(node) && node.type !== undefined) {
      edits.push({ start: node.name.end, end: node.type.end })
    }
    if (ts.isArrowFunction(node) && node.type !== undefined) {
      const colon = node
        .getChildren(fragment)
        .find((child) => child.kind === ts.SyntaxKind.ColonToken)
      if (colon === undefined) throw new Error('missing return type colon')
      edits.push({ start: colon.getStart(fragment), end: node.type.end })
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'fetch'
    ) {
      throw new Error('unselected setup entered the extracted prefix')
    }
  })
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    prefix = prefix.slice(0, edit.start) + prefix.slice(edit.end)
  }
  const executable = `
    let tmp, child, url, token;
    return {
      setup: async () => { ${prefix} },
      cleanup: ${after.callback.getText(file)}
    };
  `
  return new Function(...Object.keys(ports), executable)(...Object.values(ports)) as Protocol
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

function scenario(diagnosticFailure?: 'initial-clock' | 'stage-clock' | 'elapsed' | 'sink') {
  const ready = deferred<{ url: string; token: string }>()
  const entered = deferred<void>()
  const exited = deferred<number>()
  const messages: string[] = []
  const events: string[] = []
  const diagnosticFailures: string[] = []
  const stream = {}
  const result = { url: 'controlled-ready-value', token: 'controlled-opaque-value' }
  let clock = 1_000
  let clockReads = 0
  const failDiagnostic = () => {
    diagnosticFailures.push(diagnosticFailure!)
    throw new Error('controlled diagnostic failure')
  }
  const protocol = loadStartupPrefix({
    performance: {
      now: () => {
        clockReads += 1
        if (
          diagnosticFailure === 'initial-clock' ||
          (diagnosticFailure === 'stage-clock' && clockReads > 1)
        ) {
          return failDiagnostic()
        }
        if (diagnosticFailure === 'elapsed' && clockReads > 1) {
          return { [Symbol.toPrimitive]: failDiagnostic }
        }
        return (clock += 1.25)
      },
    },
    console: {
      error: (message: string) => {
        if (diagnosticFailure === 'sink') failDiagnostic()
        messages.push(message)
      },
    },
    process: { env: { FIXTURE_VALUE: 'must-not-appear-in-diagnostics' } },
    tmpdir: () => '/controlled',
    join: (...parts: string[]) => parts.join('/'),
    mkdtempSync: (_prefix: string) => {
      events.push('tmp-created')
      return '/controlled/owned-directory'
    },
    spawnDaemon: (_env: unknown) => {
      events.push('spawn-port')
      return {
        stdout: stream,
        kill: (signal: string) => {
          if (signal !== 'SIGTERM') throw new Error('original cleanup signal changed')
          events.push('kill-port')
        },
        exited: exited.promise,
      }
    },
    waitForReady: (received: unknown, timeoutMs: number) => {
      if (received !== stream || timeoutMs !== 10_000)
        throw new Error('original read arguments changed')
      events.push('read-port')
      entered.resolve()
      return ready.promise
    },
    rmSync: (path: string, options: { recursive: boolean; force: boolean }) => {
      if (path !== '/controlled/owned-directory' || !options.recursive || !options.force) {
        throw new Error('original cleanup arguments changed')
      }
      events.push('directory-removed')
    },
    fetch: () => {
      throw new Error('unselected setup must not execute')
    },
  })
  const diagnostics = () =>
    messages.map((message) => {
      const match = message.match(
        /^\[daemon-start setup\] (operation-0[1-9]-(?:enter|complete)) elapsedMs=(\d+\.\d{2})$/,
      )
      if (match?.[1] === undefined || match[2] === undefined) {
        throw new Error('diagnostic contains data outside the fixed stage and elapsed fields')
      }
      return { stage: match[1], elapsedMs: Number(match[2]) }
    })
  return {
    protocol,
    ready,
    entered,
    exited,
    result,
    diagnostics,
    events,
    messages,
    diagnosticFailures,
  }
}

const pendingStages = [
  'operation-01-enter',
  'operation-01-complete',
  'operation-02-enter',
  'operation-02-complete',
  'operation-03-enter',
  'operation-03-complete',
  'operation-04-enter',
]

describe('RFC-359 W43 daemon setup stage diagnostics', () => {
  test.each(['initial-clock', 'stage-clock', 'elapsed', 'sink'] as const)(
    'a throwing diagnostic %s preserves startup, original errors and cleanup',
    async (diagnosticFailure) => {
      const s = scenario(diagnosticFailure)
      s.ready.resolve(s.result)
      try {
        await expect(s.protocol.setup()).resolves.toBeUndefined()
        expect(s.diagnosticFailures).toContain(diagnosticFailure)
        expect(s.events).toEqual(['tmp-created', 'spawn-port', 'read-port'])
      } finally {
        if (s.events.includes('spawn-port')) {
          const cleanup = s.protocol.cleanup()
          s.exited.resolve(0)
          await cleanup
        }
      }
      expect(s.events).toEqual([
        'tmp-created',
        'spawn-port',
        'read-port',
        'kill-port',
        'directory-removed',
      ])

      const rejected = scenario(diagnosticFailure)
      const setup = rejected.protocol.setup()
      const originalError = new Error('controlled original readiness rejection')
      try {
        await rejected.entered.promise
        rejected.ready.reject(originalError)
        await expect(setup).rejects.toBe(originalError)
        expect(rejected.diagnosticFailures).toContain(diagnosticFailure)
        expect(rejected.events).toEqual(['tmp-created', 'spawn-port', 'read-port'])
      } finally {
        rejected.ready.resolve(rejected.result)
        await Promise.allSettled([setup])
        const cleanup = rejected.protocol.cleanup()
        rejected.exited.resolve(0)
        await cleanup
      }
      expect(rejected.events).toEqual([
        'tmp-created',
        'spawn-port',
        'read-port',
        'kill-port',
        'directory-removed',
      ])
    },
  )

  test('the real pending startup prefix reports only fixed stages and monotonic elapsed values', async () => {
    const s = scenario()
    let complete = false
    const setup = s.protocol.setup().then(() => {
      complete = true
    })
    try {
      await s.entered.promise
      expect(s.diagnostics().map((entry) => entry.stage)).toEqual(pendingStages)
      expect(complete).toBe(false)
      s.ready.resolve(s.result)
      await setup
      expect(s.diagnostics().map((entry) => entry.stage)).toEqual([
        ...pendingStages,
        'operation-04-complete',
      ])
      const elapsed = s.diagnostics().map((entry) => entry.elapsedMs)
      expect(
        elapsed.every(
          (value, index) => value >= 0 && (index === 0 || value >= elapsed[index - 1]!),
        ),
      ).toBe(true)
    } finally {
      s.ready.resolve(s.result)
      await setup
      const cleanup = s.protocol.cleanup()
      s.exited.resolve(0)
      await cleanup
    }
  })

  test('a rejected readiness port keeps its original error and leaves the pending stage visible', async () => {
    const s = scenario()
    const setup = s.protocol.setup()
    const originalError = new Error('controlled read failure')
    try {
      await s.entered.promise
      s.ready.reject(originalError)
      await expect(setup).rejects.toBe(originalError)
      expect(s.diagnostics().map((entry) => entry.stage)).toEqual(pendingStages)
    } finally {
      s.ready.resolve(s.result)
      await Promise.allSettled([setup])
      const cleanup = s.protocol.cleanup()
      s.exited.resolve(0)
      await cleanup
    }
  })

  test('the original cleanup still waits for process exit before removing its directory', async () => {
    const s = scenario()
    s.ready.resolve(s.result)
    await s.protocol.setup()
    let complete = false
    const cleanup = s.protocol.cleanup().then(() => {
      complete = true
    })
    try {
      expect(s.events).toEqual(['tmp-created', 'spawn-port', 'read-port', 'kill-port'])
      expect(complete).toBe(false)
    } finally {
      s.exited.resolve(0)
      await cleanup
    }
    expect(s.events).toEqual([
      'tmp-created',
      'spawn-port',
      'read-port',
      'kill-port',
      'directory-removed',
    ])
  })
})

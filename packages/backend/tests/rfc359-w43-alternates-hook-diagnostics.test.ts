import { expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

// RFC-359 W43: identify an unfinished setup operation without running Git or changing its budget.
const source = readFileSync(join(import.meta.dir, 'rfc210-alternates.test.ts'), 'utf8')
const stages = [
  'fixture-root',
  'config-path',
  'config-write',
  'previous-config-value',
  'fixture-config-value',
  'module-path',
  'module-directory',
  'module-init',
  'module-content',
  'module-stage',
  'module-commit',
  'cache-path',
  'cache-directory',
  'cache-init',
  'cache-content',
  'cache-stage',
  'cache-commit',
  'cache-module-add',
  'cache-module-commit',
  'pool-path',
  'worktree-path',
  'worktree-create',
  'worktree-module-update',
]
const gitStages = [
  'module-init',
  'module-stage',
  'module-commit',
  'cache-init',
  'cache-stage',
  'cache-commit',
  'cache-module-add',
  'cache-module-commit',
  'worktree-create',
  'worktree-module-update',
]

type Hook = () => void | Promise<void>
type Child = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter }
type State = { root: string; pool: string; wt: string; prevGlobal: string | undefined }
type Controls = {
  holdAt?: number
  failWrite?: boolean
  loggingFails?: boolean
  childErrorAt?: number
  closeCode?: number | null
}

function parsed(text: string) {
  const sf = ts.createSourceFile('rfc210-alternates.test.ts', text, ts.ScriptTarget.Latest, true)
  const before = sf.statements.find(
    (node) =>
      ts.isExpressionStatement(node) &&
      ts.isCallExpression(node.expression) &&
      node.expression.expression.getText(sf) === 'beforeAll',
  )
  const after = sf.statements.find(
    (node) =>
      ts.isExpressionStatement(node) &&
      ts.isCallExpression(node.expression) &&
      node.expression.expression.getText(sf) === 'afterAll',
  )
  const git = sf.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'git',
  )
  if (
    !before ||
    !after ||
    !git ||
    !ts.isExpressionStatement(before) ||
    !ts.isCallExpression(before.expression)
  )
    throw new Error('original hooks and git adapter required')
  const callback = before.expression.arguments[0]
  if (!callback || !ts.isArrowFunction(callback) || !ts.isBlock(callback.body))
    throw new Error('original setup block required')
  const variables = sf.statements.filter(
    (node) =>
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some((declaration) =>
        ['root', 'pool', 'wt', 'prevGlobal'].includes(declaration.name.getText(sf)),
      ),
  )
  return { sf, before, after, git, callback, variables }
}

function originalWithoutDiagnostics(text: string): string {
  const { sf, callback } = parsed(text)
  if (!ts.isBlock(callback.body)) throw new Error('setup block required')
  const nodes = callback.body.statements
  const first = nodes[0]
  if (
    !first ||
    !ts.isVariableStatement(first) ||
    first.declarationList.declarations[0]?.name.getText(sf) !== 'setupStartedAt'
  )
    return text
  const helper = nodes[1]
  if (
    !helper ||
    !ts.isVariableStatement(helper) ||
    helper.declarationList.declarations[0]?.name.getText(sf) !== 'markSetupPhase'
  )
    throw new Error('diagnostic helper required')
  const spans = [{ start: callback.body.getStart(sf) + 1, end: text.indexOf('\n', helper.end) + 1 }]
  for (const node of nodes) {
    if (
      ts.isExpressionStatement(node) &&
      ts.isCallExpression(node.expression) &&
      node.expression.expression.getText(sf) === 'markSetupPhase'
    ) {
      spans.push({
        start: text.lastIndexOf('\n', node.getStart(sf) - 1) + 1,
        end: text.indexOf('\n', node.end) + 1,
      })
    }
  }
  for (const span of spans.sort((a, b) => b.start - a.start))
    text = text.slice(0, span.start) + text.slice(span.end)
  return text
}

function runtimeText(node: ts.Node, sf: ts.SourceFile): string {
  const start = node.getStart(sf)
  let text = node.getText(sf)
  const spans: { start: number; end: number }[] = []
  function visit(child: ts.Node): void {
    if ((ts.isParameter(child) || ts.isVariableDeclaration(child)) && child.type) {
      spans.push({ start: child.name.end - start, end: child.type.end - start })
    } else if ((ts.isFunctionDeclaration(child) || ts.isArrowFunction(child)) && child.type) {
      spans.push({ start: child.type.pos - 1 - start, end: child.type.end - start })
    }
    ts.forEachChild(child, visit)
  }
  visit(node)
  for (const span of spans.sort((a, b) => b.start - a.start)) {
    assert.match(text.slice(span.start, span.end), /^\s*:/)
    text = text.slice(0, span.start) + text.slice(span.end)
  }
  return text
}

function fixture(text: string, controls: Controls = {}) {
  const { sf, before, after, git, variables } = parsed(text)
  const events: unknown[] = []
  const logs: unknown[][] = []
  const failure = new Error('controlled fixture failure')
  let setup: Hook | undefined
  let cleanup: Hook | undefined
  let snapshot: (() => State) | undefined
  let budget: number | undefined
  let count = 0
  let clock = 0
  let held: (() => void) | undefined
  let reached: (() => void) | undefined
  const entered = new Promise<void>((resolve) => {
    reached = resolve
  })
  const env: { GIT_CONFIG_GLOBAL?: string } = {}
  const ports = {
    beforeAll(hook: Hook, timeout: number) {
      setup = hook
      budget = timeout
    },
    afterAll(hook: Hook) {
      cleanup = hook
    },
    captureState(read: () => State) {
      snapshot = read
    },
    process: { env },
    performance: { now: () => clock++ },
    console: {
      info(...args: unknown[]) {
        logs.push(args)
        if (controls.loggingFails) throw failure
      },
    },
    tmpdir: () => '/logical/fixture-parent',
    join,
    mkdtempSync(path: string) {
      events.push(['mkdtemp', path])
      return '/logical/fixture'
    },
    mkdirSync(path: string) {
      events.push(['mkdir', path])
    },
    writeFileSync(path: string, data: string) {
      events.push(['write', path, data])
      if (controls.failWrite) throw failure
    },
    rmSync(path: string, options: unknown) {
      events.push(['rm', path, options])
    },
    spawn(command: string, args: string[], options: { cwd: string; stdio: string[] }): Child {
      const ordinal = ++count
      events.push(['spawn', ordinal, command, args, options])
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      })
      const complete = () => {
        if (controls.childErrorAt === ordinal) {
          events.push(['child-error', ordinal])
          child.emit('error', failure)
          return
        }
        child.stdout.emit('data', Buffer.from('controlled stdout'))
        child.stderr.emit('data', Buffer.from('controlled stderr'))
        const code = controls.closeCode === undefined ? 0 : controls.closeCode
        events.push(['close', ordinal, code])
        child.emit('close', code)
      }
      queueMicrotask(() => {
        if (controls.holdAt === ordinal) {
          held = complete
          reached?.()
        } else complete()
      })
      return child
    },
  }
  const body = [...variables, git, before, after].map((node) => runtimeText(node, sf)).join('\n')
  const register = new Function(
    'ports',
    `const { beforeAll, afterAll, spawn, mkdtempSync, mkdirSync, writeFileSync, rmSync, tmpdir, join, process, performance, console } = ports;\n${body}\nports.captureState(() => ({ root, pool, wt, prevGlobal }));`,
  )
  register(ports)
  return {
    events,
    logs,
    failure,
    entered,
    get commandCount() {
      return count
    },
    get budget() {
      return budget
    },
    get state() {
      if (!snapshot) throw new Error('state reader missing')
      return snapshot()
    },
    get environment() {
      return { ...env }
    },
    run() {
      if (!setup) throw new Error('setup missing')
      return setup()
    },
    close() {
      if (!cleanup) throw new Error('cleanup missing')
      return cleanup()
    },
    release() {
      if (!held) throw new Error('held child missing')
      held()
    },
  }
}

function diagnosticRows(logs: unknown[][]) {
  return logs.map((args) => {
    assert.equal(args.length, 2)
    assert.equal(args[0], '[rfc210-beforeAll]')
    const value = args[1]
    if (value === null || typeof value !== 'object') throw new Error('diagnostic object required')
    assert.deepEqual(Object.keys(value).sort(), ['elapsedMs', 'phase'])
    const phase: unknown = Reflect.get(value, 'phase')
    const elapsedMs: unknown = Reflect.get(value, 'elapsedMs')
    if (typeof phase !== 'string' || typeof elapsedMs !== 'number')
      throw new Error('diagnostic scalar fields required')
    return { phase, elapsedMs }
  })
}

const original = originalWithoutDiagnostics(source)

test('W43 alternates setup keeps the complete original protocol and fixed diagnostic fields', async () => {
  const before = fixture(original)
  const after = fixture(source)
  await before.run()
  await after.run()
  expect(after.events).toEqual(before.events)
  expect(after.state).toEqual(before.state)
  expect(after.budget).toBe(60_000)
  expect(before.budget).toBe(after.budget)
  expect(after.commandCount).toBe(10)
  const rows = diagnosticRows(after.logs)
  expect(rows.map((row) => row.phase)).toEqual(
    stages.flatMap((stage) => [`${stage}:begin`, `${stage}:end`]),
  )
  expect(
    rows.every(
      (row, index) =>
        Number.isFinite(row.elapsedMs) &&
        row.elapsedMs >= 0 &&
        (index === 0 || row.elapsedMs >= (rows[index - 1]?.elapsedMs ?? 0)),
    ),
  ).toBe(true)
  await before.close()
  await after.close()
  expect(after.events).toEqual(before.events)
  expect(after.environment).toEqual(before.environment)
})

test('W43 every pending setup Git operation retains its await and unfinished phase', async () => {
  for (let ordinal = 1; ordinal <= 10; ordinal++) {
    const before = fixture(original, { holdAt: ordinal })
    const after = fixture(source, { holdAt: ordinal })
    const oldPending = before.run()
    const newPending = after.run()
    await Promise.all([before.entered, after.entered])
    expect(after.events).toEqual(before.events)
    expect(after.commandCount).toBe(ordinal)
    expect(diagnosticRows(after.logs).at(-1)?.phase).toBe(`${gitStages[ordinal - 1]}:begin`)
    before.release()
    after.release()
    await Promise.all([oldPending, newPending])
    await before.close()
    await after.close()
    expect(after.events).toEqual(before.events)
  }
})

test('W43 setup input failures and failing diagnostic sinks preserve the original cleanup', async () => {
  for (const loggingFails of [false, true]) {
    const before = fixture(original, { failWrite: true })
    const after = fixture(source, { failWrite: true, loggingFails })
    await expect(before.run()).rejects.toBe(before.failure)
    await expect(after.run()).rejects.toBe(after.failure)
    expect(after.events).toEqual(before.events)
    expect(after.commandCount).toBe(0)
    expect(diagnosticRows(after.logs).at(-1)?.phase).toBe('config-write:begin')
    await before.close()
    await after.close()
    expect(after.events).toEqual(before.events)
    expect(after.environment).toEqual(before.environment)
  }
})

test('W43 original child error and close results do not gain new rejection behavior', async () => {
  for (const controls of [
    { childErrorAt: 1 },
    { closeCode: 17 },
    { closeCode: null },
    { loggingFails: true },
  ]) {
    const before = fixture(original, controls)
    const after = fixture(source, controls)
    await before.run()
    await after.run()
    expect(after.events).toEqual(before.events)
    expect(after.commandCount).toBe(10)
    expect(diagnosticRows(after.logs).at(-1)?.phase).toBe('worktree-module-update:end')
    await before.close()
    await after.close()
    expect(after.events).toEqual(before.events)
  }
})

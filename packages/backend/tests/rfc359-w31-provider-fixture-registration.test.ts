import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

import * as fixtureRegistry from '@/db/client'

// Only fixture object identities and the actual registration statements run here.
// Database constructors, application composition and HTTP requests are not invoked.
const backendRoot = resolve(import.meta.dir, '..')
const clientText = readFileSync(resolve(backendRoot, 'src/db/client.ts'), 'utf8')
const harnessText = readFileSync(resolve(backendRoot, 'tests/helpers/eachProvider.ts'), 'utf8')
const parse = (text: string) =>
  ts.createSourceFile('fixture.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const compact = (node: ts.Node, source: ts.SourceFile) => node.getText(source).replace(/\s+/g, '')

function declaration(source: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const found = source.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === name,
  )
  if (found?.body === undefined) throw new Error(`missing fixture declaration: ${name}`)
  return found
}

function collect<T extends ts.Node>(
  node: ts.Node,
  predicate: (candidate: ts.Node) => candidate is T,
): T[] {
  const found: T[] = []
  const visit = (candidate: ts.Node) => {
    if (predicate(candidate)) found.push(candidate)
    ts.forEachChild(candidate, visit)
  }
  visit(node)
  return found
}

function registrationBranch(
  statement: ts.Statement | undefined,
  source: ts.SourceFile,
  options: 'opts' | 'options',
  object: 'db' | 'client',
): ts.IfStatement {
  if (
    statement === undefined ||
    !ts.isIfStatement(statement) ||
    statement.elseStatement !== undefined ||
    compact(statement.expression, source) !== `${options}.bootstrap!=='required'` ||
    compact(statement.thenStatement, source) !== `registerLegacyDaemonTestFixture(${object})`
  ) {
    throw new Error('fixture registration must retain the original option and object')
  }
  return statement
}

function sqliteRegistration(text: string): string {
  const source = parse(text)
  const owner = declaration(source, 'createInMemoryDb')
  const statements = owner.body!.statements
  const statement = registrationBranch(statements.at(-2), source, 'opts', 'db')
  if (compact(statements.at(-1)!, source) !== 'returndb') {
    throw new Error('SQLite fixture must return the registered final object')
  }
  return statement.getText(source)
}

function postgresqlRegistration(text: string): string {
  const source = parse(text)
  const owner = declaration(source, 'registerPostgresql')
  const hooks = collect(owner, ts.isCallExpression).filter(
    (node) => node.expression.getText(source) === 'beforeEach',
  )
  if (hooks.length !== 1) throw new Error('expected one PostgreSQL fixture reset hook')
  const loops = collect(hooks[0]!, ts.isForOfStatement)
  const loop = loops[0]?.statement
  if (loops.length !== 1 || loop === undefined || !ts.isBlock(loop)) {
    throw new Error('expected one per-database reset loop')
  }
  const statements = loop.statements
  const resetIndex = statements.findIndex(
    (statement) => compact(statement, source) === 'awaitresetToSnapshot(raw,snapshot,options)',
  )
  if (resetIndex < 0) throw new Error('missing awaited original snapshot reset')
  const registration = registrationBranch(statements[resetIndex + 1], source, 'options', 'client')
  if (
    compact(statements[0]!, source) !== 'const{client,raw,snapshot,sinks}=database' ||
    !statements.some((statement) => compact(statement, source) === 'state.db=client') ||
    !statements.some(
      (statement) =>
        compact(statement, source) === 'state.applicationBinding=database.applicationBinding',
    )
  ) {
    throw new Error('PostgreSQL fixture must bind its original final client')
  }
  return source.text.slice(statements[resetIndex]!.getStart(source), registration.end)
}

function runSqliteRegistration(db: object, opts: { bootstrap?: 'ready' | 'required' }) {
  const run = new Function(
    'db',
    'opts',
    'registerLegacyDaemonTestFixture',
    sqliteRegistration(clientText),
  )
  run(db, opts, fixtureRegistry.registerLegacyDaemonTestFixture)
}

function runPostgresqlRegistration(
  client: object,
  options: { bootstrap?: 'required' },
  reset: (raw: object, snapshot: object, options: { bootstrap?: 'required' }) => Promise<void>,
  raw: object,
  snapshot: object,
) {
  const run = new Function(
    'client',
    'options',
    'resetToSnapshot',
    'raw',
    'snapshot',
    'registerLegacyDaemonTestFixture',
    `return (async () => { ${postgresqlRegistration(harnessText)} })()`,
  )
  return run(client, options, reset, raw, snapshot, fixtureRegistry.registerLegacyDaemonTestFixture)
}

describe('RFC-359 W31: provider fixture registration identity', () => {
  test('registration affects only the supplied object and is idempotent', () => {
    const db = Object.freeze({})
    const other = {}
    expect(fixtureRegistry.allowsLegacyDaemonTestAccess(db)).toBe(false)
    expect(typeof fixtureRegistry.registerLegacyDaemonTestFixture).toBe('function')
    expect(fixtureRegistry.registerLegacyDaemonTestFixture(db)).toBeUndefined()
    fixtureRegistry.registerLegacyDaemonTestFixture(db)
    expect(fixtureRegistry.allowsLegacyDaemonTestAccess(db)).toBe(true)
    expect(fixtureRegistry.allowsLegacyDaemonTestAccess(other)).toBe(false)
    expect(fixtureRegistry.allowsLegacyDaemonTestAccess({ ...db })).toBe(false)
    expect(fixtureRegistry.allowsLegacyDaemonTestAccess(new Proxy(db, {}))).toBe(false)
  })

  test('the original SQLite registration branch retains all bootstrap option identities', () => {
    for (const bootstrap of [undefined, 'ready', 'required'] as const) {
      const db = {}
      runSqliteRegistration(db, bootstrap === undefined ? {} : { bootstrap })
      expect(fixtureRegistry.allowsLegacyDaemonTestAccess(db)).toBe(bootstrap !== 'required')
    }
  })

  test('the actual PostgreSQL reset prefix registers the same final client only after success', async () => {
    const client = {}
    const raw = {}
    const snapshot = {}
    const options = {}
    let finish: (() => void) | undefined
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    let resets = 0
    const completion = runPostgresqlRegistration(
      client,
      options,
      async (seenRaw, seenSnapshot, seenOptions) => {
        resets += 1
        expect(seenRaw).toBe(raw)
        expect(seenSnapshot).toBe(snapshot)
        expect(seenOptions).toBe(options)
        await pending
      },
      raw,
      snapshot,
    )
    expect(resets).toBe(1)
    expect(fixtureRegistry.allowsLegacyDaemonTestAccess(client)).toBe(false)
    if (finish === undefined) throw new Error('fixture reset resolver was not initialized')
    finish()
    await completion
    expect(fixtureRegistry.allowsLegacyDaemonTestAccess(client)).toBe(true)
    expect(fixtureRegistry.allowsLegacyDaemonTestAccess(raw)).toBe(false)
    expect(fixtureRegistry.allowsLegacyDaemonTestAccess(snapshot)).toBe(false)
  })

  test('required bootstrap and rejected reset do not register the PostgreSQL fixture', async () => {
    const required = {}
    await runPostgresqlRegistration(required, { bootstrap: 'required' }, async () => {}, {}, {})
    expect(fixtureRegistry.allowsLegacyDaemonTestAccess(required)).toBe(false)
    const failed = {}
    const error = new Error('fixture-reset-failed')
    await expect(
      runPostgresqlRegistration(failed, {}, () => Promise.reject(error), {}, {}),
    ).rejects.toBe(error)
    expect(fixtureRegistry.allowsLegacyDaemonTestAccess(failed)).toBe(false)
  })

  test('the shared consumer and PostgreSQL wrapper retain the original input object', () => {
    const source = parse(readFileSync(resolve(backendRoot, 'src/auth/composition.ts'), 'utf8'))
    const shared = declaration(source, 'createAuthRuntimeFor')
    const reads = collect(shared, ts.isCallExpression).filter(
      (node) => node.expression.getText(source) === 'allowsLegacyDaemonTestAccess',
    )
    expect(reads.map((call) => call.arguments.map((argument) => argument.getText(source)))).toEqual(
      [['input.db']],
    )
    const wrapper = declaration(source, 'createPostgresqlAuthRuntime')
    expect(wrapper.body!.statements.map((statement) => compact(statement, source))).toEqual([
      'returncreateAuthRuntimeFor(input)',
    ])
    const client = parse(clientText)
    const calls = collect(declaration(client, 'openDb'), ts.isCallExpression).map((call) =>
      call.expression.getText(client),
    )
    expect(calls).not.toContain('registerLegacyDaemonTestFixture')
    expect(calls).not.toContain('createInMemoryDb')
  })

  test('source controls reject wrong object, changed option and registration before reset', () => {
    const span = postgresqlRegistration(harnessText)
    expect(span).toContain('await resetToSnapshot(raw, snapshot, options)')
    for (const candidate of [
      harnessText.replace(
        'registerLegacyDaemonTestFixture(client)',
        'registerLegacyDaemonTestFixture(database)',
      ),
      harnessText.replace(
        "if (options.bootstrap !== 'required') registerLegacyDaemonTestFixture(client)",
        'registerLegacyDaemonTestFixture(client)',
      ),
      harnessText.replace(
        "if (options.bootstrap !== 'required') registerLegacyDaemonTestFixture(client)",
        "if (options.bootstrap === 'required') registerLegacyDaemonTestFixture(client)",
      ),
      harnessText.replace(span, span.split('\n').reverse().join('\n')),
    ]) {
      expect(candidate === harnessText).toBe(false)
      expect(() => postgresqlRegistration(candidate)).toThrow()
    }
  })
})

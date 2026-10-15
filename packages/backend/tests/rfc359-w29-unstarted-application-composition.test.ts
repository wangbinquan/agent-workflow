// RFC-359 W29 — the unstarted application lifetime helper
// (`tests/helpers/providerHttpApplication.ts#composeUnstartedApplication`) waits for
// every readiness promise, owns one instance per scope and keeps every cleanup
// failure. No application or service is started here: the actual pure lifetime
// function is evaluated with controlled lifecycle collaborators.
//
// RFC-370 v2 P1 retired this file's whole-body AST pins of the daemon roots. They
// reconstructed the pre-RFC-370 roots through a chain of RFC-370/371 inverses; the
// v2 redesign removed the host execution path those inverses undid. Root wiring is
// exercised by the provider root and application tests instead.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

const applicationHelper = ts.createSourceFile(
  'providerHttpApplication.ts',
  readFileSync(
    process.env.AW_RFC359_LIFETIME_SOURCE_PATH ??
      resolve(import.meta.dir, 'helpers/providerHttpApplication.ts'),
    'utf8',
  ),
  ts.ScriptTarget.Latest,
  true,
)

function declaration(source: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const node = source.statements.find(
    (item): item is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(item) && item.name?.text === name && item.body !== undefined,
  )
  if (node === undefined) throw new Error(`missing composition function: ${name}`)
  return node
}

interface ControlledMcpInput {
  readonly name: string
  readonly dispose: () => Promise<void>
}
class ControlledMcpService {
  constructor(readonly input: ControlledMcpInput) {}
  dispose(): Promise<void> {
    return this.input.dispose()
  }
}
interface ControlledScope {
  trackReady<T>(ready: Promise<T>): Promise<T>
  createMcpRuntimeTests(input: ControlledMcpInput): ControlledMcpService
}
type ComposeControlledScope = <T extends object>(
  compose: (scope: ControlledScope) => T | Promise<T>,
) => Promise<T & { readonly dispose: () => Promise<void> }>

function actualLifetimeHelper(): ComposeControlledScope {
  const actual = declaration(applicationHelper, 'composeUnstartedApplication').getText(
    applicationHelper,
  )
  const code = ts.transpileModule(actual.replace(/^export\s+/, ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  // Only this actual pure lifetime function is evaluated. The constructor is a
  // controlled lifecycle collaborator; no application, database, or rows are faked.
  return new Function('composeLocalMcpDiagnostics', `${code}\nreturn composeUnstartedApplication`)(
    (input: ControlledMcpInput) => new ControlledMcpService(input),
  ) as ComposeControlledScope
}

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void
  let rejectPromise!: (error: unknown) => void
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

describe('RFC-359 W29 actual application lifetime helper with controlled lifecycle collaborators', () => {
  test('waits for every real readiness promise and preserves the same owned instance', async () => {
    const compose = actualLifetimeHelper()
    const first = deferred<string>()
    const second = deferred<void>()
    const created = deferred<void>()
    let returned = false
    const log: string[] = []
    const pending = compose((scope) => {
      expect(scope.trackReady(first.promise)).toBe(first.promise)
      scope.trackReady(second.promise)
      const service = scope.createMcpRuntimeTests({
        name: 'first',
        dispose: async () => {
          log.push('dispose')
        },
      })
      created.resolve()
      return { service }
    }).then((application) => {
      returned = true
      return application
    })
    await created.promise
    first.resolve('ready')
    await first.promise
    await new Promise<void>((resolve) => setImmediate(resolve))
    try {
      expect(returned).toBe(false)
    } finally {
      second.resolve()
    }
    const application = await pending
    expect(application.service.input.name).toBe('first')
    expect(log).toEqual([])
    expect(Object.isFrozen(application)).toBe(true)
    const a = application.dispose()
    const b = application.dispose()
    expect(a).toBe(b)
    await a
    expect(log).toEqual(['dispose'])
  })

  test('finishes pending initialization before cleanup after construction failure', async () => {
    const compose = actualLifetimeHelper()
    const initialization = deferred<void>()
    const constructing = deferred<void>()
    const failure = new Error('construction failed')
    const log: string[] = []
    const pending = compose((scope) => {
      scope.trackReady(initialization.promise)
      scope.createMcpRuntimeTests({
        name: 'failed',
        dispose: async () => {
          log.push('dispose')
        },
      })
      constructing.resolve()
      throw failure
    })
    const outcome = pending.then(
      () => undefined,
      (error: unknown) => error,
    )
    await constructing.promise
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(log).toEqual([])
    log.push('initialization finished')
    initialization.resolve()
    expect(await outcome).toBe(failure)
    expect(log).toEqual(['initialization finished', 'dispose'])
  })

  test('keeps initialization failure and closes every service even when cleanup also fails', async () => {
    const compose = actualLifetimeHelper()
    const failure = new Error('module initialization failed')
    const cleanup = new Error('owned service disposal failed')
    const log: string[] = []
    const outcome = await compose((scope) => {
      scope.trackReady(Promise.reject(failure))
      scope.createMcpRuntimeTests({
        name: 'first',
        dispose: async () => {
          log.push('first')
          throw cleanup
        },
      })
      scope.createMcpRuntimeTests({
        name: 'second',
        dispose: async () => {
          log.push('second')
        },
      })
      return { marker: 'constructed' }
    }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(outcome).toBeInstanceOf(AggregateError)
    if (!(outcome instanceof AggregateError)) throw new Error('missing combined lifecycle failure')
    expect(outcome.errors).toEqual([failure, cleanup])
    expect(log).toEqual(['first', 'second'])
  })

  test('gives consecutive app scopes separate instances and preserves each cleanup failure identity', async () => {
    const compose = actualLifetimeHelper()
    const cleanup = new Error('first disposal failed')
    const first = await compose((scope) => ({
      service: scope.createMcpRuntimeTests({
        name: 'first',
        dispose: async () => {
          throw cleanup
        },
      }),
    }))
    const second = await compose((scope) => ({
      service: scope.createMcpRuntimeTests({ name: 'second', dispose: async () => {} }),
    }))
    expect(first.service).not.toBe(second.service)
    await expect(first.dispose()).rejects.toBe(cleanup)
    await second.dispose()
    await expect(first.dispose()).rejects.toBe(cleanup)
  })
})

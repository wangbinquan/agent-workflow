// These are pure text-constructor checks. They do not run repository preparation,
// a database, a Git command, or either provider's task execution path.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import * as errorUtilities from '@/util/errors'

type Diagnostic = (error: unknown) => string

// Exact former task constructor; the PostgreSQL constructor has the same reads
// and return expression, with only the two primitive details checks reordered.
const original: Diagnostic = (err) => {
  if (!(err instanceof Error)) return String(err)
  const details = (err as { details?: unknown }).details
  const stderr =
    typeof details === 'object' && details !== null && 'stderr' in details
      ? (details as { stderr?: unknown }).stderr
      : undefined
  return typeof stderr === 'string' && stderr.length > 0 ? `${err.message}\n${stderr}` : err.message
}

function actual(relative: string, localName: string): Diagnostic {
  const path = fileURLToPath(new URL(relative, import.meta.url))
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
  const declarations = source.statements.filter(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === localName,
  )
  if (declarations.length === 1) {
    const code = ts.transpileModule(`${declarations[0]!.getText(source)}\nreturn ${localName}`, {
      compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.None },
    }).outputText
    const fn: unknown = new Function(code)()
    if (typeof fn !== 'function') throw new Error('expected original callable diagnostic')
    return fn as Diagnostic
  }
  if (declarations.length !== 0) throw new Error('ambiguous diagnostic declaration')
  const bindings = source.statements.flatMap((node) => {
    if (
      !ts.isImportDeclaration(node) ||
      !ts.isStringLiteral(node.moduleSpecifier) ||
      node.moduleSpecifier.text !== '@/util/errors' ||
      node.importClause?.namedBindings === undefined ||
      !ts.isNamedImports(node.importClause.namedBindings)
    )
      return []
    return node.importClause.namedBindings.elements.filter(
      (binding) =>
        binding.name.text === localName &&
        (binding.propertyName?.text ?? binding.name.text) === 'diagnosticTextOf',
    )
  })
  if (bindings.length !== 1) throw new Error('expected one actual shared diagnostic binding')
  const fn: unknown = Reflect.get(errorUtilities, 'diagnosticTextOf')
  if (typeof fn !== 'function') throw new Error('shared diagnostic export missing')
  return fn as Diagnostic
}

function traced(stderr: unknown, inherited = false) {
  const reads: string[] = []
  const fields = Object.defineProperty({}, 'stderr', {
    get() {
      reads.push('stderr')
      return stderr
    },
  })
  const details = new Proxy(inherited ? Object.create(fields) : fields, {
    has(target, key) {
      reads.push(`has:${String(key)}`)
      return Reflect.has(target, key)
    },
    get(target, key, receiver) {
      reads.push(`get:${String(key)}`)
      return Reflect.get(target, key, receiver)
    },
  })
  const error = new Error()
  Object.defineProperties(error, {
    details: {
      get() {
        reads.push('details')
        return details
      },
    },
    message: {
      get() {
        reads.push('message')
        return 'fetch failed'
      },
    },
  })
  return { error, reads }
}

function thrownBy(fn: () => unknown) {
  try {
    fn()
    throw new Error('expected diagnostic to throw')
  } catch (error) {
    return error
  }
}

for (const [label, relative, localName] of [
  ['task', '../src/services/task.ts', 'diagnosticTextOf'],
  [
    'repository retry',
    '../src/modules/task-execution/infrastructure/postgresqlRepositoryPreparationRetryCommand.ts',
    'diagnosticText',
  ],
]) {
  const diagnostic = actual(relative!, localName!)
  describe(`RFC-359 repository diagnostic ${label}`, () => {
    test('preserves complete text for every original details and stderr shape', () => {
      for (const value of [
        null,
        undefined,
        0,
        false,
        'raw failure',
        ['failure'],
        { code: 'fetch' },
      ]) {
        expect(diagnostic(value)).toBe(original(value))
      }
      for (const details of [
        undefined,
        null,
        false,
        1,
        'detail',
        [],
        {},
        { stderr: undefined },
        { stderr: null },
        { stderr: 3 },
        { stderr: '' },
        { stderr: 'remote unavailable\n' },
        { stderr: '远端失联\r\nretry' },
      ]) {
        const error = Object.assign(new Error('fetch failed'), { details })
        expect(diagnostic(error)).toBe(original(error))
        expect(JSON.stringify(diagnostic(error))).toBe(JSON.stringify(original(error)))
      }
      expect(diagnostic(Object.assign(new Error(''), { details: { stderr: 'remote' } }))).toBe(
        '\nremote',
      )
    })

    test('preserves inherited fields and the complete observable getter order', () => {
      for (const stderr of [undefined, null, '', 'remote\n']) {
        for (const inherited of [false, true]) {
          const expected = traced(stderr, inherited)
          const input = traced(stderr, inherited)
          expect(diagnostic(input.error)).toBe(original(expected.error))
          expect(input.reads).toEqual(expected.reads)
          expect(input.reads).toEqual(['details', 'has:stderr', 'get:stderr', 'stderr', 'message'])
        }
      }
    })

    test('preserves exception identity at each original conversion or property read', () => {
      for (const stage of ['details', 'has', 'stderr', 'message', 'conversion']) {
        const failure = new Error(`failed ${stage}`)
        const details = new Proxy(
          Object.defineProperty({}, 'stderr', {
            get() {
              if (stage === 'stderr') throw failure
              return 'remote'
            },
          }),
          {
            has(target, key) {
              if (stage === 'has') throw failure
              return Reflect.has(target, key)
            },
          },
        )
        const error = new Error()
        Object.defineProperties(error, {
          details: {
            get() {
              if (stage === 'details') throw failure
              return details
            },
          },
          message: {
            get() {
              if (stage === 'message') throw failure
              return 'fetch'
            },
          },
        })
        const input =
          stage === 'conversion'
            ? {
                [Symbol.toPrimitive]() {
                  throw failure
                },
              }
            : error
        expect(thrownBy(() => original(input))).toBe(failure)
        expect(thrownBy(() => diagnostic(input))).toBe(failure)
      }
    })
  })
}

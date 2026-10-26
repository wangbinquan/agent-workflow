// RFC-359 W44 / RFC-395 F-F1: preserve dependency order, missing-row semantics and
// read-error identity through typed relations. Malformed epoch-1 JSON is covered by
// rfc395-reference-target-relations; the remaining outputs JSON keeps its codec contract.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { assertAgentDependencyGraph } from '../src/modules/resource-catalog/domain/agentDependencies'
import { ValidationError } from '../src/util/errors'

type Side = 'semantics' | 'package'

function loadActualOwner(side: Side, ports: Record<string, unknown>) {
  const file =
    side === 'semantics'
      ? '../src/modules/resource-catalog/infrastructure/agentPersistenceSemantics.ts'
      : '../src/modules/resource-catalog/infrastructure/aggregateAdapters/postgresqlResourcePackageMutationArms.ts'
  const source = readFileSync(new URL(file, import.meta.url), 'utf8')
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const names =
    side === 'semantics'
      ? ['unique', 'assertDependencyGraph']
      : ['uniqueStrings', 'assertAgentDependencyGraph']
  const extracted = names.map((name) => {
    const matches = ast.statements.filter(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === name,
    )
    if (matches.length !== 1 || matches[0] === undefined) {
      throw new Error('missing unique dependency reader function')
    }
    return matches[0].getText(ast)
  })
  const javascript = new Bun.Transpiler({ loader: 'ts' }).transformSync(extracted.join('\n'))
  return new Function(...Object.keys(ports), `${javascript}\nreturn ${names.at(-1)};`)(
    ...Object.values(ports),
  ) as (transaction: unknown, id: string, roots: readonly string[]) => Promise<void>
}

interface Control {
  readonly ids: readonly string[]
  readonly missing?: boolean
  readonly rowError?: Error
  readonly hold?: Promise<void>
  readonly readError?: Error
  readonly relationError?: Error
}

function scenario(side: Side, control: Control) {
  const events: string[] = []
  const parsed: { id: string; value: readonly string[] | undefined }[] = []
  const queries: { id: string; table: 'agents' | 'dependencies'; terminal: 'limit' | 'orderBy' }[] =
    []
  const table = { id: Symbol('agent-id') }
  const dependencies = {
    agentId: Symbol('parent-id'),
    dependencyAgentId: Symbol('dependency-id'),
    ordinal: Symbol('ordinal'),
  }
  const transaction = {
    select(projection: Record<string, unknown>) {
      expect(Object.keys(projection)).toEqual(['id'])
      return {
        from(received: unknown) {
          const parent = received === table
          expect(received).toBe(parent ? table : dependencies)
          expect(projection.id).toBe(parent ? table.id : dependencies.dependencyAgentId)
          return {
            where(condition: { column: unknown; id: string }) {
              expect(condition.column).toBe(parent ? table.id : dependencies.agentId)
              return {
                async limit(count: number) {
                  expect(parent).toBe(true)
                  expect(count).toBe(1)
                  queries.push({ id: condition.id, table: 'agents', terminal: 'limit' })
                  events.push(`parent:${condition.id}`)
                  if (condition.id === 'loaded' && control.readError !== undefined)
                    throw control.readError
                  return condition.id === 'loaded' && control.missing ? [] : [{ id: condition.id }]
                },
                async orderBy(order: { column: unknown; direction: string }) {
                  expect(parent).toBe(false)
                  expect(order).toEqual({ column: dependencies.ordinal, direction: 'asc' })
                  queries.push({ id: condition.id, table: 'dependencies', terminal: 'orderBy' })
                  events.push(`references:${condition.id}`)
                  if (condition.id !== 'loaded') return []
                  if (control.hold !== undefined) await control.hold
                  if (control.relationError !== undefined) throw control.relationError
                  // Storage order deliberately differs from ordinal order.
                  return control.ids
                    .map((id, ordinal) => ({ id, ordinal }))
                    .reverse()
                    .sort((a, b) => a.ordinal - b.ordinal)
                    .map(({ id }) => ({
                      get id() {
                        events.push('reference-get')
                        if (control.rowError !== undefined) throw control.rowError
                        return id
                      },
                    }))
                },
              }
            },
          }
        },
      }
    },
  }
  const file = '../src/modules/resource-catalog/infrastructure/agentDependencyRead.ts'
  const source = readFileSync(new URL(file, import.meta.url), 'utf8')
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const fn = ast.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === 'createAgentDependencyReadPort',
  )
  if (fn === undefined) throw new Error('missing dependency reader')
  const javascript = new Bun.Transpiler({ loader: 'ts' }).transformSync(
    fn.getText(ast).replace(/^export /, ''),
  )
  const createReader = new Function(
    'tablesOf',
    'eq',
    'asc',
    `${javascript}\nreturn createAgentDependencyReadPort;`,
  )(
    (handle: unknown) => {
      expect(handle).toBe(transaction)
      return { agents: table, agentDependencies: dependencies }
    },
    (column: unknown, id: string) => ({ column, id }),
    (column: unknown) => ({ column, direction: 'asc' }),
  )
  const owner = loadActualOwner(side, {
    ValidationError,
    createAgentDependencyReadPort: createReader,
    validateDependencyGraph: (input: Parameters<typeof assertAgentDependencyGraph>[0]) =>
      assertAgentDependencyGraph({
        ...input,
        load: async (dependencyId) => {
          const value = await input.load(dependencyId)
          parsed.push({ id: dependencyId, value })
          return value
        },
      }),
  })
  return { run: () => owner(transaction, 'candidate', ['loaded']), events, parsed, queries }
}

for (const side of ['semantics', 'package'] as const) {
  describe(`RFC-359 W44 / RFC-395 dependency relations ${side}`, () => {
    test('the actual loader retains ordinal order, duplicates, empty strings and Unicode', async () => {
      for (const ids of [['leaf', 'leaf', '', 'tail'], ['雪', 'é'], []]) {
        const s = scenario(side, { ids })
        await s.run()
        expect(s.parsed[0]?.value).toEqual(ids)
        expect(s.queries.slice(0, 2)).toEqual([
          { id: 'loaded', table: 'agents', terminal: 'limit' },
          { id: 'loaded', table: 'dependencies', terminal: 'orderBy' },
        ])
      }
    })

    test('a missing parent remains distinct from an existing agent with no references', async () => {
      const absent = scenario(side, { ids: [], missing: true })
      await expect(absent.run()).rejects.toMatchObject({ code: 'agent-dependency-not-found' })
      expect(absent.parsed).toEqual([{ id: 'loaded', value: undefined }])
      expect(absent.queries).toEqual([{ id: 'loaded', table: 'agents', terminal: 'limit' }])
      const empty = scenario(side, { ids: [] })
      await empty.run()
      expect(empty.parsed).toEqual([{ id: 'loaded', value: [] }])
    })

    test('parent, relation and row getter errors propagate without a JSON fallback', async () => {
      const error = new Error('controlled dependency read failure')
      for (const fault of ['readError', 'relationError', 'rowError'] as const) {
        const s = scenario(side, { ids: ['leaf'], [fault]: error })
        await expect(s.run()).rejects.toBe(error)
        expect(s.parsed).toEqual([])
        expect(s.events).toEqual(
          fault === 'readError'
            ? ['parent:loaded']
            : fault === 'relationError'
              ? ['parent:loaded', 'references:loaded']
              : ['parent:loaded', 'references:loaded', 'reference-get'],
        )
      }
    })

    test('the relation read is awaited before graph traversal completes', async () => {
      let release!: () => void
      const hold = new Promise<void>((resolve) => {
        release = resolve
      })
      const s = scenario(side, { ids: [], hold })
      let completed = false
      const running = s.run().then(() => {
        completed = true
      })
      try {
        await Promise.resolve()
        expect(completed).toBe(false)
        expect(s.events).toEqual(['parent:loaded', 'references:loaded'])
        expect(s.parsed).toEqual([])
      } finally {
        release()
        await running
      }
      expect(s.parsed).toEqual([{ id: 'loaded', value: [] }])
    })
  })
}

// RFC-359 W49: run only the actual decoders and their original property-read expressions.
function checkStringDecoder(file: string, name: string, fields: readonly string[]) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8')
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const decoderFile = '../src/modules/resource-catalog/infrastructure/agentReferenceCodec.ts'
  const decoderAst = ts.createSourceFile(
    decoderFile,
    readFileSync(new URL(decoderFile, import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  )
  const declarations = decoderAst.statements.filter(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === name,
  )
  if (declarations.length !== 1 || declarations[0] === undefined)
    throw new Error('missing unique string decoder')
  const calls: ts.CallExpression[] = []
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === name) calls.push(node)
    ts.forEachChild(node, visit)
  }
  visit(ast)
  expect(calls.map((call) => call.getText(ast).replace(/\s+/g, ' '))).toEqual(
    fields.map((field) => `${name}(row.${field})`),
  )
  const javascript = new Bun.Transpiler({ loader: 'ts' }).transformSync(
    declarations[0].getText(decoderAst).replace(/^export /, ''),
  )
  const inputs: { raw: string; expected: string[] }[] = [
    { raw: '["z","z","",null,2,false,{},[],"雪","a"]', expected: ['z', 'z', '', '雪', 'a'] },
    { raw: '[]', expected: [] },
    { raw: 'null', expected: [] },
    { raw: '{}', expected: [] },
    { raw: '"scalar"', expected: [] },
    { raw: '17', expected: [] },
    { raw: 'false', expected: [] },
    { raw: '', expected: [] },
    { raw: '[invalid', expected: [] },
  ]
  const observations: unknown[] = []
  for (const [index, call] of calls.entries()) {
    const field = fields[index]
    if (field === undefined) throw new Error('unexpected decoder caller')
    const events: string[] = []
    const failure = new Error('controlled decoder failure')
    let fault = ''
    const reader: unknown = new Function(
      'source',
      'JSON',
      `${javascript}\nreturn (row) => ${call.getText(ast)};`,
    )('other', {
      get parse() {
        events.push('parse-get')
        if (fault === 'parse-get') throw failure
        return (raw: string): unknown => {
          events.push('parse-call')
          if (fault === 'parse-call') throw failure
          if (!fault.startsWith('filter-')) return JSON.parse(raw)
          return Object.defineProperty([], 'filter', {
            get() {
              events.push('filter-get')
              if (fault === 'filter-get') throw failure
              return () => {
                events.push('filter-call')
                throw failure
              }
            },
          })
        }
      },
    })
    if (typeof reader !== 'function') throw new Error('decoder caller is not callable')
    const read = (raw: string): unknown => {
      events.length = 0
      return reader(
        Object.defineProperty({}, field, {
          get() {
            events.push('row-get')
            if (fault === 'row-get') throw failure
            return raw
          },
        }),
      )
    }
    for (const input of inputs) {
      const result = read(input.raw)
      expect(result).toEqual(input.expected)
      expect(events).toEqual(['row-get', 'parse-get', 'parse-call'])
      observations.push({ field, raw: input.raw, result, events: [...events] })
    }
    for (const raw of ['[]', '["kept"]']) {
      const first = read(raw)
      const second = read(raw)
      expect(second).toEqual(first)
      expect(second).not.toBe(first)
      expect(second).not.toBeInstanceOf(Promise)
      observations.push({ field, raw, first, second, fresh: first !== second })
    }
    fault = 'row-get'
    let escaped: unknown
    try {
      read('[]')
    } catch (error) {
      escaped = error
    }
    expect(escaped).toBe(failure)
    expect(events).toEqual(['row-get'])
    observations.push({
      field,
      fault,
      escaped,
      sameError: escaped === failure,
      events: [...events],
    })
    for (const nextFault of ['parse-get', 'parse-call', 'filter-get', 'filter-call']) {
      fault = nextFault
      const result = read('[]')
      expect(result).toEqual([])
      const expectedEvents = ['row-get', 'parse-get', 'parse-call', 'filter-get', 'filter-call']
      expect(events).toEqual(expectedEvents.slice(0, expectedEvents.indexOf(fault) + 1))
      observations.push({ field, fault, result, events: [...events] })
    }
  }
  return observations
}

test('RFC-359 W49 persistence decoder preserves ordered values and catch boundaries', () => {
  checkStringDecoder(
    '../src/modules/resource-catalog/infrastructure/agentPersistence.ts',
    'decodeAgentReferenceIds',
    ['outputs'],
  )
})

test('RFC-359 W49 / W50 Intent and catalog use the ordered relation reader', () => {
  for (const file of [
    'aggregateAdapters/intentApplyResourcePorts.ts',
    'digitalEmployeeAgentTemplateCatalog.ts',
  ]) {
    const source = readFileSync(
      new URL(`../src/modules/resource-catalog/infrastructure/${file}`, import.meta.url),
      'utf8',
    )
    expect(source).toContain('load: createAgentDependencyReadPort(transaction).load')
    expect(source).not.toMatch(/decodeAgentReferenceIds\(row\.(?:dependsOn|mcp|plugins)\)/)
  }
  const reader = readFileSync(
    new URL(
      '../src/modules/resource-catalog/infrastructure/agentDependencyRead.ts',
      import.meta.url,
    ),
    'utf8',
  )
  expect(reader).toContain('tablesOf(db)')
  expect(reader).toContain('from(agentDependencies)')
  expect(reader).toContain('eq(agentDependencies.agentId, id)')
  expect(reader).toContain('orderBy(asc(agentDependencies.ordinal))')
  expect(reader).not.toMatch(/decodeAgentReferenceIds|JSON\.parse|\blike\s*\(/)
})

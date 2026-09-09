// RFC-359 W44: share dependency JSON decoding without moving either original
// row getter across its catch boundary. These are actual functions with pure read ports.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { parseAgentDependencyIds } from '../src/modules/resource-catalog/infrastructure/agentDependencyJson'
import { assertAgentDependencyTraversal } from '../src/modules/resource-catalog/infrastructure/agentDependencyTraversal'
import { ValidationError } from '../src/util/errors'

type Side = 'semantics' | 'package'
type RowLoader = (id: string) => Promise<readonly string[] | undefined>

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
      : ['uniqueStrings', 'stringArray', 'assertAgentDependencyGraph']
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
  readonly raw: string
  readonly rowError?: Error
  readonly parseLookupError?: Error
  readonly decode?: (raw: string) => unknown
  readonly hold?: Promise<void>
  readonly readError?: Error
}

function scenario(side: Side, control: Control) {
  const events: string[] = []
  const parsed: { id: string; value: readonly string[] | undefined }[] = []
  const queries: { id: string; columns: string[]; terminal: 'limit' | 'get' }[] = []
  const readErrors: { id: string; error: unknown }[] = []
  const table = { id: Symbol('agent-id'), dependsOn: Symbol('agent-dependencies') }
  const transaction = {
    select(projection: Record<string, unknown>) {
      const columns = Object.keys(projection)
      for (const column of columns) {
        if (projection[column] !== table[column as keyof typeof table]) {
          throw new Error('original projection changed')
        }
      }
      return {
        from(received: unknown) {
          if (received !== table) throw new Error('original table changed')
          return {
            where(condition: { column: unknown; id: string }) {
              if (condition.column !== table.id) throw new Error('original equality changed')
              const load = async () => {
                events.push(`read:${condition.id}`)
                if (condition.id === 'loaded' && control.hold !== undefined) await control.hold
                if (condition.id === 'loaded' && control.readError !== undefined) {
                  throw control.readError
                }
                return {
                  id: condition.id,
                  get dependsOn() {
                    events.push(`row-get:${condition.id}`)
                    if (condition.id === 'loaded' && control.rowError !== undefined) {
                      throw control.rowError
                    }
                    return condition.id === 'loaded' ? control.raw : '[]'
                  },
                }
              }
              return {
                async limit(count: number) {
                  if (count !== 1) throw new Error('original limit changed')
                  queries.push({ id: condition.id, columns, terminal: 'limit' })
                  return [await load()]
                },
                get() {
                  queries.push({ id: condition.id, columns, terminal: 'get' })
                  return load()
                },
              }
            },
          }
        },
      }
    },
  }
  const owner = loadActualOwner(side, {
    agents: table,
    eq: (column: unknown, id: string) => ({ column, id }),
    ValidationError,
    parseAgentDependencyIds,
    JSON: {
      get parse() {
        events.push('parse-get')
        if (control.parseLookupError !== undefined) throw control.parseLookupError
        return (raw: string) => {
          events.push('parse-call')
          return control.decode === undefined ? JSON.parse(raw) : control.decode(raw)
        }
      },
    },
    assertAgentDependencyTraversal: (id: string, roots: readonly string[], read: RowLoader) =>
      assertAgentDependencyTraversal(id, roots, async (dependencyId) => {
        try {
          const value = await read(dependencyId)
          parsed.push({ id: dependencyId, value })
          return value
        } catch (error) {
          readErrors.push({ id: dependencyId, error })
          throw error
        }
      }),
  })
  return {
    run: () => owner(transaction, 'candidate', ['loaded']),
    events,
    parsed,
    queries,
    readErrors,
    side,
    raw: control.raw,
  }
}

for (const side of ['semantics', 'package'] as const) {
  describe(`RFC-359 W44 dependency JSON ${side}`, () => {
    test('the actual loader retains string order, duplicates, empty strings and parse fallbacks', async () => {
      const inputs: { raw: string; expected: string[] }[] = [
        {
          raw: '["leaf","leaf","",null,2,false,{},[],"tail"]',
          expected: ['leaf', 'leaf', '', 'tail'],
        },
        { raw: '["雪","é"]', expected: ['雪', 'é'] },
        { raw: '[]', expected: [] },
        { raw: 'null', expected: [] },
        { raw: '{}', expected: [] },
        { raw: '"scalar"', expected: [] },
        { raw: '17', expected: [] },
        { raw: 'false', expected: [] },
        { raw: '', expected: [] },
        { raw: '[invalid', expected: [] },
      ]
      for (const input of inputs) {
        const s = scenario(side, input)
        await s.run()
        expect(s.parsed[0]?.value).toEqual(input.expected)
        expect(s.queries[0]).toEqual({
          id: 'loaded',
          columns: side === 'semantics' ? ['dependsOn'] : ['id', 'dependsOn'],
          terminal: side === 'semantics' ? 'limit' : 'get',
        })
      }
    })

    test('the row getter keeps its original position relative to the parse catch', async () => {
      const originalError = new Error('controlled row getter failure')
      const s = scenario(side, { raw: '[]', rowError: originalError })
      if (side === 'semantics') {
        await s.run()
        expect(s.parsed[0]?.value).toEqual([])
        expect(s.events).toEqual(['read:loaded', 'parse-get', 'row-get:loaded'])
      } else {
        await expect(s.run()).rejects.toBe(originalError)
        expect(s.events).toEqual(['read:loaded', 'row-get:loaded'])
      }
    })

    test('parse lookup, execution and filter errors keep the original empty-array fallback', async () => {
      const error = new Error('controlled decode failure')
      const values: unknown[] = []
      Object.defineProperty(values, 'filter', {
        get() {
          throw error
        },
      })
      const controls: Control[] = [
        { raw: '[]', parseLookupError: error },
        {
          raw: '[]',
          decode: () => {
            throw error
          },
        },
        { raw: '[]', decode: () => values },
      ]
      for (const [index, control] of controls.entries()) {
        const s = scenario(side, control)
        await s.run()
        expect(s.parsed[0]?.value).toEqual([])
        if (index === 0) {
          expect(s.events).toEqual(
            side === 'semantics'
              ? ['read:loaded', 'parse-get']
              : ['read:loaded', 'row-get:loaded', 'parse-get'],
          )
        }
      }
    })

    test('the original transaction read remains awaited and rejects with the same error', async () => {
      let release!: () => void
      const hold = new Promise<void>((resolve) => {
        release = resolve
      })
      const s = scenario(side, { raw: '[]', hold })
      let completed = false
      const running = s.run().then(() => {
        completed = true
      })
      try {
        expect(completed).toBe(false)
        expect(s.events).toEqual(['read:loaded'])
        expect(s.parsed).toEqual([])
      } finally {
        release()
        await running
      }
      expect(s.parsed[0]?.value).toEqual([])
      const error = new Error('controlled read rejection')
      const rejected = scenario(side, { raw: '[]', readError: error })
      await expect(rejected.run()).rejects.toBe(error)
      expect(rejected.events).toEqual(['read:loaded'])
    })
  })
}

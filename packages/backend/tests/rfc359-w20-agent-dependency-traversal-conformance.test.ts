// RFC-359 AC1: two save-time Agent dependency walks duplicated the same DFS.
// Preserve their caller-owned root normalization and SQL while sharing the
// traversal. Pure scheduling cases and real transactional readers are separate.
import { createAgentDependencyReadPort } from '@/modules/resource-catalog/infrastructure/agentDependencyRead'
import { agentFixture, patchAgentFixture, readAgentFixtures } from './helpers/model'
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { inArray } from 'drizzle-orm'
import ts from 'typescript'
import { CreateAgentSchema } from '@agent-workflow/shared'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { assertAgentDependencyGraph } from '@/modules/resource-catalog/domain/agentDependencies'
import { createAgentPersistenceValues } from '@/modules/resource-catalog/infrastructure/agentPersistence'
import { describeEachProvider } from './helpers/eachProvider'

// RFC-395 II-a：生产直接调用领域函数 assertAgentDependencyGraph；本套件的历史输入经这层薄适配
// 对拍同一个领域实现（原 resource-catalog/infrastructure/agentDependencyTraversal.ts 仅供本套件，已删除）。
async function assertAgentDependencyTraversal(
  candidateId: string,
  roots: readonly string[],
  loadDependencies: (id: string) => Promise<readonly string[] | undefined>,
): Promise<void> {
  await assertAgentDependencyGraph({
    candidateId,
    dependencies: [],
    roots,
    load: loadDependencies,
    semantics: 'catalog',
  })
}

const OWNER = 'agent-traversal-owner'
const IDS = ['traversal-a', 'traversal-b', 'traversal-leaf']
type QueryShape = 'limited-array' | 'single-row'

function rowReader(db: PersistenceDb, shape: QueryShape, observed: string[]) {
  const reader = createAgentDependencyReadPort(
    db,
    shape === 'limited-array' ? 'semantics' : 'package',
  )
  return async (id: string): Promise<readonly string[] | undefined> => {
    observed.push(id)
    return reader.load(id)
  }
}

async function insertGraph(db: PersistenceDb, rows: Readonly<Record<string, string>>) {
  for (const [id, dependsOn] of Object.entries(rows)) {
    await agentFixture(db, {
      ...createAgentPersistenceValues({
        id,
        agent: CreateAgentSchema.parse({ name: id }),
        ownerUserId: OWNER,
        now: 1,
      }),
      dependsOn,
    })
  }
}

describe('ordered Agent dependency traversal', () => {
  test('a diamond reads each completed node once in the original root and child order', async () => {
    const graph = new Map([
      ['a', ['leaf']],
      ['b', ['leaf']],
      ['leaf', []],
    ])
    const observed: string[] = []
    await assertAgentDependencyTraversal('candidate', ['b', 'a', 'b'], async (id) => {
      observed.push(id)
      return graph.get(id)
    })
    expect(observed).toEqual(['b', 'leaf', 'a'])
  })

  for (const fixture of [
    { name: 'reaching the candidate', rows: [['a', ['candidate']]] },
    {
      name: 'a cycle below the candidate',
      rows: [
        ['a', ['b']],
        ['b', ['a']],
      ],
    },
  ] satisfies readonly { name: string; rows: [string, string[]][] }[]) {
    test(`${fixture.name} rejects before reading the repeated node`, async () => {
      const graph = new Map(fixture.rows)
      const observed: string[] = []
      await expect(
        assertAgentDependencyTraversal('candidate', ['a', 'later'], async (id) => {
          observed.push(id)
          return graph.get(id)
        }),
      ).rejects.toMatchObject({
        code: 'agent-dependency-cycle',
        message: 'agent dependency graph contains a cycle',
        status: 422,
        details: undefined,
      })
      expect(observed).toEqual(fixture.rows.map(([id]) => id))
    })
  }

  for (const roots of [['missing-z', 'missing-a'], ['a']] as const) {
    test(`the first missing node from ${roots[0]} keeps the original diagnostic`, async () => {
      const observed: string[] = []
      await expect(
        assertAgentDependencyTraversal('candidate', roots, async (id) => {
          observed.push(id)
          return id === 'a' ? ['missing-z', 'missing-a'] : undefined
        }),
      ).rejects.toMatchObject({
        code: 'agent-dependency-not-found',
        message: "agent dependency 'missing-z' not found",
        status: 422,
        details: { notFound: ['missing-z'] },
      })
      expect(observed).toEqual(roots[0] === 'a' ? ['a', 'missing-z'] : ['missing-z'])
    })
  }

  test('a pending reader settles before descendants, later roots and completion', async () => {
    const pending = Promise.withResolvers<readonly string[]>()
    const observed: string[] = []
    let completed = false
    const running = assertAgentDependencyTraversal('candidate', ['a', 'b'], async (id) => {
      observed.push(id)
      return id === 'a' ? pending.promise : []
    }).then(() => {
      completed = true
    })
    expect(observed).toEqual(['a'])
    expect(completed).toBe(false)
    pending.resolve(['leaf'])
    await running
    expect(observed).toEqual(['a', 'leaf', 'b'])
    expect(completed).toBe(true)
  })

  test('a reader rejection keeps the original error identity and stops later reads', async () => {
    const pending = Promise.withResolvers<readonly string[]>()
    const sentinel = new Error('the original query failure')
    const observed: string[] = []
    const running = assertAgentDependencyTraversal('candidate', ['a', 'b'], async (id) => {
      observed.push(id)
      return pending.promise
    })
    const rejection = running.catch((error: unknown) => error)
    pending.reject(sentinel)
    expect(await rejection).toBe(sentinel)
    expect(observed).toEqual(['a'])
  })

  test('both save wrappers retain their root and SQL mechanisms around the shared traversal', () => {
    const infrastructure = join(import.meta.dir, '../src/modules/resource-catalog/infrastructure')
    const printer = ts.createPrinter({ removeComments: true })
    const functionBody = (path: string, name: string) => {
      const source = ts.createSourceFile(
        path,
        readFileSync(join(infrastructure, path), 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      )
      const declaration = source.statements.find(
        (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name,
      )
      if (
        declaration === undefined ||
        !ts.isFunctionDeclaration(declaration) ||
        !declaration.body
      ) {
        throw new Error(`missing ${name}`)
      }
      return printer.printNode(ts.EmitHint.Unspecified, declaration.body, source)
    }
    const semantics = functionBody('agentPersistenceSemantics.ts', 'assertDependencyGraph')
    const packageArm = functionBody(
      'aggregateAdapters/postgresqlResourcePackageMutationArms.ts',
      'assertAgentDependencyGraph',
    )
    expect(semantics).toContain('roots: unique(dependencyIds)')
    expect(packageArm).toContain('roots: uniqueStrings(dependencyIds)')
    expect(semantics).toContain("createAgentDependencyReadPort(transaction, 'semantics').load")
    expect(packageArm).toContain("createAgentDependencyReadPort(transaction, 'package').load")
    for (const body of [semantics, packageArm]) {
      expect(body).toContain('await validateDependencyGraph(')
      expect(body).toContain("semantics: 'catalog'")
      expect(body).not.toMatch(/new Set|function visit/)
    }
    const domain = readFileSync(join(infrastructure, '../domain/agentDependencies.ts'), 'utf8')
    expect(domain.indexOf("'agent-dependency-self'")).toBeLessThan(
      domain.indexOf('async function visit'),
    )
    const reader = functionBody('agentDependencyRead.ts', 'createAgentDependencyReadPort')
    expect(reader).toContain('{ dependsOn: agents.dependsOn }')
    expect(reader).toContain('{ id: agents.id, dependsOn: agents.dependsOn }')
    expect(reader).toContain('.limit(1))[0]')
    expect(functionBody('agentPersistenceSemantics.ts', 'unique')).toContain(
      'new Set(values.filter((value) => value.length > 0))',
    )
    expect(
      functionBody('aggregateAdapters/postgresqlResourcePackageMutationArms.ts', 'uniqueStrings'),
    ).toContain('new Set(values)')
  })
})

describeEachProvider('Agent dependency traversal uses the caller transaction', (harness) => {
  beforeEach(async () => {
    const { users } = tablesOf(harness.db)
    await insertOne(harness.db, users, {
      id: OWNER,
      username: OWNER,
      displayName: OWNER,
      createdAt: 1,
      updatedAt: 1,
    })
  })

  for (const shape of ['limited-array', 'single-row'] as const) {
    test(`${shape}: pending rows are visible to the complete traversal and roll back with the caller`, async () => {
      const sentinel = new Error('abort the caller transaction')
      await expect(
        harness.session.transaction(async (tx) => {
          await insertGraph(tx, {
            'traversal-a': '["traversal-leaf"]',
            'traversal-b': '["traversal-leaf"]',
            'traversal-leaf': '[]',
          })
          const observed: string[] = []
          const recording = harness.recordStatements()
          try {
            await assertAgentDependencyTraversal(
              'candidate',
              ['traversal-b', 'traversal-a', 'traversal-b'],
              rowReader(tx, shape, observed),
            )
          } finally {
            recording.stop()
          }
          expect(observed).toEqual(['traversal-b', 'traversal-leaf', 'traversal-a'])
          const reads = recording
            .selects()
            .filter((statement) => statement.sql.includes('"agents"'))
          expect(reads.map((statement) => statement.rows)).toEqual([1, 1, 1])
          expect(reads.map((statement) => [...statement.values])).toEqual(
            observed.map((id) => [id, 1]),
          )
          for (const read of reads) {
            if (shape === 'limited-array') {
              expect(read.sql).toMatch(/select\s+"depends_on"\s+from/i)
              expect(read.sql).toMatch(/\blimit\b/i)
            } else {
              expect(read.sql).toMatch(/select\s+"id",\s*"depends_on"\s+from/i)
              expect(read.sql).toMatch(/\blimit\b/i)
            }
          }
          const { agents } = tablesOf(tx)
          expect(
            await tx
              .select({ id: agents.id })
              .from(agents)
              .where(inArray(agents.id, IDS))
              .orderBy(agents.id),
          ).toEqual(IDS.map((id) => ({ id })))
          throw sentinel
        }),
      ).rejects.toBe(sentinel)
      expect(await readAgentFixtures(harness.db, { id: IDS })).toEqual([])
    })

    test(`${shape}: a nested missing row aborts the transaction after the original JSON fallback`, async () => {
      const observed: string[] = []
      await expect(
        harness.session.transaction(async (tx) => {
          await insertGraph(tx, {
            'traversal-a': '[null,1,false,"traversal-leaf"]',
            'traversal-leaf': '{',
          })
          const reader = rowReader(tx, shape, observed)
          await assertAgentDependencyTraversal('candidate', ['traversal-a'], reader)
          expect(observed).toEqual(['traversal-a', 'traversal-leaf'])
          await patchAgentFixture(
            tx,
            { id: 'traversal-leaf' },
            { dependsOn: '["missing-z","missing-a"]' },
          )
          observed.length = 0
          await assertAgentDependencyTraversal('candidate', ['traversal-a'], reader)
        }),
      ).rejects.toMatchObject({
        code: 'agent-dependency-not-found',
        message: "agent dependency 'missing-z' not found",
        details: { notFound: ['missing-z'] },
      })
      expect(observed).toEqual(['traversal-a', 'traversal-leaf', 'missing-z'])
      expect(await readAgentFixtures(harness.db, { id: IDS })).toEqual([])
    })
  }
})

// RFC-359 AC1: two save-time Agent dependency walks duplicated the same DFS.
// Preserve their caller-owned root normalization and SQL while sharing the
// traversal. Pure scheduling cases and real transactional readers are separate.
import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq, inArray } from 'drizzle-orm'
import ts from 'typescript'
import { CreateAgentSchema } from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import { agents, users } from '@/db/schema'
import { assertAgentDependencyTraversal } from '@/modules/resource-catalog/infrastructure/agentDependencyTraversal'
import { createAgentPersistenceValues } from '@/modules/resource-catalog/infrastructure/agentPersistence'
import { describeEachProvider } from './helpers/eachProvider'

const OWNER = 'agent-traversal-owner'
const IDS = ['traversal-a', 'traversal-b', 'traversal-leaf']
type QueryShape = 'limited-array' | 'single-row'

function decodeDependencies(raw: string): readonly string[] {
  try {
    const value: unknown = JSON.parse(raw)
    return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === 'string')
      : []
  } catch {
    return []
  }
}

function rowReader(db: ProviderNeutralDatabase, shape: QueryShape, observed: string[]) {
  return async (id: string): Promise<readonly string[] | undefined> => {
    observed.push(id)
    if (shape === 'limited-array') {
      const row = (
        await db
          .select({ dependsOn: agents.dependsOn })
          .from(agents)
          .where(eq(agents.id, id))
          .limit(1)
      )[0]
      return row === undefined ? undefined : decodeDependencies(row.dependsOn)
    }
    const row = await db
      .select({ id: agents.id, dependsOn: agents.dependsOn })
      .from(agents)
      .where(eq(agents.id, id))
      .get()
    return row === undefined ? undefined : decodeDependencies(row.dependsOn)
  }
}

async function insertGraph(db: ProviderNeutralDatabase, rows: Readonly<Record<string, string>>) {
  for (const [id, dependsOn] of Object.entries(rows)) {
    await db.insert(agents).values({
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
    expect(semantics).toContain(
      'await assertAgentDependencyTraversal(candidateId, unique(dependencyIds), async (id) =>',
    )
    expect(packageArm).toContain(
      'await assertAgentDependencyTraversal(agentId, uniqueStrings(dependencyIds), async (id) =>',
    )
    for (const body of [semantics, packageArm]) {
      expect(body).toContain("'agent-dependency-self'")
      expect(body.indexOf("'agent-dependency-self'")).toBeLessThan(
        body.indexOf('await assertAgentDependencyTraversal'),
      )
      expect(body).not.toMatch(/new Set|function visit/)
    }
    expect(semantics).toContain('.select({ dependsOn: agents.dependsOn })')
    expect(semantics).toContain('.limit(1))[0]')
    expect(packageArm).toContain('.select({ id: agents.id, dependsOn: agents.dependsOn })')
    expect(packageArm).toContain('.get()')
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
    await harness.db.insert(users).values({
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
            observed.map((id) => (shape === 'limited-array' ? [id, 1] : [id])),
          )
          for (const read of reads) {
            if (shape === 'limited-array') {
              expect(read.sql).toMatch(/select\s+"depends_on"\s+from/i)
              expect(read.sql).toMatch(/\blimit\b/i)
            } else {
              expect(read.sql).toMatch(/select\s+"id",\s*"depends_on"\s+from/i)
              expect(read.sql).not.toMatch(/\blimit\b/i)
            }
          }
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
      expect(await harness.db.select().from(agents).where(inArray(agents.id, IDS))).toEqual([])
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
          await tx
            .update(agents)
            .set({ dependsOn: '["missing-z","missing-a"]' })
            .where(eq(agents.id, 'traversal-leaf'))
          observed.length = 0
          await assertAgentDependencyTraversal('candidate', ['traversal-a'], reader)
        }),
      ).rejects.toMatchObject({
        code: 'agent-dependency-not-found',
        message: "agent dependency 'missing-z' not found",
        details: { notFound: ['missing-z'] },
      })
      expect(observed).toEqual(['traversal-a', 'traversal-leaf', 'missing-z'])
      expect(await harness.db.select().from(agents).where(inArray(agents.id, IDS))).toEqual([])
    })
  }
})

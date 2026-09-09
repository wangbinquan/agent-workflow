import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { eq, SQL, StringChunk, sql } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { tasks, users, workflows } from '@/db/schema'
import {
  encodeCursor,
  parseTaskOperationsQuery,
  type TaskOperationsRawQuery,
} from '@/modules/task-execution/infrastructure/taskListPage/filters'
import { fastFilteredRootQuery } from '@/modules/task-execution/infrastructure/taskListPage/query'
import { describeEachProvider } from './helpers/eachProvider'

const VIEWER = { userId: 'w27-owner', canReadAllTasks: true }
const OPTIONS = { catalogVisibility: 'public' } as const
const GATE = `    fallback_gate AS MATERIALIZED (
      SELECT complete FROM prefix_complete WHERE complete = 0
    ),
`
const GATED_FROM = '      FROM fallback_gate CROSS JOIN matches m'
const ORIGINAL_FROM = '      FROM matches m'
const SOURCE_PATH = resolve(
  import.meta.dir,
  '../src/modules/task-execution/infrastructure/taskListPage/query.ts',
)

function restoreText(text: string): string {
  return text.replace(GATE, '').replace(GATED_FROM, ORIGINAL_FROM)
}

function originalQuery(query: SQL): SQL {
  let gates = 0
  let joins = 0
  const chunks = query.queryChunks.map((chunk) => {
    if (!(chunk instanceof StringChunk)) return chunk
    return new StringChunk(
      chunk.value.map((text) => {
        gates += text.split(GATE).length - 1
        joins += text.split(GATED_FROM).length - 1
        return restoreText(text)
      }),
    )
  })
  if (gates !== 1 || joins !== 1) throw new Error('missing exact fallback gate or join')
  return new SQL(chunks)
}

function inspectCte(query: SQL, end: string, select: string): SQL {
  const chunks: SQL['queryChunks'] = []
  for (const chunk of query.queryChunks) {
    if (!(chunk instanceof StringChunk)) {
      chunks.push(chunk)
      continue
    }
    for (const text of chunk.value) {
      const index = text.indexOf(end)
      if (index < 0) {
        chunks.push(new StringChunk(text))
        continue
      }
      chunks.push(new StringChunk(text.slice(0, index).replace(/,\s*$/, '\n') + select))
      return new SQL(chunks)
    }
  }
  throw new Error(`missing CTE boundary: ${end}`)
}

async function physicalRows(db: ProviderNeutralDatabase) {
  return {
    tasks: await db.all(sql`SELECT * FROM tasks ORDER BY id`),
    users: await db.all(sql`SELECT * FROM users ORDER BY id`),
    workflows: await db.all(sql`SELECT * FROM workflows ORDER BY id`),
  }
}

const METRICS = `SELECT
  (SELECT complete FROM prefix_complete) AS complete,
  (SELECT COUNT(*) FROM physical_prefix) AS physical_count,
  (SELECT COUNT(*) FROM prefix_page) AS prefix_page_count,
  (SELECT COUNT(*) FROM non_view_matches) AS non_view_count,
  (SELECT COUNT(*) FROM roots) AS root_count`

interface Opcode {
  addr: number
  opcode: string
  p1: number
  p2: number
  p3: number
  p4: string | null
  p5: number
}

let opcodeLookupSequence = 0

function missingOpcodeDiagnostic(
  program: readonly Opcode[],
  predicate: (row: Opcode) => boolean,
  sequence: number,
): string {
  return JSON.stringify({
    sequence,
    predicate: predicate.toString(),
    bunVersion: Bun.version,
    bunRevision: Bun.revision,
    platform: process.platform,
    architecture: process.arch,
    program: program.map((row) => ({
      addr: row.addr,
      opcode: row.opcode,
      p1: row.p1,
      p2: row.p2,
      p3: row.p3,
      p5: row.p5,
      p4:
        row.opcode === 'Explain'
          ? row.p4
          : {
              type: row.p4 === null ? 'null' : typeof row.p4,
              sha256: createHash('sha256')
                .update(JSON.stringify(row.p4) ?? 'undefined')
                .digest('hex'),
            },
    })),
  })
}

function opcode(program: readonly Opcode[], predicate: (row: Opcode) => boolean): Opcode {
  const sequence = ++opcodeLookupSequence
  const row = program.find(predicate)
  expect(
    row,
    row === undefined ? missingOpcodeDiagnostic(program, predicate, sequence) : undefined,
  ).toBeDefined()
  if (row === undefined) throw new Error('missing required SQLite control-flow instruction')
  return row
}

function checkGateProgram(program: readonly Opcode[], indexRootPage: number): void {
  const union = opcode(program, (row) => row.opcode === 'Explain' && row.p4 === 'UNION ALL')
  const materialize = opcode(
    program.slice(union.addr),
    (row) => row.opcode === 'Explain' && row.p4 === 'MATERIALIZE fallback_gate',
  )
  const gate = opcode(program.slice(materialize.addr), (row) => row.opcode === 'OpenEphemeral')
  const scan = opcode(
    program.slice(union.addr),
    (row) => row.opcode === 'Explain' && row.p4 === 'SCAN fallback_gate',
  )
  const rewind = opcode(program, (row) => row.addr === scan.addr + 1)
  expect(rewind.opcode).toBe('Rewind')
  expect(rewind.p1).toBe(gate.p1)
  const index = opcode(
    program.slice(union.addr, rewind.addr),
    (row) => row.opcode === 'OpenRead' && row.p2 === indexRootPage,
  )
  const seek = opcode(
    program.slice(rewind.addr),
    (row) => row.opcode.startsWith('Seek') && row.p1 === index.p1,
  )
  const next = opcode(
    program.slice(seek.addr),
    (row) => row.opcode === 'Next' && row.p1 === index.p1,
  )
  const gateNext = opcode(
    program.slice(next.addr),
    (row) => row.opcode === 'Next' && row.p1 === gate.p1,
  )
  expect(rewind.addr).toBeLessThan(seek.addr)
  expect(seek.addr).toBeLessThan(next.addr)
  expect(next.addr).toBeLessThan(gateNext.addr)
  expect(gateNext.addr).toBeLessThan(rewind.p2)
  expect(gateNext.p2).toBeGreaterThan(rewind.addr)
  expect(gateNext.p2).toBeLessThan(seek.addr)

  // A pre-gate auxiliary scan is a skipped definition; its calls stay in the loop.
  for (const jump of program.slice(union.addr, rewind.addr)) {
    if (jump.opcode !== 'Goto' || jump.p2 <= jump.addr) continue
    const definition = program.slice(jump.addr + 1, jump.p2)
    if (!definition.some((row) => row.opcode.startsWith('Seek'))) continue
    const calls = program.filter((row) => row.opcode === 'Gosub' && row.p2 === jump.addr + 1)
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(call.addr).toBeGreaterThan(rewind.addr)
      expect(call.addr).toBeLessThan(rewind.p2)
    }
  }
}

interface FixtureRow {
  id: string
  root?: string | null
  parent?: string | null
  startedAt: number
  name?: string
}
function roots(count = 16): FixtureRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `root-${String(i).padStart(2, '0')}`,
    startedAt: 1000 - i * 10,
  }))
}
async function seed(db: ProviderNeutralDatabase, rows: readonly FixtureRow[]): Promise<void> {
  await db.insert(users).values({
    id: VIEWER.userId,
    username: VIEWER.userId,
    displayName: 'W27 fixture',
    role: 'admin',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
  })
  await db.insert(workflows).values({
    id: 'w27-workflow',
    name: 'W27 workflow',
    definition: '{ "fixture": true }',
    createdAt: 1,
    updatedAt: 1,
  })
  for (const row of rows) {
    const family = row.root === undefined ? row.id : row.root
    await db.insert(tasks).values({
      id: row.id,
      name: row.name ?? 'match',
      workflowId: 'w27-workflow',
      workflowSnapshot: '{ "v" : 1 }',
      inputs: '{ "raw" : [1, null] }',
      repoPath: '/fixture/percent%_repo',
      worktreePath: `/fixture/${row.id}`,
      baseBranch: 'main',
      branch: `task/${row.id}`,
      status: 'done',
      startedAt: row.startedAt,
      finishedAt: row.startedAt + 5,
      parentTaskId: null,
      rootTaskId: family,
      branchStartedAt: row.startedAt,
      executionLineageId: family ?? row.id,
      lineageSlotPathJson: JSON.stringify([
        {
          stableNodeKey: 'task-root',
          frozenOccurrenceKey: family ?? row.id,
          workflowRevision: null,
        },
      ]),
      ownerUserId: VIEWER.userId,
      launchOrigin: 'manual',
      catalogVisibility: 'public',
      repoCount: 1,
    })
  }
  // Establish cycles after every FK target exists. Insert triggers fill NULL
  // roots, so also set intended root bytes explicitly on both real providers.
  for (const row of rows) {
    await db
      .update(tasks)
      .set({
        parentTaskId: row.parent ?? null,
        rootTaskId: row.root === undefined ? row.id : row.root,
      })
      .where(eq(tasks.id, row.id))
  }
}

const CASES = [
  {
    name: 'complete prefix skips fallback on the first page',
    raw: { limit: '2', q: 'match', subject: 'workflow' },
    complete: 1,
    facets: 24,
    rootCount: 12,
    ids: ['root-00', 'root-01', 'root-02'],
  },
  {
    name: 'complete prefix skips fallback after a near cursor',
    raw: { limit: '2', q: 'match', subject: 'workflow' },
    cursor: { branchStartedAt: 990, taskId: 'root-01' },
    complete: 1,
    facets: 24,
    rootCount: 12,
    ids: ['root-02', 'root-03', 'root-04'],
  },
  {
    name: 'incomplete prefix retains fallback after a deep cursor',
    raw: { limit: '2', q: 'match', subject: 'workflow' },
    cursor: { branchStartedAt: 820, taskId: 'root-18' },
    complete: 0,
    facets: 24,
    rootCount: 24,
    ids: ['root-19', 'root-20', 'root-21'],
  },
  {
    name: 'incomplete prefix retains sparse matching rows',
    raw: { limit: '2', q: 'sparse', subject: 'workflow' },
    complete: 0,
    facets: 3,
    rootCount: 3,
    ids: ['root-18', 'root-20', 'root-22'],
  },
  {
    name: 'incomplete prefix retains the empty-page facet row',
    raw: { limit: '2', q: 'absent', subject: 'workflow' },
    complete: 0,
    facets: 0,
    rootCount: 0,
    ids: [null],
  },
] as const

describeEachProvider('RFC-359 W39 fallback gate preserves the complete task query', (harness) => {
  for (const entry of CASES) {
    test(entry.name, async () => {
      const db = harness.db
      const fixture = roots(24)
      for (const index of [18, 20, 22]) {
        const row = fixture[index]
        if (row === undefined) throw new Error('missing bounded fixture row')
        row.name = 'match sparse'
      }
      await seed(db, fixture)
      const initial = await physicalRows(db)
      const raw: TaskOperationsRawQuery = { ...entry.raw }
      if ('cursor' in entry) {
        const initialQuery = parseTaskOperationsQuery(VIEWER, raw, OPTIONS)
        raw.cursor = encodeCursor({
          v: 1,
          ...entry.cursor,
          filterFingerprint: initialQuery.filterFingerprint,
        })
      }
      const parsed = parseTaskOperationsQuery(VIEWER, raw, OPTIONS)
      const candidate = fastFilteredRootQuery(db, VIEWER, parsed, OPTIONS.catalogVisibility)
      const original = originalQuery(candidate)
      const recording = harness.recordStatements()
      let originalRows: Record<string, unknown>[]
      let candidateRows: Record<string, unknown>[]
      try {
        originalRows = await db.all<Record<string, unknown>>(original)
        candidateRows = await db.all<Record<string, unknown>>(candidate)
      } finally {
        recording.stop()
      }
      expect(recording.statements).toHaveLength(2)
      const before = recording.statements[0]
      const after = recording.statements[1]
      if (before === undefined || after === undefined)
        throw new Error('missing actual query record')
      expect(candidateRows).toEqual(originalRows)
      expect(JSON.stringify(candidateRows)).toBe(JSON.stringify(originalRows))
      expect<readonly unknown[]>(candidateRows.map((row) => row.id)).toEqual(entry.ids)
      expect(Number(candidateRows[0]?.facet_all)).toBe(entry.facets)
      expect(restoreText(after.sql)).toBe(before.sql)
      expect(after.values).toEqual(before.values)
      expect(after.params).toBe(before.params)
      expect(after.rows).toBe(before.rows)
      expect(before.rows).toBe(originalRows.length)
      expect(after.sql.split(GATE)).toHaveLength(2)
      expect(after.sql.split(GATED_FROM)).toHaveLength(2)

      const boundary = '    page_roots AS MATERIALIZED ('
      const originalMetrics = await db.all<Record<string, unknown>>(
        inspectCte(original, boundary, METRICS),
      )
      const candidateMetrics = await db.all<Record<string, unknown>>(
        inspectCte(candidate, boundary, METRICS),
      )
      expect(candidateMetrics).toEqual(originalMetrics)
      expect(JSON.stringify(candidateMetrics)).toBe(JSON.stringify(originalMetrics))
      expect(candidateMetrics).toHaveLength(1)
      expect(Number(candidateMetrics[0]?.complete)).toBe(entry.complete)
      expect(Number(candidateMetrics[0]?.physical_count)).toBe(12)
      expect(Number(candidateMetrics[0]?.non_view_count)).toBe(entry.facets)
      expect(Number(candidateMetrics[0]?.root_count)).toBe(entry.rootCount)
      const gateRows = await db.all(
        inspectCte(
          candidate,
          '    roots AS NOT MATERIALIZED (',
          'SELECT complete FROM fallback_gate',
        ),
      )
      expect(gateRows).toEqual(entry.complete === 1 ? [] : [{ complete: 0 }])

      // VM control is SQLite-specific; both providers execute every behavior assertion above.
      if (harness.applicationBinding.provider === 'sqlite') {
        const indexes = await db.all<{ rootpage: number }>(
          sql`SELECT rootpage FROM sqlite_schema WHERE type = 'index' AND name = 'idx_tasks_list_facets_cover'`,
        )
        expect(indexes).toHaveLength(1)
        const index = indexes[0]
        if (index === undefined) throw new Error('missing existing facet index')
        const program = await db.all<Opcode>(sql`EXPLAIN ${candidate}`)
        checkGateProgram(program, index.rootpage)
      }
      const final = await physicalRows(db)
      expect(final).toEqual(initial)
      expect(JSON.stringify(final)).toBe(JSON.stringify(initial))
    })
  }
})

test('the gate inverse retains the complete published W38 query source', () => {
  const source = readFileSync(SOURCE_PATH, 'utf8')
  expect(source.split(GATE)).toHaveLength(2)
  expect(source.split(GATED_FROM)).toHaveLength(2)
  expect(createHash('sha256').update(restoreText(source)).digest('hex')).toBe(
    '3e3b04a3d8517e92abec73abaea0ffe6300e513251df480249ff2d893a248a1f',
  )
})

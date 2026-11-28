// RFC-626 T14: static guards for the release-matrix resolution seeds and their hand-written oracle
// (fixtures/release-upgrade/rfc626/). Runs without a database. Locks that every seed is curated,
// describes only state a v0.19.2 database could hold (known tables, known columns, clones of
// released-ledger rows), has a test per provider, and that the oracle stays independent of the
// converter (CLAUDE.md「发版」: never derive an oracle from the converter's output) while naming the
// same twelve validation checks, eleven probes and task-stop reasons as the product.
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { persistenceHead } from '@/bootstrap/persistenceHead'
import { taskStopProjection } from '@/modules/task-execution/domain/sourceTermination'
import { frozenEpoch1Contract } from '@/platform/persistence/migration/epoch1/contract'
import { VALIDATION_CHECKS } from '@/platform/persistence/migration/run/types'
import { readRegistry, REPO_ROOT, sha256 } from '../../../scripts/release-upgrade/lib/io'
import type { Json } from '../../../scripts/release-upgrade/lib/model'
import { readSeed, SEEDS } from '../../../scripts/release-upgrade/lib/seed-ledger'
import {
  mismatch,
  oracleKey,
  readOverlay,
  readResolutionOracle,
  RFC626_FIXTURES,
  type OverlaySeed,
} from './helpers/releaseUpgrade/rfc626'

const oracle = readResolutionOracle()
const scenarios = Object.keys(oracle.scenarios).sort()
const seeds = new Map<string, OverlaySeed>(scenarios.map((name) => [name, readOverlay(name)]))
const release = readRegistry().releases.find((entry) => entry.tag === 'v0.19.2')!
const EXECUTABLE = ['pending', 'running', 'awaiting_review', 'awaiting_human', 'interrupted']
const CANCELABLE = ['pending', 'running', 'awaiting_review', 'awaiting_human']
const CROCKFORD_ID = /^01K3986260[0-9A-HJKMNP-TV-Z]{16}$/

/** Every string identity the released v0.19.2 ledger inserts (its own seeds, 0000-0258). */
const ledgerValues = new Set<string>(
  release.epoch1!.sqlite.flatMap((receipt) =>
    readSeed(join(SEEDS, 'epoch1', `${receipt.tag}.json`), 1, receipt.tag).rows.flatMap((row) =>
      Object.values(row.values).filter((value): value is string => typeof value === 'string'),
    ),
  ),
)

function walk(value: Json, visit: (token: string, argument: Json) => void): void {
  if (Array.isArray(value)) value.forEach((entry) => walk(entry, visit))
  else if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value)
    if (keys.length === 1 && keys[0]!.startsWith('$')) visit(keys[0]!, value[keys[0]!]!)
    for (const entry of Object.values(value)) walk(entry, visit)
  }
}

describe('RFC-626 resolution seeds', () => {
  test('one seed file per oracle scenario, and nothing else in the fixture directory', () => {
    const files = readdirSync(RFC626_FIXTURES)
      .filter((file) => file !== 'oracle.json')
      .sort()
    expect(files).toEqual(scenarios.map((name) => `${name}.json`).sort())
    for (const name of scenarios) expect(oracle.scenarios[name]!.seed).toBe(`${name}.json`)
  })

  for (const name of scenarios)
    test(`${name}: curated rows a v0.19.2 database can hold`, () => {
      const seed = seeds.get(name)!
      expect(seed.providers.length).toBeGreaterThan(0)
      expect(seed.provenance.sources.length).toBeGreaterThan(0)
      const created = new Set<string>()
      for (const row of seed.rows) {
        expect(row.why.length).toBeGreaterThan(0)
        for (const provider of row.providers ?? []) expect(seed.providers).toContain(provider)
        const table = frozenEpoch1Contract.tables.find((entry) => entry.id === row.table)
        expect(table, `${name}: ${row.table} is an epoch-1 table`).toBeDefined()
        const known = new Set(table!.columns.map((column) => column.name))
        for (const column of [...Object.keys(row.values), ...Object.keys(row.replace ?? {})])
          expect(known.has(column), `${name}: ${row.table}.${column}`).toBe(true)
        if (row.op === 'clone') {
          expect(row.from && Object.keys(row.from).length).toBeTruthy()
          for (const value of Object.values(row.from!))
            if (typeof value === 'string')
              expect(
                ledgerValues.has(value) || created.has(value),
                `${name}: ${row.table} clones a released-ledger or earlier overlay row (${value})`,
              ).toBe(true)
        } else expect(row.from ?? row.replace).toBeUndefined()
        for (const [column, value] of Object.entries(row.values))
          if (typeof value === 'string' && value.startsWith('01K3986260') && value.length === 26) {
            expect(value, `${name}: ${row.table}.${column} id shape`).toMatch(CROCKFORD_ID)
            expect(ledgerValues.has(value), `${name}: ${value} is new`).toBe(false)
            created.add(value)
          }
      }
      for (const file of seed.content ?? []) {
        expect(file.path.startsWith('/') || file.path.split('/').includes('..')).toBe(false)
        if (file.sha256 !== undefined)
          expect(sha256(Buffer.from(file.utf8, 'utf8'))).toBe(file.sha256)
      }
      for (const path of [
        ...(seed.removeContent ?? []),
        ...(seed.worktrees ?? []).flatMap((entry) => [entry.path, entry.repository]),
      ])
        expect(path.startsWith('/') || path.split('/').includes('..')).toBe(false)
    })

  test('every scenario has exactly one test file per provider of its seed', () => {
    const dir = import.meta.dir
    const files = readdirSync(dir).filter((file) =>
      /^rfc626-release-upgrade-.*\.test\.ts$/.test(file),
    )
    const registered = files.flatMap((file) =>
      [
        ...readFileSync(join(dir, file), 'utf8').matchAll(
          /^registerResolutionCase\('([^']+)', '(sqlite|postgresql)'/gm,
        ),
      ].map((match) => `${match[1]}/${match[2]}`),
    )
    expect(registered.sort()).toEqual(
      scenarios.flatMap((name) => seeds.get(name)!.providers.map((p) => `${name}/${p}`)).sort(),
    )
  })
})

describe('RFC-626 resolution oracle', () => {
  test('names the conversion validation: twelve checks and the eleven read-only probes', () => {
    expect([...oracle.validation.checks].sort()).toEqual([...VALIDATION_CHECKS].sort())
    expect(oracle.validation.checks).toHaveLength(12)
    const probeFiles = [
      'platform/content/migration/probes.ts',
      'modules/collaboration/infrastructure/migration/probes.ts',
      'modules/code-capability/infrastructure/migration/probes.ts',
      'modules/intent/infrastructure/migration/probes.ts',
      'modules/resource-catalog/infrastructure/migration/probes.ts',
      'modules/task-execution/infrastructure/runSelection/table/probes.ts',
      'modules/task-execution/infrastructure/migration/probes.ts',
    ]
    const declared = new Set(
      probeFiles.flatMap((file) =>
        [
          ...readFileSync(join(REPO_ROOT, 'packages/backend/src', file), 'utf8').matchAll(
            /id: '([a-z-]+(?:\/[a-z-]+)?:[a-z-]+)'/g,
          ),
        ].map((match) => match[1]!),
      ),
    )
    expect([...oracle.validation.probes].sort()).toEqual([...declared].sort())
    expect(oracle.validation.probes).toHaveLength(11)
  })

  test('task-stop reasons are the single source of truth (design §3.2.4)', () => {
    expect(oracle.constants.endedByUpgrade).toEqual(taskStopProjection({ kind: 'upgrade' }))
    expect(oracle.constants.canceledByParent).toEqual(
      taskStopProjection({ kind: 'parent-cascade', parentTaskId: '01K3986260ST00000000000006' }),
    )
    const reasons = [
      taskStopProjection({ kind: 'upgrade' }),
      taskStopProjection({ kind: 'parent-cascade', parentTaskId: 'x' }),
    ]
    for (const name of scenarios)
      for (const row of oracle.scenarios[name]!.rows)
        if (row.table === 'tasks' && row.columns && typeof row.columns.error_summary === 'string')
          expect(
            [...reasons.map((reason) => reason.summary), 'daemon-restart'],
            `${name}: ${JSON.stringify(row.key)}`,
          ).toContain(row.columns.error_summary)
  })

  for (const name of scenarios)
    test(`${name}: settlements follow §3.2.1 / §3.2.3 and match the seed's old statuses`, () => {
      const scenario = oracle.scenarios[name]!
      const seed = seeds.get(name)!
      const ended = new Set(scenario.settlements.map((entry) => entry.taskId))
      for (const settlement of scenario.settlements) {
        const source = seed.rows.find(
          (row) => row.table === 'tasks' && row.values.id === settlement.taskId,
        )
        expect(source, `${name}: ended task ${settlement.taskId} is an overlay task`).toBeDefined()
        expect(source!.values.status).toBe(settlement.originalStatus)
        if (settlement.cause === 'parent-cascade') {
          expect(CANCELABLE).toContain(settlement.originalStatus)
          expect(settlement.blockCodesInclude).toEqual([])
          expect(ended.has(settlement.parentTaskId!)).toBe(true)
          expect(source!.values.parent_task_id).toBe(settlement.parentTaskId)
        } else {
          expect(EXECUTABLE).toContain(settlement.originalStatus)
          expect(settlement.blockCodesInclude.length).toBeGreaterThan(0)
          expect(settlement.parentTaskId).toBeNull()
        }
      }
      // An interrupted child of an ended parent is not cascaded (§3.2.3 expand).
      for (const row of seed.rows)
        if (
          row.table === 'tasks' &&
          typeof row.values.parent_task_id === 'string' &&
          ended.has(row.values.parent_task_id) &&
          !CANCELABLE.includes(String(row.values.status))
        )
          expect(ended.has(String(row.values.id))).toBe(false)
    })

  for (const name of scenarios)
    test(`${name}: oracle tokens resolve against the seed and the key orders`, () => {
      const scenario = oracle.scenarios[name]!
      const seed = seeds.get(name)!
      const paths = new Set((seed.content ?? []).map((file) => file.path))
      const sourceKey = (value: Json) =>
        walk(value, (token, argument) => {
          if (token !== '$key') return
          const [table, cells] = argument as [string, Json[]]
          const contract = frozenEpoch1Contract.tables.find((entry) => entry.id === table)
          expect(contract, `${name}: $key table ${table}`).toBeDefined()
          expect(cells).toHaveLength(contract!.migrationKey.length)
        })
      for (const entry of [
        ...scenario.rows,
        ...(scenario.dispositions ?? []),
        ...(scenario.records ?? []),
        ...(scenario.artifacts ?? []),
        ...(scenario.finalize ?? []),
      ])
        for (const provider of entry.providers ?? []) expect(seed.providers).toContain(provider)
      for (const entry of scenario.dispositions ?? []) sourceKey(entry.sourceKey)
      for (const entry of scenario.records ?? []) sourceKey(entry.payload)
      for (const entry of scenario.artifacts ?? []) sourceKey(entry.sourceKey)
      for (const entry of scenario.finalize ?? [])
        walk(entry.targetKey, (token, argument) => {
          if (token !== '$key') return
          const [table, cells] = argument as [string, Json[]]
          const definition = persistenceHead().contract.contract.tables.find(
            (candidate) => candidate.id === table,
          )
          expect(definition, `${name}: target table ${table}`).toBeDefined()
          expect(cells).toHaveLength(definition!.primaryKey.length)
        })
      const contentTokens = (value: Json) =>
        walk(value, (token, argument) => {
          if (token === '$sha256Of' || token === '$sizeOf')
            expect(paths.has(String(argument)), `${name}: ${String(argument)}`).toBe(true)
        })
      for (const entry of scenario.artifacts ?? []) contentTokens(entry.columns)
      for (const entry of scenario.rows) contentTokens(entry.columns ?? null)
      for (const entry of scenario.rows)
        expect(
          frozenEpoch1Contract.tables.some((table) => table.id === entry.table) ||
            persistenceHead().contract.contract.tables.some((table) => table.id === entry.table),
          `${name}: ${entry.table}`,
        ).toBe(true)
    })

  test('the seeds, oracle and their helpers never consult the converter', () => {
    const dir = import.meta.dir
    const sources = [
      join(dir, 'helpers/releaseUpgrade/rfc626.ts'),
      join(dir, 'helpers/releaseUpgrade/rfc626Operations.ts'),
      ...readdirSync(dir)
        .filter((file) => /^rfc626-release-upgrade-.*\.test\.ts$/.test(file))
        .map((file) => join(dir, file)),
    ]
    for (const file of sources)
      expect(readFileSync(file, 'utf8'), file).not.toMatch(
        /from '@\/platform\/persistence\/migration\/conversion/,
      )
    expect(oracle.authoring.converterExecuted).toBe(false)
    expect(oracle.authoring.conversionOutputUsed).toBe(false)
  })
})

describe('RFC-626 oracle matcher', () => {
  const ctx = { scenario: 'unit', seed: seeds.get('content')! }
  test('subset objects, exact arrays and literal values', () => {
    expect(mismatch({ a: 1, b: 'x' }, { a: 1 }, ctx)).toBeNull()
    expect(mismatch({ a: 1n }, { a: 1 }, ctx)).toBeNull()
    expect(mismatch({ a: 2 }, { a: 1 }, ctx)).toContain('.a')
    expect(mismatch([1, 2], [1], ctx)).toContain('expected 1 entries')
    expect(mismatch(null, { a: 1 }, ctx)).toContain('expected an object')
  })
  test('tokens', () => {
    expect(mismatch('x', { $notNull: true }, ctx)).toBeNull()
    expect(mismatch(null, { $notNull: true }, ctx)).toContain('expected a value')
    expect(mismatch('rfc165-x', { $startsWith: 'rfc165' }, ctx)).toBeNull()
    expect(mismatch('abc', { $includes: 'z' }, ctx)).toContain('does not include')
    expect(mismatch('b', { $oneOf: ['a', 'b'] }, ctx)).toBeNull()
    expect(mismatch('c', { $oneOf: ['a', 'b'] }, ctx)).toContain('is none of')
    expect(mismatch('{"a":{"b":1}}', { $json: { a: { b: 1 } } }, ctx)).toBeNull()
    expect(mismatch('not json', { $json: {} }, ctx)).toContain('not JSON')
    expect(mismatch([3, 1, 2], { $includesAll: [1, 2] }, ctx)).toBeNull()
    expect(mismatch([3], { $includesAll: [1] }, ctx)).toContain('missing')
    expect(mismatch(1778459600000, { $upgradeTime: true }, ctx)).toBeNull()
    expect(mismatch(1, { $upgradeTime: true }, ctx)).toContain('expected')
    const path = 'runs/01K3986260CN00000000000003/review/review/document/v1.md'
    const bytes = Buffer.from(ctx.seed.content!.find((file) => file.path === path)!.utf8, 'utf8')
    expect(mismatch(sha256(bytes), { $sha256Of: path }, ctx)).toBeNull()
    expect(mismatch(bytes.byteLength, { $sizeOf: path }, ctx)).toBeNull()
    expect(mismatch('p', { $source: 'col' }, { ...ctx, sourceRow: { col: 'p' } })).toBeNull()
    expect(() => mismatch('x', { $unknownToken: 1 }, ctx)).toThrow('unknown oracle token')
  })
  test('$key is the mk1 key of the listed cells', () => {
    const key = oracleKey(['tasks', ['t1']])
    expect(key.startsWith('mk1:')).toBe(true)
    expect(JSON.parse(key.slice(4))).toEqual(['tasks', [{ type: 'text', value: 't1' }]])
    expect(JSON.parse(oracleKey(['node_run_inputs', ['r1', 0]]).slice(4))).toEqual([
      'node_run_inputs',
      [
        { type: 'text', value: 'r1' },
        { type: 'integer', value: '0' },
      ],
    ])
    expect(mismatch(key, { $key: ['tasks', ['t1']] }, ctx)).toBeNull()
    expect(mismatch(key, { $key: ['tasks', ['t2']] }, ctx)).toContain('expected')
    expect(() => oracleKey(['tasks'])).toThrow('invalid $key')
  })
})

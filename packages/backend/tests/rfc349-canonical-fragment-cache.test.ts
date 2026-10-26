// Frozen epoch-1 artifact/operation protocol; native provider moves are covered by rfc349-database-migration-coordinator.integration.
// RFC-349 canonical JSON fragment cache (platform/persistence/schemaContract.ts).
//
// WHY THIS EXISTS: every digest in the PostgreSQL migration history is the SHA-256 of
// canonicalSchemaJson, and those digests are persisted in journals and manifests. The
// history replay now reuses fragments of tables shared between versions (one daemon
// boot replayed ~30 full contracts; postgresql-evidence 38613687770 and the macOS e2e
// daemon-ready timeouts on 6c576f8c8 were that cost). The cached path must therefore
// produce byte-identical text to the plain `JSON.stringify(canonicalize(v), null, 2)`
// path for every value — the real history and arbitrary JSON-like data alike.
import { describe, expect, test } from 'bun:test'
import { readPostgresqlMigrationHistoryPrefix } from '@/platform/persistence/migration/legacy/postgresqlMigrationHistory'
import {
  canonicalSchemaJson,
  createCanonicalFragmentCache,
  withCanonicalFragmentCache,
} from '@/platform/persistence/schemaContract'
import { resolvePostgresqlMigrationsFolder } from '@/util/migrationsFolder'

const cachedJson = (cache: ReturnType<typeof createCanonicalFragmentCache>, value: unknown) =>
  withCanonicalFragmentCache(cache, () => canonicalSchemaJson(value))

/** Deterministic pseudo-random generator so a failure reproduces. */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state / 2 ** 32
  }
}

const KEYS = ['b', 'a', 'B', 'A', '_z', 'Ä', 'ä', '10', '2', 'é', 'e', 'z_', 'ß', '中', '😀', '']
const STRINGS = ['', 'x', 'line\nbreak', 'quote"\\', '中文', '😀', '\u0000', 'tab\t']
const NUMBERS = [0, -0, 1, -1.5, 1e21, 2 ** 53, Number.NaN, Number.POSITIVE_INFINITY]

function generate(next: () => number, depth: number, shared: object[]): unknown {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!
  const roll = next()
  if (depth > 4 || roll < 0.3) {
    return pick<unknown>([
      null,
      true,
      false,
      undefined,
      ...STRINGS,
      ...NUMBERS,
      () => 'fn',
      Symbol('s'),
    ])
  }
  if (roll < 0.4 && shared.length > 0) return pick(shared)
  if (roll < 0.65) {
    const array = Array.from({ length: Math.floor(next() * 4) }, () =>
      generate(next, depth + 1, shared),
    )
    if (next() < 0.1) array.length += 1 // a hole
    shared.push(array)
    return array
  }
  const record: Record<string, unknown> = {}
  for (let index = Math.floor(next() * 5); index > 0; index -= 1) {
    record[pick(KEYS)] = generate(next, depth + 1, shared)
  }
  shared.push(record)
  return record
}

describe('RFC-349 canonical fragment cache', () => {
  test('the real migration history is written byte for byte the same', async () => {
    const history = await readPostgresqlMigrationHistoryPrefix({
      migrationsFolder: await resolvePostgresqlMigrationsFolder(),
    })
    const values: unknown[] = [
      history.root,
      ...history.steps,
      ...history.versions.flatMap((version) => [version.contract, version.plan, version]),
      // The same tables again at a different depth than inside their contract.
      ...history.head.contract.tables.slice(0, 5),
    ]
    const cache = createCanonicalFragmentCache()
    for (const value of values) {
      const plain = canonicalSchemaJson(value)
      expect(cachedJson(cache, value)).toBe(plain)
      expect(cachedJson(cache, value)).toBe(plain) // served from the cache
    }
  }, 60_000)

  test('arbitrary JSON-like values with shared parts match the plain path', () => {
    for (let seed = 1; seed <= 400; seed += 1) {
      const next = random(seed)
      const shared: object[] = []
      const value = {
        first: generate(next, 0, shared),
        second: generate(next, 0, shared),
        nested: { again: shared[0] ?? null, list: [shared[1] ?? null, shared[0] ?? null] },
      }
      const cache = createCanonicalFragmentCache()
      const plain = canonicalSchemaJson(value)
      expect(cachedJson(cache, value)).toBe(plain)
      for (const part of shared) expect(cachedJson(cache, part)).toBe(canonicalSchemaJson(part))
    }
  })

  test('objects with toJSON, empty containers and top-level primitives match', () => {
    const withToJson = { toJSON: () => ({ z: 1, a: [2, { c: 3 }] }), ignored: true }
    const values: unknown[] = [
      { outer: { inner: withToJson }, list: [withToJson] },
      { empty: {}, none: [], deep: [[], [{}]] },
      'text',
      12,
      null,
    ]
    const cache = createCanonicalFragmentCache()
    for (const value of values) expect(cachedJson(cache, value)).toBe(canonicalSchemaJson(value))
  })

  test('the cache is active only inside its scope and nesting restores the outer one', () => {
    const outer = createCanonicalFragmentCache()
    const inner = createCanonicalFragmentCache()
    const value = { a: { b: 1 } }
    withCanonicalFragmentCache(outer, () => {
      canonicalSchemaJson(value)
      withCanonicalFragmentCache(inner, () => canonicalSchemaJson(value.a))
      expect(inner.fragments.has(value.a)).toBe(true)
      canonicalSchemaJson({ c: 2 })
    })
    expect(outer.fragments.has(value)).toBe(true)
    const outside = { d: 3 }
    canonicalSchemaJson(outside)
    expect(outer.fragments.has(outside)).toBe(false)
    expect(inner.fragments.has(outside)).toBe(false)
  })
})

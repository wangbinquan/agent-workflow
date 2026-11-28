// RFC-626 §4.4 (design §7 "耗时与编排"): opening a content inventory builds its lookups once
// instead of scanning every listed file and root on each tree query (freezeInventory.ts used
// `manifest.files.some/filter` and `manifest.roots.some` per call). The index must answer
// exactly what those scans answered, in the same order, for captured (sorted) and arbitrary
// (unsorted) listings alike; the source assertions keep the scans from coming back.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createContentManifestIndex } from '@/platform/content/inventory/manifestIndex'
import { inventoryRelativePath } from '@/platform/content/inventory/resolvers'
import type { FreezeContentManifest } from '@/platform/persistence/migration/run/types'

function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}
const SEGMENTS = ['a', 'ab', 'a-b', 'a.b', 'b', 'B', 'skills', 'files', 'é', '𝄞', '技', '10', '9']

function listing(seed: number, count: number, sorted: boolean): FreezeContentManifest {
  const next = seeded(seed)
  const pick = <T>(values: readonly T[]) => values[Math.floor(next() * values.length)]!
  const paths = new Set<string>()
  for (let attempt = 0; paths.size < count && attempt < count * 20; attempt += 1)
    paths.add(Array.from({ length: 1 + Math.floor(next() * 4) }, () => pick(SEGMENTS)).join('/'))
  const ordered = [...paths]
  if (sorted) ordered.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  else
    for (let index = ordered.length - 1; index > 0; index -= 1) {
      const other = Math.floor(next() * (index + 1))
      ;[ordered[index], ordered[other]] = [ordered[other]!, ordered[index]!]
    }
  const home = '/home/aw'
  return {
    version: 1,
    roots: [
      home,
      ...[...new Set(ordered.map((path) => path.split('/').slice(0, -1).join('/')))]
        .filter((directory) => directory && next() < 0.5)
        .map((directory) => `${home}/${directory}`),
    ],
    files: ordered.map((path, index) => ({ path, size: index, mtimeMs: index * 10 })),
    objects: Array.from({ length: 5 }, (_, index) => ({
      id: `object-${index}`,
      present: index % 2 === 0,
      size: index % 2 === 0 ? index : null,
      sha256: index % 2 === 0 ? String(index).repeat(64).slice(0, 64) : null,
    })),
    databaseTrees: ['live', 'version:1', 'version:2'].map((tree, index) => ({
      skillId: `skill-${index % 2}`,
      tree,
      size: index,
      sha256: 'c'.repeat(64),
    })),
    digest: `sha256:${'0'.repeat(64)}`,
  }
}

function prefixes(manifest: FreezeContentManifest, seed: number): string[] {
  const next = seeded(seed)
  const result = new Set<string>(['', '/', 'a', 'a/', 'z/', '𝄞/', 'skills/files/'])
  for (const entry of manifest.files) {
    const parts = entry.path.split('/')
    for (let depth = 1; depth <= parts.length; depth += 1)
      result.add(`${parts.slice(0, depth).join('/')}/`)
    result.add(entry.path)
    result.add(entry.path.slice(0, Math.floor(next() * entry.path.length)))
  }
  return [...result]
}

for (const sorted of [true, false])
  test(`prefix and path lookups equal the linear scans over a ${sorted ? 'captured (sorted)' : 'shuffled'} listing`, () => {
    for (let seed = 1; seed <= 12; seed += 1) {
      const manifest = listing(seed, seed * 40, sorted)
      const index = createContentManifestIndex(manifest)
      for (const prefix of prefixes(manifest, seed)) {
        const scanned = manifest.files.filter((entry) => entry.path.startsWith(prefix))
        const found = index.filesUnder(prefix)
        expect(found).toEqual(scanned)
        // Same entry objects, in listing order.
        expect(found.every((entry, at) => entry === scanned[at])).toBe(true)
        expect(index.hasFilesUnder(prefix)).toBe(
          manifest.files.some((entry) => entry.path.startsWith(prefix)),
        )
        const relative = prefix.replace(/\/$/u, '')
        expect(index.hasDirectory(relative)).toBe(
          manifest.roots.some(
            (directory) => inventoryRelativePath(manifest.roots[0]!, directory) === relative,
          ),
        )
        expect(index.file(prefix)).toBe(manifest.files.find((entry) => entry.path === prefix))
      }
      for (const entry of manifest.files) expect(index.file(entry.path)).toBe(entry)
      for (const id of ['object-0', 'object-3', 'object-9'])
        expect(index.object(id)).toBe(manifest.objects.find((entry) => entry.id === id))
      for (const [skillId, tree] of [
        ['skill-0', 'live'],
        ['skill-1', 'version:1'],
        ['skill-0', 'version:2'],
        ['skill-1', 'live'],
      ] as const)
        expect(index.databaseTree(skillId, tree)).toBe(
          manifest.databaseTrees.find((entry) => entry.skillId === skillId && entry.tree === tree),
        )
    }
  })

test('an empty listing answers like the scans: nothing listed, no root matched', () => {
  const empty: FreezeContentManifest = {
    version: 1,
    roots: [],
    files: [],
    objects: [],
    databaseTrees: [],
    digest: `sha256:${'0'.repeat(64)}`,
  }
  const index = createContentManifestIndex(empty)
  expect(index.filesUnder('')).toEqual([])
  expect(index.hasFilesUnder('')).toBe(false)
  expect(index.hasDirectory('')).toBe(false)
  expect(index.file('a')).toBeUndefined()
  expect(index.object('a')).toBeUndefined()
  expect(index.databaseTree('a', 'live')).toBeUndefined()
})

test('the home itself is a listed directory, relative to the first root', () => {
  const manifest = listing(3, 30, true)
  const index = createContentManifestIndex(manifest)
  expect(index.hasDirectory('')).toBe(true)
  expect(index.hasDirectory('..')).toBe(false)
})

test('tree queries no longer scan the whole listing per call', () => {
  const source = readFileSync(
    join(import.meta.dir, '../src/platform/content/inventory/freezeInventory.ts'),
    'utf8',
  )
  expect(source).toContain('createContentManifestIndex(input.manifest)')
  expect(source).not.toContain('input.manifest.files.')
  expect(source).not.toContain('input.manifest.roots.')
  expect(source).not.toContain('input.manifest.objects.find')
  expect(source).not.toContain('input.manifest.databaseTrees.find')
})

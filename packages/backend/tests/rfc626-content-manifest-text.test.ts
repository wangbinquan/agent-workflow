// RFC-626 §4.4 / §4.7 (design §7 "耗时与编排"): a content manifest is serialized once per
// inventory and hashed while its text is produced, and verification checks the listing in place
// instead of through a schema copy. The definition of the manifest text and of its digest must
// not move: `referenceDigest` / `referenceVerify` below are the implementations before RFC-626,
// and the new code must agree with them byte for byte (random listings with escapes, astral
// characters, `-0`, log entries; listings larger than one text chunk; shapes the fast path does
// not render, which must fall back to the same result) and accept or reject exactly the same
// manifests with the same errors.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z, ZodError } from 'zod'
import {
  contentManifestDigest,
  verifyContentManifest,
  writeContentManifest,
} from '@/platform/content/inventory/manifest'
import { inventoryRelativePath } from '@/platform/content/inventory/resolvers'
import { canonicalSchemaJson, digestSchemaContract } from '@/platform/persistence/schema/canonical'
import type { FreezeContentManifest } from '@/platform/persistence/migration/run/types'

type Payload = Omit<FreezeContentManifest, 'digest'>

let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'rfc626-manifest-text-'))
}, 5_000)
afterEach(() => rmSync(directory, { recursive: true, force: true }), 5_000)

/** `contentManifestDigest` before RFC-626. */
function referenceDigest(payload: Payload): string {
  const home = payload.roots[0] ?? ''
  return digestSchemaContract({
    ...payload,
    roots: payload.roots
      .map((path) => inventoryRelativePath(home, path))
      .filter((path) => path !== 'logs' && !path.startsWith('logs/')),
    files: payload.files.filter((file) => file.path !== 'logs' && !file.path.startsWith('logs/')),
  })
}

const byteFacts = {
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}
const referenceSchema = z.strictObject({
  version: z.literal(1),
  roots: z.array(z.string()),
  files: z.array(z.strictObject({ path: z.string(), size: byteFacts.size, mtimeMs: z.number() })),
  objects: z.array(
    z.strictObject({
      id: z.string(),
      present: z.boolean(),
      size: byteFacts.size.nullable(),
      sha256: byteFacts.sha256.nullable(),
    }),
  ),
  databaseTrees: z.array(z.strictObject({ skillId: z.string(), tree: z.string(), ...byteFacts })),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
})
/** `verifyContentManifest` before RFC-626. */
function referenceVerify(input: FreezeContentManifest): void {
  const { digest, ...payload } = referenceSchema.parse(input)
  if (referenceDigest(payload) !== digest) throw new Error('content-manifest-digest-mismatch')
  if (
    new Set(payload.files.map((entry) => entry.path)).size !== payload.files.length ||
    new Set(payload.objects.map((entry) => entry.id)).size !== payload.objects.length ||
    new Set(payload.databaseTrees.map((entry) => canonicalSchemaJson([entry.skillId, entry.tree])))
      .size !== payload.databaseTrees.length
  )
    throw new Error('content-manifest-duplicate-entry')
}

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
const SEGMENTS = [
  'logs',
  'logs-old',
  'runs',
  'skills',
  'a',
  'B',
  '技能',
  '𝄞 clef',
  'x y',
  'q"t',
  'b\\s',
  '\u0001ctl',
  'é',
  'é',
  '10',
  '9',
  '\ud800lone',
]
const MTIMES = [0, -0, 1, 1.5, 1_700_000_000_123, 8_640_000_000_000_000]

function randomPayload(seed: number, count: number, segmentLength = 0): Payload {
  const next = seeded(seed)
  const pick = <T>(values: readonly T[]) => values[Math.floor(next() * values.length)]!
  const home = '/home/aw'
  const paths = new Set<string>()
  let attempts = 0
  while (paths.size < count && attempts++ < count * 20) {
    const depth = 1 + Math.floor(next() * 4)
    const parts = Array.from({ length: depth }, () => pick(SEGMENTS))
    if (segmentLength) parts.push('p'.repeat(segmentLength) + String(paths.size) + pick(SEGMENTS))
    paths.add(parts.join('/'))
  }
  return {
    version: 1,
    roots: [home, `${home}/logs`, `${home}/logs/rotated`, `${home}/runs/x`, `${home}/skills/技能`],
    files: [...paths].map((path) => ({
      path,
      size: Math.floor(next() * 1_000_000),
      mtimeMs: pick(MTIMES),
    })),
    objects: [
      { id: 'object-1', present: true, size: 3, sha256: 'a'.repeat(64) },
      { id: 'object-2', present: false, size: null, sha256: null },
    ],
    databaseTrees: [{ skillId: 'skill', tree: 'live', size: 1, sha256: 'b'.repeat(64) }],
  }
}

/** A copy of `items` with a hole at `hole`. */
function sparseCopy<T>(items: readonly T[], hole: number): T[] {
  const copy = new Array<T>(items.length)
  items.forEach((item, index) => {
    if (index !== hole) copy[index] = item
  })
  return copy
}

test('the digest of random listings equals the earlier one-string serialization', () => {
  for (let seed = 1; seed <= 40; seed += 1) {
    const payload = randomPayload(seed, (seed * 37) % 400)
    expect(contentManifestDigest(payload)).toBe(referenceDigest(payload))
  }
  const empty: Payload = { version: 1, roots: [], files: [], objects: [], databaseTrees: [] }
  expect(contentManifestDigest(empty)).toBe(referenceDigest(empty))
})

test('listings and members the canonical renderer does not cover fall back to the same digest', () => {
  const base = randomPayload(7, 30)
  const entry = base.files[0]!
  const variants: unknown[] = [
    { ...base, files: [{ ...entry, extra: 1 }, ...base.files.slice(1)] },
    { ...base, files: [{ ...entry, mtimeMs: Number.NaN }] },
    { ...base, files: [{ ...entry, mtimeMs: Number.POSITIVE_INFINITY }] },
    { ...base, files: [{ ...entry, size: '3' }] },
    { ...base, files: [{ path: entry.path, size: entry.size }] },
    // A hole is skipped by the log filter in both implementations.
    { ...base, files: sparseCopy(base.files, 1) },
    // Members around `files` keep canonical order, including keys sorting before it.
    { ...base, extra: { nested: [1, { b: 2, a: 1 }] } },
    { ...base, digest: 'sha256:'.padEnd(71, '0') },
    { ...base, 1: 'array-index key', aardvark: true },
    { ...base, objects: undefined },
  ]
  for (const variant of variants)
    expect(contentManifestDigest(variant as Payload)).toBe(referenceDigest(variant as Payload))
})

test('a listing larger than one text chunk keeps its digest and is written as its canonical text', () => {
  const payload = randomPayload(11, 20_000, 200)
  expect(payload.files.length).toBe(20_000)
  const digest = contentManifestDigest(payload)
  expect(digest).toBe(referenceDigest(payload))
  const manifest: FreezeContentManifest = { ...payload, digest }
  const destination = join(directory, 'manifest.json')
  writeContentManifest(destination, manifest)
  const expected = canonicalSchemaJson(manifest)
  expect(Buffer.byteLength(expected)).toBeGreaterThan(4 << 20)
  expect(Buffer.compare(readFileSync(destination), Buffer.from(expected, 'utf8'))).toBe(0)
  expect(() => verifyContentManifest(manifest)).not.toThrow()
  expect(() => referenceVerify(manifest)).not.toThrow()
})

test('the writer falls back to the plain serialization for shapes outside the renderer', () => {
  const payload = randomPayload(13, 10)
  const manifest = {
    ...payload,
    files: [{ ...payload.files[0]!, extra: 'kept' }, ...payload.files.slice(1)],
    digest: 'sha256:'.padEnd(71, '1'),
  } as unknown as FreezeContentManifest
  const destination = join(directory, 'fallback.json')
  writeContentManifest(destination, manifest)
  expect(readFileSync(destination, 'utf8')).toBe(canonicalSchemaJson(manifest))
})

function outcome(check: () => void): { ok: true } | { ok: false; kind: string; detail: unknown } {
  try {
    check()
    return { ok: true }
  } catch (error) {
    if (error instanceof ZodError) return { ok: false, kind: 'zod', detail: error.issues }
    return { ok: false, kind: (error as Error).constructor.name, detail: (error as Error).message }
  }
}

test('verification accepts and rejects exactly what the schema-copying check did, with the same errors', () => {
  const payload = randomPayload(17, 60)
  const sealed = (value: unknown): FreezeContentManifest => {
    const record = value as Payload & { digest?: string }
    try {
      const { digest: _digest, ...rest } = record
      return { ...record, digest: referenceDigest(rest) } as FreezeContentManifest
    } catch {
      return record as FreezeContentManifest
    }
  }
  const valid = sealed(payload)
  const file = valid.files[0]!
  const withFile = (entry: unknown, at = 3) =>
    sealed({ ...valid, files: valid.files.map((item, index) => (index === at ? entry : item)) })
  const cases: Record<string, FreezeContentManifest> = {
    valid,
    stale: { ...valid, files: [] },
    duplicatePath: sealed({ ...valid, files: [...valid.files, { ...file }] }),
    negativeSize: withFile({ ...file, size: -1 }),
    fractionalSize: withFile({ ...file, size: 1.5 }),
    unsafeSize: withFile({ ...file, size: 2 ** 60 }),
    negativeZeroSize: withFile({ ...file, size: -0 }),
    textSize: withFile({ ...file, size: '3' }),
    nanTime: withFile({ ...file, mtimeMs: Number.NaN }),
    infiniteTime: withFile({ ...file, mtimeMs: Number.POSITIVE_INFINITY }),
    textTime: withFile({ ...file, mtimeMs: '1' }),
    missingTime: withFile({ path: file.path, size: file.size }),
    extraKey: withFile({ ...file, extra: true }),
    numberPath: withFile({ ...file, path: 7 }),
    nullEntry: withFile(null),
    arrayEntry: withFile([file.path, file.size, file.mtimeMs]),
    filesNotArray: sealed({ ...valid, files: {} }),
    extraTopLevel: sealed({ ...valid, extra: 1 }),
    missingObjects: sealed({ ...valid, objects: undefined }),
    version: sealed({ ...valid, version: 2 }),
    rootType: sealed({ ...valid, roots: [...valid.roots, 1] }),
    digestShape: { ...valid, digest: 'sha256:xyz' },
    objectDigest: sealed({
      ...valid,
      objects: [{ id: 'object', present: true, size: 1, sha256: 'A'.repeat(64) }],
    }),
    duplicateObject: sealed({ ...valid, objects: [valid.objects[0], valid.objects[0]] }),
    duplicateTree: sealed({
      ...valid,
      databaseTrees: [valid.databaseTrees[0], { ...valid.databaseTrees[0]!, size: 2 }],
    }),
  }
  cases.hole = sealed({ ...valid, files: sparseCopy(valid.files, 2) })
  for (const [name, manifest] of Object.entries(cases)) {
    const expected = outcome(() => referenceVerify(manifest))
    const actual = outcome(() => verifyContentManifest(manifest))
    expect({ name, ...actual }).toEqual({ name, ...expected })
  }
  expect(outcome(() => verifyContentManifest(valid))).toEqual({ ok: true })
  expect(outcome(() => verifyContentManifest(cases.stale!))).toEqual({
    ok: false,
    kind: 'Error',
    detail: 'content-manifest-digest-mismatch',
  })
  expect(outcome(() => verifyContentManifest(cases.duplicatePath!))).toEqual({
    ok: false,
    kind: 'Error',
    detail: 'content-manifest-duplicate-entry',
  })
})

test('capture serializes each entry once, shares it with the digest and does not re-verify by serializing', () => {
  const source = readFileSync(
    join(import.meta.dir, '../src/platform/content/inventory/manifest.ts'),
    'utf8',
  )
  const capture = source.slice(source.indexOf('export async function captureContentManifest'))
  expect(capture).toContain('const texts = listed.map(fileEntryText)')
  expect(capture).toContain('manifestDigest(payload, texts)')
  expect(capture).toContain('writeManifestText(input.destination, manifest, texts)')
  expect(capture).not.toContain('verifyContentManifest(')
  expect(capture).not.toContain('canonicalSchemaJson(manifest)')
  expect(capture).not.toContain('existsSync(')
})

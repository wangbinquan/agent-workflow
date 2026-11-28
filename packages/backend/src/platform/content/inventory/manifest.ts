import type { MigrationProgressCallback } from '@/platform/persistence/migration/run/progress'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  statSync,
  writeFileSync,
  writeSync,
  type Dirent,
  type Stats,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { createSha256DigestBuilder } from '@/platform/contracts/hash'
import { canonicalSchemaJson, digestSchemaContract } from '@/platform/persistence/schema/canonical'
import type {
  ContentRootSpec,
  FreezeContentManifest,
  FrozenSourceHandle,
} from '@/platform/persistence/migration/run/types'
import type { InventoryObjectReader } from './objects'
import { statInventoryObject } from './objects'
import { inventoryManifestPath, inventoryHomePath, inventoryRelativePath } from './resolvers'
import { frozenSourceDetails } from '@/platform/persistence/migration/freeze/sourceAccess'
import { readInventorySource } from './databaseTrees'
import { contentByteFacts } from './treeDigest'

type ListedFile = FreezeContentManifest['files'][number]

const byteFacts = {
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}
const listedFileSchema = z.strictObject({
  path: z.string(),
  size: byteFacts.size,
  mtimeMs: z.number(),
})
const headShape = {
  version: z.literal(1),
  roots: z.array(z.string()),
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
}
const manifestSchema = z.strictObject({
  version: headShape.version,
  roots: headShape.roots,
  files: z.array(listedFileSchema),
  objects: headShape.objects,
  databaseTrees: headShape.databaseTrees,
  digest: headShape.digest,
})
/** Everything but the file listing, which `listedFiles` checks in place. */
const manifestHeadSchema = z.strictObject(headShape)

export function verifyContentManifest(input: FreezeContentManifest): void {
  const { digest, ...payload } = checkContentManifest(input)
  if (contentManifestDigest(payload) !== digest) throw new Error('content-manifest-digest-mismatch')
  const paths = new Set<string>()
  for (const entry of payload.files) paths.add(entry.path)
  if (
    paths.size !== payload.files.length ||
    new Set(payload.objects.map((entry) => entry.id)).size !== payload.objects.length ||
    new Set(payload.databaseTrees.map((entry) => canonicalSchemaJson([entry.skillId, entry.tree])))
      .size !== payload.databaseTrees.length
  )
    throw new Error('content-manifest-duplicate-entry')
}

/**
 * The manifest schema's verdict without its copy of the listing. Parsing rebuilds every file
 * entry, a second copy of the largest structure an upgrade holds (RFC-626 §4.7), so entries are
 * checked in place. An entry the plain check does not accept goes through the schema, so what
 * fails, and with which error, stays the schema's.
 */
function checkContentManifest(input: FreezeContentManifest): FreezeContentManifest {
  const { files, ...head } = input
  if (!listedFiles(files)) return manifestSchema.parse(input)
  return { ...manifestHeadSchema.parse(head), files }
}

/**
 * At least as strict as `listedFileSchema`; also the shape `fileEntryText` renders exactly. Not a
 * type guard: callers hold typed listings whose runtime shape is what is in question.
 */
function listedFiles(files: unknown): boolean {
  if (!Array.isArray(files)) return false
  // Indexed, not `every`: a hole is not an entry and must fail like the schema fails it.
  for (let index = 0; index < files.length; index += 1) {
    const entry: unknown = files[index]
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false
    if (
      Object.keys(entry).length !== 3 ||
      !Object.hasOwn(entry, 'path') ||
      !Object.hasOwn(entry, 'size') ||
      !Object.hasOwn(entry, 'mtimeMs')
    )
      return false
    const { path, size, mtimeMs } = entry as Record<string, unknown>
    if (
      typeof path !== 'string' ||
      !Number.isSafeInteger(size) ||
      (size as number) < 0 ||
      !Number.isFinite(mtimeMs)
    )
      return false
  }
  return true
}

const volatilePath = (path: string) => path === 'logs' || path.startsWith('logs/')

/** Daemon logs are listed for content checks, but their churn does not invalidate a
 * database/skills backup. External receipts still rehash any referenced log bytes. */
export function contentManifestDigest(payload: Omit<FreezeContentManifest, 'digest'>): string {
  return manifestDigest(payload)
}

/**
 * `contentManifestDigest`, hashed as the canonical text is produced instead of over one string
 * holding it. `texts` are the entries' `fileEntryText`, when the caller already holds them.
 */
function manifestDigest(
  payload: Omit<FreezeContentManifest, 'digest'>,
  texts?: readonly string[],
): string {
  const home = payload.roots[0] ?? ''
  const roots = payload.roots
    .map((path) => inventoryRelativePath(home, path))
    .filter((path) => !volatilePath(path))
  if (!listedFiles(payload.files))
    return digestSchemaContract({
      ...payload,
      roots,
      files: payload.files.filter((file) => !volatilePath(file.path)),
    })
  const hash = createSha256DigestBuilder()
  const out = chunkedText((chunk) => hash.update(chunk))
  writeCanonicalManifest(
    out.emit,
    { ...payload, roots },
    { files: payload.files, texts, include: (file) => !volatilePath(file.path) },
  )
  out.flush()
  return `sha256:${hash.digestHex()}`
}

/**
 * `canonicalSchemaJson` of one listed file as it sits in a manifest: an item of the top-level
 * `files` array, two levels in. Keys in canonical order: mtimeMs, path, size.
 */
function fileEntryText(file: ListedFile): string {
  return `{\n      "mtimeMs": ${JSON.stringify(file.mtimeMs)},\n      "path": ${JSON.stringify(file.path)},\n      "size": ${JSON.stringify(file.size)}\n    }`
}

/** Member order of `canonicalSchemaJson`: localeCompare, with array-index keys enumerated first. */
function canonicalMemberOrder(keys: readonly string[]): readonly string[] {
  const sorted = [...keys].sort((a, b) => a.localeCompare(b))
  return Object.keys(Object.fromEntries(sorted.map((key) => [key, true])))
}

interface FileListing {
  readonly files: readonly ListedFile[]
  readonly texts?: readonly string[]
  readonly include?: (file: ListedFile) => boolean
}

/**
 * Emits `canonicalSchemaJson(record)` piece by piece. Its `files` member is rendered from
 * `listing`; every other member through `canonicalSchemaJson`, indented to its depth (JSON text
 * holds no raw line breaks, so re-indenting a member is a plain replacement).
 */
function writeCanonicalManifest(
  emit: (text: string) => void,
  record: object,
  listing: FileListing,
): void {
  const members = record as Readonly<Record<string, unknown>>
  let first = true
  emit('{')
  for (const key of canonicalMemberOrder(Object.keys(members))) {
    const value = members[key]
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') continue
    emit(`${first ? '\n  ' : ',\n  '}${JSON.stringify(key)}: `)
    first = false
    if (key !== 'files') {
      emit(canonicalSchemaJson(value).slice(0, -1).replaceAll('\n', '\n  '))
      continue
    }
    let empty = true
    for (let index = 0; index < listing.files.length; index += 1) {
      const file = listing.files[index]!
      if (listing.include && !listing.include(file)) continue
      emit(empty ? '[\n    ' : ',\n    ')
      emit(listing.texts ? listing.texts[index]! : fileEntryText(file))
      empty = false
    }
    emit(empty ? '[]' : '\n  ]')
  }
  emit(first ? '}\n' : '\n}\n')
}

const TEXT_CHUNK = 1 << 20

/** Groups small pieces into ~1 MiB chunks; pieces are never split, so no surrogate pair is. */
function chunkedText(sink: (chunk: string) => void): {
  readonly emit: (text: string) => void
  readonly flush: () => void
} {
  let parts: string[] = []
  let length = 0
  const flush = () => {
    if (!parts.length) return
    const chunk = parts.join('')
    parts = []
    length = 0
    sink(chunk)
  }
  return {
    emit(text) {
      parts.push(text)
      length += text.length
      if (length >= TEXT_CHUNK) flush()
    },
    flush,
  }
}

/** Writes `canonicalSchemaJson(manifest)` to `destination` without holding it as one string. */
export function writeContentManifest(destination: string, manifest: FreezeContentManifest): void {
  writeManifestText(destination, manifest)
}

function writeManifestText(
  destination: string,
  manifest: FreezeContentManifest,
  texts?: readonly string[],
): void {
  if (!listedFiles(manifest.files)) {
    writeFileSync(destination, canonicalSchemaJson(manifest))
    return
  }
  const descriptor = openSync(destination, 'w')
  try {
    const out = chunkedText((chunk) => {
      const bytes = Buffer.from(chunk, 'utf8')
      for (let offset = 0; offset < bytes.byteLength; )
        offset += writeSync(descriptor, bytes, offset, bytes.byteLength - offset)
    })
    writeCanonicalManifest(out.emit, manifest, { files: manifest.files, texts })
    out.flush()
  } finally {
    closeSync(descriptor)
  }
}

/** The filesystem calls of the content walk; tests count them through this seam. */
export interface InventoryFileSystem {
  readonly readDirectory: (path: string) => Dirent[]
  readonly stat: (path: string) => Stats
  readonly exists: (path: string) => boolean
}
const nodeFileSystem: InventoryFileSystem = {
  readDirectory: (path) => readdirSync(path, { withFileTypes: true }),
  stat: (path) => statSync(path),
  exists: (path) => existsSync(path),
}

export async function captureContentManifest(input: {
  readonly progress?: MigrationProgressCallback
  readonly root: ContentRootSpec
  readonly source: FrozenSourceHandle
  readonly objects?: Pick<InventoryObjectReader, 'stat'>
  readonly destination: string
  readonly fileSystem?: InventoryFileSystem
}): Promise<FreezeContentManifest> {
  input.progress?.({ phase: 'content-capture', detail: 'start', boundary: true })
  const fileSystem = input.fileSystem ?? nodeFileSystem
  const root = resolve(input.root.root)
  const index = await readInventorySource(input.source, input.root, dirname(input.destination))
  const directories = new Set<string>([root])
  let live = false
  try {
    live = frozenSourceDetails(input.source).mode === 'live'
  } catch {
    /* Synthetic handles use frozen semantics. */
  }
  const files = new Map<string, ListedFile>()
  const excluded = (relative: string) =>
    input.root.kind === 'backup' &&
    !input.root.runsSupplied &&
    /^(runs|logs|evidence)(\/|$)/.test(relative)
  // RFC-626 §4.4: typed directory reads tell files from directories, so a directory is listed
  // without a stat and a file is stat'ed once. What the walk used to skip because existsSync
  // could not see it, it still skips: a failed stat, or a failed listing of a path that is not
  // visible, ends the visit; a listing that fails on a visible directory fails as before.
  const walk = (path: string) => {
    if (directories.has(path) && path !== root) return
    let entries: Dirent[]
    try {
      entries = fileSystem.readDirectory(path)
    } catch (error) {
      if (!fileSystem.exists(path)) return
      directories.add(path)
      throw error
    }
    directories.add(path)
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) visit(join(path, entry.name), entry)
  }
  const visit = (path: string, entry?: Dirent) => {
    try {
      const relative = inventoryManifestPath(input.root, path)
      if (excluded(relative)) return
      if (entry?.isDirectory()) {
        walk(path)
        return
      }
      // Content locations mostly name what the walk already listed; one stat per file.
      if (
        !entry &&
        ((directories.has(path) && path !== root) ||
          (files.has(relative) && inventoryHomePath(input.root, relative) === path))
      )
        return
      let info: Stats
      try {
        info = fileSystem.stat(path)
      } catch {
        return
      }
      if (info.isDirectory()) walk(path)
      else if (info.isFile()) {
        files.set(relative, { path: relative, size: info.size, mtimeMs: Math.trunc(info.mtimeMs) })
        input.progress?.({
          phase: 'content-capture',
          detail: 'inventory',
          completed: files.size,
          unit: 'files',
        })
      }
    } catch (error) {
      if (!live || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  for (const name of ['skills', 'runs', 'logs', 'evidence', 'config.json'])
    visit(inventoryHomePath(input.root, name))
  for (const location of index.locations.values())
    if (location.kind === 'file' || location.kind === 'directory-tree') visit(location.path)
  const objects: FreezeContentManifest['objects'][number][] = []
  if (input.root.objects !== 'none') {
    if (!input.objects && index.objects.size) throw new Error('content-object-reader-required')
    for (const id of [...index.objects].sort()) {
      const object = await statInventoryObject(input.objects!, id)
      objects.push({
        id,
        present: object !== null,
        size: object?.size ?? null,
        sha256: object?.sha256 ?? null,
      })
    }
  }
  // RFC-626 §4.7: one entry array for the rest of the capture; the map only deduplicated paths.
  const listed = [...files.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  )
  files.clear()
  const payload = {
    version: 1 as const,
    roots: [
      root,
      ...[...directories]
        .filter((path) => path !== root)
        .map((path) => join(root, inventoryManifestPath(input.root, path)))
        .sort(),
    ],
    files: listed,
    objects,
    databaseTrees: [...index.trees.values()]
      .map((tree) => ({ skillId: tree.skillId, tree: tree.tree, ...contentByteFacts(tree.bytes) }))
      .sort((a, b) =>
        Buffer.compare(
          Buffer.from(canonicalSchemaJson([a.skillId, a.tree])),
          Buffer.from(canonicalSchemaJson([b.skillId, b.tree])),
        ),
      ),
  }
  // RFC-626 §4.4: one canonical text per entry, shared by the digest and the written file.
  const texts = listed.map(fileEntryText)
  const manifest = { ...payload, digest: manifestDigest(payload, texts) }
  // The digest was just computed from these texts, and paths, object ids and trees come from
  // keyed collections, so only the shape is checked; nothing is serialized again.
  checkContentManifest(manifest)
  await input.source.reader.assertUnchanged(input.source.preflight)
  mkdirSync(dirname(input.destination), { recursive: true })
  writeManifestText(input.destination, manifest, texts)
  input.progress?.({
    phase: 'content-capture',
    detail: 'complete',
    completed: listed.length,
    unit: 'files',
    boundary: true,
  })
  return manifest
}

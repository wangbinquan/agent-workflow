import type { MigrationProgressCallback } from '@/platform/persistence/migration/run/progress'
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
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

const byteFacts = {
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}
const manifestSchema = z.strictObject({
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
export function verifyContentManifest(input: FreezeContentManifest): void {
  const { digest, ...payload } = manifestSchema.parse(input)
  if (contentManifestDigest(payload) !== digest) throw new Error('content-manifest-digest-mismatch')
  if (
    new Set(payload.files.map((entry) => entry.path)).size !== payload.files.length ||
    new Set(payload.objects.map((entry) => entry.id)).size !== payload.objects.length ||
    new Set(payload.databaseTrees.map((entry) => canonicalSchemaJson([entry.skillId, entry.tree])))
      .size !== payload.databaseTrees.length
  )
    throw new Error('content-manifest-duplicate-entry')
}

/** Daemon logs are listed for content checks, but their churn does not invalidate a
 * database/skills backup. External receipts still rehash any referenced log bytes. */
export function contentManifestDigest(payload: Omit<FreezeContentManifest, 'digest'>): string {
  const home = payload.roots[0] ?? ''
  return digestSchemaContract({
    ...payload,
    roots: payload.roots
      .map((path) => inventoryRelativePath(home, path))
      .filter((path) => path !== 'logs' && !path.startsWith('logs/')),
    files: payload.files.filter((file) => file.path !== 'logs' && !file.path.startsWith('logs/')),
  })
}

export async function captureContentManifest(input: {
  readonly progress?: MigrationProgressCallback
  readonly root: ContentRootSpec
  readonly source: FrozenSourceHandle
  readonly objects?: Pick<InventoryObjectReader, 'stat'>
  readonly destination: string
}): Promise<FreezeContentManifest> {
  input.progress?.({ phase: 'content-capture', detail: 'start', boundary: true })
  const root = resolve(input.root.root)
  const index = await readInventorySource(input.source, input.root, dirname(input.destination))
  const directories = new Set<string>([root])
  let live = false
  try {
    live = frozenSourceDetails(input.source).mode === 'live'
  } catch {
    /* Synthetic handles use frozen semantics. */
  }
  const files = new Map<string, FreezeContentManifest['files'][number]>()
  const visit = (path: string) => {
    try {
      if (!existsSync(path)) return
      const relative = inventoryManifestPath(input.root, path)
      if (
        input.root.kind === 'backup' &&
        !input.root.runsSupplied &&
        /^(runs|logs|evidence)(\/|$)/.test(relative)
      )
        return
      const info = statSync(path)
      if (info.isDirectory()) {
        if (directories.has(path) && path !== root) return
        directories.add(path)
        for (const name of readdirSync(path).sort()) visit(join(path, name))
      } else if (info.isFile()) {
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
  const payload = {
    version: 1 as const,
    roots: [
      root,
      ...[...directories]
        .filter((path) => path !== root)
        .map((path) => join(root, inventoryManifestPath(input.root, path)))
        .sort(),
    ],
    files: [...files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
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
  const manifest = { ...payload, digest: contentManifestDigest(payload) }
  verifyContentManifest(manifest)
  await input.source.reader.assertUnchanged(input.source.preflight)
  mkdirSync(dirname(input.destination), { recursive: true })
  writeFileSync(input.destination, canonicalSchemaJson(manifest))
  input.progress?.({
    phase: 'content-capture',
    detail: 'complete',
    completed: files.size,
    unit: 'files',
    boundary: true,
  })
  return manifest
}

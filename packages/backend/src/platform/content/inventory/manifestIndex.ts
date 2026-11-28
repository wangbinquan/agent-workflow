// RFC-626 §4.4: lookups over a frozen content listing. Tree queries used to scan every listed
// file and root per call (a listing holds ~830k files), so each index is built once, on first use.
import type { FreezeContentManifest } from '@/platform/persistence/migration/run/types'
import { inventoryRelativePath } from './resolvers'

type ListedFile = FreezeContentManifest['files'][number]
type ListedObject = FreezeContentManifest['objects'][number]
type ListedTree = FreezeContentManifest['databaseTrees'][number]

export interface ContentManifestIndex {
  /** The listed file at a home-relative path. */
  file(path: string): ListedFile | undefined
  /** Listed files whose path starts with `prefix`, in listing order. */
  filesUnder(prefix: string): readonly ListedFile[]
  /** Whether any listed file path starts with `prefix`. */
  hasFilesUnder(prefix: string): boolean
  /** Whether a listed root is `relative`, taken relative to the listing's home (`roots[0]`). */
  hasDirectory(relative: string): boolean
  object(id: string): ListedObject | undefined
  databaseTree(skillId: string, tree: string): ListedTree | undefined
}

const byCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export function createContentManifestIndex(manifest: FreezeContentManifest): ContentManifestIndex {
  const files = manifest.files
  let paths: Map<string, ListedFile> | undefined
  // Listing positions in code-unit order of path, or `null` when the listing already is in that
  // order, as every captured listing is. Paths sharing a prefix are then one contiguous range.
  let order: Uint32Array | null | undefined
  let directories: ReadonlySet<string> | undefined
  let objects: Map<string, ListedObject> | undefined
  let trees: Map<string, ListedTree> | undefined
  const sorted = (): Uint32Array | null => {
    if (order !== undefined) return order
    let ascending = true
    for (let index = 1; index < files.length && ascending; index += 1)
      ascending = files[index - 1]!.path < files[index]!.path
    if (ascending) return (order = null)
    const positions = new Uint32Array(files.length)
    for (let index = 0; index < files.length; index += 1) positions[index] = index
    positions.sort((a, b) => byCodeUnits(files[a]!.path, files[b]!.path))
    return (order = positions)
  }
  const at = (rank: number, positions: Uint32Array | null) => (positions ? positions[rank]! : rank)
  const lowerBound = (prefix: string, positions: Uint32Array | null) => {
    let low = 0
    let high = files.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (files[at(middle, positions)]!.path < prefix) low = middle + 1
      else high = middle
    }
    return low
  }
  const treeKey = (skillId: string, tree: string) => JSON.stringify([skillId, tree])
  return {
    file(path) {
      paths ??= new Map(files.map((entry) => [entry.path, entry]))
      return paths.get(path)
    },
    filesUnder(prefix) {
      const positions = sorted()
      const found: number[] = []
      for (let rank = lowerBound(prefix, positions); rank < files.length; rank += 1) {
        const position = at(rank, positions)
        if (!files[position]!.path.startsWith(prefix)) break
        found.push(position)
      }
      if (positions) found.sort((a, b) => a - b)
      return found.map((position) => files[position]!)
    },
    hasFilesUnder(prefix) {
      const positions = sorted()
      const rank = lowerBound(prefix, positions)
      return rank < files.length && files[at(rank, positions)]!.path.startsWith(prefix)
    },
    hasDirectory(relative) {
      directories ??= new Set(
        manifest.roots.map((directory) => inventoryRelativePath(manifest.roots[0]!, directory)),
      )
      return directories.has(relative)
    },
    object(id) {
      if (!objects) {
        objects = new Map()
        // First entry wins, as a linear find would; the manifest check rejects duplicates.
        for (const entry of manifest.objects)
          if (!objects.has(entry.id)) objects.set(entry.id, entry)
      }
      return objects.get(id)
    },
    databaseTree(skillId, tree) {
      if (!trees) {
        trees = new Map()
        for (const entry of manifest.databaseTrees) {
          const key = treeKey(entry.skillId, entry.tree)
          if (!trees.has(key)) trees.set(key, entry)
        }
      }
      return trees.get(treeKey(skillId, tree))
    },
  }
}

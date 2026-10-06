import type { CompleteWorkingRows, CompleteWorkingRow } from '../ports/completeWorkingRows'
import type { CoverageIntervalStore, CoverageIntervalNode } from '../domain/coverageIntervalIndex'
interface Root {
  readonly tree: string
  readonly id: string | null
  /** A single original interval needs no duplicate TEMP node row. */
  readonly point?: readonly [number, number]
}
async function prefetchRoots(
  input: {
    readonly rows: CompleteWorkingRows
    readonly rootSpace: string
    readonly keyOf: (value: string) => string
    readonly roots: Map<string, Root>
    readonly dirtyRoots: Map<string, Root>
    readonly coverage: CoverageIntervalStore
    readonly empty: () => boolean | undefined
    readonly revision: () => bigint
    readonly remember: (key: string, row: Root) => void
    readonly signal?: AbortSignal
  },
  trees: AsyncIterable<string> | Iterable<string>,
) {
  const wanted = new Map<string, string>()
  async function load() {
    input.signal?.throwIfAborted()
    const batch = new Map(wanted)
    wanted.clear()
    const before = input.revision()
    const found = await input.rows.getMany<Root>(input.rootSpace, [...batch.keys()])
    input.signal?.throwIfAborted()
    if (input.revision() !== before) return
    for (const [key, tree] of batch) {
      const row = found.get(key)
      if (row && row.tree !== tree) throw new Error('Coverage root key identity conflict')
      if (!input.roots.has(key) && !input.dirtyRoots.has(key))
        input.remember(key, row ?? { tree, id: null })
    }
  }
  for await (const tree of trees) {
    input.signal?.throwIfAborted()
    if (input.empty() === undefined) await input.coverage.root(tree)
    if (input.empty() === true) continue
    const key = input.keyOf(tree)
    if (input.roots.has(key) || input.dirtyRoots.has(key)) continue
    wanted.set(key, tree)
    if (wanted.size === 500) await load()
  }
  if (wanted.size) await load()
}
/** Bounded dirty buffers and caches; authority remains the original connection's TEMP rows. */
export function completeCoverageWorkspace(
  rows: CompleteWorkingRows,
  namespace: string,
  keyOf: (value: string) => string,
  signal?: AbortSignal,
) {
  const roots = new Map<string, Root>(),
    nodes = new Map<string, CoverageIntervalNode>()
  const dirtyRoots = new Map<string, Root>(),
    dirtyNodes = new Map<string, CoverageIntervalNode>()
  let sequence = 0n
  let originalRootsEmpty: boolean | undefined
  let rootWriteRevision = 0n
  const remember = <T>(cache: Map<string, T>, key: string, value: T) => {
    cache.delete(key)
    cache.set(key, value)
    if (cache.size > 4096) cache.delete(cache.keys().next().value!)
  }
  const flushRows = async <T>(space: string, dirty: Map<string, T>) => {
    if (!dirty.size) return
    const batch: CompleteWorkingRow<T>[] = [...dirty].map(([key, document]) => ({ key, document }))
    await rows.upsert(space, batch)
    dirty.clear()
  }
  const rootSpace = `${namespace}/roots`,
    nodeSpace = `${namespace}/nodes`
  const nodeKey = (tree: string, id: string) => keyOf(JSON.stringify([tree, id]))
  const coverage: CoverageIntervalStore = {
    async root(tree) {
      const key = keyOf(tree)
      let row = roots.get(key) ?? dirtyRoots.get(key)
      if (!row && originalRootsEmpty === true) return null
      if (!row && originalRootsEmpty === undefined) {
        const first = await rows.page<Root>(rootSpace, null, 1)
        if (originalRootsEmpty === undefined)
          originalRootsEmpty = first.items.length === 0 && first.nextCursor === null
        row = roots.get(key) ?? dirtyRoots.get(key)
      }
      while (!row) {
        const revision = rootWriteRevision
        const retained = await rows.get<Root>(rootSpace, key)
        row = roots.get(key) ?? dirtyRoots.get(key)
        // A root written during the read may already have been flushed and evicted.
        if (!row && revision !== rootWriteRevision) continue
        row ??= retained
        if (!row) {
          remember(roots, key, { tree, id: null })
          return null
        }
      }
      if (row.tree !== tree) throw new Error('Coverage root key identity conflict')
      remember(roots, key, row)
      return row.id
    },
    async setRoot(tree, id) {
      originalRootsEmpty = false
      rootWriteRevision++
      const key = keyOf(tree),
        current = roots.get(key) ?? dirtyRoots.get(key),
        nodeId = nodeKey(tree, id),
        pending = dirtyNodes.get(nodeId)
      const leaf =
        pending &&
        pending.left === null &&
        pending.right === null &&
        pending.height === 1 &&
        pending.maximum === pending.end
      const row: Root =
        current?.id === id && current.point
          ? current
          : current?.id == null && leaf
            ? { tree, id, point: [pending.start, pending.end] }
            : { tree, id }
      if (row.point) {
        dirtyNodes.delete(nodeId)
        nodes.delete(nodeId)
      }
      remember(roots, key, row)
      dirtyRoots.set(key, row)
      if (dirtyRoots.size === 500) await flushRows(rootSpace, dirtyRoots)
    },
    async node(tree, id) {
      await coverage.root(tree)
      const root = roots.get(keyOf(tree)) ?? dirtyRoots.get(keyOf(tree))
      if (root?.id === id && root.point) {
        if (root.point.length !== 2 || !root.point.every(Number.isSafeInteger))
          throw new Error('Coverage point interval invalid')
        return {
          id,
          start: root.point[0],
          end: root.point[1],
          maximum: root.point[1],
          height: 1,
          left: null,
          right: null,
        }
      }
      const key = nodeKey(tree, id),
        row =
          nodes.get(key) ??
          dirtyNodes.get(key) ??
          (await rows.get<CoverageIntervalNode>(nodeSpace, key))
      if (!row || row.id !== id) throw new Error('Coverage interval node missing')
      remember(nodes, key, row)
      return { ...row }
    },
    async save(tree, node) {
      await coverage.root(tree)
      const rootKey = keyOf(tree),
        root = roots.get(rootKey) ?? dirtyRoots.get(rootKey)
      if (root?.id === node.id && root.point) {
        const leaf =
          node.left === null &&
          node.right === null &&
          node.height === 1 &&
          node.maximum === node.end
        const row: Root = leaf
          ? { tree, id: node.id, point: [node.start, node.end] }
          : { tree, id: node.id }
        rootWriteRevision++
        remember(roots, rootKey, row)
        dirtyRoots.set(rootKey, row)
        if (leaf) {
          if (dirtyRoots.size === 500) await flushRows(rootSpace, dirtyRoots)
          return
        }
      }
      // Preserve the original pending first leaf when the previous full nodes fill a batch.
      if (
        dirtyNodes.size === 499 &&
        root?.id == null &&
        node.left === null &&
        node.right === null &&
        node.height === 1 &&
        node.maximum === node.end &&
        !dirtyNodes.has(nodeKey(tree, node.id))
      )
        await flushRows(nodeSpace, dirtyNodes)
      const key = nodeKey(tree, node.id),
        copy = { ...node }
      remember(nodes, key, copy)
      dirtyNodes.set(key, copy)
      if (dirtyNodes.size === 500) await flushRows(nodeSpace, dirtyNodes)
      if (dirtyRoots.size === 500) await flushRows(rootSpace, dirtyRoots)
    },
    async allocateId() {
      return String(++sequence)
    },
  }
  return {
    coverage,
    prefetchRoots: (trees: AsyncIterable<string> | Iterable<string>) =>
      prefetchRoots(
        {
          rows,
          rootSpace,
          keyOf,
          roots,
          dirtyRoots,
          coverage,
          empty: () => originalRootsEmpty,
          revision: () => rootWriteRevision,
          remember: (key, row) => remember(roots, key, row),
          signal,
        },
        trees,
      ),
    flush: async () => {
      await flushRows(rootSpace, dirtyRoots)
      await flushRows(nodeSpace, dirtyNodes)
    },
  }
}

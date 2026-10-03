import type { CompleteWorkingRows, CompleteWorkingRow } from '../ports/completeWorkingRows'
import type { CoverageIntervalStore, CoverageIntervalNode } from '../domain/coverageIntervalIndex'
interface Root {
  readonly tree: string
  readonly id: string | null
}
/** Bounded dirty buffers and caches; authority remains the original connection's TEMP rows. */
export function completeCoverageWorkspace(
  rows: CompleteWorkingRows,
  namespace: string,
  keyOf: (value: string) => string,
) {
  const roots = new Map<string, Root>(),
    nodes = new Map<string, CoverageIntervalNode>()
  const dirtyRoots = new Map<string, Root>(),
    dirtyNodes = new Map<string, CoverageIntervalNode>()
  let sequence = 0n
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
      const key = keyOf(tree),
        hit = roots.get(key) ?? dirtyRoots.get(key),
        row = hit ?? (await rows.get<Root>(rootSpace, key))
      if (!row) return null
      if (row.tree !== tree) throw new Error('Coverage root key identity conflict')
      remember(roots, key, row)
      return row.id
    },
    async setRoot(tree, id) {
      const key = keyOf(tree),
        row = { tree, id }
      remember(roots, key, row)
      dirtyRoots.set(key, row)
      if (dirtyRoots.size === 500) await flushRows(rootSpace, dirtyRoots)
    },
    async node(tree, id) {
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
      const key = nodeKey(tree, node.id),
        copy = { ...node }
      remember(nodes, key, copy)
      dirtyNodes.set(key, copy)
      if (dirtyNodes.size === 500) await flushRows(nodeSpace, dirtyNodes)
    },
    async allocateId() {
      return String(++sequence)
    },
  }
  return {
    coverage,
    flush: async () => {
      await flushRows(rootSpace, dirtyRoots)
      await flushRows(nodeSpace, dirtyNodes)
    },
  }
}

/** RFC-371: an augmented AVL tree in private report working storage.
 * A prefix maximum always comes from one original interval; intervals are never unioned.
 */
export interface CoverageIntervalNode {
  readonly id: string
  readonly start: number
  readonly end: number
  readonly maximum: number
  readonly height: number
  readonly left: string | null
  readonly right: string | null
}

/** Implementations may use bounded caches; the complete population lives in TEMP. */
export interface CoverageIntervalStore {
  root(tree: string): Promise<string | null>
  setRoot(tree: string, id: string): Promise<void>
  node(tree: string, id: string): Promise<CoverageIntervalNode>
  save(tree: string, node: CoverageIntervalNode): Promise<void>
  allocateId(): Promise<string>
}

async function child(store: CoverageIntervalStore, tree: string, id: string | null) {
  return id === null ? null : store.node(tree, id)
}

async function refreshed(store: CoverageIntervalStore, tree: string, node: CoverageIntervalNode) {
  const left = await child(store, tree, node.left)
  const right = await child(store, tree, node.right)
  return {
    ...node,
    height: Math.max(left?.height ?? 0, right?.height ?? 0) + 1,
    maximum: Math.max(node.end, left?.maximum ?? node.end, right?.maximum ?? node.end),
  }
}

async function rotateLeft(store: CoverageIntervalStore, tree: string, node: CoverageIntervalNode) {
  if (node.right === null) throw new Error('Coverage interval right child missing')
  const right = await store.node(tree, node.right)
  const down = await refreshed(store, tree, { ...node, right: right.left })
  await store.save(tree, down)
  const up = await refreshed(store, tree, { ...right, left: down.id })
  await store.save(tree, up)
  return up
}

async function rotateRight(store: CoverageIntervalStore, tree: string, node: CoverageIntervalNode) {
  if (node.left === null) throw new Error('Coverage interval left child missing')
  const left = await store.node(tree, node.left)
  const down = await refreshed(store, tree, { ...node, left: left.right })
  await store.save(tree, down)
  const up = await refreshed(store, tree, { ...left, right: down.id })
  await store.save(tree, up)
  return up
}

async function balanced(
  store: CoverageIntervalStore,
  tree: string,
  original: CoverageIntervalNode,
) {
  let node = await refreshed(store, tree, original)
  const left = await child(store, tree, node.left)
  const right = await child(store, tree, node.right)
  const balance = (left?.height ?? 0) - (right?.height ?? 0)
  if (balance > 1) {
    if (left === null) throw new Error('Coverage interval balance invalid')
    const a = await child(store, tree, left.left)
    const b = await child(store, tree, left.right)
    if ((a?.height ?? 0) < (b?.height ?? 0)) {
      const rotated = await rotateLeft(store, tree, left)
      node = { ...node, left: rotated.id }
    }
    return rotateRight(store, tree, node)
  }
  if (balance < -1) {
    if (right === null) throw new Error('Coverage interval balance invalid')
    const a = await child(store, tree, right.left)
    const b = await child(store, tree, right.right)
    if ((a?.height ?? 0) > (b?.height ?? 0)) {
      const rotated = await rotateRight(store, tree, right)
      node = { ...node, right: rotated.id }
    }
    return rotateLeft(store, tree, node)
  }
  await store.save(tree, node)
  return node
}

export async function insertCoverageInterval(
  store: CoverageIntervalStore,
  tree: string,
  interval: { readonly start: number; readonly end: number },
): Promise<void> {
  if (!Number.isSafeInteger(interval.start) || !Number.isSafeInteger(interval.end))
    throw new Error('Coverage interval endpoints invalid')
  const id = await store.allocateId()
  if (!/^[1-9]\d*$/.test(id)) throw new Error('Coverage interval identity invalid')
  const inserted: CoverageIntervalNode = {
    id,
    ...interval,
    maximum: interval.end,
    height: 1,
    left: null,
    right: null,
  }
  await store.save(tree, inserted)
  const insert = async (at: string | null): Promise<CoverageIntervalNode> => {
    if (at === null) return inserted
    const node = await store.node(tree, at)
    const before =
      interval.start < node.start || (interval.start === node.start && BigInt(id) < BigInt(node.id))
    const branch = before ? 'left' : 'right'
    const result = await insert(node[branch])
    return balanced(store, tree, { ...node, [branch]: result.id })
  }
  const root = await insert(await store.root(tree))
  await store.setRoot(tree, root.id)
}

/** Maximum original end among individual intervals whose start is at most bound. */
export async function coveragePrefixMaximum(
  store: CoverageIntervalStore,
  tree: string,
  bound: number,
): Promise<number | null> {
  let at = await store.root(tree)
  let result: number | null = null
  while (at !== null) {
    const node = await store.node(tree, at)
    if (node.start > bound) {
      at = node.left
      continue
    }
    const left = await child(store, tree, node.left)
    result = Math.max(result ?? node.end, node.end, left?.maximum ?? node.end)
    at = node.right
  }
  return result
}

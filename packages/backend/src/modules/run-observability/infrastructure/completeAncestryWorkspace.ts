import type { CompleteWorkingRows } from '../ports/completeWorkingRows'

/** Original digest rows remain authoritative; negative cache entries are only bounded read facts. */
export function completeAncestryWorkspace(
  rows: CompleteWorkingRows,
  namespace: string,
  keyOf: (value: string) => string,
  signal?: AbortSignal,
) {
  const cache = new Map<string, string | undefined>(),
    pending = new Map<string, string>()
  let writes = 0n
  const remember = (key: string, path: string | undefined) => {
    cache.delete(key)
    cache.set(key, path)
    if (cache.size > 4096) cache.delete(cache.keys().next().value!)
  }
  async function flush() {
    if (!pending.size) return
    await rows.insert(
      namespace,
      [...pending].map(([key, document]) => ({ key, document })),
    )
    pending.clear()
  }
  async function load(keys: readonly string[]) {
    signal?.throwIfAborted()
    const before = writes
    const found = await rows.getMany<string>(namespace, keys)
    signal?.throwIfAborted()
    if (writes !== before) return
    for (const key of keys) if (!pending.has(key) && !cache.has(key)) remember(key, found.get(key))
  }
  return {
    flush,
    async prefetch(sessions: Iterable<{ readonly group: string; readonly session: string }>) {
      const keys = new Set<string>()
      for (const { group, session } of sessions) {
        const key = keyOf(JSON.stringify([group, session]))
        if (pending.has(key) || cache.has(key)) continue
        keys.add(key)
        if (keys.size === 500) {
          await load([...keys])
          keys.clear()
        }
      }
      if (keys.size) await load([...keys])
    },
    async bind(group: string, session: string, path: string) {
      const key = keyOf(JSON.stringify([group, session]))
      let previous = pending.get(key) ?? cache.get(key)
      while (!pending.has(key) && !cache.has(key)) {
        const before = writes
        const retained = await rows.get<string>(namespace, key)
        previous = pending.get(key) ?? cache.get(key)
        if (!pending.has(key) && !cache.has(key) && before !== writes) continue
        if (!pending.has(key) && !cache.has(key)) previous = retained
        break
      }
      if (previous !== undefined && previous !== path)
        throw new Error('Conflicting observation session ancestry')
      writes++
      if (previous === undefined) pending.set(key, path)
      remember(key, path)
      if (pending.size === 500) await flush()
    },
  }
}

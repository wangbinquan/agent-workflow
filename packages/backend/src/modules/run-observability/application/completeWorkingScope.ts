import type { CompleteWorkingRows } from '../ports/completeWorkingRows'

/** Release one finished Task's intermediate rows after its complete output is retained. */
export function completeWorkingScope(original: CompleteWorkingRows, namespace: string) {
  if (!namespace) throw new Error('Complete Task workspace scope is empty')
  const live = new Set<string>()
  let active = true
  let cleanup: Promise<void> | undefined
  const check = (name: string) => {
    if (!active) throw new Error('Complete Task workspace scope is released')
    if (name !== namespace && !name.startsWith(namespace + '/'))
      throw new Error('Complete Task workspace namespace is outside its scope')
  }
  const rows: CompleteWorkingRows = {
    async insert(name, items) {
      check(name)
      live.add(name)
      await original.insert(name, items)
    },
    async upsert(name, items) {
      check(name)
      live.add(name)
      await original.upsert(name, items)
    },
    async put(name, row) {
      check(name)
      live.add(name)
      await original.put(name, row)
    },
    async get<T>(name: string, key: string) {
      check(name)
      return original.get<T>(name, key)
    },
    async getMany<T>(name: string, keys: readonly string[]) {
      check(name)
      return original.getMany<T>(name, keys)
    },
    async page<T>(name: string, after: string | null, size?: number) {
      check(name)
      return original.page<T>(name, after, size)
    },
    async clear(name) {
      check(name)
      await original.clear(name)
      live.delete(name)
    },
  }
  const release = () => {
    cleanup ??= (async () => {
      active = false
      for (const name of live) {
        await original.clear(name)
        live.delete(name)
      }
    })()
    return cleanup
  }
  return {
    rows,
    release,
    async run<T>(work: (workspace: CompleteWorkingRows) => Promise<T>): Promise<T> {
      check(namespace)
      let outcome: { success: true; value: T } | { success: false; error: unknown }
      try {
        outcome = { success: true, value: await work(rows) }
      } catch (error) {
        outcome = { success: false, error }
      }
      try {
        await release()
      } catch (error) {
        // Cancellation can also stop clear; the original snapshot closes its TEMP in finally.
        if (outcome.success) outcome = { success: false, error }
      }
      if (!outcome.success) throw outcome.error
      return outcome.value
    },
  }
}

import { opencodeUsageDatabasePath } from '@/services/runtime'
import { createOpencodeNativeVersionObserver } from '../infrastructure/opencodeNativeVersionObserver'
import type { HistoricalNativeVersionObserver } from '../application/ports/historicalNativeVersion'

/** Platform bootstrap selects the actual daemon environment, for both application providers. */
export function createHistoricalNativeVersionObserver(
  env: Readonly<Record<string, string | undefined>>,
): HistoricalNativeVersionObserver {
  let selected:
      | { readonly path: string | null; readonly observer: HistoricalNativeVersionObserver }
      | undefined,
    tail: Promise<void> = Promise.resolve()
  const serialize = <T>(work: () => Promise<T>) => {
    const result = tail.then(work)
    tail = result.then(
      () => {},
      () => {},
    )
    return result
  }
  return {
    sample: () =>
      serialize(async () => {
        const path = opencodeUsageDatabasePath(env)
        if (!selected || selected.path !== path) {
          await selected?.observer.close()
          selected = { path, observer: createOpencodeNativeVersionObserver(path) }
        }
        return selected.observer.sample()
      }),
    close: () =>
      serialize(async () => {
        const previous = selected
        selected = undefined
        await previous?.observer.close()
      }),
  }
}

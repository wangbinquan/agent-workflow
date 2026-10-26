import { createGateCorpus, BACKEND_PREFIX } from '../architecture/rfc294Gates'
import type { SourceUnit } from '../architecture/census'
export const EPOCH2_RUNTIME_ENTRIES = [
  BACKEND_PREFIX + 'bootstrap/daemonStart.ts',
  BACKEND_PREFIX + 'bootstrap/standalone.ts',
  BACKEND_PREFIX + 'bootstrap/crewstation.ts',
  BACKEND_PREFIX + 'bootstrap/maintenanceWorkerGraph.ts',
]
/** Erased type imports describe ports; every executable import shape is traversed. */
export function executableReachability(units: readonly SourceUnit[], entries: readonly string[]) {
  const corpus = createGateCorpus(units)
  const reachable = new Set<string>(),
    pending = [...entries]
  for (const entry of entries)
    if (!corpus.byPath.has(entry)) throw new Error(`missing runtime entry:${entry}`)
  while (pending.length) {
    const path = pending.pop()!
    if (reachable.has(path)) continue
    reachable.add(path)
    for (const edge of corpus.imports.get(path) ?? [])
      if (edge.kind === 'value' && corpus.byPath.has(edge.target)) pending.push(edge.target)
  }
  return { corpus, reachable }
}

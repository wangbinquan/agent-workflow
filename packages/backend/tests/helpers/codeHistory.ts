// RFC-513 placed this reader in code-capability's application for the composition's default; RFC-523 made the reader a required
// argument, so only tests use it: every read fails with the original error.
import { CodeHistoryReadError } from '../../src/modules/code-capability/domain/codeHistoryPackage'
import type { CodeHistoryQueryReader } from '../../src/modules/code-capability/application/ports/historyQueryIndex'

export function createUnboundCodeHistoryReader(): CodeHistoryQueryReader {
  const unbound = async (): Promise<never> => {
    throw new CodeHistoryReadError('code-history-reader-unbound', 'installation binding required')
  }
  return {
    rows: unbound,
    find: unbound,
    workItems: { readPage: unbound },
    attempts: { load: unbound },
    deliveries: { recent: unbound, byCorrelation: unbound, failures: unbound },
    metrics: { loadSince: unbound },
  }
}

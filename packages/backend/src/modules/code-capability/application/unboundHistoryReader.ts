// RFC-513 — the history reader used when no installation is bound: every read fails with the original error.
import { CodeHistoryReadError } from '../domain/codeHistoryPackage'
import type { CodeHistoryReader } from './ports/historyReader'

export function createUnboundCodeHistoryReader(): CodeHistoryReader {
  return {
    rows: async () => {
      throw new CodeHistoryReadError('code-history-reader-unbound', 'installation binding required')
    },
    find: async () => {
      throw new CodeHistoryReadError('code-history-reader-unbound', 'installation binding required')
    },
  }
}

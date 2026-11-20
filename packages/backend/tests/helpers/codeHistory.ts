// RFC-513 placed this reader in code-capability's application for the composition's default; RFC-523 made the reader a required
// argument, so only tests use it: every read fails with the original error.
import { CodeHistoryReadError } from '../../src/modules/code-capability/domain/codeHistoryPackage'
import type { CodeHistoryReader } from '../../src/modules/code-capability/application/ports/historyReader'

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

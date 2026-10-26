import type { HistoryConnection } from './connection'
import type { HistoryCatalog } from './catalog'

export interface HistorySession {
  transaction<T>(body: (connection: HistoryConnection) => Promise<T>): Promise<T>
  read<T>(
    body: (connection: HistoryConnection, catalog: () => Promise<HistoryCatalog>) => Promise<T>,
  ): Promise<T>
}

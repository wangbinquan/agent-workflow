import type {
  CodeHistoryQueryRow,
  CodeHistoryQueryTable,
  CodeHistoryRecord,
  CodeHistoryTable,
} from '../../domain/codeHistoryPackage'

export interface CodeHistoryReader {
  rows<K extends CodeHistoryQueryTable>(table: K): Promise<readonly CodeHistoryQueryRow<K>[]>
  find(table: CodeHistoryTable, originalId: string): Promise<CodeHistoryRecord | null>
}

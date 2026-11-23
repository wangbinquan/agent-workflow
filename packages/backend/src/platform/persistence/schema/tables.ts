// Bootstrap supplies the live types and values; platform never imports the composition root.
import type { NeutralTableSet } from './neutral'
import type { SchemaHistoryRuntime } from './history/runtime'

export interface SchemaBinding {
  readonly schemaEpoch: 2
}
export type PersistenceTables = NeutralTableSet<SchemaBinding['definitions']>
export type NativeTableSets = SchemaBinding['nativeTables']
/** RFC-545: the live schema bootstrap composes; it reaches platform as an explicit argument, never through module state. */
export interface RuntimeSchemaBinding {
  readonly definitions: SchemaBinding['definitions']
  readonly nativeTables: NativeTableSets
  readonly rowRuleCodes: ReadonlyMap<string, string>
  /** RFC-549: the binary's schema history, carried with the live schema to every reader. */
  readonly history: SchemaHistoryRuntime
}

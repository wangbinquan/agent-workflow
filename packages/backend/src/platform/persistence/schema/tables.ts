// Bootstrap supplies the live types and values; platform never imports the composition root.
import type { NeutralTableSet } from './neutral'

export interface SchemaBinding {
  readonly schemaEpoch: 2
}
export type PersistenceTables = NeutralTableSet<SchemaBinding['definitions']>
export type NativeTableSets = SchemaBinding['nativeTables']
interface RuntimeSchemaBinding {
  readonly definitions: SchemaBinding['definitions']
  readonly nativeTables: NativeTableSets
  readonly rowRuleCodes: ReadonlyMap<string, string>
}
let liveBinding: RuntimeSchemaBinding | undefined
export function registerPersistenceSchema(binding: RuntimeSchemaBinding): void {
  liveBinding = Object.freeze(binding)
}
export function persistenceSchemaBinding(): RuntimeSchemaBinding {
  if (!liveBinding) throw new Error('Live persistence schema has not been composed')
  return liveBinding
}

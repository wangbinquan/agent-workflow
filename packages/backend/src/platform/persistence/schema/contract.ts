// RFC-395 I-a: the explicit contract is distinct from the frozen epoch-1 artifact projection.
import { digestSchemaContract } from './canonical'
import { validateSchemaRegistry, type SchemaRegistry } from './registry'

export function compileContract(registry: SchemaRegistry) {
  validateSchemaRegistry(registry)
  const payload = {
    contractVersion: 3 as const,
    contributions: registry.contributions.map(({ owner, version }) => ({ owner, version })),
    tables: registry.tables,
  }
  return Object.freeze({ ...payload, digest: digestSchemaContract(payload) })
}
